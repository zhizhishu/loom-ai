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
//!   it. A reconnect retires the entry and drops the old gate with it, so a
//!   lease or view held against a replaced socket can never be reused — and a
//!   caller that still holds the retired instance fails closed instead of
//!   reaching the new connection. The epoch is the one thing carried over: leases
//!   are discarded, but the counter only ever moves forward, so an epoch issued
//!   before the reconnect can never be issued again after it.
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
    sync::{Arc, Mutex, atomic::AtomicU64},
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
    /// One critical section owns the whole transition, so it is a single boundary
    /// rather than three steps that can interleave:
    ///
    /// * A late arrival from an already replaced generation is refused instead of
    ///   installed. Overwriting a newer entry with an older one would move the
    ///   epoch backwards and let a number be issued twice.
    /// * The replaced device is retired before the replacement is built, and the
    ///   replacement keeps the *same* epoch allocator rather than a sampled value.
    ///   Retirement is the fence: its lease, views and sequence are dropped with
    ///   the socket, and every later operation on the instance — including one a
    ///   caller still holds an `Arc` to — fails closed, so nothing can be sent on
    ///   the new connection under an epoch issued for the old one. Sharing the
    ///   allocator is what keeps the epoch unique when retirement cannot take the
    ///   gate (an input or a takeover is still inside it): a takeover parked there
    ///   re-checks its retirement and refuses, and any advance it still makes is
    ///   visible to the replacement.
    /// * The epoch is allocated by that counter, never read from a gate, so an
    ///   input that is still running cannot stall the reconnect.
    ///
    /// A concurrent caller that already installed this generation wins, under the
    /// same lock, because replacing it would drop a live lease.
    fn install(
        &self,
        node_id: &str,
        generation: u64,
        provider: Arc<dyn Provider>,
    ) -> Result<Arc<Computer>, &'static str> {
        let mut entries = self.entries.lock().map_err(|_| "computer_busy")?;
        if let Some(cached) = entries.get(node_id) {
            if cached.generation == generation {
                return Ok(cached.computer.clone());
            }
            if cached.generation > generation {
                // A newer connection already owns this node; this call is a late
                // arrival from the socket that connection replaced.
                return Err("node_connection_changed");
            }
        }
        let epoch = match entries.get(node_id) {
            Some(cached) => cached.computer.retire(),
            None => Arc::new(AtomicU64::new(0)),
        };
        let computer = Arc::new(Computer::with_provider(provider, epoch));
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
    /// The connection generation this provider was built against, and the one
    /// every operation it sends is fenced to. A reply from any other generation
    /// is discarded by the transport, and a request is refused when the node has
    /// reconnected since — checked inside the registration critical section, not
    /// merely before it.
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
        // Cheap early refusal: the socket this provider was built for is already
        // gone, so nothing is attempted at all. This check is *not* the fence —
        // a reconnect can land right after it — which is why the binding
        // generation is also handed to the transport, where it is compared in the
        // same critical section that registers the waiter and is then used to
        // send. Together those two checks mean an operation built for a replaced
        // connection is never registered, never sent and never answered.
        let handle = tokio::runtime::Handle::try_current().map_err(|_| "computer_busy")?;
        let current = handle.block_on(self.hub.computer_generation(&self.node_id));
        if current != Some(self.generation) {
            return Err("node_connection_changed");
        }
        let request = ComputerRequestV1 {
            version: COMPUTER_VERSION,
            request_id: uuid::Uuid::new_v4().simple().to_string(),
            op,
        };
        request_blocking(
            &self.hub,
            &self.node_id,
            self.generation,
            request,
            COMPUTER_DEADLINE,
        )
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
            .map_err(input_transport_failure)?;
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

/// Map a transport failure on the input path to PiBot's two cases.
///
/// `computer_input_unconfirmed` and `computer_timeout` are only returned after
/// the frame was queued: the node may already have injected the input. Every
/// other error is admission/send failure, which proves nothing left the Host.
fn input_transport_failure(code: &'static str) -> Failure {
    match code {
        "computer_input_unconfirmed" | "computer_timeout" => Failure::Unconfirmed,
        _ => Failure::NotSent,
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
    use super::super::{
        AcquirePark, ControlBody, EventBody, EventKind, InputBody, ReleaseBody, ViewBody,
    };
    use super::*;
    use crate::auth::{Session, Sessions};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

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

    fn open_view(
        computer: &Arc<Computer>,
        sessions: &Sessions,
        session: &Arc<Session>,
        device: &DeviceInfo,
    ) -> String {
        computer
            .start_view(
                sessions,
                session,
                ViewBody {
                    consent: true,
                    device_id: device.id.clone(),
                },
            )
            .unwrap()["viewId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// One takeover on `view`, returning the lease identity and its epoch.
    fn take(
        computer: &Arc<Computer>,
        sessions: &Sessions,
        session: &Arc<Session>,
        device: &DeviceInfo,
        view: &str,
    ) -> (String, u64) {
        let lease = computer
            .acquire(
                sessions,
                session,
                ControlBody {
                    view_id: view.to_owned(),
                    device_id: device.id.clone(),
                    consent: true,
                    ttl_seconds: 30,
                },
            )
            .unwrap();
        (
            lease["controlId"].as_str().unwrap().to_owned(),
            lease["generation"].as_u64().unwrap(),
        )
    }

    fn fixture_parts() -> (Arc<Sessions>, Arc<Session>) {
        let token = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&token).unwrap());
        let (_, session) = sessions
            .login(&token)
            .ok()
            .expect("browser session must be issued");
        (sessions, session)
    }

    /// A desktop whose input only returns when the test lets it, so the gate can
    /// be held open on purpose while a reconnect is attempted.
    struct BlockingDevice {
        device: DeviceInfo,
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        inputs: AtomicU64,
    }

    impl Provider for BlockingDevice {
        fn info(&self) -> Result<DeviceInfo, Failure> {
            Ok(self.device.clone())
        }
        fn capture(&self, _max_width: u32, _max_height: u32) -> Result<Frame, Failure> {
            Err(Failure::Failed)
        }
        fn input(&self, _command: &InputCommand) -> Result<(), Failure> {
            // Announce that the gate is now held by this input, then wait for the
            // test to let go. Nothing is counted until the input really completes.
            let _ = self.entered.send(());
            let _ = self.release.lock().unwrap().recv();
            self.inputs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn release(&self) -> Result<(), Failure> {
            Ok(())
        }
    }

    #[test]
    fn a_reconnect_retires_the_old_device_and_never_reissues_an_epoch() {
        let (sessions, session) = fixture_parts();
        let device = Arc::new(FakeDevice::new());
        let provider: Arc<dyn Provider> = device.clone();
        let computers = NodeComputers::new();

        // The node advertises the transport on connection generation 7.
        let first = computers.install("node-1", 7, provider.clone()).unwrap();
        let view = open_view(&first, &sessions, &session, &device.device);
        let (control, epoch) = take(&first, &sessions, &session, &device.device, &view);
        assert_eq!(epoch, 1);
        assert_eq!(first.epoch(), epoch);

        // The node reconnects: generation 8 replaces the device.
        let second = computers.install("node-1", 8, provider.clone()).unwrap();
        assert!(
            !Arc::ptr_eq(&first, &second),
            "a reconnect must replace the device, not reuse it"
        );
        // The fence is the retirement: a caller that still holds the replaced
        // instance cannot reach the provider at all, so nothing it does can be
        // addressed to the connection that replaced it.
        let late = InputBody {
            view_id: view.clone(),
            ..click(&control, epoch, 1)
        };
        assert_eq!(
            first.input(&sessions, &session, late).unwrap_err(),
            "computer_unavailable",
            "an input on the replaced instance must fail closed"
        );
        assert_eq!(
            first
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
            "computer_unavailable",
            "the replaced instance must not hand back a lease either"
        );
        assert_eq!(
            first
                .start_view(
                    &sessions,
                    &session,
                    ViewBody {
                        consent: true,
                        device_id: device.device.id.clone(),
                    },
                )
                .unwrap_err(),
            "computer_unavailable",
            "the replaced instance must not open a view either"
        );
        assert_eq!(
            device.inputs.load(Ordering::SeqCst),
            0,
            "the replaced instance reached the device after the reconnect"
        );

        // The lease was live, so retiring the replaced device revoked it and
        // published that advance: the replacement starts strictly above the epoch
        // the old socket had issued.
        assert_eq!(
            second.epoch(),
            epoch + 1,
            "the replacement must never restart below an epoch that was issued"
        );
        assert_eq!(first.epoch(), epoch + 1);

        // The replacement holds no lease and no view: the operation the old
        // connection admitted is refused instead of being replayed. Its epoch is
        // below the inherited counter, so it is reported as stale rather than
        // being mistaken for a missing lease on the new device.
        let body = InputBody {
            view_id: view.clone(),
            ..click(&control, epoch, 2)
        };
        assert_eq!(
            second.input(&sessions, &session, body).unwrap_err(),
            "computer_input_stale"
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
        let fresh = open_view(&second, &sessions, &session, &device.device);
        let (fresh_control, taken) = take(&second, &sessions, &session, &device.device, &fresh);
        assert_eq!(taken, epoch + 2, "the reconnect must not reuse an epoch");
        // And the lease from before the reconnect is stale, not merely unknown.
        let body = InputBody {
            view_id: view.clone(),
            ..click(&control, epoch, 3)
        };
        assert_eq!(
            second.input(&sessions, &session, body).unwrap_err(),
            "computer_input_stale"
        );
        assert_eq!(device.inputs.load(Ordering::SeqCst), 0);

        // Positive control: exactly one input reaches the device, and only for the
        // lease that was issued after the reconnect. Without this, the `0` above
        // would also pass if the fixture simply never delivered anything.
        let accepted = InputBody {
            view_id: fresh.clone(),
            ..click(&fresh_control, taken, 1)
        };
        assert!(second.input(&sessions, &session, accepted).is_ok());
        assert_eq!(device.inputs.load(Ordering::SeqCst), 1);

        // A late arrival from the replaced generation must be refused, not
        // installed: taking it would move the epoch backwards.
        let third = computers.install("node-1", 9, provider.clone()).unwrap();
        assert_eq!(third.epoch(), taken + 1);
        assert_eq!(
            computers.install("node-1", 8, provider.clone()).err(),
            Some("node_connection_changed"),
            "a late install from a replaced generation must be refused"
        );
        assert!(computers.current("node-1", 8).unwrap().is_none());
        assert!(Arc::ptr_eq(
            &third,
            &computers.install("node-1", 9, provider).unwrap()
        ));
        // The refused late install left the newest device in place and usable.
        assert_eq!(third.epoch(), taken + 1);
    }

    /// A reconnect must never wait on a gate that an input is holding: the epoch
    /// it inherits is a published counter, and retirement is a non-blocking fence.
    /// The budget below is far above any correct cost (both reads are a load and a
    /// `try_lock`), so a regression to the old "poll the gate for up to 7 s" path
    /// fails here instead of stalling a runtime thread in production.
    #[tokio::test(flavor = "current_thread")]
    async fn a_reconnect_never_waits_on_a_gate_an_input_is_holding() {
        let (sessions, session) = fixture_parts();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let device = Arc::new(BlockingDevice {
            device: FakeDevice::new().device,
            entered: entered_tx,
            release: Mutex::new(release_rx),
            inputs: AtomicU64::new(0),
        });
        let provider: Arc<dyn Provider> = device.clone();
        let computers = NodeComputers::new();
        let first = computers.install("node-1", 7, provider.clone()).unwrap();
        let view = open_view(&first, &sessions, &session, &device.device);
        let (control, epoch) = take(&first, &sessions, &session, &device.device, &view);

        // An input admitted on generation 7 now holds the gate while its backend
        // blocks, exactly like a real desktop that is slow to inject.
        let held = {
            let computer = first.clone();
            let sessions = sessions.clone();
            let session = session.clone();
            let body = InputBody {
                view_id: view.clone(),
                ..click(&control, epoch, 1)
            };
            std::thread::spawn(move || computer.input(&sessions, &session, body))
        };
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the input never reached the device, so the gate is not held");

        // Reading the epoch is a counter load.
        assert_eq!(first.epoch(), epoch);

        // The whole transition runs inline on this single-threaded runtime, exactly
        // as `for_node` runs it, and must not wait: it is a counter load plus a
        // `try_lock`, while the old "poll the gate" read would burn the gate's own
        // 7 s deadline here. The budget is orders of magnitude above the correct
        // cost and well below that deadline, so a regression fails instead of
        // stalling an executor thread in production.
        let progressed = Arc::new(AtomicBool::new(false));
        let watcher = tokio::spawn({
            let progressed = progressed.clone();
            async move { progressed.store(true, Ordering::SeqCst) }
        });
        let started = std::time::Instant::now();
        let installed = computers
            .install("node-1", 8, provider)
            .expect("a reconnect must install while an input holds the replaced gate");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the reconnect waited on the gate an input was holding"
        );
        // An unrelated task on the same runtime still got to run around it.
        tokio::task::yield_now().await;
        watcher.await.unwrap();
        assert!(progressed.load(Ordering::SeqCst));
        // A revocation it could not perform under the busy gate is not invented:
        // the replacement starts at the epoch the old socket published, and its
        // first takeover moves past it.
        assert_eq!(installed.epoch(), epoch);
        let fresh = open_view(&installed, &sessions, &session, &device.device);
        let (_, taken) = take(&installed, &sessions, &session, &device.device, &fresh);
        assert_eq!(taken, epoch + 1);

        // The pre-admitted input finished against the device it was admitted for;
        // the replaced instance is fenced from then on.
        release_tx.send(()).unwrap();
        assert!(
            held.join().unwrap().is_ok(),
            "an input admitted before the reconnect must still finish"
        );
        assert_eq!(device.inputs.load(Ordering::SeqCst), 1);
        let late = InputBody {
            view_id: view.clone(),
            ..click(&control, epoch, 2)
        };
        assert_eq!(
            first.input(&sessions, &session, late).unwrap_err(),
            "computer_unavailable"
        );
        assert_eq!(
            device.inputs.load(Ordering::SeqCst),
            1,
            "the retired device delivered an input after the reconnect"
        );
    }

    /// Two reconnects installing different generations of the same node race on
    /// purpose. Whatever the interleaving, the newest generation must end up
    /// installed, the epoch must never move backwards, and the device that lost
    /// must be fenced rather than left able to send on the surviving connection.
    /// The rounds are what expose the second interleaving; each round is otherwise
    /// a plain install against a shared cache.
    #[test]
    fn racing_reconnects_never_move_the_epoch_backwards() {
        let (sessions, session) = fixture_parts();
        let device = Arc::new(FakeDevice::new());
        let provider: Arc<dyn Provider> = device.clone();
        let computers = Arc::new(NodeComputers::new());
        for round in 0..32 {
            let node = format!("node-{round}");
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let older = {
                let (computers, provider, barrier, node) = (
                    computers.clone(),
                    provider.clone(),
                    barrier.clone(),
                    node.clone(),
                );
                std::thread::spawn(move || {
                    barrier.wait();
                    computers.install(&node, 8, provider)
                })
            };
            let newer = {
                let (computers, provider, barrier, node) = (
                    computers.clone(),
                    provider.clone(),
                    barrier.clone(),
                    node.clone(),
                );
                std::thread::spawn(move || {
                    barrier.wait();
                    computers.install(&node, 9, provider)
                })
            };
            let older = older.join().unwrap();
            let newer = newer
                .join()
                .unwrap()
                .expect("the newer connection must always end up installed");
            // The newest generation owns the node and the replaced one owns nothing;
            // a late install of 8 never displaces 9 (it is refused), and an install
            // of 9 after 8 replaces and retires 8.
            assert!(
                Arc::ptr_eq(&newer, &computers.current(&node, 9).unwrap().unwrap()),
                "the newest connection lost the cache"
            );
            assert!(
                computers.current(&node, 8).unwrap().is_none(),
                "a replaced generation stayed installed"
            );
            if let Ok(older) = older {
                assert!(
                    newer.epoch() >= older.epoch(),
                    "the epoch moved backwards across a racing reconnect"
                );
                // The device that lost the race is fenced: it can neither open a
                // view nor execute anything against the surviving connection.
                assert_eq!(
                    older
                        .start_view(
                            &sessions,
                            &session,
                            ViewBody {
                                consent: true,
                                device_id: device.device.id.clone(),
                            },
                        )
                        .unwrap_err(),
                    "computer_unavailable"
                );
                assert_eq!(
                    device.inputs.load(Ordering::SeqCst),
                    0,
                    "a replaced device reached the backend"
                );
            }
        }
    }

    /// The exact interleaving the review called out: a takeover of the replaced
    /// device is already inside its gate, so retirement cannot take that gate and
    /// cannot advance the epoch behind it. The takeover must be refused instead of
    /// handing out a number the replacement would hand out again — and because both
    /// devices allocate from one counter, even an advance it slipped past its own
    /// refusal could not repeat the replacement's epoch.
    #[test]
    fn a_takeover_holding_the_gate_cannot_reissue_the_replacement_epoch() {
        let (sessions, session) = fixture_parts();
        let device = Arc::new(FakeDevice::new());
        let provider: Arc<dyn Provider> = device.clone();
        let computers = NodeComputers::new();
        let first = computers.install("node-1", 7, provider.clone()).unwrap();
        let view = open_view(&first, &sessions, &session, &device.device);
        let (_, epoch) = take(&first, &sessions, &session, &device.device, &view);
        assert_eq!(epoch, 1);

        // Park a second takeover of the replaced device inside its gate, exactly
        // where it allocates its epoch.
        let (entered_tx, entered_rx) = mpsc::channel();
        let (proceed_tx, proceed_rx) = mpsc::channel();
        first.park_next_acquire(AcquirePark::BeforeRetirementCheck, entered_tx, proceed_rx);
        let parked = {
            let (computer, sessions, session, view, device_id) = (
                first.clone(),
                sessions.clone(),
                session.clone(),
                view.clone(),
                device.device.id.clone(),
            );
            std::thread::spawn(move || {
                computer.acquire(
                    &sessions,
                    &session,
                    ControlBody {
                        view_id: view,
                        device_id,
                        consent: true,
                        ttl_seconds: 30,
                    },
                )
            })
        };
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the parked takeover never took the replaced gate");

        // The reconnect now arrives while that gate is held: `retire` cannot lock
        // it, so it inherits the published epoch instead of inventing an advance.
        let second = computers.install("node-1", 8, provider.clone()).unwrap();
        assert_eq!(
            second.epoch(),
            epoch,
            "the reconnect must inherit the epoch the old socket published"
        );

        // The parked takeover is fenced closed; it issues nothing.
        proceed_tx.send(()).unwrap();
        assert_eq!(
            parked.join().unwrap().unwrap_err(),
            "computer_unavailable",
            "a takeover that held the replaced gate must not issue an epoch"
        );

        // The replacement's first takeover is the next epoch, not a repeat, and
        // both devices read that from the same allocator.
        let fresh = open_view(&second, &sessions, &session, &device.device);
        let (fresh_control, next) = take(&second, &sessions, &session, &device.device, &fresh);
        assert_eq!(next, epoch + 1);
        assert_eq!(second.epoch(), next);
        assert_eq!(
            first.epoch(),
            next,
            "the replaced device must observe the epoch the replacement allocated"
        );

        // Nothing was delivered by the fenced device, and the live one still works.
        assert_eq!(device.inputs.load(Ordering::SeqCst), 0);
        let accepted = InputBody {
            view_id: fresh.clone(),
            ..click(&fresh_control, next, 1)
        };
        assert!(second.input(&sessions, &session, accepted).is_ok());
        assert_eq!(device.inputs.load(Ordering::SeqCst), 1);
    }

    /// The second half of the same window: a takeover that already passed its
    /// retirement re-check, parked immediately before it allocates. Retirement cannot
    /// take the gate here either, so the epoch it hands to the replacement is the
    /// published one — and the epoch the parked takeover then allocates must be a
    /// number the replacement can never issue again. Only a shared allocator gives
    /// that; a copied counter would let both devices issue the same value.
    #[test]
    fn an_epoch_allocated_while_the_gate_was_held_is_never_issued_twice() {
        let (sessions, session) = fixture_parts();
        let device = Arc::new(FakeDevice::new());
        let provider: Arc<dyn Provider> = device.clone();
        let computers = NodeComputers::new();
        let first = computers.install("node-1", 7, provider.clone()).unwrap();
        let view = open_view(&first, &sessions, &session, &device.device);
        let (_, epoch) = take(&first, &sessions, &session, &device.device, &view);
        assert_eq!(epoch, 1);

        let (entered_tx, entered_rx) = mpsc::channel();
        let (proceed_tx, proceed_rx) = mpsc::channel();
        first.park_next_acquire(AcquirePark::BeforeAllocation, entered_tx, proceed_rx);
        let parked = {
            let (computer, sessions, session, view, device_id) = (
                first.clone(),
                sessions.clone(),
                session.clone(),
                view.clone(),
                device.device.id.clone(),
            );
            std::thread::spawn(move || {
                computer.acquire(
                    &sessions,
                    &session,
                    ControlBody {
                        view_id: view,
                        device_id,
                        consent: true,
                        ttl_seconds: 30,
                    },
                )
            })
        };
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the parked takeover never reached its allocation");

        // The reconnect arrives with that gate held: it inherits the published
        // epoch and the replacement issues the next one.
        let second = computers.install("node-1", 8, provider.clone()).unwrap();
        assert_eq!(second.epoch(), epoch);
        let fresh = open_view(&second, &sessions, &session, &device.device);
        let (fresh_control, taken) = take(&second, &sessions, &session, &device.device, &fresh);
        assert_eq!(taken, epoch + 1);

        // Let the parked takeover allocate. It consumes the next epoch and is then
        // refused, because the device it belongs to is already fenced.
        proceed_tx.send(()).unwrap();
        assert_eq!(
            parked.join().unwrap().unwrap_err(),
            "computer_unavailable",
            "a takeover that outlived its device must not hand out a lease"
        );

        // Both devices see the same allocator, so the consumed number is burned:
        // the replacement's next takeover is strictly above what it already issued.
        assert_eq!(second.epoch(), taken + 1);
        assert_eq!(first.epoch(), taken + 1);
        let left = second
            .release_control(
                &sessions,
                &session,
                ReleaseBody {
                    view_id: fresh.clone(),
                    control_id: fresh_control,
                    generation: taken,
                },
            )
            .unwrap();
        let after_handback = left["generation"].as_u64().unwrap();
        let (_, retaken) = take(&second, &sessions, &session, &device.device, &fresh);
        assert_eq!(retaken, after_handback + 1);
        assert!(
            retaken > taken,
            "an epoch was issued twice across a held gate"
        );
        // Nothing was delivered while the device was fenced.
        assert_eq!(device.inputs.load(Ordering::SeqCst), 0);
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
        assert_eq!(Failure::NotSent.input_code(), "computer_input_not_sent");
    }

    #[test]
    fn input_transport_failures_keep_not_sent_separate_from_unconfirmed() {
        // Admission/send failures never put a frame on the node.
        for code in [
            "node_offline",
            "node_connection_changed",
            "computer_version_unsupported",
            "computer_busy",
            "node_backpressure",
            "token_revoked",
        ] {
            assert_eq!(input_transport_failure(code), Failure::NotSent, "{code}");
        }
        // These two are returned only after the request was queued.
        assert_eq!(
            input_transport_failure("computer_input_unconfirmed"),
            Failure::Unconfirmed
        );
        assert_eq!(
            input_transport_failure("computer_timeout"),
            Failure::Unconfirmed
        );
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
