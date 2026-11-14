//! Executable identity used by installation discovery and spawn admission.
#[cfg(unix)]
use std::{fs::{File,OpenOptions},io::{Read,Seek,SeekFrom},os::unix::fs::{MetadataExt,OpenOptionsExt},path::Path};
#[cfg(unix)]
use anyhow::{bail,Result};
#[cfg(unix)]
use sha2::{Digest,Sha256};

#[cfg(unix)]
#[derive(Debug,Clone,PartialEq,Eq)]
pub(crate) struct UnixApplicationIdentity { pub(crate) digest:String }
#[cfg(unix)]
pub(crate) fn open_application(path:&Path)->Result<File> {
    if !path.is_absolute() {bail!("process_boundary.invalid_application");}
    let canonical=std::fs::canonicalize(path)?;
    Ok(OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(canonical)?)
}
#[cfg(unix)]
pub(crate) fn from_file(file:&mut File)->Result<UnixApplicationIdentity> {
    let before=file.metadata()?;
    if !before.is_file() || before.mode()&0o111==0 || before.len()>1024*1024*1024 {
        bail!("process_boundary.invalid_application");
    }
    file.seek(SeekFrom::Start(0))?;
    let mut content=Sha256::new();let mut buffer=[0_u8;65536];
    loop {let n=file.read(&mut buffer)?;if n==0 {break;}content.update(&buffer[..n]);}
    let after=file.metadata()?;
    let fields=|m:&std::fs::Metadata|[m.dev(),m.ino(),m.len(),m.mode() as u64,
        m.mtime() as u64,m.mtime_nsec() as u64,m.ctime() as u64,m.ctime_nsec() as u64];
    if fields(&before)!=fields(&after) {bail!("process_boundary.application_changed");}
    let mut identity=Sha256::new();identity.update(b"rovai.native-application.v1\0unix\0");
    for value in fields(&before) {identity.update(value.to_le_bytes());}
    identity.update(content.finalize());
    file.seek(SeekFrom::Start(0))?;
    Ok(UnixApplicationIdentity{digest:format!("sha256:{:x}",identity.finalize())})
}
#[cfg(unix)]
pub(crate) fn capture(path:&Path)->Result<UnixApplicationIdentity> {from_file(&mut open_application(path)?)}
