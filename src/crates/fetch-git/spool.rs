// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Disk spooling for large packfiles.
//!
//! Holding a whole packfile (let alone its decompressed objects) in memory
//! does not scale to repositories like nixpkgs, whose packs run to many
//! gigabytes. [`SpooledPack`] instead streams the pack to an *unlinked*
//! temporary file as it arrives from the network, verifying the trailing
//! SHA-1 checksum on the fly, and then memory-maps the file read-only.
//!
//! The mapping gives downstream code (indexing, delta resolution, random
//! object reads) cheap byte-range access to the pack while the kernel page
//! cache decides how much of it actually stays resident. Because the backing
//! file is unlinked at creation, it is reclaimed automatically when the
//! [`SpooledPack`] drops — including on crash.

use std::path::Path;

use sha1::{Digest as _, Sha1};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _, BufWriter};

use crate::GitFetchError;

/// Packfile trailer length: a raw SHA-1 of everything before it.
const TRAILER_LEN: usize = 20;

/// Read chunk size while spooling.
const SPOOL_CHUNK: usize = 256 * 1024;

/// A packfile spooled to an unlinked temporary file and memory-mapped
/// read-only.
///
/// The trailing 20-byte SHA-1 checksum is verified during spooling, so the
/// mapped bytes are known-intact from construction. The full pack (header,
/// objects, and trailer) is available via [`data`](Self::data).
#[derive(Debug)]
pub struct SpooledPack {
    // Field order matters: the mapping must drop before the file handle.
    mmap: memmap2::Mmap,
    _file: std::fs::File,
}

impl SpooledPack {
    /// Stream `reader` to a temporary file in `dir`, verifying the SHA-1
    /// trailer, and memory-map the result.
    ///
    /// `max_size` bounds the on-disk pack size; exceeding it aborts with
    /// [`GitFetchError::TooLarge`].
    pub async fn spool<R: AsyncRead + Unpin>(
        mut reader: R,
        dir: &Path,
        max_size: usize,
    ) -> Result<Self, GitFetchError> {
        let file = tempfile::tempfile_in(dir).map_err(|e| {
            GitFetchError::RequestFailed(format!(
                "create pack spool file in {}: {e}",
                dir.display()
            ))
        })?;
        let mut writer = BufWriter::with_capacity(SPOOL_CHUNK, tokio::fs::File::from_std(file));

        // The trailer is SHA-1 of everything *before* it, but where the
        // pack ends is only known at EOF, so hashing lags the stream:
        // `held` keeps back the latest TRAILER_LEN bytes, and everything
        // older is hashed. Bytes go to disk as they arrive.
        let mut hasher = Sha1::new();
        let mut held = [0u8; TRAILER_LEN];
        let mut held_len = 0;
        let mut total: usize = 0;
        let mut buf = vec![0u8; SPOOL_CHUNK];

        loop {
            let n = reader
                .read(&mut buf)
                .await
                .map_err(|e| GitFetchError::from_io(e, "read pack stream"))?;
            if n == 0 {
                break;
            }

            total += n;
            if total > max_size {
                return Err(GitFetchError::TooLarge {
                    what: "pack size",
                    size: total,
                    limit: max_size,
                });
            }

            let chunk = &buf[..n];
            writer
                .write_all(chunk)
                .await
                .map_err(|e| GitFetchError::RequestFailed(format!("write pack spool: {e}")))?;

            let release = (held_len + n).saturating_sub(TRAILER_LEN);
            let from_held = release.min(held_len);
            hasher.update(&held[..from_held]);
            hasher.update(&chunk[..release - from_held]);
            let tail = &chunk[release - from_held..];
            held.copy_within(from_held..held_len, 0);
            let kept = held_len - from_held;
            held[kept..kept + tail.len()].copy_from_slice(tail);
            held_len = kept + tail.len();
        }

        // 12-byte header + trailer is the smallest possible pack.
        if total < 12 + TRAILER_LEN {
            return Err(GitFetchError::InvalidPackfile(format!(
                "pack stream too short: {total} bytes"
            )));
        }

        let actual: [u8; 20] = hasher.finalize().into();
        if held != actual {
            return Err(GitFetchError::InvalidPackfile(format!(
                "packfile checksum mismatch: trailer {}, computed {}",
                hex::encode(held),
                hex::encode(actual)
            )));
        }

        writer
            .flush()
            .await
            .map_err(|e| GitFetchError::RequestFailed(format!("flush pack spool: {e}")))?;

        let file = writer.into_inner().into_std().await;

        // SAFETY: the file is an unlinked temporary owned exclusively by
        // this process; nothing else can truncate or mutate it while the
        // mapping is alive.
        let mmap = unsafe { memmap2::Mmap::map(&file) }
            .map_err(|e| GitFetchError::RequestFailed(format!("mmap pack spool: {e}")))?;

        if mmap.len() != total {
            return Err(GitFetchError::InvalidPackfile(format!(
                "pack spool size mismatch: wrote {total}, mapped {}",
                mmap.len()
            )));
        }

        Ok(Self { mmap, _file: file })
    }

    /// Give up the file handle and keep just the mapping, which stays valid
    /// on its own (the unlinked file lives as long as the mapping).
    pub fn into_map(self) -> memmap2::Mmap {
        self.mmap
    }

    /// The complete packfile bytes (header, objects, trailer).
    pub fn data(&self) -> &[u8] {
        &self.mmap
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal valid pack: header for zero objects + SHA-1 trailer.
    fn empty_pack() -> Vec<u8> {
        let mut pack = Vec::new();
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&0u32.to_be_bytes());
        let sha = Sha1::digest(&pack);
        pack.extend_from_slice(&sha);
        pack
    }

    #[tokio::test]
    async fn spool_roundtrip() {
        let pack = empty_pack();
        let spooled = SpooledPack::spool(
            std::io::Cursor::new(pack.clone()),
            &std::env::temp_dir(),
            1024,
        )
        .await
        .unwrap();
        assert_eq!(spooled.data(), &pack[..]);
    }

    #[tokio::test]
    async fn spool_large_body_in_small_chunks() {
        // Body larger than the spool chunk, delivered in odd-sized pieces.
        let mut pack = Vec::new();
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&0u32.to_be_bytes());
        pack.extend_from_slice(&vec![0xAB; 3 * SPOOL_CHUNK + 17]);
        let sha = Sha1::digest(&pack);
        pack.extend_from_slice(&sha);

        let reader = crate::pktline::test_util::ChunkedReader::new(pack.clone(), 1013);
        let spooled = SpooledPack::spool(reader, &std::env::temp_dir(), pack.len())
            .await
            .unwrap();
        assert_eq!(spooled.data(), &pack[..]);
    }

    #[tokio::test]
    async fn spool_rejects_corrupt_trailer() {
        let mut pack = empty_pack();
        let last = pack.len() - 1;
        pack[last] ^= 0xFF;
        let err = SpooledPack::spool(std::io::Cursor::new(pack), &std::env::temp_dir(), 1024)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("checksum mismatch"), "{err}");
    }

    #[tokio::test]
    async fn spool_rejects_oversized_stream() {
        let pack = empty_pack();
        let err = SpooledPack::spool(std::io::Cursor::new(pack), &std::env::temp_dir(), 16)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                GitFetchError::TooLarge {
                    size: 32,
                    limit: 16,
                    ..
                }
            ),
            "{err}"
        );
    }

    #[tokio::test]
    async fn spool_handles_every_chunk_size() {
        // Chunks shorter than, equal to, and longer than the trailer all
        // keep the hashing exactly TRAILER_LEN bytes behind.
        let mut pack = b"PACK".to_vec();
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&0u32.to_be_bytes());
        pack.extend((0..200u8).map(|i| i.wrapping_mul(7)));
        let sha = Sha1::digest(&pack);
        pack.extend_from_slice(&sha);
        for chunk in [1, 7, 19, 20, 21, 40, 64, pack.len()] {
            let reader = crate::pktline::test_util::ChunkedReader::new(pack.clone(), chunk);
            let spooled = SpooledPack::spool(reader, &std::env::temp_dir(), pack.len())
                .await
                .unwrap_or_else(|e| panic!("chunk {chunk}: {e}"));
            assert_eq!(spooled.data(), &pack[..], "chunk {chunk}");
        }
    }

    #[tokio::test]
    async fn spool_keeps_errors_from_the_stream() {
        let sideband = crate::sideband::SidebandReader::from_reader(std::io::Cursor::new(
            crate::pktline::encode_pkt_line(b"ERR upload-pack: not our ref\n"),
        ));
        let err = SpooledPack::spool(sideband, &std::env::temp_dir(), 1024)
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "request failed: remote error: upload-pack: not our ref"
        );
    }

    #[tokio::test]
    async fn spool_rejects_short_stream() {
        let err = SpooledPack::spool(
            std::io::Cursor::new(b"PACK".to_vec()),
            &std::env::temp_dir(),
            1024,
        )
        .await
        .unwrap_err();
        assert!(format!("{err}").contains("too short"), "{err}");
    }
}
