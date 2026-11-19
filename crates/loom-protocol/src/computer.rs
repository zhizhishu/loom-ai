//! Computer transport v1: closed operations for driving a paired Node's desktop.
//!
//! Scope is the wire contract only. There is no program, no path, no argv, no
//! environment, no URL and no shell field anywhere in these types, so a paired
//! node token can never be turned into a generic process or file API. Identity
//! is not carried here at all: the authenticated node socket plus the current
//! connection generation is what makes a request attributable, exactly as in
//! `workspace_rpc`. Serde success is never authorization.
//!
//! The node owns exactly one thing here: its own physical device. Session
//! ownership, view lifetime, control leases and consent are Host concerns and
//! deliberately absent from this module, so there is no second scheduler and no
//! duplicated lease state to desynchronize.
//!
//! Frame bytes never travel inside a reply. A capture is a
//! [`ComputerFrameHeaderV1`] followed by [`ComputerFrameChunkV1`] frames, so one
//! chunk always stays far below the node channel's 2 MiB frame ceiling. The
//! chunk bounds below are owned here and must not be relaxed to fit a bigger
//! screenshot.

use serde::{Deserialize, Serialize};

/// Wire version this module implements. Checked before anything else.
pub const COMPUTER_VERSION: u32 = 1;

/// Maximum raw bytes in one frame chunk. base64 of this is 1_398_104 bytes,
/// which leaves ample room under the node channel's 2 MiB frame ceiling.
pub const MAX_CHUNK_BYTES: u32 = 1_048_576;

/// Maximum raw PNG bytes for one capture. Matches the Host's own frame bound.
pub const MAX_FRAME_BYTES: u32 = 4 * 1024 * 1024;

/// Maximum capture dimension on either axis.
pub const MAX_DIMENSION: u32 = 4096;

/// Longest request id, counted in bytes.
pub const MAX_ID_BYTES: usize = 80;

/// Longest text payload, in codepoints.
pub const MAX_TEXT_CODEPOINTS: usize = 2048;

/// Largest wheel delta a single event may carry.
pub const MAX_WHEEL: i32 = 1000;

/// Closed refusal/result set. No variant carries caller data, so nothing here
/// can echo a coordinate or captured pixels into a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputerCodeV1 {
    Ok,
    UnsupportedVersion,
    InvalidRequest,
    Unsupported,
    DeviceUnavailable,
    Busy,
    Timeout,
    InputFailed,
    InputUnsupported,
    CaptureFailed,
    EncoderUnavailable,
    BackendUnavailable,
    SessionLocked,
    ReleaseUnconfirmed,
    Cancelled,
}

impl ComputerCodeV1 {
    /// Stable diagnostic spelling. Contains no caller-supplied text.
    pub fn code(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::UnsupportedVersion => "computer_unsupported_version",
            Self::InvalidRequest => "computer_invalid_request",
            Self::Unsupported => "computer_unsupported",
            Self::DeviceUnavailable => "computer_device_unavailable",
            Self::Busy => "computer_busy",
            Self::Timeout => "computer_helper_timeout",
            Self::InputFailed => "computer_input_failed",
            Self::InputUnsupported => "computer_input_unsupported",
            Self::CaptureFailed => "computer_capture_failed",
            Self::EncoderUnavailable => "computer_encoder_unavailable",
            Self::BackendUnavailable => "computer_backend_unavailable",
            Self::SessionLocked => "computer_session_locked",
            Self::ReleaseUnconfirmed => "computer_release_unconfirmed",
            Self::Cancelled => "computer_cancelled",
        }
    }

    pub fn is_ok(self) -> bool {
        matches!(self, Self::Ok)
    }
}

impl std::fmt::Display for ComputerCodeV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ComputerCodeV1 {}

// ---------------------------------------------------------------------------
// Geometry and device identity
// ---------------------------------------------------------------------------

/// Signed screen rectangle. Multi-monitor layouts legitimately use negative
/// origins, so client coordinates are checked against this rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerBoundsV1 {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl ComputerBoundsV1 {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        let dx = i64::from(x) - i64::from(self.x);
        let dy = i64::from(y) - i64::from(self.y);
        dx >= 0 && dy >= 0 && dx < i64::from(self.width) && dy < i64::from(self.height)
    }
}

/// Metadata only. This carries no pixels and never authorizes input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerDeviceV1 {
    pub device_id: String,
    pub platform: String,
    pub bounds: ComputerBoundsV1,
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerButtonV1 {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerActionV1 {
    Click,
    Move,
}

/// Closed key whitelist. Every key is a tap, so a dropped client can never
/// leave a key held down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerKeyV1 {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    Pageup,
    Pagedown,
    Shift,
    Ctrl,
    Alt,
    Meta,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
}

impl ComputerKeyV1 {
    /// The helper's own spelling of this key.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Enter => "enter",
            Self::Tab => "tab",
            Self::Escape => "escape",
            Self::Backspace => "backspace",
            Self::Delete => "delete",
            Self::Space => "space",
            Self::Left => "left",
            Self::Right => "right",
            Self::Up => "up",
            Self::Down => "down",
            Self::Home => "home",
            Self::End => "end",
            Self::Pageup => "pageup",
            Self::Pagedown => "pagedown",
            Self::Shift => "shift",
            Self::Ctrl => "ctrl",
            Self::Alt => "alt",
            Self::Meta => "meta",
            Self::F1 => "f1",
            Self::F2 => "f2",
            Self::F3 => "f3",
            Self::F4 => "f4",
            Self::F5 => "f5",
            Self::F6 => "f6",
            Self::F7 => "f7",
            Self::F8 => "f8",
            Self::F9 => "f9",
            Self::F10 => "f10",
            Self::F11 => "f11",
            Self::F12 => "f12",
        }
    }
}

/// The only four shapes a node may be asked to inject. There is deliberately no
/// command string, no clipboard, no file and no URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ComputerInputV1 {
    Pointer {
        x: i32,
        y: i32,
        #[serde(default)]
        button: Option<ComputerButtonV1>,
        action: ComputerActionV1,
    },
    Wheel {
        x: i32,
        y: i32,
        delta: i32,
    },
    Key {
        key: ComputerKeyV1,
    },
    Text {
        text: String,
    },
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// A tagged operation. Tag key is `kind`, variant fields are camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ComputerOpV1 {
    /// Metadata probe. Never captures and never injects input.
    ///
    /// The empty braces are load-bearing. As a *unit* variant, serde's
    /// internally tagged representation accepts the tag and silently drops every
    /// other key, so `{"kind":"info","program":"/bin/sh"}` would decode as
    /// `Info`. As an empty struct variant the variant content is deserialized by
    /// the struct field visitor, where `deny_unknown_fields` rejects each extra
    /// key. The valid wire is unchanged: `{"kind":"info"}`.
    Info {},
    Frame {
        max_width: u32,
        max_height: u32,
    },
    Input {
        input: ComputerInputV1,
    },
    /// Drain and release. The node replies `Ok` only after every in-flight input
    /// it owns has finished, which is the only proof of physical release.
    ///
    /// Empty struct for the same reason as [`Self::Info`].
    Release {},
}

/// The external, identity-free request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerRequestV1 {
    pub version: u32,
    pub request_id: String,
    pub op: ComputerOpV1,
}

impl ComputerRequestV1 {
    /// Codes: `UnsupportedVersion`; `InvalidRequest` for any id, dimension,
    /// coordinate, wheel or text violation. The platform-specific text rule is
    /// [`platform_accepts_text`] and runs where the target platform is known.
    pub fn validate(&self) -> Result<(), ComputerCodeV1> {
        if self.version != COMPUTER_VERSION {
            return Err(ComputerCodeV1::UnsupportedVersion);
        }
        validate_id(&self.request_id)?;
        match &self.op {
            ComputerOpV1::Info {} | ComputerOpV1::Release {} => Ok(()),
            ComputerOpV1::Frame {
                max_width,
                max_height,
            } => {
                if !(1..=MAX_DIMENSION).contains(max_width)
                    || !(1..=MAX_DIMENSION).contains(max_height)
                {
                    return Err(ComputerCodeV1::InvalidRequest);
                }
                Ok(())
            }
            ComputerOpV1::Input { input } => validate_input(input),
        }
    }
}

fn validate_input(input: &ComputerInputV1) -> Result<(), ComputerCodeV1> {
    match input {
        ComputerInputV1::Pointer {
            button, action, ..
        } => match (action, button) {
            (ComputerActionV1::Move, None) | (ComputerActionV1::Click, Some(_)) => Ok(()),
            _ => Err(ComputerCodeV1::InvalidRequest),
        },
        ComputerInputV1::Wheel { delta, .. } => {
            if *delta == 0 || delta.unsigned_abs() > MAX_WHEEL.unsigned_abs() {
                return Err(ComputerCodeV1::InvalidRequest);
            }
            Ok(())
        }
        ComputerInputV1::Key { .. } => Ok(()),
        ComputerInputV1::Text { text } => validate_text(text),
    }
}

fn validate_text(text: &str) -> Result<(), ComputerCodeV1> {
    if text.is_empty() {
        return Err(ComputerCodeV1::InvalidRequest);
    }
    let mut count = 0;
    for character in text.chars() {
        count += 1;
        if count > MAX_TEXT_CODEPOINTS
            || character.is_control()
            || character == '\u{fffd}'
            || u32::from(character) > 0xffff
        {
            return Err(ComputerCodeV1::InvalidRequest);
        }
    }
    Ok(())
}

/// Whether the named backend can truthfully inject this text.
///
/// The X11 path sends keysyms, so it can only reach the first 256 codepoints;
/// the Windows path sends UTF-16 pairs and covers the basic plane. A node whose
/// backend cannot encode the text must refuse *before* injecting anything, and
/// no platform may claim support it does not have.
pub fn platform_accepts_text(platform: &str, text: &str) -> Result<(), ComputerCodeV1> {
    validate_text(text)?;
    if is_linux_platform(platform) {
        for character in text.chars() {
            if u32::from(character) > 0xff {
                return Err(ComputerCodeV1::InputUnsupported);
            }
        }
        return Ok(());
    }
    if is_windows_platform(platform) {
        return Ok(());
    }
    Err(ComputerCodeV1::InputUnsupported)
}

pub fn is_linux_platform(platform: &str) -> bool {
    platform.starts_with("linux")
}

pub fn is_windows_platform(platform: &str) -> bool {
    platform.starts_with("windows")
}

/// A node may only report a backend this contract can reason about.
pub fn known_platform(platform: &str) -> bool {
    is_linux_platform(platform) || is_windows_platform(platform)
}

fn validate_id(value: &str) -> Result<(), ComputerCodeV1> {
    if value.is_empty() || value.len() > MAX_ID_BYTES {
        return Err(ComputerCodeV1::InvalidRequest);
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(ComputerCodeV1::InvalidRequest);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Replies and frame chunks
// ---------------------------------------------------------------------------

/// Header for one capture. The pixels follow in `chunk_count` chunk frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerFrameHeaderV1 {
    pub width: u32,
    pub height: u32,
    /// `scale * 1000`, so the wire stays integral and exactly comparable.
    pub scale_millis: u32,
    pub captured_at: u64,
    pub chunk_bytes: u32,
    pub chunk_count: u32,
    pub total_bytes: u32,
}

impl ComputerFrameHeaderV1 {
    /// Check a header against this module's bounds before any chunk is accepted.
    pub fn validate(&self) -> Result<(), ComputerCodeV1> {
        if self.width == 0
            || self.height == 0
            || self.width > MAX_DIMENSION
            || self.height > MAX_DIMENSION
            || self.chunk_bytes == 0
            || self.chunk_bytes > MAX_CHUNK_BYTES
            || self.total_bytes == 0
            || self.total_bytes > MAX_FRAME_BYTES
            || self.chunk_count == 0
            || u64::from(self.chunk_count) != chunk_count(self.total_bytes, self.chunk_bytes)?
        {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        Ok(())
    }

    pub fn scale(&self) -> f64 {
        f64::from(self.scale_millis) / 1000.0
    }
}

/// Number of chunks needed for `total_bytes` at `chunk_bytes` per chunk.
pub fn chunk_count(total_bytes: u32, chunk_bytes: u32) -> Result<u64, ComputerCodeV1> {
    if total_bytes == 0 || chunk_bytes == 0 {
        return Err(ComputerCodeV1::InvalidRequest);
    }
    Ok(u64::from(total_bytes).div_ceil(u64::from(chunk_bytes)))
}

/// Encoded length of one full chunk's payload. Used by the tests to prove a
/// chunk never approaches the node channel's 2 MiB frame ceiling.
pub fn encoded_chunk_bound() -> u64 {
    u64::from(MAX_CHUNK_BYTES).div_ceil(3) * 4
}

/// Result of one operation. `frame` is a header only; pixels arrive separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerReplyV1 {
    pub version: u32,
    pub request_id: String,
    pub code: ComputerCodeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<ComputerDeviceV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<ComputerFrameHeaderV1>,
}

impl ComputerReplyV1 {
    pub fn refusal(request_id: &str, code: ComputerCodeV1) -> Self {
        Self {
            version: COMPUTER_VERSION,
            request_id: request_id.to_owned(),
            code,
            device: None,
            frame: None,
        }
    }

    /// Check a reply against the request that asked for it.
    pub fn validate_for(&self, request: &ComputerRequestV1) -> Result<(), ComputerCodeV1> {
        if self.version != COMPUTER_VERSION {
            return Err(ComputerCodeV1::UnsupportedVersion);
        }
        if self.request_id != request.request_id {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        if let Some(header) = self.frame.as_ref() {
            header.validate()?;
        }
        if let Some(device) = self.device.as_ref() {
            if device.device_id.is_empty() || device.device_id.len() > 256 {
                return Err(ComputerCodeV1::InvalidRequest);
            }
            if !known_platform(&device.platform) {
                return Err(ComputerCodeV1::InputUnsupported);
            }
            if device.bounds.width == 0 || device.bounds.height == 0 {
                return Err(ComputerCodeV1::InvalidRequest);
            }
        }
        Ok(())
    }
}

/// One bounded slice of a capture. `seq` starts at 1 and is contiguous.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerFrameChunkV1 {
    pub version: u32,
    pub request_id: String,
    pub seq: u32,
    /// Standard padded base64 of at most [`MAX_CHUNK_BYTES`] raw bytes.
    pub data: String,
}

impl ComputerFrameChunkV1 {
    pub fn validate_for(&self, header: &ComputerFrameHeaderV1) -> Result<(), ComputerCodeV1> {
        if self.version != COMPUTER_VERSION || self.seq == 0 {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        if self.seq > header.chunk_count {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        // Encoded length is checked before decoding so an oversized payload is
        // refused without allocating it.
        let encoded_max = u64::from(header.chunk_bytes).div_ceil(3) * 4;
        if self.data.len() as u64 > encoded_max {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        Ok(())
    }
}

/// Pixels can be private. Debug is metadata only.
impl std::fmt::Debug for ComputerFrameChunkV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ComputerFrameChunkV1")
            .field("request_id", &self.request_id)
            .field("seq", &self.seq)
            .field("encoded_bytes", &self.data.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(op: ComputerOpV1) -> ComputerRequestV1 {
        ComputerRequestV1 {
            version: COMPUTER_VERSION,
            request_id: "req_1".to_owned(),
            op,
        }
    }

    fn with_unknown_field(json: &str) -> String {
        let mut text = json.to_string();
        assert_eq!(text.pop(), Some('}'));
        text.push_str(",\"unexpected\":1}");
        text
    }

    #[test]
    fn the_wire_schema_is_closed_and_has_no_program_path_or_environment() {
        let frame = request(ComputerOpV1::Frame {
            max_width: 1920,
            max_height: 1080,
        });
        let json = serde_json::to_string(&frame).expect("request serializes");
        for key in ["\"version\":1", "\"requestId\":\"req_1\"", "\"kind\":\"frame\""] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        assert_eq!(
            serde_json::from_str::<ComputerRequestV1>(&json).expect("round trip"),
            frame
        );
        assert!(
            serde_json::from_str::<ComputerRequestV1>(&with_unknown_field(&json)).is_err()
        );

        // A caller cannot smuggle a program, a path or an environment value:
        // there is no field for it and unknown fields are rejected.
        for smuggled in [
            r#"{"kind":"info","program":"/bin/sh"}"#,
            r#"{"kind":"info","path":"/etc/passwd"}"#,
            r#"{"kind":"info","env":[["A","B"]]}"#,
            r#"{"kind":"run","args":["-c","id"]}"#,
            r#"{"kind":"shell","command":"id"}"#,
        ] {
            assert!(serde_json::from_str::<ComputerOpV1>(smuggled).is_err(), "{smuggled}");
        }
        for smuggled in [
            r#"{"kind":"text","text":"a","file":"/tmp/x"}"#,
            r#"{"kind":"pointer","x":1,"y":1,"action":"click","button":"left","argv":["sh"]}"#,
        ] {
            assert!(serde_json::from_str::<ComputerInputV1>(smuggled).is_err(), "{smuggled}");
        }

        // Unknown versions and unknown codes are refused.
        let mut wrong = frame;
        wrong.version = 2;
        assert_eq!(wrong.validate(), Err(ComputerCodeV1::UnsupportedVersion));
        assert!(serde_json::from_str::<ComputerCodeV1>("\"screenshot\"").is_err());
        assert!(serde_json::from_str::<ComputerKeyV1>("\"printscreen\"").is_err());
    }

    #[test]
    fn request_bounds_cover_ids_dimensions_wheel_and_text() {
        let long = "a".repeat(MAX_ID_BYTES + 1);
        for (request_id, ok) in [("r", true), ("", false), ("a b", false), (long.as_str(), false)] {
            let mut ask = request(ComputerOpV1::Info {});
            ask.request_id = request_id.to_owned();
            assert_eq!(ask.validate().is_ok(), ok, "{request_id:?}");
        }
        for (width, ok) in [(0, false), (1, true), (MAX_DIMENSION, true), (MAX_DIMENSION + 1, false)] {
            let op = ComputerOpV1::Frame {
                max_width: width,
                max_height: 1,
            };
            assert_eq!(request(op).validate().is_ok(), ok, "{width}");
        }
        for (delta, ok) in [(0, false), (1, true), (-MAX_WHEEL, true), (MAX_WHEEL + 1, false)] {
            let op = ComputerOpV1::Input {
                input: ComputerInputV1::Wheel { x: 0, y: 0, delta },
            };
            assert_eq!(request(op).validate().is_ok(), ok, "{delta}");
        }
        // A move carries no button; a click requires one.
        for (action, button, ok) in [
            (ComputerActionV1::Move, None, true),
            (ComputerActionV1::Move, Some(ComputerButtonV1::Left), false),
            (ComputerActionV1::Click, None, false),
            (ComputerActionV1::Click, Some(ComputerButtonV1::Left), true),
        ] {
            let op = ComputerOpV1::Input {
                input: ComputerInputV1::Pointer { x: 0, y: 0, button, action },
            };
            assert_eq!(request(op).validate().is_ok(), ok);
        }
        // Text: bounded, no control characters, no supplementary plane.
        for (text, ok) in [
            ("hello", true),
            ("", false),
            ("a\u{0}b", false),
            ("\u{1f600}", false),
        ] {
            let op = ComputerOpV1::Input {
                input: ComputerInputV1::Text { text: text.to_owned() },
            };
            assert_eq!(request(op).validate().is_ok(), ok, "{text:?}");
        }
        let too_long = "a".repeat(MAX_TEXT_CODEPOINTS + 1);
        let op = ComputerOpV1::Input {
            input: ComputerInputV1::Text { text: too_long },
        };
        assert_eq!(request(op).validate(), Err(ComputerCodeV1::InvalidRequest));
    }

    #[test]
    fn the_linux_backend_refuses_text_it_cannot_encode_before_injection() {
        // The X11 path sends keysyms: only the first 256 codepoints exist.
        assert!(platform_accepts_text("linux-x11", "hello").is_ok());
        assert_eq!(
            platform_accepts_text("linux-x11", "中文"),
            Err(ComputerCodeV1::InputUnsupported)
        );
        // U+00E9 is <= 0xFF, so the X11 keysym path can carry it.
        assert_eq!(platform_accepts_text("linux-x11", "é"), Ok(()));
        // Windows sends UTF-16 pairs for the basic plane.
        assert!(platform_accepts_text("windows-gdi", "中文").is_ok());
        // An unknown backend never claims support.
        assert_eq!(
            platform_accepts_text("wayland", "hello"),
            Err(ComputerCodeV1::InputUnsupported)
        );
        assert!(!known_platform("wayland"));
        assert!(known_platform("linux-x11") && known_platform("windows-gdi"));
    }

    #[test]
    fn one_chunk_frame_stays_far_below_the_node_frame_ceiling() {
        // base64 expansion of the largest chunk, plus the JSON envelope.
        let encoded = encoded_chunk_bound();
        assert!(encoded < 2 * 1024 * 1024, "chunk payload {encoded} exceeds 2 MiB");
        assert_eq!(encoded, 1_398_104);

        // A full 4 MiB capture is exactly 4 chunks at 1 MiB each.
        assert_eq!(chunk_count(MAX_FRAME_BYTES, MAX_CHUNK_BYTES).unwrap(), 4);
        assert_eq!(chunk_count(1, MAX_CHUNK_BYTES).unwrap(), 1);
        assert_eq!(chunk_count(MAX_CHUNK_BYTES + 1, MAX_CHUNK_BYTES).unwrap(), 2);
        assert_eq!(chunk_count(0, MAX_CHUNK_BYTES), Err(ComputerCodeV1::InvalidRequest));
        assert_eq!(chunk_count(1, 0), Err(ComputerCodeV1::InvalidRequest));

        let header = ComputerFrameHeaderV1 {
            width: 1920,
            height: 1080,
            scale_millis: 1000,
            captured_at: 7,
            chunk_bytes: MAX_CHUNK_BYTES,
            chunk_count: 4,
            total_bytes: MAX_FRAME_BYTES,
        };
        assert_eq!(header.validate(), Ok(()));
        assert_eq!(header.scale(), 1.0);
        // A header that claims more chunks than the byte count needs is refused,
        // so the Host can bound reassembly from the header alone.
        let mut lying = header;
        lying.chunk_count = 5;
        assert_eq!(lying.validate(), Err(ComputerCodeV1::InvalidRequest));
        let mut oversized = header;
        oversized.total_bytes = MAX_FRAME_BYTES + 1;
        assert_eq!(oversized.validate(), Err(ComputerCodeV1::InvalidRequest));
        let mut tiny_chunks = header;
        tiny_chunks.chunk_bytes = 0;
        assert_eq!(tiny_chunks.validate(), Err(ComputerCodeV1::InvalidRequest));

        // Chunk frames are bounded before decoding, and a late seq is refused.
        let chunk = ComputerFrameChunkV1 {
            version: COMPUTER_VERSION,
            request_id: "req_1".to_owned(),
            seq: 1,
            data: "AAAA".to_owned(),
        };
        assert_eq!(chunk.validate_for(&header), Ok(()));
        let mut late = chunk.clone();
        late.seq = 5;
        assert_eq!(late.validate_for(&header), Err(ComputerCodeV1::InvalidRequest));
        let mut huge = chunk;
        huge.data = "A".repeat((encoded_chunk_bound() + 4) as usize);
        assert_eq!(huge.validate_for(&header), Err(ComputerCodeV1::InvalidRequest));
    }

    #[test]
    fn payload_free_operations_reject_every_extra_key_and_round_trip() {
        // A unit variant would silently drop these keys and decode a
        // program/path/environment request as `Info`; the empty struct variant
        // must refuse each one instead.
        for smuggled in [
            r#"{"kind":"info","program":"/bin/sh"}"#,
            r#"{"kind":"info","path":"/etc/passwd"}"#,
            r#"{"kind":"info","env":[["A","B"]]}"#,
            r#"{"kind":"info","argv":["id"]}"#,
            r#"{"kind":"info","url":"http://example.com"}"#,
            r#"{"kind":"info","command":"id"}"#,
            r#"{"kind":"info","viewId":"v"}"#,
            r#"{"kind":"release","program":"/bin/sh"}"#,
            r#"{"kind":"release","path":"/etc/passwd"}"#,
            r#"{"kind":"release","env":[["A","B"]]}"#,
            r#"{"kind":"release","argv":["id"]}"#,
            r#"{"kind":"release","url":"http://example.com"}"#,
            r#"{"kind":"release","command":"id"}"#,
        ] {
            assert!(
                serde_json::from_str::<ComputerOpV1>(smuggled).is_err(),
                "an operation accepted an extra key: {smuggled}"
            );
        }

        // The valid wire shape is byte-for-byte unchanged: the tag and nothing
        // else, so no caller can be asked to send a payload for these ops.
        assert_eq!(
            serde_json::to_string(&ComputerOpV1::Info {}).unwrap(),
            r#"{"kind":"info"}"#
        );
        assert_eq!(
            serde_json::to_string(&ComputerOpV1::Release {}).unwrap(),
            r#"{"kind":"release"}"#
        );
        assert_eq!(
            serde_json::from_str::<ComputerOpV1>(r#"{"kind":"info"}"#).unwrap(),
            ComputerOpV1::Info {}
        );
        assert_eq!(
            serde_json::from_str::<ComputerOpV1>(r#"{"kind":"release"}"#).unwrap(),
            ComputerOpV1::Release {}
        );

        // A whole request keeps the same representation and still validates.
        let ask = request(ComputerOpV1::Release {});
        let json = serde_json::to_string(&ask).unwrap();
        assert!(json.contains(r#""kind":"release""#), "{json}");
        assert!(!json.contains("payload"), "{json}");
        assert_eq!(serde_json::from_str::<ComputerRequestV1>(&json).unwrap(), ask);
        assert_eq!(ask.validate(), Ok(()));
        assert!(
            serde_json::from_str::<ComputerRequestV1>(&with_unknown_field(&json)).is_err(),
            "a request wrapper still accepts an unknown field"
        );
    }

    #[test]
    fn replies_are_checked_against_the_request_that_asked_for_them() {
        let ask = request(ComputerOpV1::Info {});
        let mut reply = ComputerReplyV1::refusal("req_1", ComputerCodeV1::Ok);
        assert_eq!(reply.validate_for(&ask), Ok(()));
        assert!(reply.code.is_ok());

        let mut other = reply.clone();
        other.request_id = "req_2".to_owned();
        assert_eq!(other.validate_for(&ask), Err(ComputerCodeV1::InvalidRequest));

        // A device reply must name a known backend and a non-empty screen.
        reply.device = Some(ComputerDeviceV1 {
            device_id: "sha256:abc".to_owned(),
            platform: "linux-x11".to_owned(),
            bounds: ComputerBoundsV1 { x: 0, y: 0, width: 1920, height: 1080 },
        });
        assert_eq!(reply.validate_for(&ask), Ok(()));
        let mut unknown = reply.clone();
        if let Some(device) = unknown.device.as_mut() {
            device.platform = "wayland".to_owned();
        }
        assert_eq!(unknown.validate_for(&ask), Err(ComputerCodeV1::InputUnsupported));

        // Every code is a stable, unique, non-empty spelling.
        let codes = [
            ComputerCodeV1::Ok,
            ComputerCodeV1::UnsupportedVersion,
            ComputerCodeV1::InvalidRequest,
            ComputerCodeV1::Unsupported,
            ComputerCodeV1::DeviceUnavailable,
            ComputerCodeV1::Busy,
            ComputerCodeV1::Timeout,
            ComputerCodeV1::InputFailed,
            ComputerCodeV1::InputUnsupported,
            ComputerCodeV1::CaptureFailed,
            ComputerCodeV1::EncoderUnavailable,
            ComputerCodeV1::BackendUnavailable,
            ComputerCodeV1::SessionLocked,
            ComputerCodeV1::ReleaseUnconfirmed,
            ComputerCodeV1::Cancelled,
        ];
        let mut seen: Vec<&'static str> = Vec::new();
        for code in codes {
            assert_eq!(code.to_string(), code.code());
            assert!(!code.code().is_empty());
            assert!(!seen.contains(&code.code()), "duplicate {}", code.code());
            seen.push(code.code());
        }
        assert_eq!(seen.len(), 15);
    }
}
