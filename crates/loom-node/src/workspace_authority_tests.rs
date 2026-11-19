use super::*;
use std::process::{Command,Stdio};
fn fixture()->(PathBuf,PreparedWorktree) {
    let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../_artifacts/workspace-authority-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(root.join("source")).unwrap();fs::create_dir_all(root.join("empty-hooks")).unwrap();
    fs::write(root.join("empty-gitconfig"),b"").unwrap();
    let root=fs::canonicalize(root).unwrap();
    #[cfg(windows)]
    let root=PathBuf::from(root.to_string_lossy().strip_prefix(r"\\?\").unwrap_or(&root.to_string_lossy()).to_owned());
    let git=|cwd:&Path,args:&[&str]|{
        let out=Command::new("git").arg("-C").arg(cwd)
            .arg("-c").arg(format!("core.hooksPath={}",root.join("empty-hooks").display()))
            .arg("-c").arg("user.name=Workspace Fixture").arg("-c").arg("user.email=fixture@invalid")
            .args(args).env("GIT_CONFIG_NOSYSTEM","1").env("GIT_CONFIG_GLOBAL",root.join("empty-gitconfig"))
            .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_COMMON_DIR")
            .stdin(Stdio::null()).output().unwrap();
        assert!(out.status.success(),"fixture Git {:?} failed: {}",args,String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    };
    git(&root.join("source"),&["init"]);
    fs::write(root.join("source/data.txt"),b"workspace fixture").unwrap();
    git(&root.join("source"),&["add","data.txt"]);
    git(&root.join("source"),&["commit","-m","fixture"]);
    git(&root.join("source"),&["worktree","add","-b","loom-fixture",root.join("worktree").to_str().unwrap()]);
    let prepared=PreparedWorktree {
        worktree:fs::canonicalize(root.join("worktree")).unwrap().to_string_lossy().into_owned(),
        source:fs::canonicalize(root.join("source")).unwrap().to_string_lossy().into_owned(),
        common_dir:fs::canonicalize(root.join("source/.git")).unwrap().to_string_lossy().into_owned(),
        base_sha:git(&root.join("worktree"),&["rev-parse","HEAD"]),branch:"loom-fixture".into(),
    };
    (root,prepared)
}
#[test]
fn prepared_facts_are_durable_exclusive_and_cannot_be_minted_from_cwd() {
    let (root,prepared)=fixture();
    let authority=WorkspaceAuthority::open(&root.join("data"),"node-b".into()).unwrap();
    assert_eq!(WorkspaceAuthority::open(&root.join("data"),"node-b".into()).err(),Some(RpcErrorCode::Busy));
    assert_eq!(authority.admit("unknown",Path::new(&prepared.worktree)).err(),Some(RpcErrorCode::Unauthorized));
    let handle=authority.record_prepared("workspace-1",&prepared).unwrap();
    assert_eq!(handle.revision(),1);
    assert_eq!(authority.record_prepared("workspace-1",&prepared).unwrap(),handle);
    fs::create_dir_all(root.join("worktree/sub")).unwrap();
    assert_eq!(authority.admit("workspace-1",Path::new("sub")).unwrap().working_directory(),
        fs::canonicalize(root.join("worktree/sub")).unwrap());
    assert_eq!(authority.admit("workspace-1",&root.join("source")).err(),Some(RpcErrorCode::PathRejected));
    assert_eq!(authority.admit("workspace-1",Path::new("../source")).err(),Some(RpcErrorCode::PathRejected));
    drop(authority);
    let authority=WorkspaceAuthority::open(&root.join("data"),"node-b".into()).unwrap();
    assert_eq!(authority.admit("workspace-1",Path::new("")).unwrap(),handle);
}
#[test]
fn replaced_roots_common_dir_conflicts_and_corrupt_storage_fail_closed() {
    let (root,prepared)=fixture();
    let authority=WorkspaceAuthority::open(&root.join("data"),"node-b".into()).unwrap();
    authority.record_prepared("workspace-1",&prepared).unwrap();
    let mut wrong=prepared.clone();wrong.common_dir=root.join("source").to_string_lossy().into_owned();
    assert_eq!(authority.record_prepared("workspace-2",&wrong).err(),Some(RpcErrorCode::PathRejected));
    let mut remap=prepared.clone();remap.worktree=prepared.source.clone();
    assert_eq!(authority.record_prepared("workspace-1",&remap).err(),Some(RpcErrorCode::RequestConflict));
    // Recreating an equally named Git worktree path cannot reuse the enrolled
    // directory's OS identity. All mutations are isolated fixture artifacts.
    let dot=fs::read(root.join("worktree/.git")).unwrap();
    fs::rename(root.join("worktree"),root.join("worktree-old")).unwrap();
    fs::create_dir(root.join("worktree")).unwrap();fs::write(root.join("worktree/.git"),dot).unwrap();
    assert_eq!(authority.admit("workspace-1",Path::new("")).err(),Some(RpcErrorCode::PolicyMismatch));
    assert_eq!(authority.record_prepared("workspace-1",&prepared).err(),Some(RpcErrorCode::RequestConflict));
    drop(authority);
    atomic_write_private_bytes(&root.join("data/workspace-authority/workspaces-v1.json"),b"{broken").unwrap();
    assert_eq!(WorkspaceAuthority::open(&root.join("data"),"node-b".into()).err(),Some(RpcErrorCode::StorageUnavailable));
}
#[tokio::test]
async fn new_prepares_register_without_restart_and_policy_revisions_do_not_silently_remap() {
    use crate::workspace_rpc::{WorkspacePolicy,WorkspaceRpcExecutor};
    use loom_protocol::workspace_rpc::*;
    let (root,prepared)=fixture();
    let authority=WorkspaceAuthority::open(&root.join("data"),"node-b".into()).unwrap();
    let engine=WorkspaceRpcExecutor::open("node-b".into(),root.join("rpc"),vec![]).unwrap();
    let handle=authority.record_prepared("workspace-1",&prepared).unwrap();
    let make_policy=|revision,read|WorkspacePolicy::from_prepared(handle.clone(),"mission-1".into(),revision,true,read,BTreeMap::new()).unwrap();
    engine.register_trusted_workspace(make_policy(1,true)).unwrap();
    engine.register_trusted_workspace(make_policy(1,true)).unwrap();
    assert_eq!(engine.register_trusted_workspace(make_policy(1,false)),Err(RpcErrorCode::PolicyMismatch));
    engine.register_trusted_workspace(make_policy(2,false)).unwrap();
    assert_eq!(engine.register_trusted_workspace(make_policy(1,true)),Err(RpcErrorCode::PolicyMismatch));
    let request=WorkspaceRequest{version:RPC_VERSION,request_id:"list-new-workspace".into(),workspace_id:"workspace-1".into(),
        timeout_ms:5000,operation:WorkspaceOperation::List{path:String::new(),limit:10}};
    let scope=CallerScope{run_id:"run".into(),attempt:1,session_id:"session".into(),member_id:"member".into(),mission_id:"mission-1".into()};
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let dispatch=WorkspaceDispatch::new(request.clone(),scope.clone(),"node-b".into(),2,now).unwrap();
    let mut result=engine.submit_trusted(dispatch).unwrap();
    let terminal=tokio::time::timeout(std::time::Duration::from_secs(5),async{
        loop {let event=result.live.as_mut().unwrap().recv().await.unwrap();
            if matches!(event.body,WorkspaceEventBody::Completed{..}|WorkspaceEventBody::Failed{..}|WorkspaceEventBody::Unknown{..}) {break event;}}
    }).await.unwrap();
    assert!(matches!(terminal.body,WorkspaceEventBody::Completed{result:WorkspaceResult::List{..}}));
    let read=WorkspaceRequest{request_id:"denied-read".into(),operation:WorkspaceOperation::Read{path:"data.txt".into(),offset:0,max_bytes:16},..request};
    assert_eq!(engine.submit_trusted(WorkspaceDispatch::new(read,scope,"node-b".into(),2,now).unwrap()).err(),Some(RpcErrorCode::ToolDenied));
}

#[tokio::test]
async fn authenticated_wire_requires_prepare_and_runs_only_fixed_native_git_status() {
    use crate::workspace_rpc::{WorkspaceRpcExecutor,WorkspaceRpcWire};
    use loom_protocol::{ClientMessage,workspace_rpc::*};
    use base64::Engine as _;
    let (root,prepared)=fixture();
    let authority=WorkspaceAuthority::open(&root.join("authority"),"node-b".into()).unwrap();
    let engine=WorkspaceRpcExecutor::open("node-b".into(),root.join("rpc"),vec![]).unwrap();
    let wire=WorkspaceRpcWire::with_authority(engine,authority.clone());
    let scope=CallerScope{run_id:"wire-run".into(),attempt:1,session_id:"same-session".into(),
        member_id:"member".into(),mission_id:"mission".into()};
    let make=|id:&str,args:Vec<String>| {
        let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        WorkspaceDispatch::new(WorkspaceRequest{version:RPC_VERSION,request_id:id.into(),
            workspace_id:"workspace-1".into(),timeout_ms:15000,
            operation:WorkspaceOperation::Run{tool_id:"git.status".into(),args,cwd:String::new()}},
            scope.clone(),"node-b".into(),1,now).unwrap()
    };
    let (tx,mut rx)=tokio::sync::mpsc::channel(16);
    wire.handle_dispatch(make("unprepared",vec![]),tx.clone()).await;
    assert!(matches!(rx.recv().await.unwrap(),ClientMessage::WorkspaceRpcRejected{rejection}
        if rejection.code==RpcErrorCode::Unauthorized));
    authority.record_prepared("workspace-1",&prepared).unwrap();
    fs::write(root.join("worktree/data.txt"),b"changed enrolled worktree").unwrap();
    // A repository-selected worktree must not override the enrolled one.
    use std::io::Write as _;
    let mut config=fs::OpenOptions::new().append(true).open(root.join("source/.git/config")).unwrap();
    writeln!(config,"\n[core]\n\tworktree = {}",root.join("source").display().to_string().replace('\\',"/")).unwrap();
    drop(config);
    wire.handle_dispatch(make("status",vec![]),tx.clone()).await;
    let mut output=Vec::new();
    let terminal=tokio::time::timeout(std::time::Duration::from_secs(20),async {
        loop {
            match rx.recv().await.unwrap() {
                ClientMessage::WorkspaceRpcEvent{event}=>match event.body {
                    WorkspaceEventBody::Output{stream:RpcOutputStream::Stdout,data}=>{
                        output.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap());
                    }
                    body@WorkspaceEventBody::Completed{..}|body@WorkspaceEventBody::Failed{..}|
                    body@WorkspaceEventBody::Unknown{..}|body@WorkspaceEventBody::Cancelled{..}=>break body,
                    _=>{}
                },
                ClientMessage::WorkspaceRpcRejected{rejection}=>panic!("fixed Git rejected: {:?}",rejection.code),
                _=>panic!("unrelated wire frame"),
            }
        }
    }).await.unwrap();
    assert!(matches!(terminal,WorkspaceEventBody::Completed{result:WorkspaceResult::Run{exit_code:0,..}}),
        "fixed Git did not complete: {terminal:?}");
    assert!(String::from_utf8(output).unwrap().contains(" M data.txt"));
    wire.handle_dispatch(make("extra-argv",vec!["--ignored".into()]),tx).await;
    assert!(matches!(rx.recv().await.unwrap(),ClientMessage::WorkspaceRpcRejected{rejection}
        if rejection.code==RpcErrorCode::ToolDenied));
}
