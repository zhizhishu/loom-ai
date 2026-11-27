use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomArtifactPptxSlide {
    pub label: String,
    pub hidden: bool,
    pub jpeg_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomArtifactPptxPreview {
    pub status: String,
    pub missing_dependency: Option<String>,
    pub error: Option<String>,
    pub slides: Vec<LoomArtifactPptxSlide>,
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let path = dir.join(name);
            if path.is_file() { return Some(path) }
            if cfg!(windows) {
                for suffix in [".exe", ".bat", ".cmd"] {
                    let path = dir.join(format!("{name}{suffix}"));
                    if path.is_file() { return Some(path) }
                }
            }
            None
        })
    })
}

fn bundled_office_command(name: &str) -> Option<PathBuf> {
    let root = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates: &[&str] = if cfg!(windows) {
        match name {
            "soffice" => &["runtime/office/windows-x64/libreoffice/program/soffice.exe"],
            _ => &["runtime/office/windows-x64/poppler/bin/pdftoppm.exe", "runtime/office/windows-x64/poppler/pdftoppm.exe"],
        }
    } else {
        match name {
            "soffice" => &["runtime/office/linux-x64/libreoffice/program/soffice"],
            _ => &["runtime/office/linux-x64/poppler/bin/pdftoppm"],
        }
    };
    candidates.iter().map(|relative| root.join(relative)).find(|path| path.is_file())
}

fn office_command(name: &str) -> Option<PathBuf> {
    bundled_office_command(name).or_else(|| which(name))
}

fn poppler_ld_library_path() -> Option<std::ffi::OsString> {
    if cfg!(windows) { return None }
    let root = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let office = root.join("runtime/office/linux-x64");
    if !office.join("poppler/bin/pdftoppm").is_file() { return std::env::var_os("LD_LIBRARY_PATH") }
    let mut paths = vec![office.join("poppler/lib")];
    if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") { paths.extend(std::env::split_paths(&existing)) }
    std::env::join_paths(paths).ok()
}

fn zip_entries(bytes: &[u8]) -> Option<Vec<(String, Vec<u8>)>> {
    let eocd_pos = bytes.windows(22).rev().position(|w| w[..4] == [0x50, 0x4b, 0x05, 0x06])
        .map(|back| bytes.len() - back - 22)?;
    let eocd = bytes.get(eocd_pos..eocd_pos + 22)?;
    let count = (eocd[10] as usize) | ((eocd[11] as usize) << 8);
    let mut pos = u32::from_le_bytes(eocd[16..20].try_into().ok()?) as usize;
    let mut entries = Vec::new();
    for _ in 0..count {
        if bytes.get(pos..pos + 46)?[..4] != [0x50, 0x4b, 0x01, 0x02] { return None }
        let method = u16::from_le_bytes(bytes[pos + 10..pos + 12].try_into().ok()?);
        let compressed = u32::from_le_bytes(bytes[pos + 20..pos + 24].try_into().ok()?) as usize;
        let name_len = u16::from_le_bytes(bytes[pos + 28..pos + 30].try_into().ok()?) as usize;
        let extra_len = u16::from_le_bytes(bytes[pos + 30..pos + 32].try_into().ok()?) as usize;
        let comment_len = u16::from_le_bytes(bytes[pos + 32..pos + 34].try_into().ok()?) as usize;
        let local = u32::from_le_bytes(bytes[pos + 42..pos + 46].try_into().ok()?) as usize;
        let name = std::str::from_utf8(bytes.get(pos + 46..pos + 46 + name_len)?).ok()?.to_string();
        let local_name = u16::from_le_bytes(bytes.get(local + 26..local + 28)?.try_into().ok()?) as usize;
        let local_extra = u16::from_le_bytes(bytes.get(local + 28..local + 30)?.try_into().ok()?) as usize;
        let start = local + 30 + local_name + local_extra;
        let data = bytes.get(start..start + compressed)?;
        let data = match method {
            0 => data.to_vec(),
            8 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(data).read_to_end(&mut out).ok()?;
                out
            }
            _ => return None,
        };
        entries.push((name, data));
        pos += 46 + name_len + extra_len + comment_len;
    }
    Some(entries)
}

fn read_zip_entry(bytes: &[u8], wanted: &str) -> Option<Vec<u8>> {
    zip_entries(bytes)?.into_iter().find(|(name, _)| name == wanted).map(|(_, data)| data)
}

fn u16le(out: &mut Vec<u8>, value: u16) { out.extend_from_slice(&value.to_le_bytes()) }
fn u32le(out: &mut Vec<u8>, value: u32) { out.extend_from_slice(&value.to_le_bytes()) }

fn write_zip_entries(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        if name.len() > u16::MAX as usize || data.len() > u32::MAX as usize { return Err("pptx zip entry too large".into()) }
        let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).map_err(|e| e.to_string())?;
        let compressed = encoder.finish().map_err(|e| e.to_string())?;
        if compressed.len() > u32::MAX as usize { return Err("pptx zip entry too large".into()) }
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let offset = out.len() as u32;
        u32le(&mut out, 0x04034b50); u16le(&mut out, 20); u16le(&mut out, 0); u16le(&mut out, 8);
        u16le(&mut out, 0); u16le(&mut out, 0); u32le(&mut out, crc.sum());
        u32le(&mut out, compressed.len() as u32); u32le(&mut out, data.len() as u32);
        u16le(&mut out, name.len() as u16); u16le(&mut out, 0);
        out.extend_from_slice(name.as_bytes()); out.extend_from_slice(&compressed);
        u32le(&mut central, 0x02014b50); u16le(&mut central, 20); u16le(&mut central, 20);
        u16le(&mut central, 0); u16le(&mut central, 8); u16le(&mut central, 0); u16le(&mut central, 0);
        u32le(&mut central, crc.sum()); u32le(&mut central, compressed.len() as u32); u32le(&mut central, data.len() as u32);
        u16le(&mut central, name.len() as u16); u16le(&mut central, 0); u16le(&mut central, 0);
        u16le(&mut central, 0); u16le(&mut central, 0); u32le(&mut central, 0); u32le(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
    }
    if entries.len() > u16::MAX as usize { return Err("too many pptx zip entries".into()) }
    let central_offset = out.len() as u32;
    let central_len = central.len() as u32;
    out.extend_from_slice(&central);
    u32le(&mut out, 0x06054b50); u16le(&mut out, 0); u16le(&mut out, 0);
    u16le(&mut out, entries.len() as u16); u16le(&mut out, entries.len() as u16);
    u32le(&mut out, central_len); u32le(&mut out, central_offset); u16le(&mut out, 0);
    Ok(out)
}

fn attr(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(start) = tag.find(&needle) {
            let rest = &tag[start + needle.len()..];
            if let Some(end) = rest.find(quote) { return Some(rest[..end].to_string()) }
        }
    }
    None
}

fn replace_xml_attr(tag: &str, name: &str, value: &str) -> String {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(start) = tag.find(&needle) {
            let value_start = start + needle.len();
            if let Some(end) = tag[value_start..].find(quote) {
                return format!("{}{}{quote}{}{}{}", &tag[..value_start], "", value, "", &tag[value_start + end + 1..]);
            }
        }
    }
    tag.to_string()
}

fn cut_outside_links(rels: &str) -> Option<Vec<u8>> {
    let mut out = String::new();
    let mut rest = rels;
    let mut cut = false;
    while let Some(pos) = rest.find("<Relationship") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos..];
        let Some(end) = after.find('>') else { return Some(br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"#.to_vec()) };
        let tag = &after[..=end];
        let external = attr(tag, "TargetMode").is_some_and(|v| v.eq_ignore_ascii_case("external"));
        let target = attr(tag, "Target").unwrap_or_default();
        let lower = target.to_ascii_lowercase();
        let web_or_mail = lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("mailto:");
        if external && !web_or_mail {
            out.push_str(&replace_xml_attr(tag, "Target", "about:blank"));
            cut = true;
        } else {
            out.push_str(tag);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    cut.then(|| out.into_bytes())
}

fn without_outside_links(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let entries = zip_entries(bytes).ok_or("pptx zip cannot be parsed")?;
    let mut changed = false;
    let mut rewritten = Vec::with_capacity(entries.len());
    for (name, data) in entries {
        if name.to_ascii_lowercase().ends_with(".rels") && data.len() <= 32 * 1024 * 1024 {
            let text = String::from_utf8_lossy(&data);
            if let Some(cut) = cut_outside_links(&text) {
                changed = true;
                rewritten.push((name, cut));
                continue;
            }
        }
        rewritten.push((name, data));
    }
    if changed { write_zip_entries(&rewritten) } else { Ok(bytes.to_vec()) }
}

fn opc_target(target: &str, external: bool) -> Option<String> {
    if external { return None }
    let mut parts: Vec<&str> = vec!["ppt"];
    for part in target.trim_start_matches('/').split('/') {
        match part { "" | "." => {}, ".." => { parts.pop()?; }, _ => parts.push(part) }
    }
    Some(parts.join("/"))
}

#[derive(Clone)]
struct SlideInfo { name: String, part: String, hidden: bool }

fn slide_info(bytes: &[u8]) -> Result<Vec<SlideInfo>, String> {
    let rels = read_zip_entry(bytes, "ppt/_rels/presentation.xml.rels").ok_or("missing presentation relationships")?;
    let rels = String::from_utf8_lossy(&rels);
    let mut rid_to_part = Vec::new();
    let mut rest = rels.as_ref();
    while let Some(pos) = rest.find("<Relationship") {
        let after = &rest[pos..];
        let end = after.find('>').ok_or("bad relationship xml")?;
        let tag = &after[..=end];
        if attr(tag, "Type").is_some_and(|v| v.ends_with("/slide")) {
            if let (Some(id), Some(target)) = (attr(tag, "Id"), attr(tag, "Target")) {
                let external = attr(tag, "TargetMode").is_some_and(|v| v == "External");
                if let Some(part) = opc_target(&target, external) { rid_to_part.push((id, part)) }
            }
        }
        rest = &after[end + 1..];
    }
    let pres = read_zip_entry(bytes, "ppt/presentation.xml").ok_or("missing presentation.xml")?;
    let pres = String::from_utf8_lossy(&pres);
    let mut out = Vec::new();
    let mut rest = pres.as_ref();
    while let Some(pos) = rest.find("<p:sldId") {
        let after = &rest[pos..];
        let end = after.find('>').ok_or("bad presentation xml")?;
        let tag = &after[..=end];
        if let Some(rid) = attr(tag, "r:id") {
            if let Some((_, part)) = rid_to_part.iter().find(|(id, _)| *id == rid) {
                let xml = read_zip_entry(bytes, part).ok_or_else(|| format!("missing {part}"))?;
                let head = String::from_utf8_lossy(&xml[..xml.len().min(2048)]);
                let root_start = head.find("<p:sld").unwrap_or(0);
                let root_end = head[root_start..].find('>').map(|end| root_start + end).unwrap_or(head.len());
                let root = &head[root_start..root_end];
                let hidden = root.contains("show=\"0\"") || root.contains("show='0'") || root.contains("show=\"false\"") || root.contains("show='false'");
                out.push(SlideInfo { name: part.rsplit('/').next().unwrap_or(part).to_string(), part: part.clone(), hidden });
            }
        }
        rest = &after[end + 1..];
    }
    if out.is_empty() { Err("no slides in presentation order".into()) } else { Ok(out) }
}

fn libreoffice_profile_url(profile: &Path) -> Result<String, String> {
    url::Url::from_file_path(profile)
        .map(|url| url.to_string())
        .map_err(|()| format!("LibreOffice profile is not an absolute path: {}", profile.display()))
}

fn conversion_command_missing() -> Option<&'static str> {
    let soffice = office_command("soffice").is_some();
    let pdftoppm = office_command("pdftoppm").is_some();
    match (soffice, pdftoppm) {
        (true, true) => None,
        (false, true) => Some("soffice"),
        (true, false) => Some("pdftoppm"),
        (false, false) => Some("soffice,pdftoppm"),
    }
}

pub fn render_pptx_preview(bytes: &[u8]) -> LoomArtifactPptxPreview {
    if let Some(missing) = conversion_command_missing() {
        return LoomArtifactPptxPreview { status: "missing_dependency".into(), missing_dependency: Some(missing.into()), error: None, slides: vec![] };
    }
    match render_pptx_preview_inner(bytes) {
        Ok(slides) => LoomArtifactPptxPreview { status: "ready".into(), missing_dependency: None, error: None, slides },
        Err(error) => LoomArtifactPptxPreview { status: "conversion_failed".into(), missing_dependency: None, error: Some(error), slides: vec![] },
    }
}

fn render_pptx_preview_inner(bytes: &[u8]) -> Result<Vec<LoomArtifactPptxSlide>, String> {
    let info = slide_info(bytes)?;
    let root = std::env::temp_dir().join(format!("loom-pptx-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let result = render_with_soffice(bytes, &root, &info);
    let _ = fs::remove_dir_all(&root);
    result
}

fn render_with_soffice(bytes: &[u8], root: &Path, info: &[SlideInfo]) -> Result<Vec<LoomArtifactPptxSlide>, String> {
    let input = root.join("input.pptx");
    let bytes = without_outside_links(bytes)?;
    fs::write(&input, bytes).map_err(|e| e.to_string())?;
    let profile = root.join("lo-profile");
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let profile_url = libreoffice_profile_url(&profile)?;
    let output = Command::new(office_command("soffice").ok_or("soffice missing")?)
        .arg(format!("-env:UserInstallation={profile_url}"))
        .args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(root).arg(&input)
        .env("SAL_USE_VCLPLUGIN", "svp")
        .output().map_err(|e| format!("soffice failed to start: {e}"))?;
    let pdf = root.join("input.pdf");
    if !output.status.success() || !pdf.is_file() {
        return Err(format!("PDF conversion failed: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
    let output = Command::new(office_command("pdftoppm").ok_or("pdftoppm missing")?).args(["-jpeg", "-r", "100"]).arg(&pdf).arg(root.join("slide"))
        .env("LD_LIBRARY_PATH", poppler_ld_library_path().unwrap_or_default())
        .output().map_err(|e| format!("pdftoppm failed to start: {e}"))?;
    if !output.status.success() { return Err("Image conversion failed".into()) }
    let mut images: Vec<PathBuf> = fs::read_dir(root).map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("slide-") && n.ends_with(".jpg")))
        .collect();
    images.sort();
    let visible_count = info.iter().filter(|slide| !slide.hidden).count();
    let rendered_hidden = images.len() == info.len() && info.len() != visible_count;
    if !rendered_hidden && images.len() != visible_count {
        return Err(format!("LibreOffice rendered {} page(s) for {} visible slide(s) of {}; thumbnails would be mislabeled", images.len(), visible_count, info.len()))
    }
    let mut image_index = 0usize;
    let mut slides = Vec::new();
    for slide in info {
        let rendered = rendered_hidden || !slide.hidden;
        let jpeg_base64 = if rendered {
            let path = images.get(image_index).ok_or("rendered slide image missing")?;
            image_index += 1;
            Some(STANDARD.encode(fs::read(path).map_err(|e| e.to_string())?))
        } else { None };
        slides.push(LoomArtifactPptxSlide { label: format!("{}{}", slide.name, if slide.hidden { " (hidden)" } else { "" }), hidden: slide.hidden, jpeg_base64 });
    }
    Ok(slides)
}

#[cfg(test)]
mod tests {
    use super::{attr, libreoffice_profile_url};
    use std::path::Path;
    #[test]
    fn attr_reads_both_quote_forms() {
        assert_eq!(attr("<x r:id=\"rId2\"/>", "r:id").as_deref(), Some("rId2"));
        assert_eq!(attr("<x r:id='rId3'/>", "r:id").as_deref(), Some("rId3"));
    }

    #[test]
    fn outside_links_are_cut_after_zip_rewrite() {
        let rels = br#"<Relationships xmlns="x"><Relationship Id="rId1" Type="t" Target="file:///etc/passwd" TargetMode="External"/><Relationship Id="rId2" Type="t" Target="https://example.test" TargetMode="External"/></Relationships>"#.to_vec();
        let zipped = super::write_zip_entries(&[("ppt/slides/_rels/slide1.xml.rels".into(), rels)]).unwrap();
        let sanitized = super::without_outside_links(&zipped).unwrap();
        let rels = String::from_utf8(super::read_zip_entry(&sanitized, "ppt/slides/_rels/slide1.xml.rels").unwrap()).unwrap();
        assert!(rels.contains("about:blank"));
        assert!(rels.contains("https://example.test"));
        assert!(!rels.contains("file:///etc/passwd"));
    }

    #[cfg(windows)]
    #[test]
    fn libreoffice_profile_url_is_a_windows_file_url() {
        let profile = Path::new(r"C:\Users\loom\AppData\Local\Temp\loom-pptx-1\lo profile");
        let url = libreoffice_profile_url(profile).unwrap();
        assert!(url.starts_with("file:///C:/"), "{url}");
        assert!(!url.contains('\\'), "{url}");
        assert!(url.contains("lo%20profile"), "{url}");
        assert!(libreoffice_profile_url(Path::new(r"relative\lo profile")).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn libreoffice_profile_url_is_a_unix_file_url() {
        let profile = Path::new("/tmp/loom-pptx-1/lo profile");
        let url = libreoffice_profile_url(profile).unwrap();
        assert!(url.starts_with("file:///tmp/loom-pptx-1/"), "{url}");
        assert!(!url.contains('\\'), "{url}");
        assert!(url.contains("lo%20profile"), "{url}");
        assert!(libreoffice_profile_url(Path::new("relative/lo profile")).is_err());
    }
}
