use anyhow::{Context, Result, ensure};
#[cfg(any(not(windows), test))]
use rovai_core::platform::{atomic_write_private_bytes, open_private_read_file};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Semaphore, watch};

pub const SESSION_LIFETIME: Duration = Duration::from_secs(30 * 24 * 60 * 60);
pub const RENEWAL_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const LOGIN_TICKET_LIFETIME: Duration = Duration::from_secs(120);
const MAX_SESSIONS: usize = 32;
const LOGIN_ATTEMPTS: usize = 12;
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const STORE_FILE: &str = "web-auth.json";

type Registry = HashMap<[u8; 32], Arc<Session>>;
// Credentials deliberately have no Debug implementation. Host owns the private
// document under its admitted data-dir lease; no raw Bearer or editor proof is stored.
pub struct Sessions {
    state: Mutex<SessionState>,
    path: Option<PathBuf>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}
struct SessionState {
    enabled: bool,
    administrator: [u8; 32],
    administrator_plaintext: String,
    sessions: Registry,
    attempts: VecDeque<Instant>,
    generation: u64,
    ticket: Option<LoginTicket>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAuth {
    version: u32,
    administrator_token: String,
    sessions: Vec<StoredSession>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSession {
    digest: [u8; 32],
    client_id: String,
    expires_at: u64,
    #[serde(default)]
    last_used_at: u64,
}
struct LoginTicket {
    digest: [u8; 32],
    expires_at: Instant,
}
pub struct TicketGrant {
    generation: u64,
    digest: [u8; 32],
}
pub struct Session {
    pub client_id: String,
    pub expires_at: watch::Sender<u64>,
    pub revoked: watch::Sender<bool>,
    pub streams: Arc<Semaphore>,
    pub downloads: Arc<Semaphore>,
    last_used_at: AtomicU64,
}
impl Session {
    fn new(client_id: String, expires_at: u64, last_used_at: u64) -> Arc<Self> {
        Arc::new(Self {
            client_id,
            expires_at: watch::channel(expires_at).0,
            revoked: watch::channel(false).0,
            streams: Arc::new(Semaphore::new(2)),
            downloads: Arc::new(Semaphore::new(2)),
            last_used_at: AtomicU64::new(last_used_at),
        })
    }
    pub fn expiry(&self) -> u64 {
        *self.expires_at.borrow()
    }
}
pub enum LoginFailure {
    Throttled,
    Unauthorized,
    Capacity,
    Storage(AuthStoreFailure),
}

/// Safe public diagnostics. Internal error chains and credential values never
/// become a Desktop/HTTP error message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStoreFailure {
    ReadDenied,
    Read,
    SaveDenied,
    Save,
    Content,
    Path,
}
impl AuthStoreFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::ReadDenied | Self::Read => "HOST_WEB_AUTH_READ_FAILED",
            Self::SaveDenied | Self::Save => "HOST_WEB_AUTH_SAVE_FAILED",
            Self::Content => "HOST_WEB_AUTH_INVALID_CONTENT",
            Self::Path => "HOST_WEB_AUTH_INVALID_PATH",
        }
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::ReadDenied => "无法读取登录凭据：操作系统拒绝访问。原文件已保留。",
            Self::Read => {
                "无法读取登录凭据：文件读取失败，请检查文件是否被占用后重试。原文件已保留。"
            }
            Self::SaveDenied => {
                "无法保存登录状态：操作系统拒绝写入或替换凭据文件。原登录凭据未被修改。"
            }
            Self::Save => {
                "无法保存登录状态：写入或原子替换失败，请检查磁盘空间及文件占用后重试。原登录凭据未被修改。"
            }
            Self::Content => {
                "登录凭据文件内容异常，无法使用。请恢复有效的凭据文件；原文件未被覆盖。"
            }
            Self::Path => {
                "登录凭据文件路径或身份异常，无法使用。请检查数据目录中的文件路径；原文件已保留。"
            }
        }
    }
    fn io(error: &anyhow::Error, saving: bool) -> Self {
        #[cfg(windows)]
        if error.is::<rovai_core::platform::WebAuthPathError>() {
            return Self::Path;
        }
        match error.downcast_ref::<std::io::Error>() {
            Some(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                if saving {
                    Self::SaveDenied
                } else {
                    Self::ReadDenied
                }
            }
            Some(_) => {
                if saving {
                    Self::Save
                } else {
                    Self::Read
                }
            }
            None => Self::Path,
        }
    }
    pub(crate) fn saving(error: anyhow::Error) -> Self {
        error.downcast_ref::<Self>().copied().unwrap_or(Self::Save)
    }
}
impl std::fmt::Display for AuthStoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for AuthStoreFailure {}

fn open_store_file(path: &Path) -> Result<std::fs::File> {
    #[cfg(windows)]
    let opened =
        rovai_core::platform::open_web_auth_read_file(path.parent().expect("store parent"));
    #[cfg(not(windows))]
    let opened = open_private_read_file(path);
    opened.map_err(|error| {
        let failure = AuthStoreFailure::io(&error, false);
        error.context(failure)
    })
}
fn write_store_file(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(windows)]
    let written = rovai_core::platform::atomic_write_web_auth_bytes(
        path.parent().expect("store parent"),
        bytes,
    );
    #[cfg(not(windows))]
    let written = atomic_write_private_bytes(path, bytes);
    written.map_err(|error| {
        let failure = AuthStoreFailure::io(&error, true);
        error.context(failure)
    })
}

fn wall_clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn milliseconds(duration: Duration) -> u64 {
    duration.as_millis() as u64
}
pub fn new_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("system random source unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn digest(kind: &[u8], token: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(kind);
    hash.update(token.as_bytes());
    hash.finalize().into()
}
fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn read_store(path: &Path) -> Result<Option<StoredAuth>> {
    // symlink_metadata also detects a dangling symlink; file admission rejects
    // links and non-regular objects instead of treating them as a new store.
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => {
            let metadata = result.map_err(|error| {
                let error = anyhow::Error::from(error);
                let failure = AuthStoreFailure::io(&error, false);
                error.context(failure)
            })?;
            ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                AuthStoreFailure::Path
            );
        }
    }
    let mut bytes = Vec::new();
    open_store_file(path)?
        .take(65537)
        .read_to_end(&mut bytes)
        .context(AuthStoreFailure::Read)?;
    ensure!(bytes.len() <= 65536, AuthStoreFailure::Content);
    let stored: StoredAuth = serde_json::from_slice(&bytes).context(AuthStoreFailure::Content)?;
    ensure!(
        stored.version == 1
            && valid_token(&stored.administrator_token)
            && stored.sessions.len() <= MAX_SESSIONS
            && stored
                .sessions
                .iter()
                .all(|session| valid_token(&session.client_id) && session.expires_at > 0),
        AuthStoreFailure::Content
    );
    let mut digests = std::collections::HashSet::new();
    let mut editors = std::collections::HashSet::new();
    ensure!(
        stored
            .sessions
            .iter()
            .all(|session| digests.insert(session.digest) && editors.insert(&session.client_id)),
        AuthStoreFailure::Content
    );
    Ok(Some(stored))
}
/// Read-only local Token command. An existing unified document takes precedence
/// over the standalone preview's legacy server-token bootstrap file.
pub fn stored_administrator_token(data_dir: &Path) -> Result<Option<String>> {
    Ok(read_store(&data_dir.join(STORE_FILE))?.map(|stored| stored.administrator_token))
}

impl Sessions {
    pub fn new(administrator: &str) -> Result<Self> {
        ensure!(
            valid_token(administrator),
            "administrator token must be 32 random bytes encoded as 64 hexadecimal characters"
        );
        Ok(Self {
            state: Mutex::new(SessionState {
                enabled: true,
                administrator: digest(b"rovai-administrator-v1\0", administrator),
                administrator_plaintext: administrator.to_owned(),
                sessions: HashMap::new(),
                attempts: VecDeque::new(),
                generation: 0,
                ticket: None,
            }),
            path: None,
            clock: Arc::new(wall_clock),
        })
    }
    /// Called only after Core admits the data-dir lease. Invalid or unreadable
    /// state fails closed; ordinary restart never generates replacement credentials.
    pub fn open(data_dir: &Path, bootstrap: Option<&str>) -> Result<Self> {
        Self::open_with_clock(data_dir, bootstrap, Arc::new(wall_clock))
    }
    fn open_with_clock(
        data_dir: &Path,
        bootstrap: Option<&str>,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Result<Self> {
        let path = data_dir.join(STORE_FILE);
        let stored = read_store(&path)?;
        let token = match &stored {
            Some(stored) => stored.administrator_token.clone(),
            None => match bootstrap {
                Some(token) => token.to_owned(),
                None => new_token()?,
            },
        };
        if let Some(bootstrap) = bootstrap {
            ensure!(
                bool::from(token.as_bytes().ct_eq(bootstrap.as_bytes())),
                "A different login Token is already stored; use the existing Token or explicitly reset it"
            );
        }
        let mut result = Self::new(&token)?;
        result.path = Some(path);
        result.clock = clock;
        let mut state = result.state.lock().expect("session registry poisoned");
        if let Some(stored) = stored {
            for entry in stored.sessions {
                if entry.expires_at > result.now() {
                    state.sessions.insert(
                        entry.digest,
                        Session::new(entry.client_id, entry.expires_at, entry.last_used_at),
                    );
                }
            }
        } else {
            result.persist(&state.administrator_plaintext, &state.sessions, None)?;
        }
        drop(state);
        Ok(result)
    }
    pub fn now(&self) -> u64 {
        (self.clock)()
    }
    pub fn timing(&self, session: &Session) -> serde_json::Value {
        let now = self.now();
        let expiry = session.expiry();
        serde_json::json!({"expiresAt":expiry,"serverTime":now,
            "expiresInSeconds":expiry.saturating_sub(now) / 1000,
            "renewalWindowSeconds":RENEWAL_WINDOW.as_secs()})
    }
    fn persist(
        &self,
        administrator: &str,
        sessions: &Registry,
        renewal: Option<(&Session, u64)>,
    ) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let stored = StoredAuth {
            version: 1,
            administrator_token: administrator.to_owned(),
            sessions: sessions
                .iter()
                .map(|(digest, session)| StoredSession {
                    digest: *digest,
                    client_id: session.client_id.clone(),
                    expires_at: renewal
                        .filter(|(renewed, _)| std::ptr::eq(*renewed, session.as_ref()))
                        .map_or_else(|| session.expiry(), |(_, expiry)| expiry),
                    last_used_at: session.last_used_at.load(Ordering::Relaxed),
                })
                .collect(),
        };
        write_store_file(
            path,
            &serde_json::to_vec(&stored).context(AuthStoreFailure::Save)?,
        )
    }
    // Publish to disk before changing memory or notifying streams. Renewal and
    // revocation use this same mutex, so a late response cannot resurrect a grant.
    fn replace(&self, state: &mut SessionState, token: &str, sessions: Registry) -> Result<()> {
        self.persist(token, &sessions, None)?;
        for (key, old) in &state.sessions {
            if !sessions.get(key).is_some_and(|next| Arc::ptr_eq(next, old)) {
                old.revoked.send_replace(true);
            }
        }
        state.sessions = sessions;
        state.administrator = digest(b"rovai-administrator-v1\0", token);
        state.administrator_plaintext = token.to_owned();
        Ok(())
    }
    #[cfg(test)]
    pub fn login(
        &self,
        administrator: &str,
    ) -> std::result::Result<(String, Arc<Session>), LoginFailure> {
        let generation = self.authorize_login(administrator)?;
        self.issue(generation, new_token().map_err(|_| LoginFailure::Capacity)?)
    }
    pub fn authorize_login(&self, administrator: &str) -> std::result::Result<u64, LoginFailure> {
        let mut state = self.state.lock().expect("session registry poisoned");
        Self::admit_login(&mut state, Instant::now())?;
        let candidate = digest(b"rovai-administrator-v1\0", administrator);
        if !valid_token(administrator) || !bool::from(state.administrator.ct_eq(&candidate)) {
            return Err(LoginFailure::Unauthorized);
        }
        Ok(state.generation)
    }
    fn admit_login(
        state: &mut SessionState,
        now: Instant,
    ) -> std::result::Result<(), LoginFailure> {
        if !state.enabled {
            return Err(LoginFailure::Unauthorized);
        }
        while state
            .attempts
            .front()
            .is_some_and(|time| now.duration_since(*time) >= LOGIN_WINDOW)
        {
            state.attempts.pop_front();
        }
        if state.attempts.len() >= LOGIN_ATTEMPTS {
            return Err(LoginFailure::Throttled);
        }
        state.attempts.push_back(now);
        Ok(())
    }
    pub fn login_ticket(&self) -> Result<String> {
        let token = new_token()?;
        let mut state = self.state.lock().expect("session registry poisoned");
        ensure!(state.enabled, "Web service is disabled");
        state.ticket = Some(LoginTicket {
            digest: digest(b"rovai-login-ticket-v1\0", &token),
            expires_at: Instant::now() + LOGIN_TICKET_LIFETIME,
        });
        Ok(token)
    }
    pub fn authorize_ticket(&self, ticket: &str) -> std::result::Result<TicketGrant, LoginFailure> {
        let mut state = self.state.lock().expect("session registry poisoned");
        let now = Instant::now();
        Self::admit_login(&mut state, now)?;
        let candidate = digest(b"rovai-login-ticket-v1\0", ticket);
        if !valid_token(ticket)
            || !state.ticket.as_ref().is_some_and(|stored| {
                stored.expires_at > now && bool::from(stored.digest.ct_eq(&candidate))
            })
        {
            return Err(LoginFailure::Unauthorized);
        }
        Ok(TicketGrant {
            generation: state.generation,
            digest: candidate,
        })
    }
    pub fn issue_ticket(
        &self,
        grant: TicketGrant,
        client_id: String,
    ) -> std::result::Result<(String, Arc<Session>), LoginFailure> {
        let mut state = self.state.lock().expect("session registry poisoned");
        if !state.ticket.as_ref().is_some_and(|stored| {
            stored.expires_at > Instant::now() && bool::from(stored.digest.ct_eq(&grant.digest))
        }) {
            return Err(LoginFailure::Unauthorized);
        }
        let result = self.issue_locked(&mut state, grant.generation, client_id)?;
        state.ticket = None;
        Ok(result)
    }
    pub fn issue(
        &self,
        generation: u64,
        client_id: String,
    ) -> std::result::Result<(String, Arc<Session>), LoginFailure> {
        let mut state = self.state.lock().expect("session registry poisoned");
        self.issue_locked(&mut state, generation, client_id)
    }
    fn issue_locked(
        &self,
        state: &mut SessionState,
        generation: u64,
        client_id: String,
    ) -> std::result::Result<(String, Arc<Session>), LoginFailure> {
        if !state.enabled || state.generation != generation || !valid_token(&client_id) {
            return Err(LoginFailure::Unauthorized);
        }
        self.insert(
            state,
            client_id,
            self.now() + milliseconds(SESSION_LIFETIME),
        )
    }
    fn insert(
        &self,
        state: &mut SessionState,
        client_id: String,
        expiry: u64,
    ) -> std::result::Result<(String, Arc<Session>), LoginFailure> {
        let now = self.now();
        // Select before cloning the registry: a sole Arc belongs to the registry
        // only. Authenticated requests and SSE streams retain their own Arc, so
        // they (including the fork parent) cannot be evicted mid-use. Admission
        // and authentication share this lock; no new reader can race selection.
        let oldest_idle = state
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.expiry() > now
                    && session.client_id != client_id
                    && Arc::strong_count(session) == 1
            })
            .min_by_key(|(key, session)| (session.last_used_at.load(Ordering::Relaxed), **key))
            .map(|(key, _)| *key);
        let mut next = state.sessions.clone();
        next.retain(|_, session| session.expiry() > now && session.client_id != client_id);
        if next.len() >= MAX_SESSIONS {
            let Some(oldest_idle) = oldest_idle else {
                return Err(LoginFailure::Capacity);
            };
            next.remove(&oldest_idle);
        }
        let token = new_token().map_err(|_| LoginFailure::Capacity)?;
        let session = Session::new(client_id, expiry, now);
        next.insert(digest(b"rovai-session-v1\0", &token), session.clone());
        self.replace(state, &state.administrator_plaintext.clone(), next)
            .map_err(|error| LoginFailure::Storage(AuthStoreFailure::saving(error)))?;
        Ok((token, session))
    }
    fn live(&self, state: &SessionState, session: &Session) -> bool {
        self.live_at(state, session, self.now())
    }
    fn live_at(&self, state: &SessionState, session: &Session, now: u64) -> bool {
        state.enabled
            && session.expiry() > now
            && !*session.revoked.borrow()
            && state
                .sessions
                .values()
                .any(|stored| std::ptr::eq(stored.as_ref(), session))
    }
    pub fn is_live(&self, session: &Session) -> bool {
        self.live(
            &self.state.lock().expect("session registry poisoned"),
            session,
        )
    }
    pub fn fork(
        &self,
        parent: &Session,
        client_id: String,
    ) -> std::result::Result<(String, Arc<Session>), LoginFailure> {
        let mut state = self.state.lock().expect("session registry poisoned");
        if !self.live(&state, parent) || !valid_token(&client_id) || client_id == parent.client_id {
            return Err(LoginFailure::Unauthorized);
        }
        self.insert(&mut state, client_id, parent.expiry())
    }
    pub fn renew(&self, session: &Session) -> std::result::Result<serde_json::Value, LoginFailure> {
        let state = self.state.lock().expect("session registry poisoned");
        let now = self.now();
        if !self.live_at(&state, session, now) {
            return Err(LoginFailure::Unauthorized);
        }
        if session.expiry().saturating_sub(now) <= milliseconds(RENEWAL_WINDOW) {
            let expiry = now + milliseconds(SESSION_LIFETIME);
            self.persist(
                &state.administrator_plaintext,
                &state.sessions,
                Some((session, expiry)),
            )
            .map_err(|error| LoginFailure::Storage(AuthStoreFailure::saving(error)))?;
            session.expires_at.send_replace(expiry);
        }
        Ok(self.timing(session))
    }
    pub fn administrator_token(&self) -> String {
        self.state
            .lock()
            .expect("session registry poisoned")
            .administrator_plaintext
            .clone()
    }
    pub fn authenticate(&self, token: &str) -> Option<Arc<Session>> {
        if !valid_token(token) {
            return None;
        }
        let state = self.state.lock().expect("session registry poisoned");
        let session = state.sessions.get(&digest(b"rovai-session-v1\0", token))?;
        self.live(&state, session).then(|| {
            session.last_used_at.store(self.now(), Ordering::Relaxed);
            session.clone()
        })
    }
    pub fn revoke(&self, session: &Session) -> Result<()> {
        let mut state = self.state.lock().expect("session registry poisoned");
        let mut next = state.sessions.clone();
        next.retain(|_, stored| !std::ptr::eq(stored.as_ref(), session));
        let token = state.administrator_plaintext.clone();
        self.replace(&mut state, &token, next)
    }
    pub fn rotate(&self, administrator: &str) -> Result<()> {
        ensure!(valid_token(administrator), "invalid administrator token");
        let mut state = self.state.lock().expect("session registry poisoned");
        self.replace(&mut state, administrator, HashMap::new())?;
        state.generation += 1;
        state.attempts.clear();
        state.ticket = None;
        Ok(())
    }
    /// Explicit Web disable revokes all Sessions durably but retains the Token.
    pub fn close(&self) -> Result<()> {
        let mut state = self.state.lock().expect("session registry poisoned");
        let token = state.administrator_plaintext.clone();
        self.replace(&mut state, &token, HashMap::new())?;
        state.enabled = false;
        state.generation += 1;
        state.ticket = None;
        Ok(())
    }
    /// Ordinary process shutdown ends streams/tickets, without altering disk.
    pub fn suspend(&self) {
        let mut state = self.state.lock().expect("session registry poisoned");
        state.enabled = false;
        state.generation += 1;
        state.ticket = None;
        for session in state.sessions.values() {
            session.revoked.send_replace(true);
        }
    }
    pub fn enable(&self) {
        let mut state = self.state.lock().expect("session registry poisoned");
        state.enabled = true;
        for session in state.sessions.values() {
            session.revoked.send_replace(false);
        }
    }
    pub fn count(&self) -> usize {
        let state = self.state.lock().expect("session registry poisoned");
        state
            .sessions
            .values()
            .filter(|session| self.live(&state, session))
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // This pure owner covers credential state transitions; it deliberately has
    // no Core, files, sockets, timers or Runtime fixture.
    #[test]
    fn sessions_are_independent_revocable_expiring_and_do_not_survive_listener_close() {
        // The existing credential lifecycle owner also covers one-time ticket
        // expiry, replacement and the authorization-to-commit race, without timeouts.
        let tickets = Arc::new(Sessions::new(&new_token().unwrap()).unwrap());
        let old_ticket = tickets.login_ticket().unwrap();
        let old_grant = tickets.authorize_ticket(&old_ticket).ok().unwrap();
        let ticket = tickets.login_ticket().unwrap();
        assert!(tickets.authorize_ticket(&old_ticket).is_err());
        assert!(
            tickets
                .issue_ticket(old_grant, new_token().unwrap())
                .is_err()
        );
        let left = tickets.authorize_ticket(&ticket).ok().unwrap();
        let right = tickets.authorize_ticket(&ticket).ok().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = [left, right]
            .into_iter()
            .map(|grant| {
                let tickets = tickets.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    tickets.issue_ticket(grant, new_token().unwrap()).is_ok()
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| usize::from(worker.join().unwrap()))
                .sum::<usize>(),
            1
        );
        assert_eq!(tickets.count(), 1);
        assert!(tickets.authorize_ticket(&ticket).is_err());
        let expired = tickets.login_ticket().unwrap();
        let grant = tickets.authorize_ticket(&expired).ok().unwrap();
        tickets
            .state
            .lock()
            .unwrap()
            .ticket
            .as_mut()
            .unwrap()
            .expires_at = Instant::now();
        assert!(tickets.authorize_ticket(&expired).is_err());
        assert!(tickets.issue_ticket(grant, new_token().unwrap()).is_err());
        let before_rotation = tickets.login_ticket().unwrap();
        let grant = tickets.authorize_ticket(&before_rotation).ok().unwrap();
        tickets.rotate(&new_token().unwrap()).unwrap();
        assert!(tickets.authorize_ticket(&before_rotation).is_err());
        assert!(tickets.issue_ticket(grant, new_token().unwrap()).is_err());
        let before_close = tickets.login_ticket().unwrap();
        let grant = tickets.authorize_ticket(&before_close).ok().unwrap();
        tickets.close().unwrap();
        assert!(tickets.authorize_ticket(&before_close).is_err());
        assert!(tickets.issue_ticket(grant, new_token().unwrap()).is_err());
        assert!(tickets.login_ticket().is_err());

        // Same pure lifecycle owner: exact renewal boundaries use a controllable
        // wall clock, never a sleep or a test-only HTTP time override.
        use std::sync::atomic::{AtomicU64, Ordering};
        let now = Arc::new(AtomicU64::new(1_800_000_000_000));
        let clock = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let stable_token = new_token().unwrap();
        let mut renewable = Sessions::new(&stable_token).unwrap();
        renewable.clock = clock;
        let renewable = Arc::new(renewable);
        let (bearer, live) = renewable.login(&stable_token).ok().unwrap();
        let original = live.expiry();
        assert_eq!(
            original - now.load(Ordering::SeqCst),
            milliseconds(SESSION_LIFETIME)
        );
        now.store(
            original - milliseconds(RENEWAL_WINDOW) - 1,
            Ordering::SeqCst,
        );
        assert_eq!(renewable.renew(&live).ok().unwrap()["expiresAt"], original);
        now.fetch_add(1, Ordering::SeqCst);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let (registry, live, barrier) = (renewable.clone(), live.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.renew(&live).ok().unwrap()["expiresAt"]
                        .as_u64()
                        .unwrap()
                })
            })
            .collect();
        let expected = now.load(Ordering::SeqCst) + milliseconds(SESSION_LIFETIME);
        for worker in workers {
            assert_eq!(worker.join().unwrap(), expected);
        }
        assert!(Arc::ptr_eq(
            &renewable.authenticate(&bearer).unwrap(),
            &live
        ));
        assert_eq!(renewable.administrator_token(), stable_token);
        now.store(expected, Ordering::SeqCst);
        assert!(renewable.authenticate(&bearer).is_none());
        assert!(matches!(
            renewable.renew(&live),
            Err(LoginFailure::Unauthorized)
        ));
        let (_, reauthenticated) = renewable.login(&stable_token).ok().unwrap();
        renewable.revoke(&reauthenticated).unwrap();
        assert!(matches!(
            renewable.renew(&reauthenticated),
            Err(LoginFailure::Unauthorized)
        ));

        let administrator = new_token().unwrap();
        let sessions = Sessions::new(&administrator).unwrap();
        assert!(sessions.authenticate(&administrator).is_none());
        let (first_token, first) = sessions.login(&administrator).ok().unwrap();
        let (second_token, second) = sessions.login(&administrator).ok().unwrap();
        assert_ne!(first.client_id, second.client_id);
        assert_ne!(first_token, second_token);
        assert!(sessions.authenticate(&first_token).is_some());
        let (fork_token, fork) = sessions.fork(&first, new_token().unwrap()).ok().unwrap();
        assert_ne!(fork.client_id, first.client_id);
        assert_eq!(fork.expiry(), first.expiry());
        sessions.revoke(&fork).unwrap();
        assert!(sessions.authenticate(&fork_token).is_none());
        assert!(sessions.authenticate(&first_token).is_some());
        sessions.revoke(&first).unwrap();
        assert!(matches!(
            sessions.fork(&first, new_token().unwrap()),
            Err(LoginFailure::Unauthorized)
        ));
        assert!(*first.revoked.borrow());
        assert!(sessions.authenticate(&first_token).is_none());
        assert!(sessions.authenticate(&second_token).is_some());
        let replacement = new_token().unwrap();
        sessions.rotate(&replacement).unwrap();
        assert!(*second.revoked.borrow());
        assert!(sessions.authenticate(&second_token).is_none());
        assert!(matches!(
            sessions.login(&administrator),
            Err(LoginFailure::Unauthorized)
        ));
        let (expired_token, expired) = sessions.login(&replacement).ok().unwrap();
        drop(expired);
        let key = digest(b"rovai-session-v1\0", &expired_token);
        sessions
            .state
            .lock()
            .unwrap()
            .sessions
            .get(&key)
            .unwrap()
            .expires_at
            .send_replace(0);
        assert!(sessions.authenticate(&expired_token).is_none());
        let (live_token, live) = sessions.login(&replacement).ok().unwrap();
        let generation = sessions.authorize_login(&replacement).ok().unwrap();
        sessions.rotate(&administrator).unwrap();
        assert!(matches!(
            sessions.issue(generation, new_token().unwrap()),
            Err(LoginFailure::Unauthorized)
        ));
        sessions.close().unwrap();
        assert!(*live.revoked.borrow());
        assert!(sessions.authenticate(&live_token).is_none());
        assert!(matches!(
            sessions.login(&replacement),
            Err(LoginFailure::Unauthorized)
        ));
        assert_eq!(sessions.count(), 0);
    }

    // Owns private-file commit/reopen failures; the pure lifecycle matrix above
    // cannot prove durability. No database, Core, socket or Runtime is started.
    #[test]
    fn authentication_reopen_preserves_renewals_and_never_resurrects_revocation() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let parent = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = parent.join(format!("rovai-auth-{}", new_token().unwrap()));
        rovai_core::platform::prepare_private_directory(&root).unwrap();
        let now = Arc::new(AtomicU64::new(1_800_000_000_000));
        let clock: Arc<dyn Fn() -> u64 + Send + Sync> = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let open = || Sessions::open_with_clock(&root, None, clock.clone()).unwrap();
        #[cfg(windows)]
        {
            // A restored file inherits the admitted parent's permissions. It
            // must be readable without rewriting credentials or repairing ACLs.
            let path = root.join(STORE_FILE);
            let bytes = serde_json::to_vec(&StoredAuth {
                version: 1,
                administrator_token: "a".repeat(64),
                sessions: Vec::new(),
            })
            .unwrap();
            std::fs::write(&path, &bytes).unwrap();
            assert!(open_private_read_file(&path).is_err());
            assert_eq!(
                stored_administrator_token(&root).unwrap().unwrap(),
                "a".repeat(64)
            );
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert!(
                open_private_read_file(&path).is_err(),
                "read must leave the inherited ACL unchanged"
            );
        }
        let registry = open();
        let token = registry.administrator_token();
        let (bearer, session) = registry.login(&token).ok().unwrap();
        let ticket = registry.login_ticket().unwrap();
        now.store(
            session.expiry() - milliseconds(RENEWAL_WINDOW),
            Ordering::SeqCst,
        );
        let expiry = registry.renew(&session).ok().unwrap()["expiresAt"]
            .as_u64()
            .unwrap();
        let (first_closed, _) = registry.fork(&session, new_token().unwrap()).ok().unwrap();
        let mut candidate = first_closed.clone();
        for _ in 0..MAX_SESSIONS * 2 {
            now.fetch_add(1, Ordering::SeqCst);
            let parent = registry.authenticate(&candidate).unwrap();
            let (next, _) = registry.fork(&parent, new_token().unwrap()).ok().unwrap();
            candidate = next;
        }
        assert!(registry.authenticate(&first_closed).is_none());
        registry.suspend();
        drop(registry);
        // The previous persisted format has no activity timestamp. Upgrading
        // must retain its unexpired credentials instead of rejecting the store.
        let path = root.join(STORE_FILE);
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        for entry in legacy["sessions"].as_array_mut().unwrap() {
            assert!(
                entry
                    .as_object_mut()
                    .unwrap()
                    .remove("lastUsedAt")
                    .is_some()
            );
        }
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let registry = Arc::new(open());
        assert_eq!(stored_administrator_token(&root).unwrap().unwrap(), token);
        let restored = registry.authenticate(&bearer).unwrap();
        assert_eq!(restored.client_id, session.client_id);
        assert_eq!(restored.expiry(), expiry);
        assert_eq!(registry.count(), MAX_SESSIONS);
        assert!(registry.authenticate(&first_closed).is_none());
        assert!(registry.authenticate(&candidate).is_some());
        assert!(registry.authorize_ticket(&ticket).is_err());
        let bytes = std::fs::read_to_string(root.join(STORE_FILE)).unwrap();
        assert!(!bytes.contains(&bearer));
        assert!(!bytes.contains(&ticket));
        now.store(expiry - milliseconds(RENEWAL_WINDOW), Ordering::SeqCst);
        let path = root.join(STORE_FILE);
        let backup = root.join("saved-auth");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(
            registry.renew(&restored),
            Err(LoginFailure::Storage(_))
        ));
        assert_eq!(restored.expiry(), expiry);
        assert!(registry.revoke(&restored).is_err());
        assert!(registry.close().is_err());
        assert!(registry.rotate(&new_token().unwrap()).is_err());
        assert!(matches!(
            registry.issue(0, new_token().unwrap()),
            Err(LoginFailure::Storage(_))
        ));
        assert_eq!(registry.count(), MAX_SESSIONS);
        assert!(registry.authenticate(&candidate).is_some());
        assert!(registry.authenticate(&bearer).is_some());
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(backup, &path).unwrap();
        // Both lock orders are legal: renew can commit before logout, but no
        // order may restore a revoked Session after this registry is reopened.
        let barrier = Arc::new(std::sync::Barrier::new(2));
        std::thread::scope(|scope| {
            let registry = &registry;
            let restored = &restored;
            let barrier = &barrier;
            scope.spawn(move || {
                barrier.wait();
                let _ = registry.renew(restored);
            });
            scope.spawn(move || {
                barrier.wait();
                registry.revoke(restored).unwrap();
            });
        });
        assert!(registry.authenticate(&bearer).is_none());
        drop(registry);
        let registry = open();
        assert!(registry.authenticate(&bearer).is_none());
        let (expired, live) = registry.login(&token).ok().unwrap();
        now.store(live.expiry(), Ordering::SeqCst);
        drop(registry);
        let registry = open();
        assert!(registry.authenticate(&expired).is_none());
        let (closed, _) = registry.login(&token).ok().unwrap();
        registry.close().unwrap();
        drop(registry);
        let registry = open();
        assert!(registry.authenticate(&closed).is_none());
        assert_eq!(registry.administrator_token(), token);
        let (rotated, _) = registry.login(&token).ok().unwrap();
        let replacement = new_token().unwrap();
        registry.rotate(&replacement).unwrap();
        drop(registry);
        let registry = open();
        assert_eq!(registry.administrator_token(), replacement);
        assert!(registry.authenticate(&rotated).is_none());
        assert!(registry.authorize_login(&token).is_err());
        drop(registry);
        for bytes in [
            b"{broken".to_vec(),
            vec![b' '; 65537],
            serde_json::to_vec(&StoredAuth {
                version: 2,
                administrator_token: replacement.clone(),
                sessions: Vec::new(),
            })
            .unwrap(),
        ] {
            // Match credential I/O policy when constructing invalid-content fixtures.
            write_store_file(&path, &bytes).unwrap();
            let error = Sessions::open(&root, None)
                .err()
                .expect("invalid content must fail");
            assert_eq!(
                error.downcast_ref::<AuthStoreFailure>(),
                Some(&AuthStoreFailure::Content)
            );
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn login_admission_bounds_attempts_sessions_and_malformed_credentials() {
        let administrator = new_token().unwrap();
        for invalid in ["", "x", &"g".repeat(64), &"a".repeat(63)] {
            assert!(Sessions::new(invalid).is_err());
        }
        let sessions = Sessions::new(&administrator).unwrap();
        for _ in 0..LOGIN_ATTEMPTS {
            assert!(matches!(
                sessions.login("bad"),
                Err(LoginFailure::Unauthorized)
            ));
        }
        assert!(matches!(
            sessions.login(&administrator),
            Err(LoginFailure::Throttled)
        ));
        sessions.state.lock().unwrap().attempts.clear();
        // A closed tab releases its request/SSE Arc, but its persisted Bearer
        // must still reopen. Repeating beyond the cap owns the accumulation bug.
        let mut reopened = Sessions::new(&administrator).unwrap();
        let now = Arc::new(AtomicU64::new(1_800_000_000_000));
        reopened.clock = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let pinned = reopened.login(&administrator).ok().unwrap();
        let (mut candidate, _) = reopened.login(&administrator).ok().unwrap();
        let oldest_closed = candidate.clone();
        for index in 0..MAX_SESSIONS * 3 {
            now.fetch_add(1, Ordering::SeqCst);
            let parent = reopened.authenticate(&candidate).unwrap();
            let child = reopened.fork(&parent, new_token().unwrap());
            assert!(
                child.is_ok(),
                "closed tab reopen {index} exhausted Sessions"
            );
            let (token, session) = child.ok().unwrap();
            assert_ne!(session.client_id, parent.client_id);
            assert_eq!(session.expiry(), parent.expiry());
            candidate = token;
            assert!(reopened.count() <= MAX_SESSIONS);
            assert!(reopened.authenticate(&pinned.0).is_some());
            assert!(!*pinned.1.revoked.borrow());
        }
        assert_eq!(reopened.count(), MAX_SESSIONS);
        assert!(reopened.authenticate(&oldest_closed).is_none());
        assert!(
            reopened.login(&administrator).is_ok(),
            "correct long Token can also reclaim an idle slot"
        );
        assert!(reopened.authenticate(&pinned.0).is_some());
        // Cardinality is the property being tested; avoid waiting for rate windows.
        let mut active = Vec::new();
        for _ in 0..MAX_SESSIONS {
            sessions.state.lock().unwrap().attempts.clear();
            active.push(sessions.login(&administrator).ok().unwrap());
        }
        assert!(matches!(
            sessions.login(&administrator),
            Err(LoginFailure::Capacity)
        ));
        // A verified editor reauthenticates by replacing its own Session, even
        // when other tabs occupy every remaining slot.
        let first = sessions
            .state
            .lock()
            .unwrap()
            .sessions
            .values()
            .next()
            .unwrap()
            .clone();
        let (replacement_token, replacement) =
            sessions.issue(0, first.client_id.clone()).ok().unwrap();
        assert!(*first.revoked.borrow());
        assert_eq!(sessions.count(), MAX_SESSIONS);
        assert_eq!(replacement.client_id, first.client_id);
        assert!(sessions.authenticate(&replacement_token).is_some());
    }
}
