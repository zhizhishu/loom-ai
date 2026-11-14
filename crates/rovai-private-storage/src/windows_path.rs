//! The same extended-length path conversion used by the existing Core storage.
use anyhow::{Result, bail};
use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
};

pub(super) fn wide_nul(value: &OsStr) -> Result<Vec<u16>> {
    let path = Path::new(value);
    let mut wide = Vec::new();
    if matches!(
        path.components().next(),
        Some(Component::Prefix(component)) if matches!(component.kind(), Prefix::Disk(_))
    ) {
        // Win32 path APIs still apply MAX_PATH to ordinary drive paths in
        // some process configurations. All callers operate on normalized
        // absolute local paths, so use the extended-length spelling and keep
        // deep Runtime View staging commits deterministic on Windows.
        wide.extend(OsStr::new(r"\\?\").encode_wide());
    }
    wide.extend(value.encode_wide().map(|unit| {
        if unit == b'/' as u16 {
            b'\\' as u16
        } else {
            unit
        }
    }));
    if wide.contains(&0) {
        bail!("Windows attachment path contains an interior NUL");
    }
    wide.push(0);
    Ok(wide)
}
