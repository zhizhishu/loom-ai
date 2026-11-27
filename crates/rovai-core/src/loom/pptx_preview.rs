use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
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

fn which(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| {
            let path = dir.join(name);
            path.is_file()
                || (cfg!(windows) && [".exe", ".bat", ".cmd"].iter().any(|suffix| dir.join(format!("{name}{suffix}")).is_file()))
        })
    })
}

fn read_zip_entry(bytes: &[u8], wanted: &str) -> Option<Vec<u8>> {
    let eocd = bytes.windows(22).rev().find_map(|w| {
        if w[..4] == [0x50, 0x4b, 0x05, 0x06] { Some((w[10] as usize) | ((w[11] as usize) << 8)) } else { None }
    })?;
    let mut pos = bytes.windows(22).rev().position(|w| w[..4] == [0x50, 0x4b, 0x05, 0x06])
        .map(|back| bytes.len() - back - 22)?;
    pos = u32::from_le_bytes(bytes.get(pos + 16..pos + 20)?.try_into().ok()?) as usize;
    for _ in 0..eocd {
        if bytes.get(pos..pos + 46)?[..4] != [0x50, 0x4b, 0x01, 0x02] { return None }
        let method = u16::from_le_bytes(bytes[pos + 10..pos + 12].try_into().ok()?);
        let compressed = u32::from_le_bytes(bytes[pos + 20..pos + 24].try_into().ok()?) as usize;
        let name_len = u16::from_le_bytes(bytes[pos + 28..pos + 30].try_into().ok()?) as usize;
        let extra_len = u16::from_le_bytes(bytes[pos + 30..pos + 32].try_into().ok()?) as usize;
        let comment_len = u16::from_le_bytes(bytes[pos + 32..pos + 34].try_into().ok()?) as usize;
        let local = u32::from_le_bytes(bytes[pos + 42..pos + 46].try_into().ok()?) as usize;
        let name = std::str::from_utf8(bytes.get(pos + 46..pos + 46 + name_len)?).ok()?;
        if name == wanted {
            let local_name = u16::from_le_bytes(bytes.get(local + 26..local + 28)?.try_into().ok()?) as usize;
            let local_extra = u16::from_le_bytes(bytes.get(local + 28..local + 30)?.try_into().ok()?) as usize;
            let start = local + 30 + local_name + local_extra;
            let data = bytes.get(start..start + compressed)?;
            return match method {
                0 => Some(data.to_vec()),
                8 => {
                    let mut out = Vec::new();
                    flate2::read::DeflateDecoder::new(data).read_to_end(&mut out).ok()?;
                    Some(out)
                }
                _ => None,
            };
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    None
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

fn conversion_command_missing() -> Option<&'static str> {
    let soffice = which("soffice");
    let pdftoppm = which("pdftoppm");
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
    fs::write(&input, bytes).map_err(|e| e.to_string())?;
    let profile = root.join("lo-profile");
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let output = Command::new("soffice")
        .arg(format!("-env:UserInstallation=file://{}", profile.display()))
        .args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(root).arg(&input)
        .env("SAL_USE_VCLPLUGIN", "svp")
        .output().map_err(|e| format!("soffice failed to start: {e}"))?;
    let pdf = root.join("input.pdf");
    if !output.status.success() || !pdf.is_file() {
        return Err(format!("PDF conversion failed: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
    let output = Command::new("pdftoppm").args(["-jpeg", "-r", "100"]).arg(&pdf).arg(root.join("slide"))
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
    use super::attr;
    #[test]
    fn attr_reads_both_quote_forms() {
        assert_eq!(attr("<x r:id=\"rId2\"/>", "r:id").as_deref(), Some("rId2"));
        assert_eq!(attr("<x r:id='rId3'/>", "r:id").as_deref(), Some("rId3"));
    }
}
