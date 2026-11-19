use super::*;
use std::{io::Write, process::{Command,Stdio}};
use tokio::io::{AsyncBufReadExt, BufReader};
fn root()->PathBuf {
    let p=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../_artifacts/process-boundary-linux").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&p).unwrap(); std::fs::canonicalize(p).unwrap()
}
fn spec(mode:&str,cwd:PathBuf)->ProcessSpec {
    ProcessSpec::new(std::env::current_exe().unwrap(),vec!["--exact".into(),"linux_tests::owned_child_fixture".into(),"--ignored".into(),"--nocapture".into()],
        cwd,BTreeMap::from([("ROVAI_LINUX_FIXTURE".into(),mode.into())]),StdinPolicy::Null).unwrap()
}
#[test]
#[ignore="only invoked as an owned fixture process by the two owners below"]
fn owned_child_fixture() {
    let mode=std::env::var("ROVAI_LINUX_FIXTURE").unwrap();
    if mode=="sleep" {std::thread::sleep(Duration::from_secs(30)); return;}
    let child=Command::new(std::env::current_exe().unwrap())
        .args(["--exact","linux_tests::owned_child_fixture","--ignored","--nocapture"])
        .env("ROVAI_LINUX_FIXTURE","sleep").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    println!("CHILD:{}",child.id());std::io::stdout().flush().unwrap();
    if mode=="exit" {std::process::exit(0);}
    std::thread::sleep(Duration::from_secs(30));
}
async fn get_child(p:&mut NativeProcess)->u32 {
    let mut lines=BufReader::new(p.take_stdout().unwrap()).lines();
    tokio::time::timeout(Duration::from_secs(5),async {
        while let Some(l)=lines.next_line().await.unwrap() {if let Some(pid)=l.strip_prefix("CHILD:"){return pid.parse().unwrap();}}
        panic!("child did not report")
    }).await.unwrap()
}
fn live(pid:u32)->bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|s|s.rsplit_once(')').map(|(_,tail)|tail.split_whitespace().next().unwrap_or("Z").to_owned()))
        .is_some_and(|state|state!="Z" && state!="X")
}
#[tokio::test]
async fn leader_exit_does_not_hide_a_live_process_group() {
    let dir=root();
    let mut p=NativeProcess::spawn(&spec("exit",dir.clone())).unwrap();
    let child=get_child(&mut p).await;
    assert!(tokio::time::timeout(Duration::from_secs(5),p.wait()).await.unwrap().unwrap().success());
    assert!(live(child));assert!(!p.tree_is_empty().unwrap());
    // The leader's PID remains allocated after wait() until its original group
    // is empty, preventing an unrelated future process from becoming killpg's
    // target. Exercise repeated wait/drop paths against the same zombie lease.
    let stat=std::fs::read_to_string(format!("/proc/{}/stat",p.id())).unwrap();
    assert_eq!(stat.rsplit_once(')').unwrap().1.split_whitespace().next(),Some("Z"));
    assert!(p.try_wait().unwrap().unwrap().success());
    let receipt=p.terminate_and_wait(Duration::from_secs(5)).await.unwrap();
    assert!(receipt.tree_empty);assert!(!live(child));
    assert!(!Path::new(&format!("/proc/{}/stat",p.id())).exists(),"leader reaped only after group retirement");
    p.terminate_tree().unwrap(); // repeated cleanup cannot target a recycled group.
    std::fs::write(dir.join("receipt.json"),serde_json::to_vec(&serde_json::json!({"leader":p.id(),"child":child,"tree_empty":true})).unwrap()).unwrap();
}
#[tokio::test]
async fn captured_descendants_are_stopped_and_drop_has_a_cleanup_fallback() {
    let mut p=NativeProcess::spawn(&spec("wait",root())).unwrap();
    let child=get_child(&mut p).await;
    assert!(p.owns_process_id(child));assert!(!p.owns_process_id(std::process::id()));
    assert!(p.start_identity().is_some());drop(p);
    tokio::time::timeout(Duration::from_secs(5),async {
        while live(child) {tokio::time::sleep(Duration::from_millis(10)).await;}
    }).await.unwrap();
}
