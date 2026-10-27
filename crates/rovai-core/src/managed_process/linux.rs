//! Capture descendant identities before native cancellation can orphan them.
//! A pidfd pins each signal target; numeric PIDs alone never authorize a signal.
use std::{
    collections::{BTreeMap, VecDeque},
    fs, io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
};

struct Identity {
    parent: i32,
    started: u64,
}

fn identity(pid: i32) -> io::Result<Identity> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    // comm may contain whitespace and closing parentheses.
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .ok_or_else(|| io::Error::other("invalid proc stat"))?
        .1
        .split_whitespace()
        .collect();
    let invalid = || io::Error::other("invalid proc identity");
    Ok(Identity {
        parent: fields
            .get(1)
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?,
        started: fields
            .get(19)
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?,
    })
}

struct Process {
    started: u64,
    fd: OwnedFd,
}

impl Process {
    fn open(pid: i32, expected: &Identity) -> io::Result<Option<Self>> {
        // SAFETY: pidfd_open takes a process ID and zero flags, no pointers.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        // SAFETY: the successful syscall returned a new, exclusively owned fd.
        let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        let Ok(current) = identity(pid) else {
            return Ok(None);
        };
        if current.started != expected.started || current.parent != expected.parent {
            return Ok(None);
        }
        Ok(Some(Self {
            started: current.started,
            fd,
        }))
    }

    fn exited(&self) -> io::Result<bool> {
        let mut poll = libc::pollfd {
            fd: self.fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll points to one initialized pollfd and never blocks.
        if unsafe { libc::poll(&mut poll, 1, 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if poll.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::other("invalid owned pidfd"));
        }
        Ok(poll.revents & (libc::POLLIN | libc::POLLHUP) != 0)
    }

    fn signal(&self, signal: i32) -> io::Result<()> {
        // SAFETY: this fd identifies a captured process, and null siginfo asks
        // the kernel to construct the ordinary signal metadata.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

pub(super) struct ProcessTree {
    processes: BTreeMap<i32, Process>,
}

impl ProcessTree {
    pub(super) fn new(pid: i32) -> io::Result<Self> {
        let root = identity(pid)?;
        let process = Process::open(pid, &root)?
            .ok_or_else(|| io::Error::other("managed root identity changed"))?;
        Ok(Self {
            processes: BTreeMap::from([(pid, process)]),
        })
    }

    pub(super) fn capture(&mut self) -> io::Result<()> {
        let exited = self
            .processes
            .iter()
            .filter_map(|(pid, process)| match process.exited() {
                Ok(true) => Some(Ok(*pid)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<io::Result<Vec<_>>>()?;
        for pid in exited {
            self.processes.remove(&pid);
        }
        let mut children: BTreeMap<i32, Vec<(i32, Identity)>> = BTreeMap::new();
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        for entry in fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            if !entry.metadata().is_ok_and(|metadata| metadata.uid() == uid) {
                continue;
            }
            if let Ok(stat) = identity(pid) {
                children.entry(stat.parent).or_default().push((pid, stat));
            }
        }
        let mut pending: VecDeque<_> = self.processes.keys().copied().collect();
        while let Some(parent) = pending.pop_front() {
            let owned = &self.processes[&parent];
            if owned.exited()?
                || !identity(parent).is_ok_and(|current| current.started == owned.started)
            {
                continue;
            }
            for (pid, stat) in children.remove(&parent).unwrap_or_default() {
                if self.processes.contains_key(&pid) {
                    continue;
                }
                if self.processes.len() >= 16384 {
                    return Err(io::Error::other("owned process capture limit exceeded"));
                }
                if let Some(process) = Process::open(pid, &stat)? {
                    // Recheck the parent after opening the child: its PID must
                    // still denote the live ancestor that authorized capture.
                    if self.processes[&parent].exited()? {
                        break;
                    }
                    self.processes.insert(pid, process);
                    pending.push_back(pid);
                }
            }
        }
        Ok(())
    }

    pub(super) fn signal(&self, signal: i32) -> io::Result<()> {
        let mut result = Ok(());
        for process in self.processes.values().rev() {
            if let Err(error) = process.signal(signal) {
                result = Err(error);
            }
        }
        result
    }

    pub(super) fn is_empty(&self) -> io::Result<bool> {
        for process in self.processes.values() {
            if !process.exited()? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
