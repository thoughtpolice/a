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
    checksum: [u8; 20],
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

        // The trailer is SHA-1 of everything *before* it, but we only know
        // where the pack ends at EOF. Keep the most recent TRAILER_LEN bytes
        // out of the hasher: `carry` always holds the trailing bytes seen so
        // far, and anything older is hashed and written immediately.
        let mut hasher = Sha1::new();
        let mut carry: Vec<u8> = Vec::with_capacity(TRAILER_LEN + SPOOL_CHUNK);
        let mut total: usize = 0;
        let mut buf = vec![0u8; SPOOL_CHUNK];

        loop {
            let n = reader
                .read(&mut buf)
                .await
                .map_err(|e| GitFetchError::RequestFailed(format!("read pack stream: {e}")))?;
            if n == 0 {
                break;
            }

            total += n;
            if total > max_size {
                return Err(GitFetchError::TooLarge(total));
            }

            carry.extend_from_slice(&buf[..n]);
            if carry.len() > TRAILER_LEN {
                let hash_len = carry.len() - TRAILER_LEN;
                hasher.update(&carry[..hash_len]);
                writer
                    .write_all(&carry[..hash_len])
                    .await
                    .map_err(|e| GitFetchError::RequestFailed(format!("write pack spool: {e}")))?;
                carry.drain(..hash_len);
            }
        }

        // 12-byte header + trailer is the smallest possible pack.
        if total < 12 + TRAILER_LEN {
            return Err(GitFetchError::InvalidPackfile(format!(
                "pack stream too short: {total} bytes"
            )));
        }

        let expected: [u8; 20] = carry[..].try_into().expect("carry holds exactly 20 bytes");
        let actual: [u8; 20] = hasher.finalize().into();
        if expected != actual {
            return Err(GitFetchError::InvalidPackfile(format!(
                "packfile checksum mismatch: trailer {}, computed {}",
                hex::encode(expected),
                hex::encode(actual)
            )));
        }

        // Write the trailer itself so the mapping holds the complete pack.
        writer
            .write_all(&carry)
            .await
            .map_err(|e| GitFetchError::RequestFailed(format!("write pack spool: {e}")))?;
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

        Ok(Self {
            mmap,
            _file: file,
            checksum: actual,
        })
    }

    /// The complete packfile bytes (header, objects, trailer).
    pub fn data(&self) -> &[u8] {
        &self.mmap
    }

    /// The verified pack checksum (contents of the trailer).
    pub fn checksum(&self) -> [u8; 20] {
        self.checksum
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
        assert_eq!(&spooled.checksum(), &pack[pack.len() - 20..]);
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
        assert!(matches!(err, GitFetchError::TooLarge(_)));
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
