// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! DotSlash-compatible manifest parsing.
//!
//! A shabang2 file is a JSON file with a `#!/usr/bin/env shabang2` shebang
//! line. The JSON body describes platform-specific artifacts to download,
//! verify, extract, and execute.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// Top-level manifest parsed from a shabang2/dotslash file.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    /// Human-readable name for the tool.
    pub name: String,
    /// Per-platform artifact entries keyed by platform string
    /// (e.g. "linux-x86_64").
    pub platforms: HashMap<String, PlatformEntry>,
}

/// Description of a single platform's artifact.
#[derive(Debug, Clone, Deserialize)]
pub struct PlatformEntry {
    /// Expected size of the downloaded artifact in bytes.
    pub size: u64,
    /// Hash algorithm used for verification.
    pub hash: HashAlgorithm,
    /// Hex-encoded digest (64 lowercase hex characters).
    pub digest: String,
    /// Archive/compression format. When absent, treated as a raw
    /// uncompressed file.
    #[serde(default)]
    pub format: ArchiveFormat,
    /// Relative UNIX path to the executable within the extracted artifact
    /// (or the filename for single-file formats).
    pub path: String,
    /// Ordered list of download providers.
    pub providers: Vec<Provider>,
}

/// Supported hash algorithms for artifact verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlgorithm {
    Sha256,
    Blake3,
}

/// Archive/compression format of the downloaded artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
pub enum ArchiveFormat {
    /// Raw uncompressed file (no archive, no compression).
    #[default]
    #[serde(rename = "")]
    Plain,
    /// Zstandard compressed single file.
    #[serde(rename = "zst")]
    Zst,
    /// Gzip compressed single file.
    #[serde(rename = "gz")]
    Gz,
    /// Tar archive (uncompressed).
    #[serde(rename = "tar")]
    Tar,
    /// Tar archive with gzip compression.
    #[serde(rename = "tar.gz")]
    TarGz,
    /// Tar archive with zstandard compression.
    #[serde(rename = "tar.zst")]
    TarZst,
    /// Zip archive.
    #[serde(rename = "zip")]
    Zip,
}

/// A download provider (currently only HTTP URLs).
#[derive(Debug, Clone, Deserialize)]
pub struct Provider {
    /// HTTP(S) URL to fetch the artifact from.
    pub url: String,
}

/// The required shebang prefix for shabang2 files.
const SHEBANG_PREFIX: &str = "#!/usr/bin/env shabang2";

/// Alternate shebang prefix (dotslash compat).
const DOTSLASH_SHEBANG_PREFIX: &str = "#!/usr/bin/env dotslash";

/// Parse a shabang2 manifest from a file path.
///
/// Reads the file, strips the shebang line, and deserializes the remaining
/// JSON body into a [`Manifest`].
pub fn parse_manifest_file(path: &Path) -> Result<Manifest> {
    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("reading manifest: {}", path.display()))?;
    parse_manifest(&contents)
}

/// Parse a shabang2 manifest from a string.
pub fn parse_manifest(contents: &str) -> Result<Manifest> {
    let json_body = strip_shebang(contents)?;
    let manifest: Manifest = serde_json::from_str(json_body).context("parsing manifest JSON")?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Strip the shebang line and return the remaining JSON body.
fn strip_shebang(contents: &str) -> Result<&str> {
    let first_line_end = contents.find('\n').unwrap_or(contents.len());
    let first_line = contents[..first_line_end].trim_end_matches('\r');

    if !first_line.starts_with(SHEBANG_PREFIX) && !first_line.starts_with(DOTSLASH_SHEBANG_PREFIX) {
        bail!(
            "manifest must start with '{}' or '{}', got: {:?}",
            SHEBANG_PREFIX,
            DOTSLASH_SHEBANG_PREFIX,
            first_line,
        );
    }

    Ok(&contents[first_line_end..])
}

/// Validate manifest fields after deserialization.
fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.name.is_empty() {
        bail!("manifest 'name' must not be empty");
    }
    if manifest.platforms.is_empty() {
        bail!("manifest must have at least one platform entry");
    }
    for (platform, entry) in &manifest.platforms {
        validate_platform_entry(platform, entry)?;
    }
    Ok(())
}

fn validate_platform_entry(platform: &str, entry: &PlatformEntry) -> Result<()> {
    // Validate digest is 64 hex chars
    if entry.digest.len() != 64 {
        bail!(
            "platform '{}': digest must be 64 hex characters, got {}",
            platform,
            entry.digest.len()
        );
    }
    if !entry
        .digest
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        bail!("platform '{}': digest must be lowercase hex", platform);
    }

    // Validate path
    if entry.path.is_empty() {
        bail!("platform '{}': path must not be empty", platform);
    }
    if entry.path.starts_with('/') {
        bail!("platform '{}': path must be relative", platform);
    }
    if entry.path.contains('\\') {
        bail!("platform '{}': path must use forward slashes", platform);
    }
    if entry.path.contains("..") {
        bail!("platform '{}': path must not contain '..'", platform);
    }

    // Must have at least one provider
    if entry.providers.is_empty() {
        bail!("platform '{}': must have at least one provider", platform);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_MANIFEST: &str = r#"#!/usr/bin/env shabang2

{
  "name": "test-tool",
  "platforms": {
    "linux-x86_64": {
      "size": 12345,
      "hash": "sha256",
      "digest": "07380145d2d5de8836bc001d65b82c0ae0a1fa7ff649c7057a0327e98fad9269",
      "format": "zst",
      "path": "test-tool-linux",
      "providers": [
        { "url": "https://example.com/test-tool.zst" }
      ]
    }
  }
}"#;

    #[test]
    fn test_parse_manifest() {
        let manifest = parse_manifest(SAMPLE_MANIFEST).unwrap();
        assert_eq!(manifest.name, "test-tool");
        assert_eq!(manifest.platforms.len(), 1);

        let entry = &manifest.platforms["linux-x86_64"];
        assert_eq!(entry.size, 12345);
        assert_eq!(entry.hash, HashAlgorithm::Sha256);
        assert_eq!(entry.format, ArchiveFormat::Zst);
        assert_eq!(entry.path, "test-tool-linux");
        assert_eq!(entry.providers.len(), 1);
        assert_eq!(entry.providers[0].url, "https://example.com/test-tool.zst");
    }

    #[test]
    fn test_dotslash_compat_shebang() {
        let contents =
            SAMPLE_MANIFEST.replace("#!/usr/bin/env shabang2", "#!/usr/bin/env dotslash");
        let manifest = parse_manifest(&contents).unwrap();
        assert_eq!(manifest.name, "test-tool");
    }

    #[test]
    fn test_bad_shebang() {
        let contents = "#!/usr/bin/env python\n{}";
        let err = parse_manifest(contents).unwrap_err();
        assert!(err.to_string().contains("must start with"));
    }

    #[test]
    fn test_plain_format_default() {
        let contents = r#"#!/usr/bin/env shabang2

{
  "name": "raw",
  "platforms": {
    "linux-x86_64": {
      "size": 100,
      "hash": "blake3",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "path": "my-binary",
      "providers": [{ "url": "https://example.com/raw" }]
    }
  }
}"#;
        let manifest = parse_manifest(contents).unwrap();
        let entry = &manifest.platforms["linux-x86_64"];
        assert_eq!(entry.format, ArchiveFormat::Plain);
    }

    #[test]
    fn test_invalid_digest_length() {
        let contents = r#"#!/usr/bin/env shabang2

{
  "name": "bad",
  "platforms": {
    "linux-x86_64": {
      "size": 100,
      "hash": "sha256",
      "digest": "abc123",
      "path": "bin",
      "providers": [{ "url": "https://example.com/x" }]
    }
  }
}"#;
        let err = parse_manifest(contents).unwrap_err();
        assert!(err.to_string().contains("64 hex characters"));
    }

    #[test]
    fn test_invalid_absolute_path() {
        let contents = r#"#!/usr/bin/env shabang2

{
  "name": "bad",
  "platforms": {
    "linux-x86_64": {
      "size": 100,
      "hash": "sha256",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "path": "/usr/bin/bad",
      "providers": [{ "url": "https://example.com/x" }]
    }
  }
}"#;
        let err = parse_manifest(contents).unwrap_err();
        assert!(err.to_string().contains("relative"));
    }
}
