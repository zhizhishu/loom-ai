//! Unix process groups plus identity-bound descendant capture. Linux uses the
//! existing pidfd owner; Darwin uses PID-version checked signals. This is not
//! an OS sandbox: a malicious double-fork before capture needs cgroup/launchd
//! admission. Such containment is deliberately not claimed by this API.
use std::{cell::{Cell, RefCell}, io, process::{ExitStatus, Stdio}, time::Duration};
use anyhow::{Context, Result};
use super::{ProcessSpec, ProcessStdin, ProcessStdout, ProcessStderr, StdinPolicy};
#[cfg(target_os="linux")]
#[path="linux.rs"]
mod process_tree;
#[cfg(target_os="macos")]
#[path="macos.rs"]
mod process_tree;

pub(super) struct UnixManagedProcess {
    child: tokio::process::Child,
    pid: u32,
    tree: RefCell<process_tree::ProcessTree>,
    uncertain: Cell<bool>,
    group_retired: Cell<bool>,
    started: Option<u64>,
    #[cfg(target_os="linux")]
    leader_status: Cell<Option<ExitStatus>>,
    #[cfg(target_os="linux")]
    leader_reaped: Cell<bool>,
}
impl UnixManagedProcess {
    pub(super) fn spawn(spec: &ProcessSpec) -> Result<Self> {
        let mut application=super::application_identity::open_application(spec.application())?;
        if super::application_identity::from_file(&mut application)?.digest!=spec.application_identity_digest() {
            anyhow::bail!("process_boundary.application_changed");
        }
        #[cfg(target_os="linux")]
        let mut command={
            use std::os::{fd::AsRawFd,unix::process::CommandExt};
            let mut command=tokio::process::Command::new(format!("/proc/self/fd/{}",application.as_raw_fd()));
            command.as_std_mut().arg0(spec.application());command
        };
        #[cfg(target_os="macos")]
        let mut command=tokio::process::Command::new(spec.application());
        command.args(spec.arguments()).current_dir(spec.working_directory())
            .env_clear().envs(spec.environment())
            .stdin(match spec.stdin_policy() { StdinPolicy::Null=>Stdio::null(), StdinPolicy::Piped=>Stdio::piped() })
            .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        command.process_group(0);
        let child=command.spawn().context("process_boundary.spawn_failed")?;
        drop(application); // Linux exec has consumed the pinned executable fd.
        Self::adopt_legacy_process_group(child)
    }
    pub(super) fn adopt_legacy_process_group(mut child: tokio::process::Child) -> Result<Self> {
        let pid=child.id().context("process_boundary.spawn_outcome_unknown")?;
        // Do not signal a process group unless this exact unreaped child is its
        // leader. A wrong/adopted external process must never authorize killpg.
        if pid <= 1 || pid == std::process::id() ||
            unsafe { libc::getpgid(pid as i32) } != pid as i32 {
            let _=child.start_kill();
            anyhow::bail!("process_boundary.spawn_outcome_unknown");
        }
        let tree=match process_tree::ProcessTree::new(pid as i32) {
            Ok(tree)=>tree,
            Err(error)=>{
                // A process existed: failure is UNKNOWN, never a proof that a
                // side effect did not happen. Kill the owned group immediately.
                unsafe { libc::killpg(pid as i32,libc::SIGKILL); }
                let _=child.start_kill();
                return Err(error).context("process_boundary.spawn_outcome_unknown");
            }
        };
        #[cfg(target_os="linux")]
        let started=process_tree::process_start_identity(pid as i32);
        #[cfg(target_os="macos")]
        let started=None;
        Ok(Self { child,pid,tree:RefCell::new(tree),uncertain:Cell::new(false),group_retired:Cell::new(false),started,
            #[cfg(target_os="linux")] leader_status:Cell::new(None),
            #[cfg(target_os="linux")] leader_reaped:Cell::new(false) })
    }
    fn capture(&self)->io::Result<()> {
        let result=self.tree.borrow_mut().capture();
        if result.is_err() { self.uncertain.set(true); }
        result
    }
    pub(super) fn id(&self)->u32 { self.pid }
    pub(super) fn start_identity(&self)->Option<u64> { self.started }
    pub(super) fn owns_process_id(&self,pid:u32)->bool {
        self.capture().is_ok() && self.tree.borrow().owns_live_pid(pid).unwrap_or(false)
    }
    pub(super) fn take_stdin(&mut self)->Option<ProcessStdin> { self.child.stdin.take() }
    pub(super) fn take_stdout(&mut self)->Option<ProcessStdout> { self.child.stdout.take() }
    pub(super) fn take_stderr(&mut self)->Option<ProcessStderr> { self.child.stderr.take() }
    #[cfg(target_os="linux")]
    fn observe_leader_lease(&self)->io::Result<Option<ExitStatus>> {
        use std::os::unix::process::ExitStatusExt;
        if self.leader_reaped.get() {
            if !self.group_retired.get() {
                self.uncertain.set(true);
                return Err(io::Error::other("process_boundary.group_lease_lost"));
            }
            return Ok(self.leader_status.get());
        }
        // WNOWAIT preserves the child zombie as a PID/PGID lease. Returning
        // leader status must never free that numeric id while killpg may still
        // be required for an orphan. No external waiter may reap this owner.
        let mut info:libc::siginfo_t=unsafe{std::mem::zeroed()};
        let result=unsafe{libc::waitid(libc::P_PID,self.pid as libc::id_t,&mut info,
            libc::WEXITED|libc::WNOHANG|libc::WNOWAIT)};
        if result!=0 {
            let error=io::Error::last_os_error();
            if error.raw_os_error()!=Some(libc::EINTR) {self.uncertain.set(true);}
            return Err(error);
        }
        if unsafe{info.si_pid()}!=0 {
            let raw=match info.si_code {
                libc::CLD_EXITED=>(unsafe{info.si_status()})<<8,
                libc::CLD_KILLED=>unsafe{info.si_status()},
                libc::CLD_DUMPED=>(unsafe{info.si_status()})|0x80,
                _=>return Err(io::Error::other("process_boundary.invalid_wait_state")),
            };
            self.leader_status.set(Some(ExitStatus::from_raw(raw)));
        }
        Ok(self.leader_status.get())
    }
    pub(super) fn try_wait(&mut self)->io::Result<Option<ExitStatus>> {
        self.capture()?;
        #[cfg(target_os="linux")]
        {
            let status=self.observe_leader_lease()?;
            if status.is_some() && self.group_retired.get() && !self.leader_reaped.get() {
                if self.child.try_wait()?.is_none() {
                    self.uncertain.set(true);
                    return Err(io::Error::other("process_boundary.leader_reap_unconfirmed"));
                }
                self.leader_reaped.set(true);
            }
            Ok(status)
        }
        #[cfg(target_os="macos")]
        { self.child.try_wait() }
    }
    pub(super) async fn wait(&mut self)->io::Result<ExitStatus> {
        loop {
            if let Some(status)=self.try_wait()? { return Ok(status); }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    pub(super) fn tree_is_empty(&self)->io::Result<bool> {
        self.capture()?;
        if self.uncertain.get() {
            return Err(io::Error::other("process_boundary.ownership_unconfirmed"));
        }
        let captured_empty=self.tree.borrow().is_empty()?;
        #[cfg(target_os="linux")]
        {
            if !self.group_retired.get() {
                self.observe_leader_lease()?;
                if !process_tree::group_has_live_members(self.pid as i32)? {
                    self.group_retired.set(true);
                }
            }
            Ok(captured_empty && self.group_retired.get())
        }
        #[cfg(target_os="macos")]
        { Ok(captured_empty) }
    }
    pub(super) fn terminate_tree(&mut self)->io::Result<()> {
        let captured=self.capture();
        let signalled=self.tree.borrow().signal(libc::SIGKILL);
        #[cfg(target_os="linux")]
        let grouped=if self.group_retired.get() { Ok(()) } else {
            // Reconfirm the unreaped child lease before numeric group delivery.
            // A failed lease check still leaves pidfd signals safe, but does not
            // authorize killpg against a possibly recycled numeric group id.
            self.observe_leader_lease()?;
            if self.pid<=1 || self.pid as i32==unsafe {libc::getpgrp()} {
                Err(io::Error::other("process_boundary.invalid_group"))
            } else if unsafe {libc::killpg(self.pid as i32,libc::SIGKILL)}==0 {
                Ok(())
            } else {
                let e=io::Error::last_os_error();
                if e.raw_os_error()==Some(libc::ESRCH) { self.group_retired.set(true);Ok(()) } else {Err(e)}
            }
        };
        #[cfg(target_os="macos")]
        let grouped=Ok(());
        captured.and(signalled).and(grouped)
    }
}
