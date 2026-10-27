//! Short-lived downloads authorized at preparation and admitted by ticket and
//! Session. File transfer uses bounded I/O without further Core queries.
use super::*;
use axum::{body::Bytes, http::Method};
use rovai_core::local_attachment_snapshot::open_resolved_file_without_following;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, mpsc},
};

const ADMISSION_WINDOW: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const CHUNK: usize = 64 * 1024;
static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);

pub(super) struct Downloads {
    tickets: Mutex<HashMap<[u8; 32], Arc<Ticket>>>,
    active: Arc<Semaphore>,
    preparing: Arc<Semaphore>,
    max_bytes: Option<u64>,
}
struct Ticket {
    session: Weak<Session>,
    target: resources::DownloadTarget,
    expires: Instant,
    active: Arc<Semaphore>,
    completed: AtomicBool,
}
impl Downloads {
    pub fn new() -> Result<Self> {
        let max_bytes = std::env::var("ROVAI_WEB_DOWNLOAD_MAX_BYTES")
            .ok()
            .map(|value| {
                value
                    .parse::<u64>()
                    .context("ROVAI_WEB_DOWNLOAD_MAX_BYTES must be an unsigned byte count")
            })
            .transpose()?;
        Ok(Self {
            tickets: Mutex::new(HashMap::new()),
            active: Arc::new(Semaphore::new(8)),
            preparing: Arc::new(Semaphore::new(4)),
            max_bytes,
        })
    }
    fn lookup(&self, token: &str) -> Result<Arc<Ticket>> {
        ensure!(
            token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()),
            "download_expired"
        );
        self.tickets
            .lock()
            .expect("download registry poisoned")
            .get(&digest(token))
            .filter(|ticket| ticket.expires > Instant::now())
            .cloned()
            .context("download_expired")
    }
    fn check_size(&self, size: u64) -> Result<()> {
        ensure!(
            self.max_bytes.is_none_or(|max| size <= max),
            "download_too_large"
        );
        Ok(())
    }
}
pub(super) fn capabilities(state: &WebState) -> Value {
    json!({"uploadMaxBytes":uploads::MAX_BYTES,"nativeDownload":true,
        "downloadMaxBytes":state.downloads.max_bytes,"downloadAdmissionSeconds":ADMISSION_WINDOW.as_secs()})
}
fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn make_ticket_room(
    tickets: &mut HashMap<[u8; 32], Arc<Ticket>>,
    session: &Weak<Session>,
) -> Result<()> {
    loop {
        let session_full = tickets
            .values()
            .filter(|ticket| ticket.session.ptr_eq(session))
            .count()
            >= 16;
        if tickets.len() < 256 && !session_full {
            return Ok(());
        }
        // Completed tickets remain retryable until expiry or cache pressure.
        // Never evict an active transfer or consume a ticket merely for HEAD.
        let oldest = tickets
            .iter()
            .filter(|(_, ticket)| {
                ticket.completed.load(Ordering::Acquire)
                    && ticket.active.available_permits() == 1
                    && (!session_full || ticket.session.ptr_eq(session))
            })
            .min_by_key(|(_, ticket)| ticket.expires)
            .map(|(key, _)| *key)
            .context("download_ticket_capacity")?;
        tickets.remove(&oldest);
    }
}

struct Progress {
    operation: u64,
    emitted: AtomicU64,
    settled: AtomicBool,
}
impl Progress {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            operation: NEXT_OPERATION.fetch_add(1, Ordering::Relaxed),
            emitted: AtomicU64::new(0),
            settled: AtomicBool::new(false),
        })
    }
    fn interrupted(&self, error: &anyhow::Error) {
        if self.settled.swap(true, Ordering::AcqRel) {
            return;
        }
        let stage = error
            .chain()
            .filter_map(|cause| match cause.to_string().as_str() {
                "read" => Some("read"),
                "send" => Some("send"),
                _ => None,
            })
            .last()
            .unwrap_or("response");
        // Only closed, non-sensitive fields: never the ticket, URL, source or path.
        eprintln!(
            "{}",
            json!({"event":"web.download.interrupted","operationId":self.operation,
            "stage":stage,"code":error_code(error),"bytesEmitted":self.emitted.load(Ordering::Acquire)})
        );
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Prepare {
    Source {
        source: Value,
    },
    Preview {
        #[serde(rename = "handleId")]
        handle_id: String,
        #[serde(rename = "expectedGeneration")]
        // Accepted for older clients only; downloads do not pin a preview version.
        _legacy_generation: Option<String>,
    },
}
pub(super) async fn prepare(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Json(request): Json<Prepare>,
) -> Response {
    let result = async {
        let permit = Arc::new(
            state
                .downloads
                .preparing
                .clone()
                .try_acquire_owned()
                .context("download_capacity")?,
        );
        let mut target = match request {
            Prepare::Source { source } => {
                resources::download_source(&state, &session, source).await?
            }
            Prepare::Preview { handle_id, .. } => {
                resources::download_preview(&state, &session, &handle_id).await?
            }
        };
        target.name = target
            .name
            .chars()
            .map(|c| {
                if c.is_control() || matches!(c, '/' | '\\') {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        if target.name.is_empty() || matches!(target.name.as_str(), "." | "..") {
            target.name = "attachment".to_owned();
        }
        let (_, size) = open(&target.path, permit).await?;
        state.downloads.check_size(size)?;
        ensure!(state.sessions.is_live(&session), "session_required");
        let token = new_token()?;
        let ticket = Arc::new(Ticket {
            session: Arc::downgrade(&session),
            target,
            expires: Instant::now() + ADMISSION_WINDOW,
            active: Arc::new(Semaphore::new(1)),
            completed: AtomicBool::new(false),
        });
        let mut tickets = state
            .downloads
            .tickets
            .lock()
            .expect("download registry poisoned");
        tickets.retain(|_, ticket| {
            ticket.expires > Instant::now()
                && ticket
                    .session
                    .upgrade()
                    .is_some_and(|session| state.sessions.is_live(&session))
        });
        make_ticket_room(&mut tickets, &ticket.session)?;
        let reply = json!({"url":format!("/api/v1/downloads/{token}"),"name":ticket.target.name,
            "byteSize":size,"expiresInSeconds":ADMISSION_WINDOW.as_secs()});
        tickets.insert(digest(&token), ticket);
        Ok::<_, anyhow::Error>(Json(reply).into_response())
    }
    .await;
    result.unwrap_or_else(failure)
}

/// Keep capacity in the blocking task itself, even if its HTTP future is dropped.
async fn open(
    path: &std::path::Path,
    capacity: impl Send + 'static,
) -> Result<(std::fs::File, u64)> {
    let path = path.to_owned();
    resources::blocking(capacity, move || {
        let file = open_resolved_file_without_following(&path).map_err(|error| {
            let code = if error.to_string() == "resolved file is not regular" {
                "not_regular_file"
            } else {
                match error
                    .downcast_ref::<std::io::Error>()
                    .map(std::io::Error::kind)
                {
                    Some(std::io::ErrorKind::NotFound) => "file_not_found",
                    Some(std::io::ErrorKind::PermissionDenied) => "file_unreadable",
                    _ => "download_unavailable",
                }
            };
            error.context(code)
        })?;
        let size = file.metadata().context("file_unreadable")?.len();
        Ok((file, size))
    })
    .await
}

/// Lease belongs to the HTTP body, including queued bytes after the reader
/// finishes. On cancellation the worker releases it even for an unpolled body.
struct Lease(Mutex<Option<Vec<OwnedSemaphorePermit>>>);
impl Lease {
    fn release(&self) {
        self.0.lock().expect("download lease poisoned").take();
    }
}
struct Transfer {
    task: JoinHandle<()>,
    lease: Arc<Lease>,
    progress: Arc<Progress>,
    // Retain the active Session against idle eviction, without watching revocation.
    _session: Arc<Session>,
}
impl Drop for Transfer {
    fn drop(&mut self) {
        self.task.abort();
        self.lease.release();
        self.progress
            .interrupted(&anyhow::anyhow!("client_disconnected"));
    }
}

pub(super) async fn file(
    State(state): State<WebState>,
    Path(token): Path<String>,
    method: Method,
) -> Response {
    let result = async {
        let ticket = state.downloads.lookup(&token)?;
        let session = ticket.session.upgrade().context("session_required")?;
        ensure!(state.sessions.is_live(&session), "session_required");
        let prepare = state.downloads.preparing.clone().try_acquire_owned().context("download_capacity")?;
        let (file, size) = open(&ticket.target.path, prepare).await?;
        state.downloads.check_size(size)?;
        ensure!(state.sessions.is_live(&session), "session_required");
        let body = if method == Method::HEAD || size == 0 {
            if method == Method::GET { ticket.completed.store(true, Ordering::Release); }
            Body::empty()
        } else {
            let permits = vec![state.downloads.active.clone().try_acquire_owned().context("download_capacity")?,
                session.downloads.clone().try_acquire_owned().context("download_capacity")?,
                ticket.active.clone().try_acquire_owned().context("download_capacity")?];
            let lease = Arc::new(Lease(Mutex::new(Some(permits))));
            let worker_lease = lease.clone();
            let (tx, mut rx) = mpsc::channel::<Option<Bytes>>(1);
            let progress = Progress::new();
            let worker_progress = progress.clone();
            let task = tokio::spawn(async move {
                let result = tokio::select! {
                    _ = tx.closed() => Err(anyhow::anyhow!("client_disconnected")),
                    result = async {
                        pump(file, size, &tx).await?;
                        tokio::time::timeout(IDLE_TIMEOUT, tx.send(None)).await.context("send")?.context("client_disconnected")?;
                        tokio::time::timeout(IDLE_TIMEOUT, tx.closed()).await.context("send")?;
                        Ok::<_, anyhow::Error>(())
                    } => result,
                };
                if let Err(error) = result {
                    worker_progress.interrupted(&error);
                    worker_lease.release();
                }
            });
            let transfer = Transfer { task, lease, progress: progress.clone(), _session: session };
            let body_ticket = ticket.clone();
            Body::from_stream(async_stream::stream! {
                let _transfer = transfer;
                loop {
                    match rx.recv().await {
                        Some(Some(bytes)) => {
                            if progress.emitted.fetch_add(bytes.len() as u64, Ordering::AcqRel) + bytes.len() as u64 == size {
                                progress.settled.store(true, Ordering::Release);
                                body_ticket.completed.store(true, Ordering::Release);
                            }
                            yield Ok(bytes);
                        }
                        Some(None) => break,
                        None => { yield Err(std::io::Error::other("download interrupted")); break; }
                    }
                }
            })
        };
        Ok::<_, anyhow::Error>(Response::builder().status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_DISPOSITION, resources::disposition(&ticket.target.name))
            .header(header::CONTENT_LENGTH, size)
            .header(header::ACCEPT_RANGES, "none")
            .header("x-accel-buffering", "no")
            .body(body)?)
    }.await;
    result.unwrap_or_else(failure)
}

async fn pump(file: std::fs::File, size: u64, tx: &mpsc::Sender<Option<Bytes>>) -> Result<()> {
    let mut reader = tokio::fs::File::from_std(file);
    let mut remaining = size;
    while remaining > 0 {
        let mut bytes = vec![0; remaining.min(CHUNK as u64) as usize];
        tokio::time::timeout(IDLE_TIMEOUT, reader.read_exact(&mut bytes))
            .await
            .context("read")?
            .context("read")?;
        remaining -= bytes.len() as u64;
        tokio::time::timeout(IDLE_TIMEOUT, tx.send(Some(Bytes::from(bytes))))
            .await
            .context("send")?
            .context("client_disconnected")?;
    }
    Ok(())
}

fn error_code(error_value: &anyhow::Error) -> &'static str {
    let known = [
        "session_required",
        "source_not_authorized",
        "file_not_found",
        "not_regular_file",
        "file_unreadable",
        "download_too_large",
        "download_expired",
        "download_capacity",
        "download_ticket_capacity",
        "client_disconnected",
        "core_unavailable",
    ];
    error_value
        .chain()
        .find_map(|error| {
            known
                .iter()
                .copied()
                .find(|code| error.to_string() == *code)
        })
        .unwrap_or_else(|| {
            if error_value
                .downcast_ref::<tokio::time::error::Elapsed>()
                .is_some()
            {
                "download_timeout"
            } else if error_value.downcast_ref::<std::io::Error>().is_some() {
                "read_failed"
            } else {
                "download_unavailable"
            }
        })
}
fn failure(error_value: anyhow::Error) -> Response {
    let code = error_code(&error_value);
    let status = match code {
        "session_required" => StatusCode::UNAUTHORIZED,
        "source_not_authorized" => StatusCode::FORBIDDEN,
        "file_not_found" => StatusCode::NOT_FOUND,
        "download_expired" => StatusCode::GONE,
        "download_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
        "download_capacity" | "download_ticket_capacity" => StatusCode::TOO_MANY_REQUESTS,
        "core_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        "download_timeout" => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_REQUEST,
    };
    super::error(status, code)
}
