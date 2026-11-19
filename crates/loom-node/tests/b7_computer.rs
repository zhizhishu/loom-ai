//! B7: the paired-node computer **wire contract** harness.
//!
//! This is not a paired-node proof and must not be read as one. It runs no
//! server, no socket and no desktop; it proves only what is decidable from the
//! contract types:
//!
//! * the wire schema is closed and has no program, path, environment, argv or
//!   URL field, so a paired token cannot become a generic process/file API;
//! * a capture is chunked and every chunk frame stays far below the node
//!   channel's 2 MiB ceiling — the existing frame limit is not widened;
//! * a header cannot over-claim, and chunks must arrive in order and in size;
//! * an X11 target refuses text it cannot encode *before* injection;
//! * a release has its own unconfirmed code and can never read as success.
//!
//! The functional transport proof lives where it can be real:
//!
//! * `rovai-web/src/nodes.rs` — Hub capability + connection-generation routing
//!   on send and on receive, and pending-request failure on detach;
//! * `rovai-web/src/computer/node_provider.rs` — remote codes never map to a
//!   confirmed release or a clean input;
//! * `loom-node/src/computer_provider.rs` — epoch-enforced cancellation: a queued
//!   old-epoch input never starts, an active helper is killed and reaped on
//!   disconnect, and an unconfirmed input blocks the next one until a release;
//! * the supervisor's Xvfb/window run — real pixels and real injection.
use loom_protocol::computer::{
    COMPUTER_VERSION, ComputerCodeV1, ComputerFrameChunkV1, ComputerFrameHeaderV1, ComputerInputV1,
    ComputerOpV1, ComputerRequestV1, MAX_CHUNK_BYTES, MAX_FRAME_BYTES, chunk_count,
    encoded_chunk_bound, platform_accepts_text,
};
use std::process::ExitCode;

type Check = fn() -> Result<(), String>;

fn main() -> ExitCode {
    let checks: &[(&str, Check)] = &[
        ("schema_is_closed", schema_is_closed),
        ("no_program_path_or_environment", no_program_path_or_environment),
        ("chunk_bounds_fit_the_channel", chunk_bounds_fit_the_channel),
        ("header_claims_are_bounded", header_claims_are_bounded),
        ("chunk_order_and_size_are_enforced", chunk_order_and_size_are_enforced),
        ("linux_text_is_refused_before_injection", linux_text_is_refused_before_injection),
        ("release_has_its_own_unconfirmed_code", release_has_its_own_unconfirmed_code),
        ("request_identity_is_a_plain_bounded_id", request_identity_is_a_plain_bounded_id),
    ];
    let mut failures = Vec::new();
    for (name, check) in checks {
        match (*check)() {
            Ok(()) => println!("ok   {name}"),
            Err(message) => failures.push(format!("{name}: {message}")),
        }
    }
    if failures.is_empty() {
        println!(
            "B7 computer wire contract: {} checks passed (wire only; NOT a paired-node proof)",
            checks.len()
        );
        return ExitCode::SUCCESS;
    }
    for failure in &failures {
        eprintln!("B7 computer contract FAILED: {failure}");
    }
    ExitCode::FAILURE
}

fn frame_request() -> ComputerRequestV1 {
    ComputerRequestV1 {
        version: COMPUTER_VERSION,
        request_id: "req_1".to_owned(),
        op: ComputerOpV1::Frame {
            max_width: 1920,
            max_height: 1080,
        },
    }
}

fn with_unknown_field(json: &str) -> String {
    let mut text = json.to_owned();
    let _ = text.pop();
    text.push_str(",\"unexpected\":1}");
    text
}

fn schema_is_closed() -> Result<(), String> {
    let json = serde_json::to_string(&frame_request()).map_err(|error| error.to_string())?;
    if serde_json::from_str::<ComputerRequestV1>(&with_unknown_field(&json)).is_ok() {
        return Err("a request accepted an unknown field".to_owned());
    }
    let mut wrong = frame_request();
    wrong.version = 2;
    if wrong.validate().is_ok() {
        return Err("a future version was accepted".to_owned());
    }
    for op in [
        r#"{"kind":"run","args":["sh"]}"#,
        r#"{"kind":"screenshot"}"#,
        r#"{"kind":"viewStart","viewId":"v","ttlMs":1000}"#,
    ] {
        if serde_json::from_str::<ComputerOpV1>(op).is_ok() {
            return Err(format!("an undeclared operation was accepted: {op}"));
        }
    }
    Ok(())
}

fn no_program_path_or_environment() -> Result<(), String> {
    for smuggled in [
        r#"{"kind":"info","program":"/bin/sh"}"#,
        r#"{"kind":"info","path":"/etc/passwd"}"#,
        r#"{"kind":"info","env":[["A","B"]]}"#,
        r#"{"kind":"info","url":"http://example.com"}"#,
        r#"{"kind":"info","argv":["id"]}"#,
        r#"{"kind":"info","command":"id"}"#,
    ] {
        if serde_json::from_str::<ComputerOpV1>(smuggled).is_ok() {
            return Err(format!("an operation carried a forbidden field: {smuggled}"));
        }
    }
    for smuggled in [
        r#"{"kind":"text","text":"a","file":"/tmp/x"}"#,
        r#"{"kind":"text","text":"a","clipboard":true}"#,
        r#"{"kind":"key","key":"enter","script":"id"}"#,
    ] {
        if serde_json::from_str::<ComputerInputV1>(smuggled).is_ok() {
            return Err(format!("an input carried a forbidden field: {smuggled}"));
        }
    }
    Ok(())
}

fn chunk_bounds_fit_the_channel() -> Result<(), String> {
    const CHANNEL_FRAME: usize = 2 * 1024 * 1024;
    // A full 4 MiB capture is four chunks, never one oversized frame.
    if chunk_count(MAX_FRAME_BYTES, MAX_CHUNK_BYTES) != Ok(4) {
        return Err("a full capture is not four chunks".to_owned());
    }
    if encoded_chunk_bound() >= CHANNEL_FRAME as u64 {
        return Err("one chunk already exceeds the channel frame ceiling".to_owned());
    }
    // Measure the real serialized frame with a full payload, not just the bound.
    let payload = base64_of(MAX_CHUNK_BYTES as usize);
    let chunk = ComputerFrameChunkV1 {
        version: COMPUTER_VERSION,
        request_id: "req_1".to_owned(),
        seq: 1,
        data: payload,
    };
    let encoded = serde_json::to_vec(&chunk).map_err(|error| error.to_string())?;
    if encoded.len() >= CHANNEL_FRAME {
        return Err(format!(
            "a full chunk frame is {} bytes and would exceed the {CHANNEL_FRAME} byte ceiling",
            encoded.len()
        ));
    }
    Ok(())
}

fn base64_of(raw: usize) -> String {
    // Standard padded base64 of `raw` zero bytes, built without a dependency.
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(raw.div_ceil(3) * 4);
    for _ in 0..(raw / 3) {
        encoded.push(ALPHABET[0] as char);
        encoded.push(ALPHABET[0] as char);
        encoded.push(ALPHABET[0] as char);
        encoded.push(ALPHABET[0] as char);
    }
    match raw % 3 {
        1 => {
            encoded.push(ALPHABET[0] as char);
            encoded.push(ALPHABET[0] as char);
            encoded.push('=');
            encoded.push('=');
        }
        2 => {
            encoded.push(ALPHABET[0] as char);
            encoded.push(ALPHABET[0] as char);
            encoded.push(ALPHABET[0] as char);
            encoded.push('=');
        }
        _ => {}
    }
    encoded
}

fn header() -> ComputerFrameHeaderV1 {
    ComputerFrameHeaderV1 {
        width: 1920,
        height: 1080,
        scale_millis: 1000,
        captured_at: 1,
        chunk_bytes: MAX_CHUNK_BYTES,
        chunk_count: 4,
        total_bytes: MAX_FRAME_BYTES,
    }
}

fn header_claims_are_bounded() -> Result<(), String> {
    if header().validate().is_err() {
        return Err("the reference header is invalid".to_owned());
    }
    let mut lying = header();
    lying.chunk_count = 1;
    if lying.validate().is_ok() {
        return Err("a header claiming fewer chunks than it needs was accepted".to_owned());
    }
    let mut over = header();
    over.total_bytes = MAX_FRAME_BYTES + 1;
    if over.validate().is_ok() {
        return Err("a capture larger than the frame bound was accepted".to_owned());
    }
    let mut zero = header();
    zero.chunk_bytes = 0;
    if zero.validate().is_ok() {
        return Err("a zero chunk size was accepted".to_owned());
    }
    let mut tiny = header();
    tiny.width = 0;
    if tiny.validate().is_ok() {
        return Err("a zero-width capture was accepted".to_owned());
    }
    Ok(())
}

fn chunk_order_and_size_are_enforced() -> Result<(), String> {
    let header = header();
    let ok = ComputerFrameChunkV1 {
        version: COMPUTER_VERSION,
        request_id: "req_1".to_owned(),
        seq: 1,
        data: "AAAA".to_owned(),
    };
    if ok.validate_for(&header).is_err() {
        return Err("a well-formed chunk was refused".to_owned());
    }
    for seq in [0_u32, 5, u32::MAX] {
        let mut bad = ok.clone();
        bad.seq = seq;
        if bad.validate_for(&header).is_ok() {
            return Err(format!("chunk seq {seq} was accepted"));
        }
    }
    let mut oversized = ok.clone();
    oversized.data = "A".repeat(encoded_chunk_bound() as usize + 4);
    if oversized.validate_for(&header).is_ok() {
        return Err("an oversized chunk was accepted".to_owned());
    }
    let mut wrong_version = ok;
    wrong_version.version = COMPUTER_VERSION + 1;
    if wrong_version.validate_for(&header).is_ok() {
        return Err("a future chunk version was accepted".to_owned());
    }
    Ok(())
}

fn linux_text_is_refused_before_injection() -> Result<(), String> {
    if platform_accepts_text("linux-x11", "hello").is_err() {
        return Err("plain ASCII was refused on X11".to_owned());
    }
    // The X11 keysym path cannot reach beyond U+00FF, so it must refuse early.
    if platform_accepts_text("linux-x11", "中文") != Err(ComputerCodeV1::InputUnsupported) {
        return Err("X11 claimed to type text it cannot encode".to_owned());
    }
    if platform_accepts_text("windows-gdi", "中文").is_err() {
        return Err("Windows refused basic-plane text it can encode".to_owned());
    }
    if platform_accepts_text("wayland", "hello") != Err(ComputerCodeV1::InputUnsupported) {
        return Err("an unsupported backend claimed text support".to_owned());
    }
    Ok(())
}

fn release_has_its_own_unconfirmed_code() -> Result<(), String> {
    let unconfirmed = ComputerCodeV1::ReleaseUnconfirmed;
    if unconfirmed.is_ok() {
        return Err("an unconfirmed release reads as success".to_owned());
    }
    if unconfirmed.code() != "computer_release_unconfirmed" {
        return Err(format!("unexpected release code {}", unconfirmed.code()));
    }
    // Distinct from every other code, so a caller cannot mistake it for one.
    let mut seen: Vec<&'static str> = Vec::new();
    for code in [
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
    ] {
        if seen.contains(&code.code()) {
            return Err(format!("duplicate code {}", code.code()));
        }
        seen.push(code.code());
    }
    Ok(())
}

fn request_identity_is_a_plain_bounded_id() -> Result<(), String> {
    for (request_id, ok) in [
        ("req_1", true),
        ("", false),
        ("req 1", false),
        ("../../etc/passwd", false),
        ("req/1", false),
    ] {
        let mut request = frame_request();
        request.request_id = request_id.to_owned();
        if request.validate().is_ok() != ok {
            return Err(format!("request id {request_id:?} was judged wrongly"));
        }
    }
    let mut request = frame_request();
    request.request_id = "a".repeat(81);
    if request.validate().is_ok() {
        return Err("an over-long request id was accepted".to_owned());
    }
    Ok(())
}
