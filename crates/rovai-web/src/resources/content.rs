//! Candidate preparation owns the digest and sparse line facts. Paging reuses
//! that analysis with size/mtime fences; other reads still hash the whole source.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
    time::SystemTime,
};

const CHUNK_BYTES: usize = 64 * 1024;
const MAX_PREVIEW_BYTES: usize = 20 * 1024 * 1024;

pub(super) struct Analysis {
    pub generation: String,
    size: usize,
    modified: SystemTime,
    text: bool,
    block_lines: Vec<u64>,
}

#[derive(Clone, Copy)]
pub(super) enum Selection {
    All,
    Metadata,
    Digest,
    Page { offset: u64, maximum: u64 },
    Line { requested: u64 },
}
pub(super) struct Content {
    pub bytes: Vec<u8>,
    pub prefix: Vec<u8>,
    pub size: usize,
    pub version: Value,
    pub generation: String,
    pub text: bool,
    pub has_nul: bool,
    pub line: u64,
    pub line_offset: usize,
    pub analysis: Option<Arc<Analysis>>,
}

// UTF-8 validation carries at most one incomplete scalar across read boundaries.
#[derive(Default)]
struct TextCheck {
    tail: Vec<u8>,
    invalid: bool,
}
impl TextCheck {
    fn push(&mut self, mut bytes: &[u8]) {
        if self.invalid {
            return;
        }
        if !self.tail.is_empty() {
            let width = if self.tail[0] < 0xe0 {
                2
            } else if self.tail[0] < 0xf0 {
                3
            } else {
                4
            };
            let take = (width - self.tail.len()).min(bytes.len());
            self.tail.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.tail.len() < width {
                return;
            }
            if std::str::from_utf8(&self.tail).is_err() {
                self.invalid = true;
                return;
            }
            self.tail.clear();
        }
        if let Err(error) = std::str::from_utf8(bytes) {
            if error.error_len().is_some() {
                self.invalid = true;
            } else {
                self.tail.extend_from_slice(&bytes[error.valid_up_to()..]);
            }
        }
    }
}

pub(super) async fn read(
    path: &Path,
    selection: Selection,
    permit: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
) -> Result<Content> {
    read_known(path, selection, None, permit).await
}
pub(super) async fn read_known(
    path: &Path,
    selection: Selection,
    known: Option<Arc<Analysis>>,
    permit: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
) -> Result<Content> {
    let path = path.to_path_buf();
    // Keep disk I/O and hashing off the async executor, without scheduling one
    // blocking filesystem task for each small chunk.
    super::blocking(permit, move || scan(&path, selection, known.as_deref())).await
}
fn scan(path: &Path, selection: Selection, known: Option<&Analysis>) -> Result<Content> {
    let file = rovai_core::local_attachment_snapshot::open_resolved_file_without_following(path)?;
    #[cfg(test)]
    let file = tests::CountedFile(file);
    let mut file = file;
    let meta = file.metadata()?;
    ensure!(meta.is_file(), "not_regular_file");
    ensure!(meta.len() <= MAX_PREVIEW_BYTES as u64, "file_too_large");
    let modified = meta.modified()?;
    if matches!(selection, Selection::Page { .. } | Selection::Line { .. }) {
        let known = known.context("read_failed")?;
        ensure!(
            meta.len() == known.size as u64 && modified == known.modified,
            "read_failed"
        );
        let content = read_selection(&mut file, selection, known)?;
        let after = file.metadata()?;
        ensure!(
            after.len() == known.size as u64 && after.modified()? == known.modified,
            "read_failed"
        );
        return Ok(content);
    }
    let mut bytes = Vec::with_capacity(match selection {
        Selection::All => meta.len() as usize,
        _ => 0,
    });
    let mut prefix = Vec::with_capacity(12);
    let mut digest = Sha256::new();
    let mut text = TextCheck::default();
    let mut has_nul = false;
    let mut size = 0usize;
    let mut line = 1;
    let mut block_lines = Vec::new();
    let mut chunk = [0u8; CHUNK_BYTES];
    loop {
        let mut count = 0;
        while count < chunk.len() {
            match file.read(&mut chunk[count..]) {
                Ok(0) => break,
                Ok(read) => count += read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
        if count == 0 {
            break;
        }
        let chunk = &chunk[..count];
        ensure!(size + count <= MAX_PREVIEW_BYTES, "file_too_large");
        digest.update(chunk);
        prefix.extend_from_slice(&chunk[..count.min(12 - prefix.len())]);
        if known.is_none() && matches!(selection, Selection::Metadata) {
            text.push(chunk);
            has_nul |= memchr::memchr(0, chunk).is_some();
        }
        match selection {
            Selection::All => bytes.extend_from_slice(chunk),
            Selection::Metadata => {
                block_lines.push(line);
                line += memchr::memchr_iter(b'\n', chunk).count() as u64;
            }
            _ => {}
        }
        size += count;
    }
    let after = file.metadata()?;
    ensure!(
        meta.len() == after.len() && modified == after.modified()?,
        "read_failed"
    );
    let version = json!({"size":size,"mtimeMs":modified.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()});
    let generation = format!("{:x}", digest.finalize());
    #[cfg(test)]
    tests::record_digest();
    // Whole-body and parent-generation reads keep their fresh digest check.
    if let Some(known) = known {
        ensure!(generation == known.generation, "read_failed");
    }
    let text = known.map_or(!text.invalid && text.tail.is_empty(), |known| known.text);
    let analysis = matches!(selection, Selection::Metadata).then(|| {
        Arc::new(Analysis {
            generation: generation.clone(),
            size,
            modified,
            text,
            block_lines,
        })
    });
    Ok(Content {
        bytes,
        prefix,
        size,
        version,
        generation,
        text,
        has_nul,
        line,
        line_offset: 0,
        analysis,
    })
}

// A block stores the line at its first byte, which may be in the middle of a
// long line. Start before the target line and continue until it or EOF is found.
fn read_selection(
    file: &mut (impl Read + Seek),
    selection: Selection,
    known: &Analysis,
) -> Result<Content> {
    let block = match selection {
        Selection::Page { offset, .. } => {
            ensure!(offset <= known.size as u64, "read_failed");
            (offset as usize / CHUNK_BYTES).min(known.block_lines.len().saturating_sub(1))
        }
        Selection::Line { requested } => known
            .block_lines
            .partition_point(|&line| line < requested)
            .saturating_sub(1),
        _ => unreachable!(),
    };
    let mut position = block * CHUNK_BYTES;
    let mut line = known.block_lines.get(block).copied().unwrap_or(1);
    file.seek(SeekFrom::Start(position as u64))?;
    let mut chunk = [0u8; CHUNK_BYTES];
    let mut bytes = Vec::new();
    match selection {
        Selection::Page { offset, maximum } => {
            let offset = offset as usize;
            let prefix = offset - position;
            file.read_exact(&mut chunk[..prefix])
                .context("read_failed")?;
            line += memchr::memchr_iter(b'\n', &chunk[..prefix]).count() as u64;
            bytes.resize(
                (known.size - offset).min(maximum.min(256 * 1024) as usize + 3),
                0,
            );
            file.read_exact(&mut bytes).context("read_failed")?;
            position = offset;
        }
        Selection::Line { requested } => {
            while position < known.size && line < requested {
                let count = CHUNK_BYTES.min(known.size - position);
                file.read_exact(&mut chunk[..count])
                    .context("read_failed")?;
                for &byte in &chunk[..count] {
                    if line >= requested {
                        break;
                    }
                    if byte == b'\n' {
                        line += 1;
                    }
                    position += 1;
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(Content {
        bytes,
        prefix: Vec::new(),
        size: known.size,
        version: json!({"size":known.size,"mtimeMs":known.modified.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()}),
        generation: known.generation.clone(),
        text: known.text,
        has_nul: false,
        line,
        line_offset: position,
        analysis: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, fs::File, ops::Deref};

    #[derive(Default, Debug, PartialEq, Eq)]
    struct ReadCounts {
        bytes: usize,
        digests: usize,
    }
    thread_local! {
        static IO: RefCell<ReadCounts> = RefCell::default();
        static AFTER_READ: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::default();
    }
    pub(super) fn record_digest() {
        IO.with(|counts| counts.borrow_mut().digests += 1);
    }
    pub(super) struct CountedFile(pub File);
    impl Deref for CountedFile {
        type Target = File;
        fn deref(&self) -> &File {
            &self.0
        }
    }
    impl Read for CountedFile {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = self.0.read(buffer)?;
            IO.with(|io| io.borrow_mut().bytes += count);
            if count > 0 {
                let after = AFTER_READ.with(|after| after.borrow_mut().take());
                if let Some(after) = after {
                    after();
                }
            }
            Ok(count)
        }
    }
    impl Seek for CountedFile {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.0.seek(position)
        }
    }
    // Measurements stay on this fixture's thread, outside the async pool.
    fn measured(
        path: &Path,
        selection: Selection,
        known: Option<&Analysis>,
    ) -> (Result<Content>, ReadCounts) {
        IO.with(|io| *io.borrow_mut() = ReadCounts::default());
        let result = scan(path, selection, known);
        (result, IO.with(|io| io.take()))
    }

    async fn read(path: &Path, selection: Selection) -> Result<Content> {
        super::read(path, selection, None).await
    }
    async fn read_known(
        path: &Path,
        selection: Selection,
        known: Option<Arc<Analysis>>,
    ) -> Result<Content> {
        super::read_known(path, selection, known, None).await
    }
    // Owns candidate analysis, bounded paging I/O and version checks at the
    // filesystem seam; the existing parser owner has no I/O or candidate state.
    #[tokio::test]
    async fn candidate_analysis_bounds_paging_and_preserves_other_digest_checks() {
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let fixture = Fixture(
            std::fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "rovai-content-test-{}",
                    crate::new_token().unwrap()
                )),
        );
        let text = format!(
            "{}🌸\n{}",
            "a".repeat(64 * 1024 - 2),
            "你好\n".repeat(300_000)
        );
        let fixed = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        let write = |bytes: &[u8]| {
            std::fs::write(&fixture.0, bytes).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&fixture.0)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(fixed))
                .unwrap();
        };
        write(text.as_bytes());
        let (metadata, counts) = measured(&fixture.0, Selection::Metadata, None);
        let metadata = metadata.unwrap();
        assert_eq!(
            counts,
            ReadCounts {
                bytes: text.len(),
                digests: 1
            }
        );
        assert!(metadata.text && !metadata.has_nul);
        assert!(metadata.bytes.is_empty());
        assert_eq!(metadata.prefix.len(), 12);
        assert_eq!(
            metadata.generation,
            format!("{:x}", Sha256::digest(text.as_bytes()))
        );
        let analysis = metadata.analysis.clone().unwrap();
        let page = read_known(
            &fixture.0,
            Selection::Page {
                offset: 64 * 1024 - 2,
                maximum: 1,
            },
            Some(analysis.clone()),
        )
        .await
        .unwrap();
        assert!(page.text);
        assert_eq!(page.bytes, "🌸".as_bytes());
        assert_eq!(page.line, 1);
        assert_eq!(page.generation, metadata.generation);
        let line = read_known(
            &fixture.0,
            Selection::Line { requested: 2 },
            Some(analysis.clone()),
        )
        .await
        .unwrap();
        assert!(line.bytes.is_empty());
        assert_eq!(line.line_offset, 64 * 1024 + 3);
        assert_eq!(line.line, 2);
        let digest = read(&fixture.0, Selection::Digest).await.unwrap();
        assert!(digest.bytes.is_empty());
        assert_eq!(digest.generation, metadata.generation);
        assert!(analysis.block_lines.len() <= MAX_PREVIEW_BYTES.div_ceil(CHUNK_BYTES));
        // Cached facts must produce the same byte/line results at boundaries,
        // after the first chunk, and beyond the last line.
        for selection in [
            Selection::Page {
                offset: 0,
                maximum: 9,
            },
            Selection::Page {
                offset: 64 * 1024 - 2,
                maximum: 1,
            },
            Selection::Page {
                offset: 2 * 64 * 1024 + 2,
                maximum: 256 * 1024,
            },
            Selection::Line { requested: 1 },
            Selection::Line { requested: 2 },
            Selection::Line { requested: 250_000 },
            Selection::Line { requested: 400_000 },
        ] {
            let (cached, counts) = measured(&fixture.0, selection, Some(&analysis));
            let cached = cached.unwrap();
            assert_eq!(counts.digests, 0);
            assert!(cached.text);
            assert_eq!(cached.generation, metadata.generation);
            match selection {
                Selection::Page { offset, maximum } => {
                    let offset = offset as usize;
                    let end = (offset + maximum as usize + 3).min(text.len());
                    assert_eq!(cached.bytes, text.as_bytes()[offset..end]);
                    assert_eq!(
                        cached.line,
                        1 + text.as_bytes()[..offset]
                            .iter()
                            .filter(|&&byte| byte == b'\n')
                            .count() as u64
                    );
                    assert!(counts.bytes <= CHUNK_BYTES + maximum as usize + 3);
                }
                Selection::Line { requested } => {
                    let mut line = 1;
                    let mut offset = 0;
                    for (index, byte) in text.bytes().enumerate() {
                        if line >= requested {
                            break;
                        }
                        if byte == b'\n' {
                            line += 1;
                        }
                        offset = index + 1;
                    }
                    assert_eq!((cached.line, cached.line_offset), (line, offset));
                    assert!(cached.bytes.is_empty());
                    assert!(counts.bytes <= 2 * CHUNK_BYTES);
                }
                _ => unreachable!(),
            }
        }
        // A non-first-page refresh: exactly one full digest, then at most one
        // locating chunk and a block prefix plus the selected page.
        let (located, locating) = measured(
            &fixture.0,
            Selection::Line { requested: 250_000 },
            Some(&analysis),
        );
        let located = located.unwrap();
        let (page, paging) = measured(
            &fixture.0,
            Selection::Page {
                offset: located.line_offset as u64,
                maximum: 256 * 1024,
            },
            Some(&analysis),
        );
        assert_eq!(page.unwrap().line, 250_000);
        assert!(locating.bytes + paging.bytes <= 2 * CHUNK_BYTES + 256 * 1024 + 3);
        assert_eq!(locating.digests + paging.digests, 0);
        println!(
            "Web candidate: {} bytes / 1 digest; locate: {} bytes / 0 digests; page: {} bytes / 0 digests",
            text.len(),
            locating.bytes,
            paging.bytes
        );
        let (missing, counts) = measured(&fixture.0, Selection::Line { requested: 2 }, None);
        assert!(missing.is_err());
        assert_eq!(counts, ReadCounts::default());

        let mut changed = text.into_bytes();
        changed[0] = b'b';
        write(&changed);
        let changed = read(&fixture.0, Selection::Metadata).await.unwrap();
        assert_eq!(changed.version, metadata.version);
        assert_ne!(changed.generation, metadata.generation);
        // Paging deliberately accepts equal size/mtime within this candidate.
        let (page, counts) = measured(
            &fixture.0,
            Selection::Page {
                offset: 0,
                maximum: 9,
            },
            Some(&analysis),
        );
        assert_eq!(page.unwrap().bytes[0], b'b');
        assert_eq!(counts.digests, 0);
        // Whole-body and parent reads still reject the old digest.
        for selection in [Selection::All, Selection::Digest] {
            let (result, counts) = measured(&fixture.0, selection, Some(&analysis));
            assert!(result.is_err());
            assert_eq!(counts.digests, 1);
        }
        File::options()
            .write(true)
            .open(&fixture.0)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(fixed + std::time::Duration::from_micros(500)),
            )
            .unwrap();
        let submillis = read(&fixture.0, Selection::Metadata).await.unwrap();
        assert_eq!(submillis.version, metadata.version);
        let (stale, counts) = measured(
            &fixture.0,
            Selection::Page {
                offset: 0,
                maximum: 9,
            },
            Some(&analysis),
        );
        assert!(stale.is_err());
        assert_eq!(counts, ReadCounts::default());

        // The after-read fence rejects changes, without retries or a new digest.
        let changing_path = fixture.0.clone();
        AFTER_READ.with(|after| {
            *after.borrow_mut() = Some(Box::new(move || {
                std::fs::write(changing_path, b"shorter").unwrap();
            }))
        });
        let (changed_during_read, counts) = measured(
            &fixture.0,
            Selection::Page {
                offset: 0,
                maximum: 9,
            },
            submillis.analysis.as_deref(),
        );
        assert!(changed_during_read.is_err());
        assert_eq!(counts.digests, 0);

        // Long lines can span many blocks; beyond-EOF resolution still permits
        // the controller to resolve the last valid line again after shortening.
        for content in [
            format!("{}\n尾", "a".repeat(3 * CHUNK_BYTES)),
            "one\n尾".into(),
            String::new(),
        ] {
            write(content.as_bytes());
            let current = read(&fixture.0, Selection::Metadata).await.unwrap();
            let analysis = current.analysis.unwrap();
            let end = read_known(
                &fixture.0,
                Selection::Line { requested: 100 },
                Some(analysis.clone()),
            )
            .await
            .unwrap();
            assert_eq!(end.line_offset, content.len());
            let last = read_known(
                &fixture.0,
                Selection::Line {
                    requested: end.line,
                },
                Some(analysis.clone()),
            )
            .await
            .unwrap();
            let start = content.rfind('\n').map_or(0, |offset| offset + 1);
            assert_eq!(last.line_offset, start);
            let page = read_known(
                &fixture.0,
                Selection::Page {
                    offset: start as u64,
                    maximum: 1,
                },
                Some(analysis),
            )
            .await
            .unwrap();
            assert_eq!(page.bytes, content.as_bytes()[start..]);
        }
        write(b"valid text followed by incomplete UTF-8\xf0\x9f");
        assert!(!read(&fixture.0, Selection::Metadata).await.unwrap().text);

        // The scanner and download opener share this ownership seam. Abort the
        // waiting HTTP task only after its blocking operation has actually begun.
        let capacity = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = Arc::new(capacity.clone().acquire_owned().await.unwrap());
        let (started, entered) = tokio::sync::oneshot::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let request = tokio::spawn(super::super::blocking(permit, move || {
            started.send(()).unwrap();
            wait.recv().unwrap();
            Ok(())
        }));
        entered.await.unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(capacity.clone().try_acquire_owned().is_err());
        finish.send(()).unwrap();
        let restored = tokio::time::timeout(std::time::Duration::from_secs(2), capacity.acquire())
            .await
            .unwrap()
            .unwrap();
        drop(restored);
    }
}
