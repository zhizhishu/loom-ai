use std::{future::Future, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use rovai_core::application::{CoreRunner, CoreService};
use serde_json::json;
use tokio::task::JoinHandle;

struct CoreTask(JoinHandle<Result<()>>);

impl Drop for CoreTask {
    fn drop(&mut self) {
        // The process-level caller tears down the owned Tokio runtime after this
        // guard. A failed Host must not detach its unique authority runner.
        self.0.abort();
    }
}

pub async fn run(
    core: CoreService,
    runner: CoreRunner,
    stop: impl Future<Output = Result<Duration>>,
    ready: impl Future<Output = Result<()>>,
) -> Result<()> {
    let mut task = CoreTask(tokio::spawn(runner.run()));
    tokio::pin!(stop);
    tokio::select! {
        biased;
        ready = core.wait_ready() => { ready?; }
        result = &mut task.0 => {
            result.context("Core startup task failed")??;
            bail!("Core stopped before Host became ready");
        }
        result = &mut stop => return stop_core(&core, &mut task, result).await,
    }
    tracing::info!("Host Core is ready");
    tokio::select! {
        result = ready => result?,
        result = &mut stop => return stop_core(&core, &mut task, result).await,
        result = &mut task.0 => { result.context("Core task failed during Host startup")??; bail!("Core stopped during Host startup"); }
    }
    let stop_result = tokio::select! {
        result = &mut stop => result,
        result = &mut task.0 => {
            result.context("Core task failed")??;
            bail!("Core stopped without a Host shutdown request");
        }
    };
    stop_core(&core, &mut task, stop_result).await
}

async fn stop_core(
    core: &CoreService,
    task: &mut CoreTask,
    stop_result: Result<Duration>,
) -> Result<()> {
    tracing::info!("Host is stopping");
    // The same deadline includes a signal received during startup, Core's
    // existing cancel-all protocol, the report and actual runner completion.
    let deadline = stop_result?;
    tokio::time::timeout(deadline, async {
        core.wait_ready().await?;
        let reply = core
            .request("core.shutdown", json!({"protocolVersion":3,"deadlineMs":deadline.as_millis() as u64}))
            .await?;
        if let Some(error) = reply.error {
            bail!("Core rejected Host shutdown: {error}");
        }
        let report = reply.result.context("Core shutdown report is missing")?;
        (&mut task.0).await.context("Core shutdown task failed")??;
        ensure!(
            report["protocolVersion"] == 3 && report["status"] == "completed",
            "Core returned an incompatible shutdown report"
        );
        ensure!(
            report["deadlineExpired"] == false
                && report["controlledShutdownCyclePersisted"] == true
                && report["unresolvedExecutions"] == 0,
            "Core shutdown did not complete its durable settlement; inspect startup recovery before retrying work"
        );
        tracing::info!("Host Core stopped after durable settlement");
        Ok(())
    })
    .await
    .context("Host shutdown exceeded its deadline; completion was not confirmed")?
}
