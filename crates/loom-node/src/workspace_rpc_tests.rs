use super::*;
use std::io::Write;

fn fixture_root()->PathBuf {
    let path=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../_artifacts/node-rpc-tests").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(path.join("workspace")).unwrap();fs::canonicalize(path).unwrap()
}
fn scope()->CallerScope {CallerScope{run_id:"run-1".into(),attempt:1,session_id:"session-1".into(),member_id:"member-1".into(),mission_id:"mission-1".into()}}
fn dispatch(id:&str,operation:WorkspaceOperation,timeout:u64)->WorkspaceDispatch {
    WorkspaceDispatch::new(WorkspaceRequest{version:RPC_VERSION,request_id:id.into(),workspace_id:"workspace-1".into(),timeout_ms:timeout,operation},scope(),"node-b".into(),1,now_ms()).unwrap()
}
fn test_filter()->String {
    let module=module_path!().split_once("::").unwrap().1;
    format!("{module}::owned_tool_fixture")
}
fn command_args()->Vec<String> {vec!["--exact".into(),test_filter(),"--ignored".into(),"--nocapture".into()]}
fn executor(root:&Path,mode:&str)->WorkspaceRpcExecutor {
    let mut env=BTreeMap::from([
        (OsString::from("NODE_RPC_TEST_MODE"),OsString::from(mode)),
        (OsString::from("NODE_RPC_TEST_ROOT"),root.as_os_str().to_owned()),
        (OsString::from("NODE_RPC_TEST_FILTER"),OsString::from(test_filter())),
    ]);
    for key in ["SystemRoot","TEMP","TMP"] {if let Some(value)=std::env::var_os(key){env.insert(key.into(),value);}}
    let tools=BTreeMap::from([("fixture".into(),ToolPolicy::new(std::env::current_exe().unwrap(),vec![command_args()],env).unwrap())]);
    let policy=WorkspacePolicy::new("workspace-1".into(),"mission-1".into(),"node-b".into(),1,root.join("workspace"),true,true,true,tools).unwrap();
    WorkspaceRpcExecutor::open("node-b".into(),root.join("journal"),vec![policy]).unwrap()
}
fn run_operation()->WorkspaceOperation {WorkspaceOperation::Run{tool_id:"fixture".into(),args:command_args(),cwd:String::new()}}
async fn complete(mut submission:Submission)->Vec<WorkspaceEvent> {
    let mut events=submission.replay;
    tokio::time::timeout(Duration::from_secs(25),async {
        while !events.last().is_some_and(|event|matches!(event.body,WorkspaceEventBody::Completed{..}|WorkspaceEventBody::Failed{..}|WorkspaceEventBody::Cancelled{..}|WorkspaceEventBody::Unknown{..})) {
            let event=submission.live.as_mut().expect("unfinished without live owner").recv().await.unwrap();
            if event.seq>events.last().map(|e|e.seq).unwrap_or(0) {events.push(event);}
        }
    }).await.unwrap();events
}
async fn drained(executor:&WorkspaceRpcExecutor) {
    tokio::time::timeout(Duration::from_secs(5),async {
        while !executor.inner.state.lock().unwrap().live.is_empty() {tokio::time::sleep(Duration::from_millis(5)).await;}
    }).await.unwrap();
}
fn replay_control(dispatch:&WorkspaceDispatch)->WorkspaceReplay {
    WorkspaceReplay{version:RPC_VERSION,request_id:dispatch.request.request_id.clone(),run_id:dispatch.scope.run_id.clone(),
        attempt:dispatch.scope.attempt,request_digest:dispatch.request_digest.clone(),after_seq:0}
}
#[test]
#[ignore="private native tool entry point; invoked by real process owner tests"]
fn owned_tool_fixture() {
    let mode=std::env::var("NODE_RPC_TEST_MODE").unwrap();
    if mode=="sleep" {std::thread::sleep(Duration::from_secs(30));return;}
    let root=PathBuf::from(std::env::var_os("NODE_RPC_TEST_ROOT").unwrap());
    let mut counter=fs::OpenOptions::new().create(true).append(true).open(root.join("count.txt")).unwrap();
    writeln!(counter,"executed").unwrap();counter.sync_all().unwrap();
    if mode=="flood" {
        let bytes=vec![b'x';2*MAX_OUTPUT_BYTES as usize];
        std::io::stdout().write_all(&bytes).unwrap();std::io::stdout().flush().unwrap();return;
    }
    if mode=="wait" {
        let child=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact",&std::env::var("NODE_RPC_TEST_FILTER").unwrap(),"--ignored","--nocapture"])
            .env("NODE_RPC_TEST_MODE","sleep")
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        fs::write(root.join("grandchild.pid"),child.id().to_string()).unwrap();
        println!("GRANDCHILD:{}",child.id());std::io::stdout().flush().unwrap();
        std::thread::sleep(Duration::from_secs(30));
    } else {println!("NODE_RPC_RUN_OK");}
}

#[tokio::test]
async fn admission_rejects_wrong_owner_policy_mission_paths_and_unapproved_argv_before_execution() {
    let root=fixture_root();let engine=executor(&root,"once");
    let base=dispatch("admit",run_operation(),5000);
    let mut variants=Vec::new();
    let mut changed=base.clone();changed.owner_node_id="node-other".into();
    changed=WorkspaceDispatch::new(changed.request,changed.scope,changed.owner_node_id,1,changed.accepted_at_unix_ms).unwrap();
    variants.push((changed,RpcErrorCode::WrongNode));
    let changed=WorkspaceDispatch::new(base.request.clone(),base.scope.clone(),"node-b".into(),2,base.accepted_at_unix_ms).unwrap();
    variants.push((changed,RpcErrorCode::PolicyMismatch));
    let mut wrong_scope=scope();wrong_scope.mission_id="foreign".into();
    variants.push((WorkspaceDispatch::new(base.request.clone(),wrong_scope,"node-b".into(),1,base.accepted_at_unix_ms).unwrap(),RpcErrorCode::Unauthorized));
    for (request,expected) in variants {assert_eq!(engine.submit_trusted(request).err(),Some(expected));}
    let mut request=base.request.clone();
    request.operation=WorkspaceOperation::Run{tool_id:"fixture".into(),args:vec!["--malicious".into()],cwd:String::new()};
    let changed=WorkspaceDispatch::new(request,scope(),"node-b".into(),1,now_ms()).unwrap();
    assert_eq!(engine.submit_trusted(changed).err(),Some(RpcErrorCode::ToolDenied));
    let mut request=base.request.clone();request.operation=WorkspaceOperation::Read{path:"../outside.txt".into(),offset:0,max_bytes:8};
    assert_eq!(request.validate(),Err(RpcErrorCode::PathRejected));
    assert!(!root.join("count.txt").exists());
    assert!(engine.inner.ledger.read("admit").unwrap().is_none());
}

#[tokio::test]
async fn same_owner_session_lists_and_reads_bounded_bytes_and_refuses_static_escape() {
    let root=fixture_root();fs::write(root.join("workspace/data.txt"),b"0123456789").unwrap();
    fs::write(root.join("outside.txt"),b"OUTSIDE_SECRET").unwrap();
    let engine=executor(&root,"once");
    let listed=complete(engine.submit_trusted(dispatch("list",WorkspaceOperation::List{path:String::new(),limit:10},5000)).unwrap()).await;
    assert!(matches!(&listed.last().unwrap().body,WorkspaceEventBody::Completed{result:WorkspaceResult::List{entries,..}} if entries.iter().any(|e|e.name=="data.txt")));
    let read=complete(engine.submit_trusted(dispatch("read",WorkspaceOperation::Read{path:"data.txt".into(),offset:2,max_bytes:3},5000)).unwrap()).await;
    assert!(matches!(&read.last().unwrap().body,WorkspaceEventBody::Completed{result:WorkspaceResult::Read{data,offset:2,truncated:true}} if STANDARD.decode(data).unwrap()==b"234"));
    #[cfg(unix)]
    let linked=std::os::unix::fs::symlink(root.join("outside.txt"),root.join("workspace/escape.txt"));
    #[cfg(windows)]
    let linked=std::os::windows::fs::symlink_file(root.join("outside.txt"),root.join("workspace/escape.txt"));
    if linked.is_ok() {
        let escaped=complete(engine.submit_trusted(dispatch("escape",WorkspaceOperation::Read{path:"escape.txt".into(),offset:0,max_bytes:64},5000)).unwrap()).await;
        assert!(matches!(escaped.last().unwrap().body,WorkspaceEventBody::Failed{code:RpcErrorCode::PathRejected}));
    } else {eprintln!("SYMLINK_PROBE_UNAVAILABLE: OS did not permit fixture link creation");}
}

#[tokio::test]
async fn write_replaces_only_a_contained_regular_file_and_refuses_escape_and_oversize() {
    let root=fixture_root();fs::create_dir_all(root.join("workspace/out")).unwrap();
    fs::create_dir_all(root.join("escape-dir")).unwrap();
    fs::write(root.join("outside.txt"),b"OUTSIDE_SECRET").unwrap();
    let engine=executor(&root,"once");
    let write=|id:&str,path:&str,bytes:&[u8]|dispatch(id,WorkspaceOperation::Write{path:path.into(),
        data:STANDARD.encode(bytes)},5000);
    let created=complete(engine.submit_trusted(write("write-new","out/report.md",b"# report\n")).unwrap()).await;
    assert!(matches!(created.last().unwrap().body,WorkspaceEventBody::Completed{
        result:WorkspaceResult::Write{bytes_written:9,created:true}}));
    assert_eq!(fs::read(root.join("workspace/out/report.md")).unwrap(),b"# report\n");
    let replaced=complete(engine.submit_trusted(write("write-replace","out/report.md",b"second")).unwrap()).await;
    assert!(matches!(replaced.last().unwrap().body,WorkspaceEventBody::Completed{
        result:WorkspaceResult::Write{bytes_written:6,created:false}}));
    assert_eq!(fs::read(root.join("workspace/out/report.md")).unwrap(),b"second");
    // No directory is created and an existing directory is not a write target.
    let absent=complete(engine.submit_trusted(write("write-absent-parent","missing/report.md",b"x")).unwrap()).await;
    assert!(matches!(absent.last().unwrap().body,WorkspaceEventBody::Failed{code:RpcErrorCode::NotFound}));
    assert!(!root.join("workspace/missing").exists());
    let directory=complete(engine.submit_trusted(write("write-directory","out",b"x")).unwrap()).await;
    assert!(matches!(directory.last().unwrap().body,WorkspaceEventBody::Failed{code:RpcErrorCode::NotFile}));
    // Traversal and oversize payloads never become a dispatch: the request
    // grammar refuses them before an owner sees the operation.
    for path in ["../outside.txt","out/../../outside.txt",".git/HEAD","/etc/passwd","out/report.md."] {
        let request=WorkspaceRequest{version:RPC_VERSION,request_id:"rejected".into(),
            workspace_id:"workspace-1".into(),timeout_ms:5000,
            operation:WorkspaceOperation::Write{path:path.into(),data:STANDARD.encode(b"x")}};
        assert_eq!(request.validate(),Err(RpcErrorCode::PathRejected),"{path}");
    }
    let oversize=WorkspaceRequest{version:RPC_VERSION,request_id:"oversize".into(),
        workspace_id:"workspace-1".into(),timeout_ms:5000,
        operation:WorkspaceOperation::Write{path:"big.bin".into(),
            data:STANDARD.encode(vec![b'x';MAX_WRITE_BYTES as usize+1])}};
    assert_eq!(oversize.validate(),Err(RpcErrorCode::InvalidRequest));
    assert!(!root.join("workspace/big.bin").exists());
    // A symlinked target and a symlinked parent directory are both refused, and
    // the file outside the workspace is untouched.
    #[cfg(unix)]
    let linked=std::os::unix::fs::symlink(root.join("outside.txt"),root.join("workspace/escape.txt"));
    #[cfg(windows)]
    let linked=std::os::windows::fs::symlink_file(root.join("outside.txt"),root.join("workspace/escape.txt"));
    if linked.is_ok() {
        let escaped=complete(engine.submit_trusted(write("write-symlink","escape.txt",b"ESCAPED")).unwrap()).await;
        assert!(matches!(escaped.last().unwrap().body,WorkspaceEventBody::Failed{code:RpcErrorCode::PathRejected}));
        assert_eq!(fs::read(root.join("outside.txt")).unwrap(),b"OUTSIDE_SECRET");
    } else {eprintln!("SYMLINK_PROBE_UNAVAILABLE: OS did not permit fixture link creation");}
    #[cfg(unix)]
    let linked_dir=std::os::unix::fs::symlink(root.join("escape-dir"),root.join("workspace/linked"));
    #[cfg(windows)]
    let linked_dir=std::os::windows::fs::symlink_dir(root.join("escape-dir"),root.join("workspace/linked"));
    if linked_dir.is_ok() {
        let escaped=complete(engine.submit_trusted(write("write-symlink-dir","linked/x.txt",b"ESCAPED")).unwrap()).await;
        assert!(matches!(escaped.last().unwrap().body,WorkspaceEventBody::Failed{code:RpcErrorCode::PathRejected}));
        assert!(!root.join("escape-dir/x.txt").exists());
    } else {eprintln!("SYMLINK_PROBE_UNAVAILABLE: OS did not permit fixture link creation");}
}

#[tokio::test]
async fn durable_request_identity_survives_retries_restart_and_unconfirmed_spawn() {
    let root=fixture_root();let engine=executor(&root,"once");
    let request=dispatch("once",run_operation(),5000);
    let first=engine.submit_trusted(request.clone()).unwrap();
    let duplicate=engine.submit_trusted(request.clone()).unwrap();
    let events=complete(first).await;let _=complete(duplicate).await;
    assert!(matches!(events.last().unwrap().body,WorkspaceEventBody::Completed{result:WorkspaceResult::Run{exit_code:0,..}}));
    drained(&engine).await;drop(engine);
    let engine=executor(&root,"once");
    let replay=engine.submit_trusted(request.clone()).unwrap();assert!(replay.live.is_none());assert_eq!(replay.replay,events);
    assert_eq!(fs::read_to_string(root.join("count.txt")).unwrap().lines().count(),1);
    let unknown=dispatch("crashed-before-spawn",run_operation(),5000);
    let mut record=Record{dispatch:unknown.clone(),events:Vec::new(),finished:false,output_bytes:0,omitted_bytes:0,cancel_cause:None};
    record.push(WorkspaceEventBody::Accepted).unwrap();engine.inner.ledger.store(&record).unwrap();
    let recovered=engine.submit_trusted(unknown.clone()).unwrap();
    assert!(matches!(recovered.replay.last().unwrap().body,WorkspaceEventBody::Unknown{..}));
    assert!(engine.submit_trusted(unknown).unwrap().live.is_none());
    assert_eq!(fs::read_to_string(root.join("count.txt")).unwrap().lines().count(),1);
    assert_eq!(engine.replay_trusted(&replay_control(&request)).unwrap(),events);
}

#[tokio::test]
async fn process_output_is_bounded_and_cancel_deadline_confirm_tree_cleanup() {
    let root=fixture_root();let engine=executor(&root,"flood");
    let output=complete(engine.submit_trusted(dispatch("flood",run_operation(),20000)).unwrap()).await;
    let retained:usize=output.iter().filter_map(|event|if let WorkspaceEventBody::Output{data,..}=&event.body {Some(STANDARD.decode(data).unwrap().len())}else{None}).sum();
    assert_eq!(retained,MAX_OUTPUT_BYTES as usize);
    assert!(output.iter().any(|event|matches!(event.body,WorkspaceEventBody::OutputTruncated{omitted_bytes} if omitted_bytes>0)));
    assert!(matches!(output.last().unwrap().body,WorkspaceEventBody::Completed{result:WorkspaceResult::Run{output_bytes,omitted_bytes,..}} if output_bytes==MAX_OUTPUT_BYTES && omitted_bytes>0));
    for (label,cause) in [("cancel",CancelCause::User),("deadline",CancelCause::Deadline)] {
        let root=fixture_root();let engine=executor(&root,"wait");
        let request=dispatch(label,run_operation(),if cause==CancelCause::User {20000}else{10000});
        let submission=engine.submit_trusted(request.clone()).unwrap();
        tokio::time::timeout(Duration::from_secs(8),async {
            while !root.join("grandchild.pid").exists() {tokio::time::sleep(Duration::from_millis(10)).await;}
        }).await.unwrap();
        let child:u32=fs::read_to_string(root.join("grandchild.pid")).unwrap().parse().unwrap();
        #[cfg(windows)]
        let pinned=pin_process(child);
        if cause==CancelCause::User {
            engine.cancel_trusted(&WorkspaceCancel{version:RPC_VERSION,request_id:request.request.request_id.clone(),
                run_id:request.scope.run_id.clone(),attempt:request.scope.attempt,request_digest:request.request_digest.clone(),cause}).unwrap();
        }
        let events=complete(submission).await;
        assert!(matches!(events.last().unwrap().body,WorkspaceEventBody::Cancelled{cause:actual} if actual==cause));
        #[cfg(windows)]
        assert_process_exited(pinned).await;
        #[cfg(target_os="linux")]
        tokio::time::timeout(Duration::from_secs(5),async {
            while linux_live(child) {tokio::time::sleep(Duration::from_millis(10)).await;}
        }).await.unwrap();
    }
}
#[tokio::test]
async fn exclusive_ledger_and_corrupt_records_fail_closed() {
    let root=fixture_root();let engine=executor(&root,"once");
    assert_eq!(WorkspaceRpcExecutor::open("node-b".into(),root.join("journal"),vec![]).err(),Some(RpcErrorCode::Busy));
    let request=dispatch("corrupt",run_operation(),5000);
    atomic_write_private_bytes(&engine.inner.ledger.path("corrupt"),b"{broken").unwrap();
    assert_eq!(engine.submit_trusted(request).err(),Some(RpcErrorCode::StorageUnavailable));
    assert!(!root.join("count.txt").exists());
}
#[cfg(windows)]
fn pin_process(pid:u32)->std::os::windows::io::OwnedHandle {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess,PROCESS_SYNCHRONIZE};
    let handle=unsafe{OpenProcess(PROCESS_SYNCHRONIZE,0,pid)};assert!(!handle.is_null());
    unsafe{std::os::windows::io::OwnedHandle::from_raw_handle(handle)}
}
#[cfg(windows)]
async fn assert_process_exited(handle:std::os::windows::io::OwnedHandle) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::{WAIT_OBJECT_0,WAIT_TIMEOUT},System::Threading::WaitForSingleObject};
    tokio::time::timeout(Duration::from_secs(5),async {
        loop {match unsafe{WaitForSingleObject(handle.as_raw_handle(),0)} {WAIT_OBJECT_0=>break,WAIT_TIMEOUT=>tokio::time::sleep(Duration::from_millis(10)).await,_=>panic!("owned process query failed")}}
    }).await.unwrap();
}
#[cfg(target_os="linux")]
fn linux_live(pid:u32)->bool {
    fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|s|s.rsplit_once(')').map(|(_,t)|t.split_whitespace().next().unwrap_or("Z").to_owned())).is_some_and(|s|s!="Z" && s!="X")
}

#[tokio::test]
async fn wire_disconnect_replays_durable_cursor_without_reexecuting_or_accepting_foreign_digest() {
    use loom_protocol::ClientMessage;
    let root=fixture_root();let engine=executor(&root,"once");
    let wire=WorkspaceRpcWire::new(engine.clone());
    let request=dispatch("wire-once",run_operation(),20000);
    let (tx,mut rx)=mpsc::channel(8);
    wire.handle_dispatch(request.clone(),tx).await;
    let first=tokio::time::timeout(Duration::from_secs(5),rx.recv()).await.unwrap().unwrap();
    assert!(matches!(first,ClientMessage::WorkspaceRpcEvent{event:WorkspaceEvent{seq:1,body:WorkspaceEventBody::Accepted,..}}));
    wire.disconnect();drop(rx);
    drained(&engine).await;
    let mut cursor=replay_control(&request);cursor.after_seq=1;
    let (tx,mut rx)=mpsc::channel(8);
    wire.handle_replay(cursor.clone(),tx).await;
    let mut seqs=Vec::new();
    tokio::time::timeout(Duration::from_secs(5),async{
        while let Some(message)=rx.recv().await {
            match message {
                ClientMessage::WorkspaceRpcEvent{event}=>{
                    seqs.push(event.seq);
                    if matches!(event.body,WorkspaceEventBody::Completed{..}) {break;}
                }
                _=>panic!("unexpected transport rejection"),
            }
        }
    }).await.unwrap();
    assert!(!seqs.is_empty());assert_eq!(seqs[0],2);
    assert!(seqs.windows(2).all(|pair|pair[1]==pair[0]+1));
    assert_eq!(fs::read_to_string(root.join("count.txt")).unwrap().lines().count(),1);
    let (tx,mut rx)=mpsc::channel(8);
    cursor.request_digest="sha256:".to_owned()+&"0".repeat(64);
    wire.handle_replay(cursor,tx).await;
    assert!(matches!(rx.recv().await,Some(ClientMessage::WorkspaceRpcRejected{..})));
    wire.disconnect();
}
