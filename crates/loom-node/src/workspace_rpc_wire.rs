//! Bounded transport delivery for the durable execution owner. A socket loss
//! aborts relays only; it neither restarts nor forgets an admitted operation.
use super::{WorkspaceRpcExecutor,Submission,MAX_LIVE,ToolPolicy,WorkspacePolicy};
use crate::workspace_authority::WorkspaceAuthority;
use loom_protocol::{ClientMessage,workspace_rpc::*};
use std::{collections::{HashMap,BTreeMap},ffi::OsString,path::Path,sync::{Arc,Mutex},time::Duration};
use tokio::{sync::{mpsc,broadcast},task::JoinHandle};

#[derive(Clone)]
pub struct WorkspaceRpcWire {
    executor:WorkspaceRpcExecutor,
    authority:Option<WorkspaceAuthority>,
    tools:Arc<BTreeMap<String,ToolPolicy>>,
    relays:Arc<Mutex<HashMap<String,JoinHandle<()>>>>,
}
impl WorkspaceRpcWire {
    pub fn new(executor:WorkspaceRpcExecutor)->Self {
        Self{executor,authority:None,tools:Arc::new(BTreeMap::new()),relays:Arc::new(Mutex::new(HashMap::new()))}
    }
    /// The authenticated Core dispatch authorizes this invocation; a completed
    /// local PrepareWorktree establishes its root. Neither part is sufficient
    /// alone. No executable, environment or absolute cwd comes from the wire.
    pub fn with_authority(executor:WorkspaceRpcExecutor,authority:WorkspaceAuthority)->Self {
        Self{executor,authority:Some(authority),tools:Arc::new(builtin_tools()),
            relays:Arc::new(Mutex::new(HashMap::new()))}
    }
    fn admit_dispatch(&self,dispatch:&WorkspaceDispatch)->Result<(),RpcErrorCode> {
        dispatch.validate()?;
        let Some(authority)=&self.authority else{return Ok(());};
        let prepared=authority.admit(&dispatch.request.workspace_id,Path::new(""))?;
        if prepared.node_id()!=dispatch.owner_node_id {return Err(RpcErrorCode::WrongNode);}
        let mut tools=(*self.tools).clone();
        if let Some(git)=tools.get_mut("git.status") {
            // Override repository core.worktree and always inspect the enrolled
            // root, even if the request's contained cwd is a nested repository.
            let raw=prepared.root().to_str().ok_or(RpcErrorCode::PathRejected)?;
            #[cfg(windows)]
            let root=if let Some(rest)=raw.strip_prefix("\\\\?\\UNC\\") {format!("\\\\{rest}")}
                else {raw.strip_prefix("\\\\?\\").unwrap_or(raw).to_owned()};
            #[cfg(not(windows))]
            let root=raw.to_owned();
            git.fixed_prefix.splice(0..0,["-C".into(),root.clone(),format!("--work-tree={root}")]);
        }
        let policy=WorkspacePolicy::from_prepared(prepared,dispatch.scope.mission_id.clone(),
            dispatch.policy_revision,true,true,true,tools)?;
        self.executor.register_trusted_workspace(policy)
    }
    /// Caller must be the authenticated Core connection. Identity and policy
    /// were resolved by Core, and the executor requires a local prepared policy.
    pub async fn handle_dispatch(&self,dispatch:WorkspaceDispatch,output:mpsc::Sender<ClientMessage>) {
        let replay=WorkspaceReplay{version:RPC_VERSION,request_id:dispatch.request.request_id.clone(),
            run_id:dispatch.scope.run_id.clone(),attempt:dispatch.scope.attempt,
            request_digest:dispatch.request_digest.clone(),after_seq:0};
        let result=self.start_relay(replay.clone(),output.clone(),||{
            self.admit_dispatch(&dispatch)?;
            self.executor.submit_trusted(dispatch)
        });
        if let Err(code)=result {send_rejection(&output,&replay,code).await;}
    }
    pub async fn handle_replay(&self,replay:WorkspaceReplay,output:mpsc::Sender<ClientMessage>) {
        let result=self.start_relay(replay.clone(),output.clone(),||self.executor.resubscribe_trusted(&replay));
        if let Err(code)=result {send_rejection(&output,&replay,code).await;}
    }
    pub async fn handle_cancel(&self,cancel:WorkspaceCancel,output:mpsc::Sender<ClientMessage>) {
        let replay=WorkspaceReplay{version:RPC_VERSION,request_id:cancel.request_id.clone(),
            run_id:cancel.run_id.clone(),attempt:cancel.attempt,request_digest:cancel.request_digest.clone(),after_seq:0};
        match self.executor.cancel_trusted(&cancel) {
            Ok(events)=>{
                // Cancellation itself is never gated on relay capacity. Existing
                // relay sees the final event; these durable duplicates are safe.
                let _=tokio::time::timeout(Duration::from_secs(5),async {
                    for event in events {
                        if output.send(ClientMessage::WorkspaceRpcEvent{event}).await.is_err(){break;}
                    }
                }).await;
            }
            Err(code)=>send_rejection(&output,&replay,code).await,
        }
    }
    fn start_relay(&self,replay:WorkspaceReplay,output:mpsc::Sender<ClientMessage>,
        submit:impl FnOnce()->Result<Submission,RpcErrorCode>)->Result<(),RpcErrorCode> {
        let mut relays=self.relays.lock().map_err(|_|RpcErrorCode::StorageUnavailable)?;
        relays.retain(|_,task|!task.is_finished());
        if !relays.contains_key(&replay.request_id) && relays.len()>=MAX_LIVE {
            return Err(RpcErrorCode::Busy);
        }
        // Reserve bounded delivery capacity before submit can admit a new side
        // effect. A conflicting retry never interrupts the existing relay.
        let submission=submit()?;
        if let Some(previous)=relays.remove(&replay.request_id) {previous.abort();}
        let executor=self.executor.clone();let id=replay.request_id.clone();
        relays.insert(id,tokio::spawn(async move {forward(executor,replay,submission,output).await;}));
        Ok(())
    }
    pub fn disconnect(&self) {
        if let Ok(mut relays)=self.relays.lock() {
            for (_,task) in relays.drain(){task.abort();}
        }
    }
}
/// A missing native Git installation removes only git.status. List/read remain
/// available. Relative PATH entries and shell wrappers are never admitted.
fn builtin_tools()->BTreeMap<String,ToolPolicy> {
    let Some(path)=std::env::var_os("PATH") else{return BTreeMap::new();};
    let name=if cfg!(windows){"git.exe"}else{"git"};
    for directory in std::env::split_paths(&path).filter(|p|p.is_absolute()) {
        let candidate=directory.join(name);
        if !candidate.is_file(){continue;}
        let mut environment=BTreeMap::<OsString,OsString>::new();
        for key in ["SystemRoot","WINDIR","TEMP","TMP"] {
            if let Some(value)=std::env::var_os(key){environment.insert(key.into(),value);}
        }
        environment.insert("PATH".into(),directory.as_os_str().to_owned());
        let null=if cfg!(windows){"NUL"}else{"/dev/null"};
        for (key,value) in [("GIT_CONFIG_NOSYSTEM","1"),("GIT_CONFIG_GLOBAL",null),
            ("GIT_CONFIG_SYSTEM",null),("GIT_OPTIONAL_LOCKS","0"),("GIT_TERMINAL_PROMPT","0")] {
            environment.insert(key.into(),value.into());
        }
        if let Ok(mut policy)=ToolPolicy::new(candidate,vec![Vec::new()],environment) {
            policy.fixed_prefix=["--no-pager","--no-optional-locks","-c","core.fsmonitor=false",
                "-c","core.untrackedCache=false","status","--porcelain=v1","--untracked-files=no"]
                .into_iter().map(str::to_owned).collect();
            return BTreeMap::from([("git.status".into(),policy)]);
        }
    }
    BTreeMap::new()
}
async fn send_rejection(output:&mpsc::Sender<ClientMessage>,replay:&WorkspaceReplay,code:RpcErrorCode) {
    let rejection=WorkspaceRejection{version:RPC_VERSION,request_id:replay.request_id.clone(),
        run_id:replay.run_id.clone(),attempt:replay.attempt,request_digest:replay.request_digest.clone(),code};
    let _=tokio::time::timeout(Duration::from_secs(5),output.send(ClientMessage::WorkspaceRpcRejected{rejection})).await;
}
fn terminal(body:&WorkspaceEventBody)->bool {
    matches!(body,WorkspaceEventBody::Completed{..}|WorkspaceEventBody::Failed{..}|
        WorkspaceEventBody::Cancelled{..}|WorkspaceEventBody::Unknown{..})
}
async fn forward(executor:WorkspaceRpcExecutor,mut cursor:WorkspaceReplay,mut submission:Submission,
    output:mpsc::Sender<ClientMessage>) {
    loop {
        for event in submission.replay {
            if event.seq<=cursor.after_seq {continue;}
            let seq=event.seq;let done=terminal(&event.body);
            if !matches!(tokio::time::timeout(Duration::from_secs(5),
                output.send(ClientMessage::WorkspaceRpcEvent{event})).await,Ok(Ok(()))) {return;}
            cursor.after_seq=seq;
            if done{return;}
        }
        let Some(mut live)=submission.live else{return;};
        loop {
            match live.recv().await {
                Ok(event)=>{
                    if event.seq<=cursor.after_seq {continue;}
                    if event.seq!=cursor.after_seq+1 {break;}
                    let seq=event.seq;let done=terminal(&event.body);
                    if !matches!(tokio::time::timeout(Duration::from_secs(5),
                        output.send(ClientMessage::WorkspaceRpcEvent{event})).await,Ok(Ok(()))) {return;}
                    cursor.after_seq=seq;if done{return;}
                }
                Err(broadcast::error::RecvError::Lagged(_)|broadcast::error::RecvError::Closed)=>break,
            }
        }
        // Snapshot and subscribe under the executor's state lock. The gap
        // between replay and live cannot discard an event.
        submission=match executor.resubscribe_trusted(&cursor) {
            Ok(submission)=>submission,
            Err(code)=>{send_rejection(&output,&cursor,code).await;return;}
        };
    }
}
