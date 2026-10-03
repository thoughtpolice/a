// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Parsing for [DotSlash][dotslash]-compatible manifests.
//!
//! A manifest is a JSON document behind a `#!` line that describes, per
//! platform, one artifact to download: its size, its hash, the archive format
//! it arrives in, the path to the executable inside it, and an ordered list of
//! URLs to try.
//!
//! Note that `size`/`hash`/`digest` describe the **downloaded artifact** — the
//! archive as served — not the file extracted from it. That is what makes an
//! entry directly usable as a content-addressed cache key: the digest is known
//! before anything is fetched.
//!
//! [dotslash]: https://dotslash-cli.com

mod manifest;
mod platform;

pub use crate::manifest::{
    ArchiveFormat, HashAlgorithm, Manifest, PlatformEntry, Provider, parse_manifest,
    parse_manifest_file,
};
pub use crate::platform::{current_platform_key, resolve_platform};
