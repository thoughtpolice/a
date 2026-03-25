// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Archive decompression and extraction.
//!
//! Supports: zst, gz, tar, tar.gz, tar.zst, plain (no compression).
//! Zip support will be added when the `zip` crate is available.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};

use crate::manifest::ArchiveFormat;

/// Extract/decompress `data` according to `format`, placing the result under
/// `dest_dir`. Returns the path to the executable identified by `target_path`
/// within the extracted output.
///
/// # Stub
///
/// This is a stub for Phase 1. The real implementation (Phase 3) will
/// handle zst, gz, tar, tar.gz, tar.zst, and plain formats.
pub fn extract(
    _data: &[u8],
    _format: ArchiveFormat,
    _target_path: &str,
    _dest_dir: &Path,
) -> Result<PathBuf> {
    bail!("archive::extract not yet implemented (Phase 3)")
}
