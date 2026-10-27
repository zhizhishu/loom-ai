use anyhow::{Context, Result};
use std::time::Duration;

#[cfg(unix)]
pub struct StopSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl StopSignals {
    pub fn register() -> Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt()).context("register SIGINT")?,
            terminate: signal(SignalKind::terminate()).context("register SIGTERM")?,
            hangup: signal(SignalKind::hangup()).context("register SIGHUP")?,
        })
    }

    pub async fn wait(mut self) -> Result<Duration> {
        tokio::select! {
            event = self.interrupt.recv() => event.context("SIGINT listener closed").map(|_| Duration::from_secs(10)),
            event = self.terminate.recv() => event.context("SIGTERM listener closed").map(|_| Duration::from_secs(10)),
            event = self.hangup.recv() => event.context("SIGHUP listener closed").map(|_| Duration::from_secs(10)),
        }
    }
}

#[cfg(windows)]
pub struct StopSignals {
    interrupt: tokio::signal::windows::CtrlC,
    break_signal: tokio::signal::windows::CtrlBreak,
    close: tokio::signal::windows::CtrlClose,
}

#[cfg(windows)]
impl StopSignals {
    pub fn register() -> Result<Self> {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close};
        Ok(Self {
            interrupt: ctrl_c().context("register Ctrl-C")?,
            break_signal: ctrl_break().context("register Ctrl-Break")?,
            close: ctrl_close().context("register console close")?,
        })
    }

    pub async fn wait(mut self) -> Result<Duration> {
        tokio::select! {
            event = self.interrupt.recv() => event.context("Ctrl-C listener closed").map(|_| Duration::from_secs(10)),
            event = self.break_signal.recv() => event.context("Ctrl-Break listener closed").map(|_| Duration::from_secs(10)),
            // Windows normally allows only five seconds after console close.
            event = self.close.recv() => event.context("console-close listener closed").map(|_| Duration::from_secs(4)),
        }
    }
}
