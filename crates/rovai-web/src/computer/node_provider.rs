//! Provider that drives a paired node's desktop over the authenticated channel.
//!
//! The Host keeps every admission decision it already makes for a local screen:
//! consent, one view per client, one control lease per device, the generation
//! and sequence fence, the idle deadman and the total ceiling. This file only
//! moves the *pixels* and the *input events* to the machine that owns the
//! physical device, and it refuses to report anything it could not prove.
//!
//! Two rules are load-bearing:
//!
//! * A release is confirmed or it is not. A lost socket, a timeout or an
//!   unparsable answer returns [`Failure::Unconfirmed`], so the Host never tells
//!   a caller that a remote keyboard is released when it cannot see it.
//! * A node's `Computer` is tied to the connection generation that advertised
//!   it. A reconnect replaces the entry and drops the old gate with it, so a
//!   lease or view held against a replaced socket can never be reused. The epoch
//!   is the one thing carried over: leases are discarded, but the counter only
//!   ever moves forward, so an epoch issued before the reconnect can never be
//!   issued again after it.
use super::{
    Bounds, Computer, DeviceInfo, Failure, Frame, InputCommand, KeyName, MAX_DIMENSION,
    MAX_FRAME_BYTES, PNG_SIGNATURE, PointerAction, PointerButton, Provider,
};
use crate::nodes::Hub;
use crate::nodes::computer::{COMPUTER_DEADLINE, ComputerOutcome, request_blocking};
use loom_protocol::computer::{
    COMPUTER_VERSION, ComputerActionV1, ComputerButtonV1, ComputerCodeV1, ComputerInputV1,
    ComputerKeyV1, ComputerOpV1, ComputerRequestV1,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// One `Computer` per node, keyed by the generation that advertised it.
#[derive(Default)]
pub(crate) struct NodeComputers {
    entries: Mutex<HashMap<String, Cached>>,
}

struct Cached {
    generation: u64,
    computer: Arc<Computer>,
}

impl NodeComputers {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// The device for one node, or a refusal. The node id is resolved through
    /// the authenticated node registry; a caller can never name a URL, a host or
    /// a port, and a node that has not advertised the transport is refused.
    pub(crate) async fn for_node(
        &self,
        hub: &Arc<Hub>,
        node_id: &str,
    ) -> Result<Arc<Computer>, &'static str> {
        let generation = hub
            .computer_generation(node_id)
            .await
            .ok_or("computer_node_unsupported")?;
        if let Some(computer) = self.current(node_id, generation)? {
            return Ok(computer);
        }
        let provider: Arc<dyn Provider> =
            Arc::new(NodeProvider::new(hub.clone(), node_id.to_owned(), generation));
        self.install(node_id, generation, provider)
    }

    /// The device already installed for exactly this connection generation.
    fn current(
        &self,
        node_id: &str,
        generation: u64,
    ) -> Result<Option<Arc<Computer>>, &'static str> {
        let entries = self.entries.lock().map_err(|_| "computer_busy")?;
        Ok(entries
            .get(node_id)
            .filter(|cached| cached.generation == generation)
            .map(|cached| cached.computer.clone()))
    }

    /// Install the device for a connection generation, replacing whatever the
    /// previous generation left behind.
    ///
    /// A replaced device's gate is dropped whole: its lease, its views and its
    /// input sequence are gone, which is what fences a lease held against a
    /// replaced socket. Its epoch is sampled first and seeded into the
    /// replacement, so the counter never runs backwards across a reconnect. A
    /// concurrent caller that already installed this generation wins, under the
    /// same write lock, because replacing it would drop a live lease.
    fn install(
        &self,
        node_id: &str,
        generation: u64,
        provider: Arc<dyn Provider>,
    ) -> Result<Arc<Computer>, &'static str> {
        // Sample the epoch of the device being replaced before taking the write
        // lock: an input still inside that gate must not stall another node's
        // transition, and a device whose epoch cannot be read is refused rather
        // than silently restarted from zero.
        let replaced = {
            let entries = self.entries.lock().map_err(|_| "computer_busy")?;
            entries.get(node_id).map(|cached| cached.computer.clone())
        };
        let epoch = match replaced {
            Some(computer) => computer.epoch()?,
            None => 0,
        };
        let computer = Arc::new(Computer::with_provider(provider, epoch));
        let mut entries = self.entries.lock().map_err(|_| "computer_busy")?;
        // Re-check under the write lock: a concurrent caller may already have
        // installed this generation, and replacing it would drop a live lease.
        if let Some(cached) = entries.get(node_id)
            && cached.generation == generation
        {
            return Ok(cached.computer.clone());
        }
        entries.insert(
            node_id.to_owned(),
            Cached {
                generation,
                computer: computer.clone(),
            },
        );
        Ok(computer)
    }
}

struct NodeProvider {
    hub: Arc<Hub>,
    node_id: String,
    /// The connection generation this provider was created against. A reply
    /// from any other generation is discarded by the transport.
    #[allow(dead_code)]
    generation: u64,
}

impl NodeProvider {
    fn new(hub: Arc<Hub>, node_id: String, generation: u64) -> Self {
        Self {
            hub,
            node_id,
            generation,
        }
    }

    fn call(&self, op: ComputerOpV1) -> Result<ComputerOutcome, &'static str> {
        let request = ComputerRequestV1 {
            version: COMPUTER_VERSION,
            request_id: uuid::Uuid::new_v4().simple().to_string(),
            op,
        };
        request_blocking(&self.hub, &self.node_id, request, COMPUTER_DEADLINE)
    }
}

impl Provider for NodeProvider {
    fn info(&self) -> Result<DeviceInfo, Failure> {
        let outcome = self
            .call(ComputerOpV1::Info {})
            .map_err(|_| Failure::Failed)?;
        let reply = outcome.reply;
        if !reply.code.is_ok() {
            return Err(failure(reply.code));
        }
        let device = reply.device.ok_or(Failure::Invalid)?;
        Ok(DeviceInfo {
            id: device.device_id,
            platform: device.platform,
            bounds: Bounds {
                x: device.bounds.x,
                y: device.bounds.y,
                width: device.bounds.width,
                height: device.bounds.height,
            },
        })
    }

    fn capture(&self, max_width: u32, max_height: u32) -> Result<Frame, Failure> {
        let op = ComputerOpV1::Frame {
            max_width: max_width.min(MAX_DIMENSION),
            max_height: max_height.min(MAX_DIMENSION),
        };
        let outcome = self.call(op).map_err(|_| Failure::Failed)?;
        let reply = outcome.reply;
        if !reply.code.is_ok() {
            return Err(failure(reply.code));
        }
        let header = reply.frame.ok_or(Failure::Invalid)?;
        let png = outcome.png.ok_or(Failure::Invalid)?;
        // Same shape checks the local backend applies: a real PNG signature, a
        // real dimension and a bounded body. A short or forged frame is refused
        // instead of being shown as a screen.
        if header.width == 0
            || header.height == 0
            || header.width > MAX_DIMENSION
            || header.height > MAX_DIMENSION
            || png.len() < PNG_SIGNATURE.len()
            || png.len() > MAX_FRAME_BYTES
            || !png.starts_with(&PNG_SIGNATURE)
        {
            return Err(Failure::Invalid);
        }
        let device = reply.device.ok_or(Failure::Invalid)?;
        if device.bounds.width == 0 || device.bounds.height == 0 {
            return Err(Failure::Invalid);
        }
        Ok(Frame {
            png,
            width: header.width,
            height: header.height,
            bounds: Bounds {
                x: device.bounds.x,
                y: device.bounds.y,
                width: device.bounds.width,
                height: device.bounds.height,
            },
            scale: header.scale(),
            captured_at: header.captured_at,
        })
    }

    fn input(&self, command: &InputCommand) -> Result<(), Failure> {
        let input = wire_input(command);
        let outcome = self
            .call(ComputerOpV1::Input { input })
            .map_err(|_| Failure::InputFailed)?;
        match outcome.reply.code {
            ComputerCodeV1::Ok => Ok(()),
            code => Err(failure(code)),
        }
    }

    fn release(&self) -> Result<(), Failure> {
        // Only a node that answered `Ok` after draining its own input proves
        // physical release. Everything else — disconnect, timeout, refusal — is
        // unconfirmed, and the Host reports it that way instead of assuming.
        match self.call(ComputerOpV1::Release {}) {
            Ok(outcome) if outcome.reply.code.is_ok() => Ok(()),
            _ => Err(Failure::Unconfirmed),
        }
    }
}

/// Map one closed node code onto the Host's own failure vocabulary. Anything
/// unknown is a failure, never a success.
fn failure(code: ComputerCodeV1) -> Failure {
    match code {
        ComputerCodeV1::Unsupported | ComputerCodeV1::UnsupportedVersion => Failure::Unavailable,
        ComputerCodeV1::EncoderUnavailable => Failure::EncoderUnavailable,
        ComputerCodeV1::BackendUnavailable | ComputerCodeV1::DeviceUnavailable => {
            Failure::BackendUnavailable
        }
        ComputerCodeV1::SessionLocked => Failure::SessionLocked,
        ComputerCodeV1::Timeout => Failure::Timeout,
        ComputerCodeV1::InputFailed => Failure::InputFailed,
        // The node refused before injecting: nothing reached the OS, so this is
        // a clean refusal rather than an unknown side effect.
        ComputerCodeV1::InputUnsupported => Failure::Unsupported,
        ComputerCodeV1::InvalidRequest => Failure::Invalid,
        ComputerCodeV1::ReleaseUnconfirmed => Failure::Unconfirmed,
        ComputerCodeV1::Ok
        | ComputerCodeV1::Busy
        | ComputerCodeV1::CaptureFailed
        | ComputerCodeV1::Cancelled => Failure::Failed,
    }
}

fn wire_input(command: &InputCommand) -> ComputerInputV1 {
    match command {
        InputCommand::Pointer {
            x,
            y,
            button,
            action,
        } => ComputerInputV1::Pointer {
            x: *x,
            y: *y,
            button: button.map(|button| match button {
                PointerButton::Left => ComputerButtonV1::Left,
                PointerButton::Right => ComputerButtonV1::Right,
                PointerButton::Middle => ComputerButtonV1::Middle,
            }),
            action: match action {
                PointerAction::Click => ComputerActionV1::Click,
                PointerAction::Move => ComputerActionV1::Move,
            },
        },
        InputCommand::Wheel { x, y, delta } => ComputerInputV1::Wheel {
            x: *x,
            y: *y,
            delta: *delta,
        },
        InputCommand::Key { key } => ComputerInputV1::Key {
            key: wire_key(*key),
        },
        InputCommand::Text { text } => ComputerInputV1::Text { text: text.clone() },
    }
}

fn wire_key(key: KeyName) -> ComputerKeyV1 {    match key {
        KeyName::Enter => ComputerKeyV1::Enter,
        KeyName::Tab => ComputerKeyV1::Tab,
        KeyName::Escape => ComputerKeyV1::Escape,
        KeyName::Backspace => ComputerKeyV1::Backspace,
        KeyName::Delete => ComputerKeyV1::Delete,
        KeyName::Space => ComputerKeyV1::Space,
        KeyName::Left => ComputerKeyV1::Left,
        KeyName::Right => ComputerKeyV1::Right,
        KeyName::Up => ComputerKeyV1::Up,
        KeyName::Down => ComputerKeyV1::Down,
        KeyName::Home => ComputerKeyV1::Home,
        KeyName::End => ComputerKeyV1::End,
        KeyName::PageUp => ComputerKeyV1::Pageup,
        KeyName::PageDown => ComputerKeyV1::Pagedown,
        KeyName::Shift => ComputerKeyV1::Shift,
        KeyName::Ctrl => ComputerKeyV1::Ctrl,
        KeyName::Alt => ComputerKeyV1::Alt,
        KeyName::Meta => ComputerKeyV1::Meta,
        KeyName::F1 => ComputerKeyV1::F1,
        KeyName::F2 => ComputerKeyV1::F2,
        KeyName::F3 => ComputerKeyV1::F3,
        KeyName::F4 => ComputerKeyV1::F4,
        KeyName::F5 => ComputerKeyV1::F5,
        KeyName::F6 => ComputerKeyV1::F6,
        KeyName::F7 => ComputerKeyV1::F7,
        KeyName::F8 => ComputerKeyV1::F8,
        KeyName::F9 => ComputerKeyV1::F9,
        KeyName::F10 => ComputerKeyV1::F10,
        KeyName::F11 => ComputerKeyV1::F11,
        KeyName::F12 => ComputerKeyV1::F12,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ControlBody, EventBody, EventKind, InputBody, ReleaseBody, ViewBody};
    use super::*;
    use crate::auth::Sessions;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// One physical desktop behind a paired node. It records every input that
    /// actually reached it, which is the only proof that a fenced lease never
    /// executed.
    struct FakeDevice {
        device: DeviceInfo,
        inputs: AtomicU64,
        infos: AtomicU64,
    }

    impl FakeDevice {
        fn new() -> Self {
            Self {
                device: DeviceInfo {
                    id: "sha256:node-device".to_owned(),
                    platform: "windows-gdi".to_owned(),
                    bounds: Bounds {
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                    },
                },
                inputs: AtomicU64::new(0),
                infos: AtomicU64::new(0),
            }
        }
    }

    impl Provider for FakeDevice {
        fn info(&self) -> Result<DeviceInfo, Failure> {
            self.infos.fetch_add(1, Ordering::SeqCst);
            Ok(self.device.clone())
        }
        fn capture(&self, _max_width: u32, _max_height: u32) -> Result<Frame, Failure> {
            Err(Failure::Failed)
        }
        fn input(&self, _command: &InputCommand) -> Result<(), Failure> {
            self.inputs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn release(&self) -> Result<(), Failure> {
            Ok(())
        }
    }

    fn click(control: &str, generation: u64, seq: u64) -> InputBody {
        InputBody {
            view_id: "view-1".to_owned(),
            control_id: control.to_owned(),
            generation,
            seq,
            consent: true,
            event: EventBody {
                kind: EventKind::Text,
                x: None,
                y: None,
                button: None,
                action: None,
                delta: None,
                key: None,
                text: Some("a".to_owned()),
            },
        }
    }

    #[test]
    fn a_reconnect_drops_every_lease_and_never_reissues_an_epoch() {
        let token = crate::new_token().unwrap();
        let sessions = Sessions::new(&token).unwrap();
        let (_, session) = sessions
            .login(&token)
            .ok()
            .expect("browser session must be issued");
        let device = Arc::new(FakeDevice::new());
        let provider: Arc<dyn Provider> = device.clone();
        let computers = NodeComputers::new();

        // The node advertises the transport on connection generation 7.
        let first = computers.install("node-1", 7, provider.clone()).unwrap();
        let view = first
            .start_view(
                &sessions,
                &session,
                ViewBody {
                    consent: true,
                    device_id: device.device.id.clone(),
                },
            )
            .unwrap()["viewId"]
            .as_str()
            .unwrap()
            .to_owned();
        let lease = first
            .acquire(
                &sessions,
                &session,
                ControlBody {
                    view_id: view.clone(),
                    device_id: device.device.id.clone(),
                    consent: true,
                    ttl_seconds: 30,
                },
            )
            .unwrap();
        let control = lease["controlId"].as_str().unwrap().to_owned();
        let epoch = lease["generation"].as_u64().unwrap();
        assert_eq!(epoch, 1);
        assert_eq!(first.epoch().unwrap(), epoch);

        // The node reconnects: generation 8 replaces the device.
        let second = computers.install("node-1", 8, provider.clone()).unwrap();
        assert!(
            !Arc::ptr_eq(&first, &second),
            "a reconnect must replace the device, not reuse it"
        );
        // The epoch is carried across the reconnect, so the number the old lease
        // was issued under can never be handed out again on the new socket.
        assert_eq!(second.epoch().unwrap(), epoch);
        // Every lease, view and sequence of the replaced socket is gone: the old
        // lease identity is refused and never reaches the device.
        let body = InputBody {
            view_id: view.clone(),
            ..click(&control, epoch, 1)
        };
        assert_eq!(
            second.input(&sessions, &session, body).unwrap_err(),
            // The replacement has no lease at all: the epoch it inherited is the
            // current one, so this is a missing lease rather than a stale one.
            "computer_control_required"
        );
        assert_eq!(device.inputs.load(Ordering::SeqCst), 0);
        assert_eq!(
            second
                .release_control(
                    &sessions,
                    &session,
                    ReleaseBody {
                        view_id: view.clone(),
                        control_id: control.clone(),
                        generation: epoch,
                    },
                )
                .unwrap_err(),
            "computer_control_required"
        );
        // A takeover on the reconnected device continues the epoch sequence.
        let fresh = second
            .start_view(
                &sessions,
                &session,
                ViewBody {
                    consent: true,
                    device_id: device.device.id.clone(),
                },
            )
            .unwrap()["viewId"]
            .as_str()
            .unwrap()
            .to_owned();
        let taken = second
            .acquire(
                &sessions,
                &session,
                ControlBody {
                    view_id: fresh.clone(),
                    device_id: device.device.id.clone(),
                    consent: true,
                    ttl_seconds: 30,
                },
            )
            .unwrap();
        assert_eq!(taken["generation"].as_u64().unwrap(), epoch + 1);
        // And the lease from before the reconnect is stale, not merely unknown.
        let body = InputBody {
            view_id: view.clone(),
            ..click(&control, epoch, 2)
        };
        assert_eq!(
            second.input(&sessions, &session, body).unwrap_err(),
            "computer_input_stale"
        );
        assert_eq!(device.inputs.load(Ordering::SeqCst), 0);

        // The same connection generation resolves to the same device instance: a
        // concurrent duplicate lookup must not drop a live lease.
        assert!(Arc::ptr_eq(
            &second,
            &computers.install("node-1", 8, provider).unwrap()
        ));
    }

    #[test]
    fn node_codes_map_to_failures_that_never_claim_success() {
        // An unknown or OK code is never folded into success.
        assert_eq!(failure(ComputerCodeV1::Ok), Failure::Failed);
        assert_eq!(failure(ComputerCodeV1::Busy), Failure::Failed);
        assert_eq!(failure(ComputerCodeV1::Cancelled), Failure::Failed);
        assert_eq!(failure(ComputerCodeV1::Timeout), Failure::Timeout);
        assert_eq!(failure(ComputerCodeV1::SessionLocked), Failure::SessionLocked);
        assert_eq!(
            failure(ComputerCodeV1::BackendUnavailable),
            Failure::BackendUnavailable
        );
        assert_eq!(
            failure(ComputerCodeV1::InputUnsupported),
            Failure::Unsupported
        );
        assert_eq!(
            failure(ComputerCodeV1::ReleaseUnconfirmed),
            Failure::Unconfirmed
        );
    }

    #[test]
    fn a_release_is_confirmed_or_it_is_unconfirmed_never_unknown_success() {
        // The only code a caller may read as "physically released".
        assert_eq!(
            Failure::Unconfirmed.release_code(),
            "computer_release_unconfirmed"
        );
        assert_eq!(Failure::Unavailable.release_code(), "computer_unsupported");
        // A refused text is a clean refusal; an attempted-but-unconfirmed input
        // is reported as unknown, so the two can never be confused.
        assert_eq!(
            Failure::Unsupported.input_code(),
            "computer_input_unsupported"
        );
        assert_eq!(Failure::Unconfirmed.input_code(), "computer_input_unknown");
        assert_eq!(Failure::Timeout.input_code(), "computer_input_unknown");
    }

    #[test]
    fn input_mapping_keeps_the_closed_shape_and_drops_no_field() {
        assert_eq!(
            wire_input(&InputCommand::Pointer {
                x: -5,
                y: 7,
                button: Some(PointerButton::Left),
                action: PointerAction::Click,
            }),
            ComputerInputV1::Pointer {
                x: -5,
                y: 7,
                button: Some(ComputerButtonV1::Left),
                action: ComputerActionV1::Click,
            }
        );
        // A move carries no button, exactly as the Host gate allowed it.
        assert_eq!(
            wire_input(&InputCommand::Pointer {
                x: 0,
                y: 0,
                button: None,
                action: PointerAction::Move,
            }),
            ComputerInputV1::Pointer {
                x: 0,
                y: 0,
                button: None,
                action: ComputerActionV1::Move,
            }
        );
        assert_eq!(
            wire_input(&InputCommand::Wheel {
                x: 1,
                y: 2,
                delta: -3,
            }),
            ComputerInputV1::Wheel {
                x: 1,
                y: 2,
                delta: -3,
            }
        );
        // `pageup`/`pagedown` keep the helper's own spelling.
        assert_eq!(
            wire_input(&InputCommand::Key {
                key: KeyName::PageUp,
            }),
            ComputerInputV1::Key {
                key: ComputerKeyV1::Pageup,
            }
        );
        assert_eq!(ComputerKeyV1::Pageup.wire(), "pageup");
        assert_eq!(
            wire_input(&InputCommand::Text {
                text: "hi".to_owned(),
            }),
            ComputerInputV1::Text {
                text: "hi".to_owned(),
            }
        );
    }
}
