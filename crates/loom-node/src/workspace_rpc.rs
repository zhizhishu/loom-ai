//! Node execution owner for versioned workspace RPC. The caller must be the
//! authenticated Core connection, never an external JSON/CLI request directly.
//! Policies are local approvals; no wire field selects a root, program or env.
//! A private journal is committed before spawn. A restarted owner reports
//! UNKNOWN for unfinished requests and never starts the same request twice.
use std::{
    collections::{BTreeMap, HashMap}, ffi::OsString, fs::{self,File},
    io::{Read,Seek,SeekFrom,Write as _}, path::{Path,PathBuf}, sync::{Arc,Mutex}, time::{Duration,SystemTime,UNIX_EPOCH},
};
use base64::{Engine as _,engine::general_purpose::STANDARD};
use loom_protocol::workspace_rpc::*;
use rovai_private_storage::{prepare_private_directory,create_private_new_file,open_private_read_write_file,
    open_private_read_file,atomic_write_private_bytes};
use rovai_process_boundary::{NativeProcess,ProcessSpec,StdinPolicy,inspect_application_identity};
use crate::workspace_authority::TrustedPreparedWorkspace;
use serde::{Serialize,Deserialize};
use sha2::{Digest,Sha256};
use tokio::{io::{AsyncRead,AsyncReadExt},sync::{broadcast,mpsc,watch}};

#[path="workspace_rpc_wire.rs"]
mod wire;
pub use wire::WorkspaceRpcWire;

type RpcResult<T> = Result<T,RpcErrorCode>;
const MAX_RECORD_BYTES:usize=4*1024*1024;
const MAX_EVENTS:usize=512;
const MAX_OUTPUT_FRAGMENTS:usize=256;
const MAX_LIVE:usize=32;

/// Exact argv variants, rather than arbitrary command text. Programs such as a
/// shell/interpreter require an explicitly approved exact invocation too.
#[derive(Clone,PartialEq,Eq)]
pub struct ToolPolicy {
    program:PathBuf,
    application_identity:String,
    fixed_prefix:Vec<String>,
    argv_variants:Vec<Vec<String>>,
    environment:BTreeMap<OsString,OsString>,
}
impl ToolPolicy {
    pub fn new(program:PathBuf,argv_variants:Vec<Vec<String>>,environment:BTreeMap<OsString,OsString>)->RpcResult<Self> {
        if !program.is_absolute() || !program.is_file() || argv_variants.is_empty() || argv_variants.len()>32 {
            return Err(RpcErrorCode::ToolDenied);
        }
        let application_identity=inspect_application_identity(&program).map_err(|_|RpcErrorCode::ToolDenied)?;
        for args in &argv_variants {
            WorkspaceRequest{version:RPC_VERSION,request_id:"policy".into(),workspace_id:"policy".into(),timeout_ms:1,
                operation:WorkspaceOperation::Run{tool_id:"policy".into(),args:args.clone(),cwd:String::new()}}
                .validate().map_err(|_|RpcErrorCode::ToolDenied)?;
        }
        Ok(Self{program,application_identity,fixed_prefix:Vec::new(),argv_variants,environment})
    }
}
#[derive(Clone,PartialEq,Eq)]
pub struct WorkspacePolicy {
    workspace_id:String, mission_id:String, owner_node_id:String, revision:u64,
    root:PathBuf, allow_list:bool, allow_read:bool, allow_write:bool, tools:BTreeMap<String,ToolPolicy>,
    prepared:Option<TrustedPreparedWorkspace>,
}
impl WorkspacePolicy {
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn new(workspace_id:String,mission_id:String,owner_node_id:String,revision:u64,root:PathBuf,
        allow_list:bool,allow_read:bool,allow_write:bool,tools:BTreeMap<String,ToolPolicy>)->RpcResult<Self> {
        if revision==0 || !root.is_absolute() || !root.is_dir() {return Err(RpcErrorCode::InvalidRequest);}
        let root=fs::canonicalize(root).map_err(|_|RpcErrorCode::PathRejected)?;
        Ok(Self{workspace_id,mission_id,owner_node_id,revision,root,allow_list,allow_read,allow_write,tools,prepared:None})
    }
    /// The root comes from a completed local prepare, never from a wire request.
    pub fn from_prepared(prepared:TrustedPreparedWorkspace,mission_id:String,revision:u64,
        allow_list:bool,allow_read:bool,allow_write:bool,tools:BTreeMap<String,ToolPolicy>)->RpcResult<Self> {
        prepared.revalidate()?;
        if revision==0 {return Err(RpcErrorCode::InvalidRequest);}
        CallerScope{run_id:"policy".into(),attempt:1,session_id:"policy".into(),member_id:"policy".into(),
            mission_id:mission_id.clone()}.validate()?;
        Ok(Self{workspace_id:prepared.workspace_id().to_owned(),owner_node_id:prepared.node_id().to_owned(),
            root:prepared.root().to_owned(),mission_id,revision,allow_list,allow_read,allow_write,tools,prepared:Some(prepared)})
    }
    pub fn workspace_id(&self)->&str {&self.workspace_id}
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Record {
    dispatch:WorkspaceDispatch, events:Vec<WorkspaceEvent>, finished:bool,
    output_bytes:u64, omitted_bytes:u64, cancel_cause:Option<CancelCause>,
}
impl Record {
    fn push(&mut self,body:WorkspaceEventBody)->RpcResult<WorkspaceEvent> {
        if self.finished || self.events.len()>=MAX_EVENTS {return Err(RpcErrorCode::SequenceConflict);}
        let event=WorkspaceEvent{version:RPC_VERSION,request_id:self.dispatch.request.request_id.clone(),
            run_id:self.dispatch.scope.run_id.clone(),attempt:self.dispatch.scope.attempt,
            owner_node_id:self.dispatch.owner_node_id.clone(),request_digest:self.dispatch.request_digest.clone(),
            seq:self.events.len() as u64+1,body};
        event.validate_for(&self.dispatch)?;
        match &event.body {
            WorkspaceEventBody::Output{data,..}=>{
                let count=STANDARD.decode(data).map_err(|_|RpcErrorCode::InvalidRequest)?.len() as u64;
                if count==0 || !matches!(self.dispatch.request.operation,WorkspaceOperation::Run{..}) {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                self.output_bytes=self.output_bytes.checked_add(count).filter(|n|*n<=MAX_OUTPUT_BYTES)
                    .ok_or(RpcErrorCode::OutputLimit)?;
            }
            WorkspaceEventBody::OutputTruncated{omitted_bytes}=>{
                self.omitted_bytes=self.omitted_bytes.checked_add(*omitted_bytes).ok_or(RpcErrorCode::OutputLimit)?;
            }
            WorkspaceEventBody::Completed{result:WorkspaceResult::Run{output_bytes,omitted_bytes,..}}=>{
                if *output_bytes!=self.output_bytes || *omitted_bytes!=self.omitted_bytes {
                    return Err(RpcErrorCode::SequenceConflict);
                }
            }
            _=>{}
        }
        self.finished=matches!(event.body,WorkspaceEventBody::Completed{..}|WorkspaceEventBody::Failed{..}
            |WorkspaceEventBody::Cancelled{..}|WorkspaceEventBody::Unknown{..});
        self.events.push(event.clone());Ok(event)
    }
    fn validate(&self)->RpcResult<()> {
        self.dispatch.validate()?;
        if self.events.is_empty() || self.events.len()>MAX_EVENTS {return Err(RpcErrorCode::StorageUnavailable);}
        let mut rebuilt=Self{dispatch:self.dispatch.clone(),events:Vec::new(),finished:false,
            output_bytes:0,omitted_bytes:0,cancel_cause:self.cancel_cause};
        for event in &self.events {
            let expected=rebuilt.push(event.body.clone())?;
            if *event!=expected {return Err(RpcErrorCode::StorageUnavailable);}
        }
        if rebuilt.finished!=self.finished || rebuilt.output_bytes!=self.output_bytes || rebuilt.omitted_bytes!=self.omitted_bytes {
            return Err(RpcErrorCode::StorageUnavailable);
        }
        Ok(())
    }
}
struct Ledger {root:PathBuf,_lease:File}
impl Ledger {
    fn open(root:&Path)->RpcResult<Self> {
        let root=prepare_private_directory(root).map_err(|_|RpcErrorCode::StorageUnavailable)?;
        let lock_path=root.join("owner.lock");
        let lease=if lock_path.exists() {open_private_read_write_file(&lock_path)} else {create_private_new_file(&lock_path)}
            .map_err(|_|RpcErrorCode::StorageUnavailable)?;
        lock_exclusively(&lease)?;
        Ok(Self{root,_lease:lease})
    }
    fn path(&self,id:&str)->PathBuf { self.root.join(format!("{:x}.json",Sha256::digest(id.as_bytes()))) }
    fn read(&self,id:&str)->RpcResult<Option<Record>> {
        let path=self.path(id);
        if !path.exists() {return Ok(None);}
        let file=open_private_read_file(&path).map_err(|_|RpcErrorCode::StorageUnavailable)?;
        let mut bytes=Vec::new();file.take(MAX_RECORD_BYTES as u64+1).read_to_end(&mut bytes)
            .map_err(|_|RpcErrorCode::StorageUnavailable)?;
        if bytes.len()>MAX_RECORD_BYTES {return Err(RpcErrorCode::StorageUnavailable);}
        let record:Record=serde_json::from_slice(&bytes).map_err(|_|RpcErrorCode::StorageUnavailable)?;
        record.validate().map_err(|_|RpcErrorCode::StorageUnavailable)?;
        if record.dispatch.request.request_id!=id {return Err(RpcErrorCode::StorageUnavailable);}
        Ok(Some(record))
    }
    fn store(&self,record:&Record)->RpcResult<()> {
        record.validate()?;
        let bytes=serde_json::to_vec(record).map_err(|_|RpcErrorCode::StorageUnavailable)?;
        if bytes.len()>MAX_RECORD_BYTES {return Err(RpcErrorCode::OutputLimit);}
        atomic_write_private_bytes(&self.path(&record.dispatch.request.request_id),&bytes)
            .map_err(|_|RpcErrorCode::StorageUnavailable)?;
        // The shared writer flushes file bytes and atomically renames. Linux
        // additionally needs directory durability before any executable starts.
        #[cfg(unix)]
        File::open(&self.root).and_then(|f|f.sync_all()).map_err(|_|RpcErrorCode::StorageUnavailable)?;
        Ok(())
    }
}
#[cfg(unix)]
fn lock_exclusively(file:&File)->RpcResult<()> {
    use std::os::fd::AsRawFd;
    if unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0 {return Err(RpcErrorCode::Busy);}
    Ok(())
}
#[cfg(windows)]
fn lock_exclusively(file:&File)->RpcResult<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Storage::FileSystem::{LockFileEx,LOCKFILE_EXCLUSIVE_LOCK,LOCKFILE_FAIL_IMMEDIATELY},
        System::IO::OVERLAPPED};
    let mut overlap=OVERLAPPED::default();
    if unsafe{LockFileEx(file.as_raw_handle(),LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,u32::MAX,u32::MAX,&mut overlap)}==0 {
        return Err(RpcErrorCode::Busy);
    }
    Ok(())
}
#[cfg(not(any(unix,windows)))]
fn lock_exclusively(_: &File)->RpcResult<()> {Err(RpcErrorCode::UnsupportedPlatform)}

struct Live {cancel:watch::Sender<Option<CancelCause>>,events:broadcast::Sender<WorkspaceEvent>}
struct State {live:HashMap<String,Live>}
struct Inner {node_id:String,policies:Mutex<BTreeMap<String,Arc<WorkspacePolicy>>>,ledger:Ledger,state:Mutex<State>}
#[derive(Clone)]
pub struct WorkspaceRpcExecutor {inner:Arc<Inner>}

/// Replay is durable; broadcast is only a bounded delivery hint. If the
/// receiver lags or reconnects, call replay with the last accepted seq.
pub struct Submission {
    pub replay:Vec<WorkspaceEvent>,
    pub live:Option<broadcast::Receiver<WorkspaceEvent>>,
}
impl WorkspaceRpcExecutor {
    pub fn open(node_id:String,ledger_root:PathBuf,policies:Vec<WorkspacePolicy>)->RpcResult<Self> {
        let mut approved=BTreeMap::new();
        for policy in policies {
            if policy.owner_node_id!=node_id || approved.insert(policy.workspace_id.clone(),Arc::new(policy)).is_some() {
                return Err(RpcErrorCode::WrongNode);
            }
        }
        Ok(Self{inner:Arc::new(Inner{node_id,policies:Mutex::new(approved),ledger:Ledger::open(&ledger_root)?,
            state:Mutex::new(State{live:HashMap::new()})})})
    }
    /// Install a policy derived from trusted Core authorization and the local
    /// prepared handle. New prepares are usable without restarting this owner.
    /// A revision is immutable; changing content requires a strictly newer one.
    pub fn register_trusted_workspace(&self,policy:WorkspacePolicy)->RpcResult<()> {
        if policy.owner_node_id!=self.inner.node_id {return Err(RpcErrorCode::WrongNode);}
        if let Some(prepared)=&policy.prepared {prepared.revalidate()?;}
        let mut policies=self.inner.policies.lock().map_err(|_|RpcErrorCode::StorageUnavailable)?;
        if let Some(old)=policies.get(&policy.workspace_id) {
            let same_binding=match (&old.prepared,&policy.prepared) {
                (Some(a),Some(b))=>a.same_binding(b),(None,None)=>old.root==policy.root,_=>false,
            };
            if !same_binding || old.mission_id!=policy.mission_id ||
                policy.revision<old.revision || (policy.revision==old.revision && **old!=policy) {
                return Err(RpcErrorCode::PolicyMismatch);
            }
            if policy.revision==old.revision {return Ok(());}
        }
        policies.insert(policy.workspace_id.clone(),Arc::new(policy));Ok(())
    }
    /// Invoke only after authenticating the Core transport. This method never
    /// interprets the public request as evidence of caller identity.
    pub fn submit_trusted(&self,dispatch:WorkspaceDispatch)->RpcResult<Submission> {
        dispatch.validate()?;
        if dispatch.owner_node_id!=self.inner.node_id {return Err(RpcErrorCode::WrongNode);}
        let policy=self.inner.policies.lock().map_err(|_|RpcErrorCode::StorageUnavailable)?
            .get(&dispatch.request.workspace_id).cloned().ok_or(RpcErrorCode::Unauthorized)?;
        if let Some(prepared)=&policy.prepared {prepared.revalidate()?;}
        if policy.mission_id!=dispatch.scope.mission_id {return Err(RpcErrorCode::Unauthorized);}
        if policy.revision!=dispatch.policy_revision {return Err(RpcErrorCode::PolicyMismatch);}
        let mut state=self.inner.state.lock().map_err(|_|RpcErrorCode::StorageUnavailable)?;
        if let Some(mut record)=self.inner.ledger.read(&dispatch.request.request_id)? {
            if record.dispatch.request_digest!=dispatch.request_digest {return Err(RpcErrorCode::RequestConflict);}
            let live=state.live.get(&dispatch.request.request_id).map(|entry|entry.events.subscribe());
            if live.is_none() && !record.finished {
                record.push(WorkspaceEventBody::Unknown{code:RpcErrorCode::UnknownOutcome})?;
                self.inner.ledger.store(&record)?;
            }
            return Ok(Submission{replay:record.events,live});
        }
        if state.live.len()>=MAX_LIVE {return Err(RpcErrorCode::Busy);}
        tokio::runtime::Handle::try_current().map_err(|_|RpcErrorCode::UnsupportedPlatform)?;
        let prepared=prepare(&policy,&dispatch.request)?;
        let mut record=Record{dispatch:dispatch.clone(),events:Vec::new(),finished:false,
            output_bytes:0,omitted_bytes:0,cancel_cause:None};
        record.push(WorkspaceEventBody::Accepted)?;
        self.inner.ledger.store(&record)?; // durable admission precedes spawn
        let (event_tx,event_rx)=broadcast::channel(256);
        let (cancel_tx,cancel_rx)=watch::channel(None);
        let id=dispatch.request.request_id.clone();
        state.live.insert(id.clone(),Live{cancel:cancel_tx,events:event_tx});
        let owner=self.clone();
        let work=tokio::spawn(async move {owner.execute(dispatch,prepared,cancel_rx).await});
        let monitor=self.clone();
        tokio::spawn(async move {
            match work.await {
                Ok(Ok(()))=>{}
                _=>{let _=monitor.emit(&id,WorkspaceEventBody::Unknown{code:RpcErrorCode::UnknownOutcome});}
            }
            if let Ok(mut state)=monitor.inner.state.lock() {state.live.remove(&id);}
        });
        Ok(Submission{replay:record.events,live:Some(event_rx)})
    }
    pub fn cancel_trusted(&self,cancel:&WorkspaceCancel)->RpcResult<Vec<WorkspaceEvent>> {
        let state=self.inner.state.lock().map_err(|_|RpcErrorCode::StorageUnavailable)?;
        let mut record=self.inner.ledger.read(&cancel.request_id)?.ok_or(RpcErrorCode::NotFound)?;
        cancel.validate_for(&record.dispatch)?;
        if !record.finished {
            if let Some(entry)=state.live.get(&cancel.request_id) {
                let first=*record.cancel_cause.get_or_insert(cancel.cause);
                self.inner.ledger.store(&record)?;
                entry.cancel.send_replace(Some(first));
            } else {
                record.push(WorkspaceEventBody::Unknown{code:RpcErrorCode::UnknownOutcome})?;
                self.inner.ledger.store(&record)?;
            }
        }
        Ok(record.events)
    }
    pub fn replay_trusted(&self,replay:&WorkspaceReplay)->RpcResult<Vec<WorkspaceEvent>> {
        Ok(self.resubscribe_trusted(replay)?.replay)
    }
    pub fn resubscribe_trusted(&self,replay:&WorkspaceReplay)->RpcResult<Submission> {
        let state=self.inner.state.lock().map_err(|_|RpcErrorCode::StorageUnavailable)?;
        let mut record=self.inner.ledger.read(&replay.request_id)?.ok_or(RpcErrorCode::NotFound)?;
        replay.validate_for(&record.dispatch)?;
        if replay.after_seq>record.events.len() as u64 {return Err(RpcErrorCode::SequenceConflict);}
        let live=state.live.get(&replay.request_id).map(|entry|entry.events.subscribe());
        if !record.finished && live.is_none() {
            record.push(WorkspaceEventBody::Unknown{code:RpcErrorCode::UnknownOutcome})?;
            self.inner.ledger.store(&record)?;
        }
        Ok(Submission{replay:record.events.into_iter().filter(|e|e.seq>replay.after_seq).collect(),live})
    }
    fn emit(&self,id:&str,body:WorkspaceEventBody)->RpcResult<()> {
        let state=self.inner.state.lock().map_err(|_|RpcErrorCode::StorageUnavailable)?;
        let mut record=self.inner.ledger.read(id)?.ok_or(RpcErrorCode::StorageUnavailable)?;
        let event=record.push(body)?;
        self.inner.ledger.store(&record)?; // never acknowledge an uncommitted event
        if let Some(live)=state.live.get(id) {let _=live.events.send(event);}
        Ok(())
    }
    async fn execute(&self,dispatch:WorkspaceDispatch,prepared:Prepared,mut cancel:watch::Receiver<Option<CancelCause>>)->RpcResult<()> {
        let id=&dispatch.request.request_id;
        if let Some(cause)=*cancel.borrow() {return self.emit(id,WorkspaceEventBody::Cancelled{cause});}
        if now_ms()>=dispatch.deadline_unix_ms {
            return self.emit(id,WorkspaceEventBody::Cancelled{cause:CancelCause::Deadline});
        }
        match prepared {
            Prepared::Run(spec)=>self.run(&dispatch,spec,cancel).await,
            fs_operation=>{
                let mut work=tokio::task::spawn_blocking(move||execute_fs(fs_operation));
                let budget=Duration::from_millis(dispatch.deadline_unix_ms.saturating_sub(now_ms()).min(MAX_TIMEOUT_MS));
                let result=tokio::select! {
                    result=&mut work=>result.map_err(|_|RpcErrorCode::UnknownOutcome)?,
                    _=tokio::time::sleep(budget)=>return self.emit(id,WorkspaceEventBody::Unknown{code:RpcErrorCode::DeadlineExceeded}),
                    _=cancel.changed()=>return self.emit(id,WorkspaceEventBody::Unknown{code:RpcErrorCode::Cancelled}),
                };
                // A blocking filesystem operation cannot be forcibly stopped.
                // Deadline/cancel above therefore reports unknown, never a
                // fabricated proof that the OS read thread has exited.
                let cause=*cancel.borrow_and_update();
                if let Some(cause)=cause {self.emit(id,WorkspaceEventBody::Cancelled{cause})}
                else if now_ms()>=dispatch.deadline_unix_ms {
                    self.emit(id,WorkspaceEventBody::Cancelled{cause:CancelCause::Deadline})
                } else {match result {
                    Ok(result)=>self.emit(id,WorkspaceEventBody::Completed{result}),
                    Err(code)=>self.emit(id,WorkspaceEventBody::Failed{code}),
                }}
            }
        }
    }
    async fn run(&self,dispatch:&WorkspaceDispatch,spec:ProcessSpec,mut cancel:watch::Receiver<Option<CancelCause>>)->RpcResult<()> {
        let id=&dispatch.request.request_id;
        let mut process=match NativeProcess::spawn(&spec) {
            Ok(process)=>process,
            // A Unix ownership-capture failure can happen after spawn. A
            // persisted identity therefore always becomes unknown, never retry.
            Err(_)=>return self.emit(id,WorkspaceEventBody::Unknown{code:RpcErrorCode::SpawnFailed}),
        };
        let stdout=process.take_stdout().ok_or(RpcErrorCode::UnknownOutcome)?;
        let stderr=process.take_stderr().ok_or(RpcErrorCode::UnknownOutcome)?;
        let (tx,mut rx)=mpsc::channel(16);
        let out_task=tokio::spawn(pump(stdout,RpcOutputStream::Stdout,tx.clone()));
        let err_task=tokio::spawn(pump(stderr,RpcOutputStream::Stderr,tx));
        let deadline=tokio::time::Instant::now()+Duration::from_millis(dispatch.deadline_unix_ms.saturating_sub(now_ms()).min(MAX_TIMEOUT_MS));
        let mut ticker=tokio::time::interval(Duration::from_millis(20));
        let mut exit=None;let mut drained=false;let mut bytes=0_u64;let mut omitted=0_u64;let mut fragments=0_usize;
        let mut cancellation=None;let mut io_failed=false;
        loop {
            if let Some(cause)=*cancel.borrow() {cancellation=Some(cause);break;}
            if exit.is_some() && drained {break;}
            tokio::select! {biased;
                changed=cancel.changed()=>{if changed.is_err(){cancellation=Some(CancelCause::User);break;}}
                _=tokio::time::sleep_until(deadline)=>{cancellation=Some(CancelCause::Deadline);break;}
                message=rx.recv(),if !drained=>{
                    match message {
                        None=>drained=true,
                        Some(Err(()))=>{io_failed=true;break;}
                        Some(Ok((stream,data)))=>{
                            let keep=if fragments<MAX_OUTPUT_FRAGMENTS {
                                (MAX_OUTPUT_BYTES-bytes).min(data.len() as u64) as usize
                            } else {0};
                            if keep>0 {
                                self.emit(id,WorkspaceEventBody::Output{stream,data:STANDARD.encode(&data[..keep])})?;
                                fragments+=1;bytes+=keep as u64;
                            }
                            omitted=omitted.checked_add((data.len()-keep) as u64).ok_or(RpcErrorCode::OutputLimit)?;
                        }
                    }
                }
                _=ticker.tick()=>{exit=process.try_wait().map_err(|_|RpcErrorCode::UnknownOutcome)?;}
            }
        }
        // Keep readers draining while terminating so pipe backpressure cannot
        // hold the native owner alive. Aborting happens after the cleanup gate.
        let cleanup=if cancellation.is_some() || io_failed || !process.tree_is_empty().unwrap_or(false) {
            process.terminate_and_wait(Duration::from_secs(3)).await.map(|receipt|receipt.exit_status)
        } else {exit.ok_or_else(||std::io::Error::other("exit unconfirmed"))};
        out_task.abort();err_task.abort();
        if omitted>0 {self.emit(id,WorkspaceEventBody::OutputTruncated{omitted_bytes:omitted})?;}
        match cleanup {
            Err(_)=>self.emit(id,WorkspaceEventBody::Unknown{code:RpcErrorCode::UnknownOutcome}),
            Ok(_) if io_failed=>self.emit(id,WorkspaceEventBody::Unknown{code:RpcErrorCode::UnknownOutcome}),
            Ok(_) if cancellation.is_some()=>self.emit(id,WorkspaceEventBody::Cancelled{cause:cancellation.unwrap()}),
            Ok(status)=>self.emit(id,WorkspaceEventBody::Completed{result:WorkspaceResult::Run{
                exit_code:status.code().unwrap_or(-1),output_bytes:bytes,omitted_bytes:omitted}}),
        }
    }
}

enum Prepared {
    List{root:PathBuf,path:String,limit:u32,authority:Option<TrustedPreparedWorkspace>},
    Read{root:PathBuf,path:String,offset:u64,max_bytes:u32,authority:Option<TrustedPreparedWorkspace>},
    Write{root:PathBuf,path:String,bytes:Vec<u8>,authority:Option<TrustedPreparedWorkspace>},
    Run(ProcessSpec),
}
fn prepare(policy:&WorkspacePolicy,request:&WorkspaceRequest)->RpcResult<Prepared> {
    match &request.operation {
        WorkspaceOperation::List{path,limit} if policy.allow_list=>Ok(Prepared::List{root:policy.root.clone(),path:path.clone(),limit:*limit,authority:policy.prepared.clone()}),
        WorkspaceOperation::Read{path,offset,max_bytes} if policy.allow_read=>Ok(Prepared::Read{root:policy.root.clone(),path:path.clone(),offset:*offset,max_bytes:*max_bytes,authority:policy.prepared.clone()}),
        WorkspaceOperation::Write{path,data} if policy.allow_write=>{
            // The request was already validated; decoding here keeps the bytes
            // bounded once, before any filesystem work starts.
            let bytes=STANDARD.decode(data).map_err(|_|RpcErrorCode::InvalidRequest)?;
            if bytes.len() as u64>MAX_WRITE_BYTES as u64 {return Err(RpcErrorCode::InvalidRequest);}
            Ok(Prepared::Write{root:policy.root.clone(),path:path.clone(),bytes,authority:policy.prepared.clone()})
        }
        WorkspaceOperation::Run{tool_id,args,cwd}=>{
            let tool=policy.tools.get(tool_id).ok_or(RpcErrorCode::ToolDenied)?;
            if !tool.argv_variants.iter().any(|allowed|allowed==args) {return Err(RpcErrorCode::ToolDenied);}
            let cwd=resolve(&policy.root,cwd)?;
            if !cwd.is_dir(){return Err(RpcErrorCode::NotDirectory);}
            let native_args=tool.fixed_prefix.iter().chain(args).map(OsString::from).collect();
            let spec=ProcessSpec::new(tool.program.clone(),native_args,cwd,
                tool.environment.clone(),StdinPolicy::Null).map_err(|_|RpcErrorCode::ToolDenied)?;
            if spec.application_identity_digest()!=tool.application_identity {return Err(RpcErrorCode::ToolDenied);}
            Ok(Prepared::Run(spec))
        }
        _=>Err(RpcErrorCode::ToolDenied)
    }
}
fn resolve(root:&Path,path:&str)->RpcResult<PathBuf> {
    validate_relative_path(path,true)?;
    let target=fs::canonicalize(root.join(path)).map_err(|_|RpcErrorCode::NotFound)?;
    if !target.starts_with(root) {return Err(RpcErrorCode::PathRejected);}
    Ok(target)
}
/// Resolve a write target without creating anything: the parent must already be
/// a contained canonical directory in the workspace, the final component must
/// be a single legal name, and an existing target may not be a symlink or a
/// directory. The bytes are written afterwards through the generic
/// `verify_open_file_inside` re-check, so a swap between this decision and the
/// open is refused rather than followed.
fn write_target(root:&Path,path:&str)->RpcResult<(PathBuf,bool)> {
    validate_write_path(path)?;
    let (parent,name)=path.rsplit_once('/').map_or(("",path),|(parent,name)|(parent,name));
    let parent=resolve(root,parent)?;
    if !parent.is_dir() {return Err(RpcErrorCode::NotDirectory);}
    let target=parent.join(name);
    let created=match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink()=>return Err(RpcErrorCode::PathRejected),
        Ok(metadata) if metadata.is_dir()=>return Err(RpcErrorCode::NotFile),
        Ok(_)=>false,
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>true,
        Err(_)=>return Err(RpcErrorCode::NotFound),
    };
    Ok((target,created))
}
fn execute_fs(operation:Prepared)->RpcResult<WorkspaceResult> {
    match operation {
        Prepared::List{root,path,limit,authority}=>{
            if let Some(authority)=&authority {authority.revalidate()?;}
            let directory=resolve(&root,&path)?;
            if !directory.is_dir(){return Err(RpcErrorCode::NotDirectory);}
            let mut entries=BTreeMap::new();let mut truncated=false;
            for (index,entry) in fs::read_dir(&directory).map_err(|_|RpcErrorCode::NotFound)?.enumerate() {
                if index>=4096 {truncated=true;break;}
                let entry=entry.map_err(|_|RpcErrorCode::NotFound)?;
                let Some(name)=entry.file_name().to_str().map(str::to_owned) else {continue;};
                if validate_relative_path(&name,false).is_err() || name.contains('/') {continue;}
                let relative=if path.is_empty(){name.clone()}else{format!("{path}/{name}")};
                let Ok(child)=resolve(&root,&relative) else {continue;};
                let kind=if child.is_dir(){EntryKind::Directory}else if child.is_file(){EntryKind::File}else{continue;};
                entries.insert(name.clone(),WorkspaceEntry{name,kind});
                if entries.len()>limit as usize {truncated=true;break;}
            }
            if let Some(authority)=&authority {authority.revalidate()?;}
            Ok(WorkspaceResult::List{entries:entries.into_values().take(limit as usize).collect(),truncated})
        }
        Prepared::Read{root,path,offset,max_bytes,authority}=>{
            if let Some(authority)=&authority {authority.revalidate()?;}
            let path=resolve(&root,&path)?;
            let mut file=File::open(&path).map_err(|_|RpcErrorCode::NotFound)?;
            if !file.metadata().map_err(|_|RpcErrorCode::NotFound)?.is_file(){return Err(RpcErrorCode::NotFile);}
            verify_open_file_inside(&file,&root)?;
            file.seek(SeekFrom::Start(offset)).map_err(|_|RpcErrorCode::InvalidRequest)?;
            let mut data=Vec::new();
            file.take(max_bytes as u64+1).read_to_end(&mut data).map_err(|_|RpcErrorCode::NotFound)?;
            let truncated=data.len()>max_bytes as usize;data.truncate(max_bytes as usize);
            if let Some(authority)=&authority {authority.revalidate()?;}
            Ok(WorkspaceResult::Read{data:STANDARD.encode(data),offset,truncated})
        }
        Prepared::Write{root,path,bytes,authority}=>{
            if let Some(authority)=&authority {authority.revalidate()?;}
            let (target,created)=write_target(&root,&path)?;
            let mut file=fs::OpenOptions::new().write(true).create(true).truncate(true)
                .open(&target).map_err(|_|RpcErrorCode::StorageUnavailable)?;
            verify_open_file_inside(&file,&root)?;
            if !file.metadata().map_err(|_|RpcErrorCode::StorageUnavailable)?.is_file() {return Err(RpcErrorCode::NotFile);}
            file.write_all(&bytes).map_err(|_|RpcErrorCode::StorageUnavailable)?;
            file.flush().map_err(|_|RpcErrorCode::StorageUnavailable)?;
            // The binding must still hold after the only mutating operation, so a
            // write that invalidated the prepared identity is reported, not
            // silently accepted.
            if let Some(authority)=&authority {authority.revalidate()?;}
            Ok(WorkspaceResult::Write{bytes_written:bytes.len() as u64,created})
        }
        Prepared::Run(_)=>Err(RpcErrorCode::InvalidRequest),
    }
}
#[cfg(target_os="linux")]
fn verify_open_file_inside(file:&File,root:&Path)->RpcResult<()> {
    use std::os::fd::AsRawFd;
    let final_path=fs::read_link(format!("/proc/self/fd/{}",file.as_raw_fd())).map_err(|_|RpcErrorCode::PathRejected)?;
    if final_path.starts_with(root) {Ok(())} else {Err(RpcErrorCode::PathRejected)}
}
#[cfg(windows)]
fn verify_open_file_inside(file:&File,root:&Path)->RpcResult<()> {
    use std::os::windows::{io::AsRawHandle,ffi::OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer=vec![0_u16;32768];
    let length=unsafe{GetFinalPathNameByHandleW(file.as_raw_handle(),buffer.as_mut_ptr(),buffer.len() as u32,0)};
    if length==0 || length as usize>=buffer.len() {return Err(RpcErrorCode::PathRejected);}
    let final_path=PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
    if final_path.starts_with(root) {Ok(())} else {Err(RpcErrorCode::PathRejected)}
}
#[cfg(target_os="macos")]
fn verify_open_file_inside(file:&File,root:&Path)->RpcResult<()> {
    use std::os::{fd::AsRawFd,unix::ffi::OsStringExt};
    let mut path=vec![0_u8;1024];
    if unsafe{libc::fcntl(file.as_raw_fd(),libc::F_GETPATH,path.as_mut_ptr())}<0 {return Err(RpcErrorCode::PathRejected);}
    path.truncate(path.iter().position(|b|*b==0).unwrap_or(path.len()));
    if PathBuf::from(OsString::from_vec(path)).starts_with(root) {Ok(())}else{Err(RpcErrorCode::PathRejected)}
}
#[cfg(not(any(target_os="linux",target_os="macos",windows)))]
fn verify_open_file_inside(_: &File,_: &Path)->RpcResult<()> {Err(RpcErrorCode::UnsupportedPlatform)}

async fn pump<R:AsyncRead+Unpin>(mut reader:R,stream:RpcOutputStream,tx:mpsc::Sender<Result<(RpcOutputStream,Vec<u8>),()>>) {
    let mut buffer=vec![0_u8;MAX_CHUNK_BYTES as usize];
    loop {match reader.read(&mut buffer).await {
        Ok(0)=>break,
        Ok(n)=>if tx.send(Ok((stream,buffer[..n].to_vec()))).await.is_err(){break;},
        Err(_)=>{let _=tx.send(Err(())).await;break;}
    }}
}
fn now_ms()->u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|n|u64::try_from(n.as_millis()).unwrap_or(u64::MAX)).unwrap_or(u64::MAX)
}
#[cfg(test)]
#[path="workspace_rpc_tests.rs"]
mod tests;
