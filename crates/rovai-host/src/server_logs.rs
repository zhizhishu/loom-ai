//! Standalone process diagnostics. Capture stderr itself so existing Core and
//! dependency diagnostics follow the same policy as tracing. Desktop never
//! installs this adapter. Human summaries and credentials use stdout directly.
use anyhow::{Context, Result};
use os_pipe::PipeWriter;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

pub(crate) struct Capture {
    original: PipeWriter,
    redirected: Option<PipeWriter>,
    drained: Option<Receiver<io::Result<()>>>,
}

impl Capture {
    /// Install before any Tokio workers or Core tasks are started.
    pub(crate) fn start(mut log: File, verbose: bool) -> Result<Self> {
        log.seek(SeekFrom::End(0))?;
        let original = os_pipe::dup_stderr()?;
        let mut mirror = original.try_clone()?;
        let (mut reader, writer) = os_pipe::pipe()?;
        let (completed, drained) = mpsc::channel();
        std::thread::Builder::new()
            .name("server-diagnostics".into())
            .spawn(move || {
                let result = (|| {
                    let mut bytes = [0; 8192];
                    loop {
                        let count = match reader.read(&mut bytes) {
                            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                            result => result?,
                        };
                        if count == 0 {
                            break;
                        }
                        log.write_all(&bytes[..count])?;
                        if verbose {
                            // A closed terminal must not prevent file logging or
                            // controlled shutdown after SIGHUP/console close.
                            let _ = mirror.write_all(&bytes[..count]);
                        }
                    }
                    log.sync_data()
                })();
                let _ = completed.send(result);
            })
            .context("could not start Server diagnostic writer")?;
        replace_stderr(&writer).context("could not route Server diagnostics")?;
        Ok(Self {
            original,
            redirected: Some(writer),
            drained: Some(drained),
        })
    }

    pub(crate) fn finish(mut self) -> Result<()> {
        self.restore()
    }

    fn restore(&mut self) -> Result<()> {
        if self.redirected.is_none() {
            return Ok(());
        }
        io::stderr().flush()?;
        replace_stderr(&self.original)?;
        self.redirected.take();
        if let Some(drained) = self.drained.take() {
            drained
                .recv_timeout(Duration::from_secs(1))
                .context("Server diagnostic writer did not finish")??;
        }
        Ok(())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

#[cfg(unix)]
fn replace_stderr(writer: &PipeWriter) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // dup2 replaces fd 2 while retaining ownership of writer. Only the process
    // entry installs/restores this, outside the lifetime of Core worker tasks.
    if unsafe { libc::dup2(writer.as_raw_fd(), libc::STDERR_FILENO) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn replace_stderr(writer: &PipeWriter) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};
    // SetStdHandle borrows the handle; Capture keeps it alive until restoration.
    if unsafe { SetStdHandle(STD_ERROR_HANDLE, writer.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
