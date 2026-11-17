//! Bounded one-shot helper process for the local Computer provider.
//!
//! The request is written to the helper's **stdin**, never to argv, so typed
//! text and pointer coordinates never appear in an OS process list or a process
//! audit record. stdout carries one JSON header line plus, for a capture, exactly
//! `bytes` raw PNG bytes. stderr is capped and discarded; nothing here is logged.
//!
//! Every invocation is bounded: the child is polled against a deadline, then
//! killed and reaped, and both pipes are drained by capped reader threads so a
//! chatty or wedged helper cannot grow memory or hold the caller open.

use super::{Failure, MAX_FRAME_BYTES};
use serde::Deserialize;
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_HEADER_BYTES: usize = 4 * 1024;
const MAX_STDERR_BYTES: usize = 4 * 1024;
const MAX_STDOUT_BYTES: usize = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 64;
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Absolute interpreter plus absolute script. Owned by the Host process
/// environment; a request can never change either field.
#[derive(Clone, Debug)]
pub(crate) struct HelperLaunch {
    pub python: PathBuf,
    pub script: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HelperReply {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub origin_x: Option<i32>,
    #[serde(default)]
    pub origin_y: Option<i32>,
    #[serde(default)]
    pub screen_width: Option<u32>,
    #[serde(default)]
    pub screen_height: Option<u32>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub captured_at: Option<u64>,
    #[serde(default)]
    pub detail: Option<String>,
}

/// Test-only, and only ever prints the shape of the reply — never the encoded screen bytes,
/// which travel next to it as a separate buffer. Production builds never contain this impl.
#[cfg(test)]
impl std::fmt::Debug for HelperReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HelperReply")
            .field("ok", &self.ok)
            .field("error", &self.error)
            .field("platform", &self.platform)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("bytes", &self.bytes)
            .field("detail", &self.detail)
            .finish_non_exhaustive()
    }
}

/// The only environment a helper may inherit. `DISPLAY`/`XAUTHORITY` are passed
/// through only when the Host already set them explicitly, which is what keeps
/// the X11 backend an opt-in instead of ambient desktop discovery.
fn inherited_environment() -> Vec<(&'static str, std::ffi::OsString)> {
    const KEYS: [&str; 6] = [
        "SystemRoot",
        "windir",
        "TEMP",
        "TMP",
        "DISPLAY",
        "XAUTHORITY",
    ];
    let mut kept = Vec::new();
    for key in KEYS {
        if let Some(value) = std::env::var_os(key) {
            kept.push((key, value));
        }
    }
    #[cfg(windows)]
    if let Some(path) = std::env::var_os("PATH") {
        // Windows interpreters may rely on PATH to resolve their own DLLs.
        // POSIX does not need it, so it is not inherited there.
        kept.push(("PATH", path));
    }
    kept
}

fn command(launch: &HelperLaunch) -> Command {
    let mut command = Command::new(&launch.python);
    command
        .arg(&launch.script)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in inherited_environment() {
        command.env(key, value);
    }
    for (key, value) in [
        ("PYTHONNOUSERSITE", "1"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONIOENCODING", "utf-8"),
    ] {
        command.env(key, value);
    }
    if let Some(parent) = launch.script.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never flash a console for a capture or a key tap.
        command.creation_flags(0x0800_0000);
    }
    command
}

fn read_capped(mut reader: impl Read, cap: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let room = cap.saturating_sub(kept.len());
                if room == 0 {
                    break;
                }
                kept.extend_from_slice(&chunk[..count.min(room)]);
            }
        }
    }
    kept
}

#[derive(Clone, Copy, Debug)]
enum Exit {
    Finished(bool),
    TimedOut,
    Broken,
}

fn helper_failure(reply: &HelperReply) -> Failure {
    match reply.error.as_deref() {
        Some("encoder_unavailable") => Failure::EncoderUnavailable,
        Some("unsupported_backend" | "no_display" | "unsupported_platform") => {
            Failure::BackendUnavailable
        }
        Some("session_locked") => Failure::SessionLocked,
        Some("invalid_request" | "unsupported_input") => Failure::Invalid,
        _ => Failure::Failed,
    }
}

/// Parse the one-line header, validate the announced byte count and translate a
/// refusal into its own failure variant.
fn split_reply(stdout: &[u8]) -> Result<(HelperReply, usize), Failure> {
    let Some(newline) = stdout.iter().position(|byte| *byte == b'\n') else {
        return Err(Failure::Failed);
    };
    if newline > MAX_HEADER_BYTES {
        return Err(Failure::Failed);
    }
    let Ok(reply) = serde_json::from_slice::<HelperReply>(&stdout[..newline]) else {
        return Err(Failure::Failed);
    };
    let body = &stdout[newline + 1..];
    if let Some(bytes) = reply.bytes {
        if usize::try_from(bytes).ok() != Some(body.len()) {
            return Err(Failure::Invalid);
        }
    } else if !body.is_empty() {
        return Err(Failure::Failed);
    }
    if !reply.ok {
        return Err(helper_failure(&reply));
    }
    Ok((reply, newline + 1))
}

/// Run one request. Returns the parsed header and, for a capture, the exact PNG
/// body announced by `bytes`.
pub(crate) fn run(
    launch: &HelperLaunch,
    payload: &Value,
    timeout: Duration,
) -> Result<(HelperReply, Vec<u8>), Failure> {
    let mut encoded = serde_json::to_vec(payload).map_err(|_| Failure::Invalid)?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err(Failure::Invalid);
    }
    encoded.push(b'\n');

    let mut child = command(launch).spawn().map_err(|_| Failure::Unavailable)?;
    let streams = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(mut stdin), Some(stdout), Some(stderr)) = streams else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Failure::Failed);
    };
    let deadline = Instant::now() + timeout;

    let (exit, stdout, stderr) = thread::scope(|scope| {
        // stdin closes as soon as the request is written, so the helper sees an
        // exact, complete request and cannot wait for more input.
        let writer = scope.spawn(move || {
            let _ = stdin.write_all(&encoded);
            let _ = stdin.flush();
        });
        let stdout_reader = scope.spawn(move || read_capped(stdout, MAX_STDOUT_BYTES));
        let stderr_reader = scope.spawn(move || read_capped(stderr, MAX_STDERR_BYTES));
        let exit = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Exit::Finished(status.success()),
                Ok(None) => {}
                Err(_) => break Exit::Broken,
            }
            if Instant::now() >= deadline {
                break Exit::TimedOut;
            }
            thread::sleep(POLL_INTERVAL);
        };
        if !matches!(exit, Exit::Finished(true)) {
            let _ = child.kill();
        }
        // Always reap, so a killed helper never becomes a zombie.
        let _ = child.wait();
        let _ = writer.join();
        (
            exit,
            stdout_reader.join().unwrap_or_default(),
            stderr_reader.join().unwrap_or_default(),
        )
    });
    // Diagnostics never include helper output or the request payload.
    let _ = stderr;

    match exit {
        Exit::TimedOut => Err(Failure::Timeout),
        Exit::Broken => Err(Failure::Failed),
        Exit::Finished(success) => {
            let (reply, start) = split_reply(&stdout)?;
            if !success {
                // A refusal that still claimed success is a protocol violation.
                return Err(Failure::Failed);
            }
            Ok((reply, stdout[start..].to_vec()))
        }
    }
}

/// Explicit path admission for a launch pair, without spawning anything.
#[cfg(test)]
pub(crate) fn resolve(python: &std::path::Path, script: &std::path::Path) -> Option<HelperLaunch> {
    (python.is_absolute() && python.is_file() && script.is_absolute() && script.is_file()).then(
        || HelperLaunch {
            python: python.to_path_buf(),
            script: script.to_path_buf(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A missing interpreter is reported as *not tested*, never as a pass.
    fn script(body: &str) -> Option<(HelperLaunch, PathBuf)> {
        let python = which("python3").or_else(|| which("python"))?;
        let root = std::env::temp_dir().join(format!(
            "loom-computer-helper-{}",
            crate::new_token().ok()?
        ));
        std::fs::create_dir_all(&root).ok()?;
        let script = root.join("helper.py");
        std::fs::write(&script, body).ok()?;
        Some((
            HelperLaunch {
                python,
                script: script.clone(),
            },
            root,
        ))
    }

    fn which(name: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
    }

    #[test]
    fn helper_request_is_written_to_stdin_and_bounded() {
        let Some((launch, root)) = script(
            "import json, sys\n\
             request = json.loads(sys.stdin.readline())\n\
             text = request.get('text', '')\n\
             assert text not in ' '.join(sys.argv), 'request must not reach argv'\n\
             sys.stdout.write(json.dumps({'ok': True, 'bytes': len(text.encode('utf-8'))}) + '\\n')\n\
             sys.stdout.write(text)\n\
             sys.stdout.flush()\n",
        ) else {
            eprintln!("NOT TESTED: no python3/python on PATH; helper stdin contract unverified");
            return;
        };
        let secret = "typed-secret-0123456789";
        let (reply, body) = run(
            &launch,
            &serde_json::json!({"op": "text", "text": secret}),
            Duration::from_secs(20),
        )
        .expect("helper must round trip through stdin");
        assert!(reply.ok);
        assert_eq!(String::from_utf8(body).unwrap(), secret);
        assert_eq!(*reply.bytes.as_ref().unwrap(), secret.len() as u64);
        // A request that cannot fit the bounded writer is refused before spawn.
        let oversized = "a".repeat(MAX_REQUEST_BYTES + 1);
        assert_eq!(
            run(
                &launch,
                &serde_json::json!({"op": "text", "text": oversized}),
                Duration::from_secs(20)
            )
            .unwrap_err(),
            Failure::Invalid
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn helper_timeout_kills_and_reaps_the_child() {
        let Some((launch, root)) = script("import time\ntime.sleep(30)\n") else {
            eprintln!("NOT TESTED: no python3/python on PATH; helper kill/reap unverified");
            return;
        };
        let started = Instant::now();
        let failure = run(
            &launch,
            &serde_json::json!({"op": "info"}),
            Duration::from_millis(400),
        )
        .unwrap_err();
        assert_eq!(failure, Failure::Timeout);
        // The deadline governs, not the helper's own sleep.
        assert!(started.elapsed() < Duration::from_secs(10));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn helper_refusals_keep_their_distinct_codes() {
        let Some((launch, root)) = script(
            "import json, os, sys\n\
             request = json.loads(sys.stdin.readline())\n\
             sys.stdout.write(json.dumps({'ok': False, 'error': request.get('op')}) + '\\n')\n\
             sys.stdout.flush()\n\
             os._exit(1)\n",
        ) else {
            eprintln!("NOT TESTED: no python3/python on PATH; helper error mapping unverified");
            return;
        };
        for (op, failure) in [
            ("encoder_unavailable", Failure::EncoderUnavailable),
            ("unsupported_backend", Failure::BackendUnavailable),
            ("session_locked", Failure::SessionLocked),
            ("invalid_request", Failure::Invalid),
            ("anything_else", Failure::Failed),
        ] {
            assert_eq!(
                run(
                    &launch,
                    &serde_json::json!({"op": op}),
                    Duration::from_secs(20)
                )
                .unwrap_err(),
                failure
            );
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn malformed_helper_stdout_is_never_accepted_as_a_frame() {
        // A raw string keeps the four-space Python indentation. A `\`-continued Rust
        // literal strips the leading whitespace of every continued line, which turned
        // each `if`/`elif` body into an IndentationError: the child then exited before
        // writing, so a `Failed` here would only prove the helper never ran.
        let Some((launch, root)) = script(
            r#"import json, sys
request = json.loads(sys.stdin.readline())
mode = request.get('op')
if mode == 'garbage':
    sys.stdout.write('not json\n')
elif mode == 'mismatch':
    sys.stdout.write(json.dumps({'ok': True, 'bytes': 99}) + '\n' + 'short')
else:
    sys.stdout.write(json.dumps({'ok': True, 'bytes': 0}) + '\n')
sys.stdout.flush()
"#,
        ) else {
            eprintln!("NOT TESTED: no python3/python on PATH; helper framing unverified");
            return;
        };
        // Positive control: the fixture must really start and produce one well-formed
        // frame, otherwise the assertions below cannot distinguish a rejection from a
        // helper that wrote nothing at all.
        let (control, control_body) = run(
            &launch,
            &serde_json::json!({"op": "control"}),
            Duration::from_secs(20),
        )
        .expect("helper fixture must produce one well-formed frame");
        assert!(control.ok);
        assert!(control_body.is_empty());
        for (op, failure) in [("garbage", Failure::Failed), ("mismatch", Failure::Invalid)] {
            assert_eq!(
                run(
                    &launch,
                    &serde_json::json!({"op": op}),
                    Duration::from_secs(20)
                )
                .unwrap_err(),
                failure
            );
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn launch_paths_must_be_absolute_existing_files() {
        use std::path::Path;
        assert!(resolve(Path::new("python3"), Path::new("helper.py")).is_none());
        assert!(
            resolve(
                Path::new("/nonexistent/python"),
                Path::new("/nonexistent/host_desktop.py")
            )
            .is_none()
        );
        assert!(resolve(Path::new("python3"), Path::new(".")).is_none());
    }
}
