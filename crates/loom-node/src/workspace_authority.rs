//! Durable local facts established only after a successful PrepareWorktree.
//! Wire cwd strings never register authority. Reconnects preserve these facts;
//! replacement of a directory or remapping of an id is rejected.
use std::{collections::BTreeMap,fs::{self,File},io::Read,path::{Path,PathBuf},sync::{Arc,Mutex}};
use loom_protocol::{PreparedWorktree,workspace_rpc::RpcErrorCode};
use rovai_private_storage::{prepare_private_directory,create_private_new_file,open_private_read_write_file,
    open_private_read_file,atomic_write_private_bytes};
use serde::{Serialize,Deserialize};

type Result<T>=std::result::Result<T,RpcErrorCode>;
const MAX_BYTES:u64=2*1024*1024;
const MAX_RECORDS:usize=2048;

#[derive(Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Facts {
    root:PathBuf,source:PathBuf,common_dir:PathBuf,
    root_git_dir:PathBuf,source_git_dir:PathBuf,
    root_identity:String,source_identity:String,common_identity:String,
}
impl Facts {
    fn from_prepared(prepared:&PreparedWorktree)->Result<Self> {
        let root=canonical_directory(Path::new(&prepared.worktree))?;
        let source=canonical_directory(Path::new(&prepared.source))?;
        let expected_common=canonical_directory(Path::new(&prepared.common_dir))?;
        let (root_git_dir,root_common)=git_binding(&root)?;
        let (source_git_dir,source_common)=git_binding(&source)?;
        if root_common!=expected_common || source_common!=expected_common {
            return Err(RpcErrorCode::PathRejected);
        }
        Ok(Self{root_identity:directory_identity(&root)?,source_identity:directory_identity(&source)?,
            common_identity:directory_identity(&expected_common)?,root,source,common_dir:expected_common,
            root_git_dir,source_git_dir})
    }
    fn revalidate(&self)->Result<()> {
        let actual=Self::from_prepared(&PreparedWorktree{worktree:self.root.to_string_lossy().into_owned(),
            source:self.source.to_string_lossy().into_owned(),common_dir:self.common_dir.to_string_lossy().into_owned(),
            base_sha:String::new(),branch:String::new()})?;
        if actual!=*self {return Err(RpcErrorCode::PolicyMismatch);}
        Ok(())
    }
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Record {facts:Facts,revision:u64}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Disk {version:u32,node_id:String,records:BTreeMap<String,Record>}
struct Inner {root:PathBuf,node_id:String,_lease:File,disk:Mutex<Disk>}

/// Cannot be deserialized or constructed from an Open/Run payload.
#[derive(Clone,PartialEq,Eq)]
pub struct TrustedPreparedWorkspace {
    workspace_id:String,node_id:String,facts:Facts,revision:u64,cwd:PathBuf,
}
impl std::fmt::Debug for TrustedPreparedWorkspace {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        f.debug_struct("TrustedPreparedWorkspace").field("workspace_id",&self.workspace_id)
            .field("node_id",&self.node_id).field("revision",&self.revision).finish_non_exhaustive()
    }
}
impl TrustedPreparedWorkspace {
    pub fn workspace_id(&self)->&str {&self.workspace_id}
    pub fn node_id(&self)->&str {&self.node_id}
    pub fn root(&self)->&Path {&self.facts.root}
    pub fn source(&self)->&Path {&self.facts.source}
    pub fn common_dir(&self)->&Path {&self.facts.common_dir}
    pub fn working_directory(&self)->&Path {&self.cwd}
    /// Local fact revision, independent of Core's authorization policy revision.
    pub fn revision(&self)->u64 {self.revision}
    pub(crate) fn revalidate(&self)->Result<()> {self.facts.revalidate()}
    pub(crate) fn same_binding(&self,other:&Self)->bool {
        self.workspace_id==other.workspace_id && self.node_id==other.node_id &&
            self.facts==other.facts && self.revision==other.revision
    }
}
#[derive(Clone)]
pub struct WorkspaceAuthority {inner:Arc<Inner>}
impl WorkspaceAuthority {
    pub fn open(data_dir:&Path,node_id:String)->Result<Self> {
        valid_id(&node_id)?;
        let root=prepare_private_directory(&data_dir.join("workspace-authority")).map_err(storage)?;
        let path=root.join("owner.lock");
        let lease=(if path.exists(){open_private_read_write_file(&path)}else{create_private_new_file(&path)})
            .map_err(storage)?;
        lock(&lease)?;
        let path=root.join("workspaces-v1.json");
        let disk=if path.exists() {
            let mut bytes=Vec::new();
            open_private_read_file(&path).map_err(storage)?.take(MAX_BYTES+1).read_to_end(&mut bytes).map_err(storage)?;
            if bytes.len() as u64>MAX_BYTES {return Err(RpcErrorCode::StorageUnavailable);}
            let disk:Disk=serde_json::from_slice(&bytes).map_err(storage)?;
            if disk.version!=1 || disk.node_id!=node_id || disk.records.len()>MAX_RECORDS {
                return Err(RpcErrorCode::StorageUnavailable);
            }
            for (id,record) in &disk.records {
                valid_id(id).map_err(|_|RpcErrorCode::StorageUnavailable)?;
                if record.revision!=1 {return Err(RpcErrorCode::StorageUnavailable);}
            }
            disk
        }else{Disk{version:1,node_id:node_id.clone(),records:BTreeMap::new()}};
        Ok(Self{inner:Arc::new(Inner{root,node_id,_lease:lease,disk:Mutex::new(disk)})})
    }
    /// Only the authenticated session's successful real PrepareWorktree seam
    /// calls this. A request id equals the durable workspace id.
    pub fn record_prepared(&self,workspace_id:&str,prepared:&PreparedWorktree)->Result<TrustedPreparedWorkspace> {
        valid_id(workspace_id)?;
        let facts=Facts::from_prepared(prepared)?;
        let mut disk=self.inner.disk.lock().map_err(storage)?;
        if let Some(record)=disk.records.get(workspace_id) {
            if record.facts!=facts {return Err(RpcErrorCode::RequestConflict);}
            return Ok(self.handle(workspace_id,record,facts.root.clone()));
        }
        if disk.records.len()>=MAX_RECORDS {return Err(RpcErrorCode::Busy);}
        let record=Record{facts,revision:1};
        disk.records.insert(workspace_id.to_owned(),record.clone());
        let result=(|| {
            let bytes=serde_json::to_vec(&*disk).map_err(storage)?;
            if bytes.len() as u64>MAX_BYTES {return Err(RpcErrorCode::StorageUnavailable);}
            atomic_write_private_bytes(&self.inner.root.join("workspaces-v1.json"),&bytes).map_err(storage)?;
            #[cfg(unix)]
            File::open(&self.inner.root).and_then(|f|f.sync_all()).map_err(storage)?;
            Ok(())
        })();
        if let Err(error)=result {disk.records.remove(workspace_id);return Err(error);}
        Ok(self.handle(workspace_id,&record,record.facts.root.clone()))
    }
    /// Revalidate the previously prepared identity and a contained cwd. This
    /// never creates a record and never treats path existence as enrollment.
    pub fn admit(&self,workspace_id:&str,cwd:&Path)->Result<TrustedPreparedWorkspace> {
        valid_id(workspace_id)?;
        let disk=self.inner.disk.lock().map_err(storage)?;
        let record=disk.records.get(workspace_id).ok_or(RpcErrorCode::Unauthorized)?;
        record.facts.revalidate()?;
        let raw=if cwd.as_os_str().is_empty(){record.facts.root.clone()}
            else if cwd.is_absolute(){cwd.to_owned()}else{
                loom_protocol::workspace_rpc::validate_relative_path(&cwd.to_string_lossy(),true)?;
                record.facts.root.join(cwd)
            };
        let cwd=canonical_directory(&raw)?;
        if !cwd.starts_with(&record.facts.root) {return Err(RpcErrorCode::PathRejected);}
        Ok(self.handle(workspace_id,record,cwd))
    }
    fn handle(&self,id:&str,record:&Record,cwd:PathBuf)->TrustedPreparedWorkspace {
        TrustedPreparedWorkspace{workspace_id:id.to_owned(),node_id:self.inner.node_id.clone(),
            facts:record.facts.clone(),revision:record.revision,cwd}
    }
}
fn storage<T>(_:T)->RpcErrorCode {RpcErrorCode::StorageUnavailable}
fn valid_id(id:&str)->Result<()> {
    if id.is_empty() || id.len()>128 || !id.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'_'|b'-'|b'.')) {
        return Err(RpcErrorCode::InvalidRequest);
    }
    Ok(())
}
fn canonical_directory(path:&Path)->Result<PathBuf> {
    if !path.is_absolute() {return Err(RpcErrorCode::PathRejected);}
    let path=fs::canonicalize(path).map_err(|_|RpcErrorCode::PathRejected)?;
    if !path.is_dir() {return Err(RpcErrorCode::PathRejected);}
    Ok(path)
}
fn short_text(path:&Path)->Result<String> {
    let file=File::open(path).map_err(|_|RpcErrorCode::PathRejected)?;
    let mut bytes=Vec::new();file.take(4097).read_to_end(&mut bytes).map_err(|_|RpcErrorCode::PathRejected)?;
    if bytes.is_empty() || bytes.len()>4096 {return Err(RpcErrorCode::PathRejected);}
    let text=String::from_utf8(bytes).map_err(|_|RpcErrorCode::PathRejected)?;
    if text.contains('\0') {return Err(RpcErrorCode::PathRejected);}
    Ok(text.trim().to_owned())
}
/// Verify Git's on-disk worktree binding, including the reverse gitdir pointer.
/// No Git command, repository configuration, shell, or hook is executed.
fn git_binding(root:&Path)->Result<(PathBuf,PathBuf)> {
    let dot=root.join(".git");
    let meta=fs::symlink_metadata(&dot).map_err(|_|RpcErrorCode::PathRejected)?;
    if meta.file_type().is_symlink() {return Err(RpcErrorCode::PathRejected);}
    let git_dir=if meta.is_dir(){canonical_directory(&dot)?}else if meta.is_file(){
        let text=short_text(&dot)?;
        let raw=PathBuf::from(text.strip_prefix("gitdir: ").ok_or(RpcErrorCode::PathRejected)?);
        canonical_directory(&if raw.is_absolute(){raw}else{root.join(raw)})?
    }else{return Err(RpcErrorCode::PathRejected);};
    let common=if git_dir.join("commondir").exists() {
        let raw=PathBuf::from(short_text(&git_dir.join("commondir"))?);
        let common=canonical_directory(&if raw.is_absolute(){raw}else{git_dir.join(raw)})?;
        let back=PathBuf::from(short_text(&git_dir.join("gitdir"))?);
        let back=fs::canonicalize(if back.is_absolute(){back}else{git_dir.join(back)}).map_err(|_|RpcErrorCode::PathRejected)?;
        if back!=fs::canonicalize(&dot).map_err(|_|RpcErrorCode::PathRejected)? {return Err(RpcErrorCode::PathRejected);}
        common
    }else{git_dir.clone()};
    if !git_dir.join("HEAD").is_file() || !common.join("objects").is_dir() || !common.join("refs").is_dir() {
        return Err(RpcErrorCode::PathRejected);
    }
    Ok((git_dir,common))
}
#[cfg(unix)]
fn directory_identity(path:&Path)->Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata=fs::metadata(path).map_err(|_|RpcErrorCode::PathRejected)?;
    Ok(format!("unix:{:x}:{:x}",metadata.dev(),metadata.ino()))
}
#[cfg(windows)]
fn directory_identity(path:&Path)->Result<String> {
    use std::os::windows::{ffi::OsStrExt,io::{AsRawHandle,FromRawHandle,OwnedHandle}};
    use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE,Storage::FileSystem::{
        CreateFileW,GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION,FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ,FILE_SHARE_WRITE,FILE_SHARE_DELETE,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS}};
    let wide:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle=unsafe{CreateFileW(wide.as_ptr(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
        std::ptr::null(),OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,std::ptr::null_mut())};
    if handle==INVALID_HANDLE_VALUE {return Err(RpcErrorCode::PathRejected);}
    let handle=unsafe{OwnedHandle::from_raw_handle(handle)};
    let mut info=BY_HANDLE_FILE_INFORMATION::default();
    if unsafe{GetFileInformationByHandle(handle.as_raw_handle(),&mut info)}==0 {return Err(RpcErrorCode::PathRejected);}
    Ok(format!("windows:{:08x}:{:08x}{:08x}",info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow))
}
#[cfg(not(any(windows,unix)))]
fn directory_identity(_: &Path)->Result<String> {Err(RpcErrorCode::UnsupportedPlatform)}
#[cfg(unix)]
fn lock(file:&File)->Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0 {return Err(RpcErrorCode::Busy);}
    Ok(())
}
#[cfg(windows)]
fn lock(file:&File)->Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Storage::FileSystem::{LockFileEx,LOCKFILE_EXCLUSIVE_LOCK,LOCKFILE_FAIL_IMMEDIATELY},System::IO::OVERLAPPED};
    let mut overlap=OVERLAPPED::default();
    if unsafe{LockFileEx(file.as_raw_handle(),LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,u32::MAX,u32::MAX,&mut overlap)}==0 {
        return Err(RpcErrorCode::Busy);
    }
    Ok(())
}
#[cfg(not(any(windows,unix)))]
fn lock(_: &File)->Result<()> {Err(RpcErrorCode::UnsupportedPlatform)}

#[cfg(test)]
#[path="workspace_authority_tests.rs"]
mod tests;
