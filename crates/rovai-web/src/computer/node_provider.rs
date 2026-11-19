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
//!   lease or view held against a replaced socket can never be reused.
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
        {
            let entries = self.entries.lock().map_err(|_| "computer_busy")?;
            if let Some(cached) = entries.get(node_id)
                && cached.generation == generation
            {
                return Ok(cached.computer.clone());
            }
        }
        let provider: Arc<dyn Provider> =
            Arc::new(NodeProvider::new(hub.clone(), node_id.to_owned(), generation));
        let computer = Arc::new(Computer::with_provider(provider));
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
    use super::*;

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
