use crate::error::{AppError, AppResult};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

/// When archive parsing fails, the raw zip-crate error ("invalid Zip
/// archive: Could not find EOCD") is useless to the user — it just means
/// "the file we downloaded isn't a real zip." Almost always that's because
/// the signed CDN URL returned HTML, an error page, or a stub — OR the
/// attachment was a different archive format (e.g. 7z) we tried to open as
/// zip. Sniffing the first bytes lets us surface what we actually got, so
/// the user (or an issue report) can tell whether it's a Patreon paywall
/// stub, a 404 page, a 7z mislabeled as zip, or genuinely a corrupt upload.
fn diagnose(archive_path: &Path) -> String {
    let size = fs::metadata(archive_path).map(|m| m.len()).unwrap_or(0);
    let mut buf = [0u8; 256];
    let read = File::open(archive_path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    let head = &buf[..read];
    let hex_prefix = head
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    let text = String::from_utf8_lossy(head);
    let text = text.trim().chars().take(120).collect::<String>();
    let kind = if head.starts_with(b"<!DOCTYPE")
        || head.starts_with(b"<html")
        || head.starts_with(b"<HTML")
    {
        " (looks like an HTML page — likely the CDN URL was unauthorized or expired)"
    } else if head.starts_with(b"{") || head.starts_with(b"[") {
        " (looks like JSON — likely a Patreon API error response)"
    } else if head.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        " (looks like a 7z archive)"
    } else if head.starts_with(b"Rar!") {
        " (looks like a RAR archive)"
    } else {
        ""
    };
    format!(
        "downloaded {size} bytes{kind}; first bytes: {hex_prefix} | {text}"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    SevenZ,
    Rar,
    Unknown,
}

/// Sniff the archive's first bytes to dispatch by actual format rather
/// than file extension. Patreon attachments lie about extensions all the
/// time (e.g. zip-renamed-to-rar, 7z labeled .zip). This catches that.
fn sniff_kind(archive_path: &Path) -> ArchiveKind {
    let mut buf = [0u8; 8];
    let n = File::open(archive_path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    let head = &buf[..n];
    if head.starts_with(&[0x50, 0x4B, 0x03, 0x04])
        || head.starts_with(&[0x50, 0x4B, 0x05, 0x06])
        || head.starts_with(&[0x50, 0x4B, 0x07, 0x08])
    {
        ArchiveKind::Zip
    } else if head.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        ArchiveKind::SevenZ
    } else if head.starts_with(b"Rar!") {
        ArchiveKind::Rar
    } else {
        ArchiveKind::Unknown
    }
}

/// Extract every file in `archive_path` into `dest_dir`, preserving relative
/// directory structure. Skips directory entries (created via parent on file
/// extraction) and entries that escape `dest_dir` via `..`. Dispatches by
/// magic bytes so zip / 7z attachments both work; .rar is rejected with a
/// clear error (the unrar Rust ecosystem is licensed in ways we'd rather
/// not vendor).
pub fn extract_all(archive_path: &Path, dest_dir: &Path) -> AppResult<u64> {
    fs::create_dir_all(dest_dir)?;
    match sniff_kind(archive_path) {
        ArchiveKind::Zip => extract_all_zip(archive_path, dest_dir),
        ArchiveKind::SevenZ => extract_all_7z(archive_path, dest_dir),
        ArchiveKind::Rar => Err(AppError::Other(format!(
            "rar archives are not supported yet — {}",
            diagnose(archive_path)
        ))),
        ArchiveKind::Unknown => Err(AppError::Other(format!(
            "unrecognized archive format — {}",
            diagnose(archive_path)
        ))),
    }
}

/// Find and extract a single named file from `archive_path`, writing it to
/// `dest_path`. Matches by basename, case-insensitive — useful when an index
/// entry says "this skin's .dat is named 'PlFcBu.dat'" without specifying
/// the full path inside a deep directory tree.
pub fn extract_named_file(
    archive_path: &Path,
    inner_filename: &str,
    dest_path: &Path,
) -> AppResult<()> {
    match sniff_kind(archive_path) {
        ArchiveKind::Zip => extract_named_file_zip(archive_path, inner_filename, dest_path),
        ArchiveKind::SevenZ => extract_named_file_7z(archive_path, inner_filename, dest_path),
        ArchiveKind::Rar => Err(AppError::Other(format!(
            "rar archives are not supported yet — {}",
            diagnose(archive_path)
        ))),
        ArchiveKind::Unknown => Err(AppError::Other(format!(
            "unrecognized archive format — {}",
            diagnose(archive_path)
        ))),
    }
}

fn extract_all_zip(archive_path: &Path, dest_dir: &Path) -> AppResult<u64> {
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        AppError::Other(format!("zip: {e} — {}", diagnose(archive_path)))
    })?;
    let mut count: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("zip entry {i}: {e}")))?;
        let outpath = match entry.enclosed_name() {
            Some(p) => dest_dir.join(p),
            None => continue,
        };
        if !outpath.starts_with(dest_dir) {
            continue;
        }
        if entry.is_dir() {
            fs::create_dir_all(&outpath)?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&outpath)?;
        io::copy(&mut entry, &mut out)?;
        count += 1;
    }
    Ok(count)
}

fn extract_named_file_zip(
    archive_path: &Path,
    inner_filename: &str,
    dest_path: &Path,
) -> AppResult<()> {
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        AppError::Other(format!("zip: {e} — {}", diagnose(archive_path)))
    })?;
    let needle = inner_filename.to_ascii_lowercase();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("zip entry {i}: {e}")))?;
        let name = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let basename = name
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if basename == needle {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = File::create(dest_path)?;
            io::copy(&mut entry, &mut out)?;
            return Ok(());
        }
    }
    Err(AppError::Other(format!(
        "'{inner_filename}' not found inside archive {}",
        archive_path.display()
    )))
}

/// Solid 7z archives share one LZMA2 stream across every entry, so the
/// callback for `for_each_entries` MUST fully drain each entry's reader
/// before returning — otherwise the decompressor desyncs and the next
/// entry's bytes look like a CRC mismatch. We always `read_to_end` and
/// then decide what to do with the bytes.
fn extract_all_7z(archive_path: &Path, dest_dir: &Path) -> AppResult<u64> {
    let dest_owned = dest_dir.to_path_buf();
    let mut count: u64 = 0;
    let mut archive = sevenz_rust2::ArchiveReader::open(archive_path, Default::default())
        .map_err(|e| AppError::Other(format!("7z: {e} — {}", diagnose(archive_path))))?;
    archive
        .for_each_entries(|entry, reader| {
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf)?;
            if entry.is_directory {
                return Ok(true);
            }
            let entry_path = std::path::PathBuf::from(&entry.name);
            let outpath = dest_owned.join(&entry_path);
            if !outpath.starts_with(&dest_owned) {
                return Ok(true);
            }
            if let Some(parent) = outpath.parent() {
                let _ = fs::create_dir_all(parent);
            }
            File::create(&outpath)
                .and_then(|mut f| std::io::Write::write_all(&mut f, &buf))?;
            count += 1;
            Ok(true)
        })
        .map_err(|e| AppError::Other(format!("7z: {e} — {}", diagnose(archive_path))))?;
    Ok(count)
}

fn extract_named_file_7z(
    archive_path: &Path,
    inner_filename: &str,
    dest_path: &Path,
) -> AppResult<()> {
    let needle = inner_filename.to_ascii_lowercase();
    let mut found = false;
    let mut payload: Vec<u8> = Vec::new();
    let mut archive = sevenz_rust2::ArchiveReader::open(archive_path, Default::default())
        .map_err(|e| AppError::Other(format!("7z: {e} — {}", diagnose(archive_path))))?;
    archive
        .for_each_entries(|entry, reader| {
            // Drain every entry, even ones we'll discard — see comment on
            // extract_all_7z for why.
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf)?;
            if found || entry.is_directory {
                return Ok(true);
            }
            let basename = std::path::Path::new(&entry.name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if basename == needle {
                payload = buf;
                found = true;
            }
            Ok(true)
        })
        .map_err(|e| AppError::Other(format!("7z: {e} — {}", diagnose(archive_path))))?;
    if !found {
        return Err(AppError::Other(format!(
            "'{inner_filename}' not found inside archive {}",
            archive_path.display()
        )));
    }
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = File::create(dest_path)?;
    std::io::Write::write_all(&mut out, &payload)?;
    Ok(())
}
