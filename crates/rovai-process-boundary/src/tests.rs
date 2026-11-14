use super::*;
use std::{io::{Read, Write}, sync::OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

fn artifact_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../_artifacts/process-boundary-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        std::fs::canonicalize(path).unwrap()
    }).clone()
}
fn child_env(mode: &str) -> BTreeMap<OsString, OsString> {
    let mut env = BTreeMap::new();
    for key in ["SystemRoot", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(key) { env.insert(key.into(), v); }
    }
    env.insert("ROVAI_BOUNDARY_FIXTURE".into(), mode.into());
    env
}
fn spec(mode: &str, stdin: StdinPolicy) -> ProcessSpec {
    ProcessSpec::new(std::env::current_exe().unwrap(), vec![
        "--exact".into(), "tests::boundary_process_fixture".into(), "--ignored".into(),
        "--nocapture".into()], artifact_root(), child_env(mode), stdin).unwrap()
}

/// The only child entry point. It is ignored during the ordinary test run and
/// enters no production service. Child and grandchild remain in the launch Job.
#[test]
#[ignore = "private child entry point invoked only by native ownership tests"]
fn boundary_process_fixture() {
    let mode = std::env::var("ROVAI_BOUNDARY_FIXTURE").expect("child fixture mode");
    if mode == "grandchild" {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    if mode == "io" {
        let mut input=String::new(); std::io::stdin().read_to_string(&mut input).unwrap();
        println!("PROOF:{}", serde_json::json!({
            "stdin":input, "environment":std::env::vars().map(|(k,_)|k).collect::<Vec<_>>()
        }));
        eprintln!("STDERR_PROOF");
        return;
    }
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact","tests::boundary_process_fixture","--ignored","--nocapture"])
        .env("ROVAI_BOUNDARY_FIXTURE","grandchild")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null()).spawn().unwrap();
    // This write occurs immediately after grandchild spawn, proving that the
    // child was already admitted to the owning Job before its first instruction.
    println!("CHILD_PID:{}",child.id());
    std::io::stdout().flush().unwrap();
    if mode == "parent-exits" { std::process::exit(0); }
    std::thread::sleep(Duration::from_secs(30));
}
async fn child_pid(process: &mut NativeProcess) -> u32 {
    let mut lines = BufReader::new(process.take_stdout().unwrap()).lines();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(pid) = line.strip_prefix("CHILD_PID:") { return pid.parse().unwrap(); }
        }
        panic!("missing child receipt")
    }).await.unwrap()
}

#[tokio::test]
async fn native_job_owns_early_grandchild_and_confirms_tree_empty_after_leader_exit() {
    let mut process=NativeProcess::spawn(&spec("parent-exits",StdinPolicy::Null)).unwrap();
    let leader=process.id();
    let job=process.windows_job_name().unwrap().to_owned();
    assert!(job.starts_with("Global\\Rovai.Boundary."));
    assert!(process.start_identity().is_some());
    let child=child_pid(&mut process).await;
    let pinned=windows::TestProcess::open(child).unwrap();
    assert!(process.owns_process_id(child));
    assert!(!process.owns_process_id(std::process::id()));
    let status=tokio::time::timeout(Duration::from_secs(5),process.wait()).await.unwrap().unwrap();
    assert!(status.success());
    assert!(!process.tree_is_empty().unwrap(), "leader exit must not count as whole-tree exit");
    assert!(pinned.is_running().unwrap());
    let receipt=process.terminate_and_wait(Duration::from_secs(5)).await.unwrap();
    assert!(receipt.tree_empty);
    // Job active membership is the execution boundary; signalling of an
    // independently pinned process handle may trail that accounting update.
    tokio::time::timeout(Duration::from_secs(5), async {
        while pinned.is_running().unwrap() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    assert!(process.tree_is_empty().unwrap());
    std::fs::write(artifact_root().join("job-native-receipt.json"), serde_json::to_vec_pretty(
        &serde_json::json!({"leader":leader,"grandchild":child,"job":job,"tree_empty":true})).unwrap()).unwrap();
}

#[tokio::test]
async fn piped_stdio_is_explicit_and_drop_kills_owned_tree() {
    let mut process=NativeProcess::spawn(&spec("io",StdinPolicy::Piped)).unwrap();
    let mut stdin=process.take_stdin().unwrap();
    stdin.write_all("literal % ! & | 中文\n".as_bytes()).await.unwrap();
    stdin.flush().await.unwrap(); drop(stdin);
    let mut stdout=process.take_stdout().unwrap();
    let mut stderr=process.take_stderr().unwrap();
    let a=tokio::spawn(async move { let mut text=String::new(); stdout.read_to_string(&mut text).await.unwrap();text });
    let b=tokio::spawn(async move { let mut text=String::new(); stderr.read_to_string(&mut text).await.unwrap();text });
    assert!(tokio::time::timeout(Duration::from_secs(8),process.wait()).await.unwrap().unwrap().success());
    let text=a.await.unwrap();
    let payload:serde_json::Value=serde_json::from_str(text.lines().find_map(|l|l.strip_prefix("PROOF:")).unwrap()).unwrap();
    assert_eq!(payload["stdin"],"literal % ! & | 中文\n");
    let keys=payload["environment"].as_array().unwrap();
    assert!(!keys.iter().any(|k|k.as_str().unwrap().eq_ignore_ascii_case("PATH")),
        "ambient environment must not be inherited");
    assert!(b.await.unwrap().contains("STDERR_PROOF"));
    let mut owned=NativeProcess::spawn(&spec("parent-waits",StdinPolicy::Null)).unwrap();
    let child=child_pid(&mut owned).await;
    let pinned=windows::TestProcess::open(child).unwrap();
    assert!(owned.owns_process_id(child));
    drop(owned);
    tokio::time::timeout(Duration::from_secs(5),async {
        while pinned.is_running().unwrap() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
}

#[test]
fn discovery_identity_matches_admission_and_rejects_changed_executable_bytes() {
    use std::io::{Seek,SeekFrom};
    let original=std::env::current_exe().unwrap();
    let copy=artifact_root().join("identity-fixture.exe");
    std::fs::copy(&original,&copy).unwrap();
    let spec=ProcessSpec::new(copy.clone(),Vec::new(),artifact_root(),BTreeMap::new(),StdinPolicy::Null).unwrap();
    let before=inspect_application_identity(&copy).unwrap();
    assert_eq!(before,spec.application_identity_digest());
    assert!(before.starts_with("sha256:") && before.len()==71);
    {
        let mut file=std::fs::OpenOptions::new().write(true).open(&copy).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();file.write_all(b"X").unwrap();file.sync_all().unwrap();
    }
    assert_ne!(inspect_application_identity(&copy).unwrap(),before);
    assert!(NativeProcess::spawn(&spec).is_err(),"changed identity must fail before child admission");
}
