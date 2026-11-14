//! Native process ownership for remote execution and continuous sessions.
//! Windows admission is atomic: CreateProcessW receives both JOB_LIST and the
//! exact three-handle HANDLE_LIST. No child runs before joining its private Job.
//! This is an ownership/termination boundary, not an OS sandbox. Callers admit
//! programs, arguments, cwd and the complete environment before constructing a spec.
//! Linux/Darwin use process groups and identity-bound descendant capture;
//! unsupported platforms fail closed.
use std::{collections::BTreeMap, ffi::OsString, io, path::{Path, PathBuf}, process::ExitStatus, time::Duration};
use anyhow::{bail, Result};

#[cfg(windows)]
mod windows;
mod application_identity;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix;

#[cfg(windows)]
pub type ProcessStdin = tokio::fs::File;
#[cfg(windows)]
pub type ProcessStdout = tokio::fs::File;
#[cfg(windows)]
pub type ProcessStderr = tokio::fs::File;
#[cfg(not(windows))]
pub type ProcessStdin = tokio::process::ChildStdin;
#[cfg(not(windows))]
pub type ProcessStdout = tokio::process::ChildStdout;
#[cfg(not(windows))]
pub type ProcessStderr = tokio::process::ChildStderr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdinPolicy { Null, Piped }
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsArgvDialect { MicrosoftCrt }

/// Immutable snapshot. The environment is explicit; ambient credentials and
/// process-global variables are never copied by this crate. Debug omits values.
#[derive(Clone)]
pub struct ProcessSpec {
    program: PathBuf,
    args: Vec<OsString>,
    cwd: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    stdin: StdinPolicy,
    #[cfg(windows)]
    application_identity: windows::WindowsApplicationIdentity,
    #[cfg(unix)]
    application_identity: application_identity::UnixApplicationIdentity,
}
impl std::fmt::Debug for ProcessSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessSpec").field("program", &self.program)
            .field("argument_count", &self.args.len()).field("cwd", &self.cwd)
            .field("environment_entry_count", &self.environment.len())
            .field("stdin", &self.stdin).finish_non_exhaustive()
    }
}
impl ProcessSpec {
    pub fn new(program: PathBuf, args: Vec<OsString>, cwd: PathBuf,
        environment: BTreeMap<OsString, OsString>, stdin: StdinPolicy) -> Result<Self> {
        if !program.is_absolute() || !program.is_file() {
            bail!("process_boundary.invalid_application: expected an absolute regular file");
        }
        if !cwd.is_absolute() || !cwd.is_dir() {
            bail!("process_boundary.invalid_cwd: expected an absolute directory");
        }
        if args.iter().any(|arg| arg.to_string_lossy().contains('\0')) {
            bail!("process_boundary.invalid_argument: NUL");
        }
        #[cfg(windows)]
        {
            if !program.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
                bail!("process_boundary.unsupported_entrypoint: resolve an admitted native executable before launch");
            }
            windows::validate_launch_input(&program, &args, &environment)?;
        }
        #[cfg(windows)]
        let application_identity = windows::capture_application_identity(&program)?;
        #[cfg(unix)]
        let application_identity = application_identity::capture(&program)?;
        Ok(Self { program, args, cwd, environment, stdin,
            #[cfg(any(windows,unix))] application_identity })
    }
    pub fn application_identity_digest(&self)->String {
        #[cfg(windows)] { self.application_identity.digest() }
        #[cfg(unix)] { self.application_identity.digest.clone() }
        #[cfg(not(any(windows,unix)))] { unreachable!("unsupported platform cannot admit a process") }
    }
    pub fn application(&self) -> &Path { &self.program }
    pub fn arguments(&self) -> &[OsString] { &self.args }
    pub fn working_directory(&self) -> &Path { &self.cwd }
    pub fn environment(&self) -> &BTreeMap<OsString, OsString> { &self.environment }
    pub fn stdin_policy(&self) -> StdinPolicy { self.stdin }
    #[cfg(windows)]
    fn application_identity(&self) -> &windows::WindowsApplicationIdentity { &self.application_identity }
    #[cfg(windows)]
    fn windows_argv_dialect(&self) -> WindowsArgvDialect { WindowsArgvDialect::MicrosoftCrt }
}

/// Stable installation identity from the same platform admission routine used
/// by ProcessSpec and revalidated by spawn. No environment/argv is hashed.
pub fn inspect_application_identity(path:&Path)->Result<String> {
    #[cfg(windows)] {Ok(windows::capture_application_identity(path)?.digest())}
    #[cfg(unix)] {Ok(application_identity::capture(path)?.digest)}
    #[cfg(not(any(windows,unix)))] {let _=path;bail!("process_boundary.unsupported_platform")}
}

/// A successful termination receipt requires both the exact leader handle to
/// be signalled and current Job membership to be zero.
#[derive(Debug)]
pub struct TerminationReceipt { pub exit_status: ExitStatus, pub tree_empty: bool }

pub struct NativeProcess {
    #[cfg(windows)]
    inner: windows::WindowsManagedProcess,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    inner: unix::UnixManagedProcess,
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    never: std::convert::Infallible,
}
impl std::fmt::Debug for NativeProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeProcess").field("pid", &self.id())
            .field("windows_job_name", &self.windows_job_name()).finish_non_exhaustive()
    }
}
impl NativeProcess {
    pub fn spawn(spec: &ProcessSpec) -> Result<Self> {
        #[cfg(windows)]
        { Ok(Self { inner: windows::WindowsManagedProcess::spawn(spec)? }) }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        { Ok(Self { inner: unix::UnixManagedProcess::spawn(spec)? }) }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        { let _ = spec; bail!("process_boundary.unsupported_platform") }
    }
    /// Owns a Child already spawned in its own Unix process group.
    ///
    /// Compatibility seam for an explicitly admitted legacy script. This does
    /// not establish executable identity or change ProcessSpec admission. The
    /// caller must set process_group(0), keep this exact Child unreaped, and
    /// accept that spawn has already happened if adoption returns an error.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn adopt_legacy_process_group(child: tokio::process::Child) -> Result<Self> {
        Ok(Self { inner: unix::UnixManagedProcess::adopt_legacy_process_group(child)? })
    }

    pub fn id(&self) -> u32 {
        #[cfg(windows)] { self.inner.id() }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.id() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn windows_job_name(&self) -> Option<&str> {
        #[cfg(windows)] { Some(self.inner.job_name()) }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { None }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn start_identity(&self) -> Option<u64> {
        #[cfg(windows)] { windows::process_start_identity(self.id()) }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.start_identity() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn owns_process_id(&self, pid: u32) -> bool {
        #[cfg(windows)] { self.inner.owns_process_id(pid) }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.owns_process_id(pid) }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { let _ = pid; match self.never {} }
    }
    pub fn take_stdin(&mut self) -> Option<ProcessStdin> {
        #[cfg(windows)] { self.inner.take_stdin() }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.take_stdin() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn take_stdout(&mut self) -> Option<ProcessStdout> {
        #[cfg(windows)] { self.inner.take_stdout() }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.take_stdout() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn take_stderr(&mut self) -> Option<ProcessStderr> {
        #[cfg(windows)] { self.inner.take_stderr() }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.take_stderr() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        #[cfg(windows)] { self.inner.try_wait() }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.try_wait() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        #[cfg(windows)] { self.inner.wait().await }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.wait().await }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn tree_is_empty(&self) -> io::Result<bool> {
        #[cfg(windows)] { self.inner.tree_is_empty() }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.tree_is_empty() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub fn terminate_tree(&mut self) -> io::Result<()> {
        #[cfg(windows)] { self.inner.terminate_job() }
        #[cfg(any(target_os = "linux", target_os = "macos"))] { self.inner.terminate_tree() }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { match self.never {} }
    }
    pub async fn terminate_and_wait(&mut self, budget: Duration) -> io::Result<TerminationReceipt> {
        self.terminate_tree()?;
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            if let Some(exit_status) = self.try_wait()? {
                if self.tree_is_empty()? {
                    // Linux may now release the leader PID lease; tree ownership
                    // has been retired before this final reap.
                    let exit_status=self.try_wait()?.unwrap_or(exit_status);
                    return Ok(TerminationReceipt { exit_status, tree_empty: true });
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "process_boundary.termination_unconfirmed"));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for NativeProcess {
    fn drop(&mut self) {
        #[cfg(windows)]
        { let _ = self.inner.terminate_job(); } // Job close is an independent kill fallback.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        { let _ = self.inner.terminate_tree(); }
    }
}

#[cfg(all(test, windows))]
mod tests;

#[cfg(all(test, target_os = "linux"))]
mod linux_tests;
