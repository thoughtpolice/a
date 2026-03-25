// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Archive decompression and extraction.
//!
//! Supports: zst, gz, tar, tar.gz, tar.zst, zip, and plain (no compression).

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use dotslash_manifest::ArchiveFormat;

/// Extract/decompress `data` according to `format`, placing the result under
/// `dest_dir`. Returns the path to the executable identified by `target_path`
/// within the extracted output.
pub fn extract(
    data: &[u8],
    format: ArchiveFormat,
    target_path: &str,
    dest_dir: &Path,
) -> Result<PathBuf> {
    match format {
        ArchiveFormat::Plain => extract_plain(data, target_path, dest_dir),
        ArchiveFormat::Zst => extract_zst(data, target_path, dest_dir),
        ArchiveFormat::Gz => extract_gz(data, target_path, dest_dir),
        ArchiveFormat::Tar => extract_tar(data, dest_dir),
        ArchiveFormat::TarGz => extract_tar_gz(data, dest_dir),
        ArchiveFormat::TarZst => extract_tar_zst(data, dest_dir),
        ArchiveFormat::Zip => extract_zip(data, dest_dir),
    }?;

    let target = dest_dir.join(target_path);
    if !target.exists() {
        bail!(
            "target '{}' not found after extraction into {}",
            target_path,
            dest_dir.display()
        );
    }
    set_executable(&target)?;
    Ok(target)
}

fn extract_plain(data: &[u8], target_path: &str, dest_dir: &Path) -> Result<()> {
    let out = dest_dir.join(target_path);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(&out, data).with_context(|| format!("writing {}", out.display()))
}

fn extract_zst(data: &[u8], target_path: &str, dest_dir: &Path) -> Result<()> {
    let mut decoder =
        zstd::stream::read::Decoder::new(Cursor::new(data)).context("zstd decoder")?;
    let mut buf = Vec::new();
    decoder.read_to_end(&mut buf).context("zstd decompress")?;
    extract_plain(&buf, target_path, dest_dir)
}

fn extract_gz(data: &[u8], target_path: &str, dest_dir: &Path) -> Result<()> {
    let mut decoder = flate2::read::GzDecoder::new(Cursor::new(data));
    let mut buf = Vec::new();
    decoder.read_to_end(&mut buf).context("gzip decompress")?;
    extract_plain(&buf, target_path, dest_dir)
}

fn extract_tar(data: &[u8], dest_dir: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(Cursor::new(data));
    archive.unpack(dest_dir).context("tar unpack")
}

fn extract_tar_gz(data: &[u8], dest_dir: &Path) -> Result<()> {
    let gz = flate2::read::GzDecoder::new(Cursor::new(data));
    let mut archive = tar::Archive::new(gz);
    archive.unpack(dest_dir).context("tar.gz unpack")
}

fn extract_tar_zst(data: &[u8], dest_dir: &Path) -> Result<()> {
    let zst = zstd::stream::read::Decoder::new(Cursor::new(data)).context("zstd decoder")?;
    let mut archive = tar::Archive::new(zst);
    archive.unpack(dest_dir).context("tar.zst unpack")
}

fn extract_zip(data: &[u8], dest_dir: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(data)).context("reading zip archive")?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).context("zip entry")?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest_dir.join(path);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .with_context(|| format!("creating dir {}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .with_context(|| format!("creating {}", out_path.display()))?;
            std::io::copy(&mut entry, &mut out_file)
                .with_context(|| format!("extracting {}", out_path.display()))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o755);
    std::fs::set_permissions(path, perms).with_context(|| format!("chmod {}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_plain() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"#!/bin/sh\necho hello\n";
        let path = extract(data, ArchiveFormat::Plain, "my-tool", dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), data);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "should be executable");
        }
    }

    #[test]
    fn test_extract_zst() {
        let dir = tempfile::tempdir().unwrap();
        let original = b"hello zstd world";
        let compressed = zstd::bulk::compress(original, 3).unwrap();
        let path = extract(&compressed, ArchiveFormat::Zst, "tool", dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn test_extract_gz() {
        use flate2::write::GzEncoder;
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let original = b"hello gzip world";
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let path = extract(&compressed, ArchiveFormat::Gz, "tool", dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn test_extract_tar_gz() {
        use flate2::write::GzEncoder;

        let dir = tempfile::tempdir().unwrap();
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let data = b"tar content here";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "bin/my-tool", &data[..])
                .unwrap();
            builder.finish().unwrap();
        }
        let mut gz = GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar_buf).unwrap();
        let compressed = gz.finish().unwrap();

        let path = extract(&compressed, ArchiveFormat::TarGz, "bin/my-tool", dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"tar content here");
    }

    #[test]
    fn test_extract_tar_zst() {
        let dir = tempfile::tempdir().unwrap();
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let data = b"zst tar content";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, "tool", &data[..]).unwrap();
            builder.finish().unwrap();
        }
        let compressed = zstd::bulk::compress(&tar_buf, 3).unwrap();

        let path = extract(&compressed, ArchiveFormat::TarZst, "tool", dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"zst tar content");
    }

    #[test]
    fn test_extract_zip() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let buf = Vec::new();
        let cursor = Cursor::new(buf);
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("bin/my-tool", options).unwrap();
        writer.write_all(b"zip content").unwrap();
        let cursor = writer.finish().unwrap();
        let zip_data = cursor.into_inner();

        let path = extract(&zip_data, ArchiveFormat::Zip, "bin/my-tool", dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"zip content");
    }

    #[test]
    fn test_extract_missing_target() {
        let dir = tempfile::tempdir().unwrap();
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let data = b"content";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "actual-name", &data[..])
                .unwrap();
            builder.finish().unwrap();
        }
        let err = extract(&tar_buf, ArchiveFormat::Tar, "wrong-name", dir.path());
        assert!(err.is_err());
        assert!(
            err.unwrap_err()
                .to_string()
                .contains("not found after extraction")
        );
    }
}
