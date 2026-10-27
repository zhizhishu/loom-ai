use rovai_core::application::{
    CoreService, HostControl, HostControlError, HostControlFuture, HostWebOperation,
};
use rovai_web::{AuthStoreFailure, WebConfig, WebServer, WebSessions};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

fn credential_failure(error: &anyhow::Error) -> Option<HostControlError> {
    error
        .downcast_ref::<AuthStoreFailure>()
        .map(|failure| HostControlError {
            code: failure.code(),
            message: failure.message().into(),
        })
}

pub struct WebControl {
    core: CoreService,
    data_dir: PathBuf,
    channels: Option<Arc<crate::desktop_channels::DesktopChannels>>,
    updates: Option<Arc<dyn rovai_web::UpdateHost>>,
    state: Mutex<WebControlState>,
}

impl WebControl {
    pub fn new(
        core: CoreService,
        desktop: bool,
        data_dir: PathBuf,
        updates: Option<Arc<dyn rovai_web::UpdateHost>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            channels: desktop
                .then(|| Arc::new(crate::desktop_channels::DesktopChannels::new(core.clone()))),
            core,
            data_dir,
            updates,
            state: Mutex::new(WebControlState {
                server: None,
                sessions: None,
            }),
        })
    }

    pub async fn start(&self, config: WebConfig, token: &str) -> anyhow::Result<Value> {
        self.state
            .lock()
            .await
            .start(
                self.core.clone(),
                config,
                &self.data_dir,
                Some(token),
                self.channels
                    .clone()
                    .map(|channels| channels as Arc<dyn rovai_web::ChannelHost>),
                self.updates.clone(),
            )
            .await
    }

    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        if let Some(server) = state.server.take() {
            server.shutdown().await;
        }
    }

    pub async fn stop(&self) -> anyhow::Result<()> {
        let mut state = self.state.lock().await;
        // Commit revocation before taking the listener. A failed write keeps it
        // enabled and reports failure instead of promising a durable logout.
        state.credentials(&self.data_dir, None)?.close()?;
        if let Some(server) = state.server.take() {
            server.shutdown().await;
        }
        Ok(())
    }
}

impl HostControl for WebControl {
    fn web(&self, operation: HostWebOperation, params: Value) -> HostControlFuture<'_> {
        Box::pin(async move {
            let invalid = || HostControlError {
                code: "HOST_WEB_INVALID_CONFIG",
                message: "Web 配置无效，请检查监听地址、公开地址和 WebUI 目录。".into(),
            };
            match operation {
                HostWebOperation::ChannelDispatch | HostWebOperation::ChannelReply => {
                    let channels = self.channels.as_ref().ok_or(HostControlError {
                        code: "CHANNELS_UNSUPPORTED",
                        message: "Desktop channels are unavailable in this deployment".into(),
                    })?;
                    if matches!(operation, HostWebOperation::ChannelDispatch) {
                        channels.dispatch(params)
                    } else {
                        channels.reply(params)
                    }
                }
                HostWebOperation::Status => Ok(self
                    .state
                    .lock()
                    .await
                    .server
                    .as_ref()
                    .map(WebServer::status)
                    .unwrap_or_else(|| json!({"enabled":false,"sessions":0}))),
                HostWebOperation::Token => {
                    let token = self
                        .state
                        .lock()
                        .await
                        .credentials(&self.data_dir, None)
                        .map_err(|error| {
                            credential_failure(&error).unwrap_or(HostControlError {
                                code: "HOST_WEB_AUTH_UNAVAILABLE",
                                message: "登录凭据暂不可用，请稍后重试。".into(),
                            })
                        })?
                        .administrator_token();
                    Ok(json!({"administratorToken":token}))
                }
                HostWebOperation::LoginTicket => {
                    let state = self.state.lock().await;
                    let server = state.server.as_ref().ok_or(HostControlError {
                        code: "HOST_WEB_DISABLED",
                        message: "请先开启 Web 服务。".into(),
                    })?;
                    server.login_ticket().map_err(|_| HostControlError {
                        code: "HOST_WEB_TICKET_UNAVAILABLE",
                        message: "扫码登录暂不可用，请重新生成二维码。".into(),
                    })
                }
                HostWebOperation::Start => {
                    let config: WebConfig =
                        serde_json::from_value(params).map_err(|_| invalid())?;
                    let mut state = self.state.lock().await;
                    let mut status = state.start(self.core.clone(), config, &self.data_dir, None, self.channels.clone().map(|channels| channels as Arc<dyn rovai_web::ChannelHost>), self.updates.clone()).await.map_err(|error| credential_failure(&error).unwrap_or(HostControlError { code: "HOST_WEB_START_FAILED", message: "Web 服务未开启。请检查端口是否被占用、WebUI 是否已构建，以及局域网访问是否已明确开启。".into() }))?;
                    // The closed, parent-owned pipe returns this only to the
                    // local manager. It is absent from status and diagnostics.
                    status["administratorToken"] = json!(
                        state
                            .sessions
                            .as_ref()
                            .expect("started credentials")
                            .administrator_token()
                    );
                    Ok(status)
                }
                HostWebOperation::Stop => {
                    self.stop().await.map_err(|error| {
                        credential_failure(&error).unwrap_or(HostControlError {
                            code: "HOST_WEB_STOP_FAILED",
                            message: "会话撤销未能保存，关闭操作未完成，请检查数据目录后重试。"
                                .into(),
                        })
                    })?;
                    Ok(json!({"enabled":false,"sessions":0}))
                }
                HostWebOperation::Rotate => {
                    let state = self.state.lock().await;
                    let server = state.server.as_ref().ok_or(HostControlError {
                        code: "HOST_WEB_DISABLED",
                        message: "请先开启 Web 服务。".into(),
                    })?;
                    let token = server
                        .rotate()
                        .map_err(|error| credential_failure(&error).unwrap_or_else(invalid))?;
                    let mut status = server.status();
                    status["administratorToken"] = json!(token);
                    Ok(status)
                }
            }
        })
    }
}

// Credentials are opened lazily, after Core readiness / data-dir admission.
struct WebControlState {
    server: Option<WebServer>,
    sessions: Option<Arc<WebSessions>>,
}

impl WebControlState {
    fn credentials(
        &mut self,
        data_dir: &std::path::Path,
        bootstrap: Option<&str>,
    ) -> anyhow::Result<Arc<WebSessions>> {
        if self.sessions.is_none() {
            self.sessions = Some(Arc::new(WebSessions::open(data_dir, bootstrap)?));
        }
        Ok(self
            .sessions
            .as_ref()
            .expect("credentials initialized")
            .clone())
    }

    async fn start(
        &mut self,
        core: CoreService,
        config: WebConfig,
        data_dir: &std::path::Path,
        bootstrap: Option<&str>,
        channels: Option<Arc<dyn rovai_web::ChannelHost>>,
        updates: Option<Arc<dyn rovai_web::UpdateHost>>,
    ) -> anyhow::Result<Value> {
        anyhow::ensure!(self.server.is_none(), "Web service is already running");
        let sessions = self.credentials(data_dir, bootstrap)?;
        let running =
            WebServer::start_with_services(core, config, sessions, channels, updates).await?;
        let status = running.status();
        self.server = Some(running);
        Ok(status)
    }
}
