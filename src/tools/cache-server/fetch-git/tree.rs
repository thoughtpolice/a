// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git tree object parsing and commit header extraction.
//!
//! # Tree object binary format
//!
//! A tree object is a directory listing. Its body is a concatenation of
//! entries with no separators between them:
//!
//! ```text
//! ┌──────────────┬────┬──────────┬─────┬──────────────────────┐
//! │ mode (ASCII) │ SP │ filename │ NUL │ SHA-1 (20 raw bytes) │
//! └──────────────┴────┴──────────┴─────┴──────────────────────┘
//! ↑ repeated for each entry
//! ```
//!
//! The mode is a Unix file-mode encoded as an ASCII octal string (without
//! leading zeroes except for the directory mode). Common values:
//!
//! | Mode     | Meaning             | [`GitTreeEntry`] predicate |
//! |----------|---------------------|----------------------------|
//! | `40000`  | Directory (subtree) | [`is_dir()`](GitTreeEntry::is_dir) |
//! | `100644` | Regular file        | _(default)_ |
//! | `100755` | Executable file     | [`is_executable()`](GitTreeEntry::is_executable) |
//! | `120000` | Symbolic link       | [`is_symlink()`](GitTreeEntry::is_symlink) |
//! | `160000` | Gitlink (submodule) | [`is_submodule()`](GitTreeEntry::is_submodule) |
//!
//! The SHA-1 field is the raw 20-byte hash (not hex-encoded) of the object
//! the entry points to: a blob for files/symlinks, another tree for
//! directories, or a commit for submodules.
//!
//! # Commit object format
//!
//! Commit objects are UTF-8 text with a header section and a message body
//! separated by a blank line:
//!
//! ```text
//! tree <40-hex-sha>\n
//! parent <40-hex-sha>\n          ← zero or more
//! author <name> <<email>> <ts> <tz>\n
//! committer <name> <<email>> <ts> <tz>\n
//! \n
//! <commit message>
//! ```
//!
//! [`commit_tree_sha`] extracts the `tree` line to find the root tree SHA-1.

use crate::GitFetchError;

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/// A single entry in a Git tree object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitTreeEntry {
    /// File mode (e.g., 100644, 100755, 40000, 120000, 160000).
    pub mode: u32,
    /// Entry name (file or directory name).
    pub name: String,
    /// 20-byte SHA-1 hash of the referenced object.
    pub sha: [u8; 20],
}

impl GitTreeEntry {
    /// Returns true if this entry is a directory (tree).
    pub fn is_dir(&self) -> bool {
        self.mode == 40000
    }

    /// Returns true if this entry is an executable file.
    pub fn is_executable(&self) -> bool {
        self.mode == 100755
    }

    /// Returns true if this entry is a symlink.
    pub fn is_symlink(&self) -> bool {
        self.mode == 120000
    }

    /// Returns true if this entry is a submodule.
    pub fn is_submodule(&self) -> bool {
        self.mode == 160000
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

/// Parse a Git tree object's data into a list of entries.
pub fn parse_tree(data: &[u8]) -> Result<Vec<GitTreeEntry>, GitFetchError> {
    let mut entries = Vec::new();
    let mut offset = 0;

    while offset < data.len() {
        // Read mode (ASCII digits until space)
        let space_pos = data[offset..]
            .iter()
            .position(|&b| b == b' ')
            .ok_or_else(|| {
                GitFetchError::InvalidPackfile("tree entry missing space after mode".into())
            })?
            + offset;

        let mode_str = std::str::from_utf8(&data[offset..space_pos]).map_err(|_| {
            GitFetchError::InvalidPackfile("tree entry mode is not valid UTF-8".into())
        })?;
        let mode: u32 = mode_str.parse().map_err(|_| {
            GitFetchError::InvalidPackfile(format!("invalid tree entry mode: {mode_str:?}"))
        })?;

        offset = space_pos + 1;

        // Read filename (bytes until NUL)
        let nul_pos = data[offset..].iter().position(|&b| b == 0).ok_or_else(|| {
            GitFetchError::InvalidPackfile("tree entry missing NUL after filename".into())
        })? + offset;

        let name = std::str::from_utf8(&data[offset..nul_pos]).map_err(|_| {
            GitFetchError::InvalidPackfile("tree entry filename is not valid UTF-8".into())
        })?;

        // Git itself never writes these names (fsck rejects them); accepting
        // them from an untrusted pack would let tree entries escape their
        // directory when the tree is materialized as filesystem paths.
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err(GitFetchError::InvalidPackfile(format!(
                "invalid tree entry name: {name:?}"
            )));
        }

        offset = nul_pos + 1;

        // Read 20-byte SHA-1
        if offset + 20 > data.len() {
            return Err(GitFetchError::InvalidPackfile(
                "tree entry truncated: missing SHA-1".into(),
            ));
        }
        let mut sha = [0u8; 20];
        sha.copy_from_slice(&data[offset..offset + 20]);
        offset += 20;

        entries.push(GitTreeEntry {
            mode,
            name: name.to_string(),
            sha,
        });
    }

    Ok(entries)
}

// ---------------------------------------------------------------------------------------------------------------
// Commit parsing helper
// ---------------------------------------------------------------------------------------------------------------

/// Extract the value of `header` from a commit/tag object's header section.
///
/// Headers end at the first blank line; the free-form message after it must
/// not be scanned, or a message line like `tree <sha>` in a malformed object
/// would be mistaken for the header. Operates on bytes because commit bodies
/// need not be UTF-8 (pre-Unicode author names are common in old history).
fn object_header_value<'a>(data: &'a [u8], header: &[u8]) -> Option<&'a [u8]> {
    for line in data.split(|&b| b == b'\n') {
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.strip_prefix(header) {
            if let Some(value) = rest.strip_prefix(b" ") {
                return Some(value);
            }
        }
    }
    None
}

/// Parse a header value as a hex SHA-1, tolerating surrounding whitespace.
fn header_value_sha(value: &[u8], what: &str) -> Result<[u8; 20], GitFetchError> {
    let hex_sha = std::str::from_utf8(value)
        .map_err(|_| GitFetchError::InvalidPackfile(format!("{what} header is not valid hex")))?;
    crate::objects::parse_sha1_hex(hex_sha.trim())
}

/// Extract the tree SHA-1 from a commit object's data.
///
/// Looks for `tree <40-hex-chars>\n` in the commit's header section.
pub fn commit_tree_sha(commit_data: &[u8]) -> Result<[u8; 20], GitFetchError> {
    match object_header_value(commit_data, b"tree") {
        Some(value) => header_value_sha(value, "commit 'tree'"),
        None => Err(GitFetchError::InvalidPackfile(
            "commit object missing 'tree' header".into(),
        )),
    }
}

/// Extract the target object SHA-1 from an annotated tag object's data.
///
/// Looks for `object <40-hex-chars>\n` in the tag's header section.
pub fn tag_target_sha(tag_data: &[u8]) -> Result<[u8; 20], GitFetchError> {
    match object_header_value(tag_data, b"object") {
        Some(value) => header_value_sha(value, "tag 'object'"),
        None => Err(GitFetchError::InvalidPackfile(
            "tag object missing 'object' header".into(),
        )),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a binary tree entry.
    fn make_tree_entry(mode: &str, name: &str, sha: &[u8; 20]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(mode.as_bytes());
        buf.push(b' ');
        buf.extend_from_slice(name.as_bytes());
        buf.push(0);
        buf.extend_from_slice(sha);
        buf
    }

    #[test]
    fn parse_single_file_entry() {
        let sha = [0xAA; 20];
        let data = make_tree_entry("100644", "README.md", &sha);
        let entries = parse_tree(&data).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].mode, 100644);
        assert_eq!(entries[0].name, "README.md");
        assert_eq!(entries[0].sha, sha);
        assert!(!entries[0].is_dir());
        assert!(!entries[0].is_executable());
    }

    #[test]
    fn parse_multiple_entries() {
        let sha1 = [0x11; 20];
        let sha2 = [0x22; 20];
        let sha3 = [0x33; 20];

        let mut data = Vec::new();
        data.extend_from_slice(&make_tree_entry("100644", "file.txt", &sha1));
        data.extend_from_slice(&make_tree_entry("100755", "script.sh", &sha2));
        data.extend_from_slice(&make_tree_entry("40000", "src", &sha3));

        let entries = parse_tree(&data).unwrap();
        assert_eq!(entries.len(), 3);

        assert_eq!(entries[0].mode, 100644);
        assert_eq!(entries[0].name, "file.txt");

        assert_eq!(entries[1].mode, 100755);
        assert!(entries[1].is_executable());

        assert_eq!(entries[2].mode, 40000);
        assert!(entries[2].is_dir());
    }

    #[test]
    fn parse_symlink_entry() {
        let sha = [0x44; 20];
        let data = make_tree_entry("120000", "link", &sha);
        let entries = parse_tree(&data).unwrap();

        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_symlink());
    }

    #[test]
    fn parse_submodule_entry() {
        // Note: tree entry names are single path components; "vendor/lib"
        // would be nested trees, never a literal name.
        let sha = [0x55; 20];
        let data = make_tree_entry("160000", "vendor", &sha);
        let entries = parse_tree(&data).unwrap();

        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_submodule());
    }

    #[test]
    fn parse_empty_tree() {
        let entries = parse_tree(&[]).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_truncated_sha_errors() {
        let mut data = Vec::new();
        data.extend_from_slice(b"100644 file.txt\0");
        data.extend_from_slice(&[0xAA; 10]); // Only 10 bytes, need 20
        assert!(parse_tree(&data).is_err());
    }

    #[test]
    fn parse_rejects_dotdot_name() {
        // "..": materializing this entry would write outside the directory.
        let data = make_tree_entry("40000", "..", &[0xAA; 20]);
        let err = parse_tree(&data).unwrap_err();
        assert!(
            format!("{err}").contains("invalid tree entry name"),
            "{err}"
        );
    }

    #[test]
    fn parse_rejects_dot_name() {
        let data = make_tree_entry("40000", ".", &[0xAA; 20]);
        assert!(parse_tree(&data).is_err());
    }

    #[test]
    fn parse_rejects_empty_name() {
        let data = make_tree_entry("100644", "", &[0xAA; 20]);
        assert!(parse_tree(&data).is_err());
    }

    #[test]
    fn parse_rejects_name_with_slash() {
        let data = make_tree_entry("100644", "a/b", &[0xAA; 20]);
        assert!(parse_tree(&data).is_err());
    }

    #[test]
    fn parse_accepts_dot_prefixed_names() {
        // Only exactly "." and ".." are special; dotfiles and "..." are fine.
        let sha = [0xAA; 20];
        let mut data = Vec::new();
        data.extend_from_slice(&make_tree_entry("100644", ".gitignore", &sha));
        data.extend_from_slice(&make_tree_entry("100644", "...", &sha));
        data.extend_from_slice(&make_tree_entry("100644", "..a", &sha));
        let entries = parse_tree(&data).unwrap();
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn commit_tree_sha_basic() {
        let commit = b"tree aabbccddee00112233445566778899aabbccddee\nparent 0000000000000000000000000000000000000000\nauthor Test <test> 0 +0000\ncommitter Test <test> 0 +0000\n\ntest\n";
        let sha = commit_tree_sha(commit).unwrap();
        assert_eq!(hex::encode(sha), "aabbccddee00112233445566778899aabbccddee");
    }

    #[test]
    fn commit_tree_sha_missing_tree_errors() {
        let commit = b"parent 0000000000000000000000000000000000000000\nauthor Test <test> 0 +0000\n\nno tree\n";
        assert!(commit_tree_sha(commit).is_err());
    }

    #[test]
    fn commit_tree_sha_ignores_message_body() {
        // No tree header, but the message body mentions one. The body must
        // not be scanned.
        let commit = b"parent 0000000000000000000000000000000000000000\nauthor T <t> 0 +0000\n\ntree aabbccddee00112233445566778899aabbccddee\n";
        assert!(commit_tree_sha(commit).is_err());
    }

    #[test]
    fn commit_tree_sha_non_utf8_body() {
        // Latin-1 author names are common in pre-Unicode history; the tree
        // header must still parse.
        let mut commit = Vec::new();
        commit.extend_from_slice(b"tree aabbccddee00112233445566778899aabbccddee\n");
        commit.extend_from_slice(b"author J\xF6rg <j> 0 +0000\n\nm\xE9ssage\n");
        let sha = commit_tree_sha(&commit).unwrap();
        assert_eq!(hex::encode(sha), "aabbccddee00112233445566778899aabbccddee");
    }

    #[test]
    fn commit_treeish_header_not_confused_for_tree() {
        // A header named "treeish" must not match "tree".
        let commit = b"treeish aabbccddee00112233445566778899aabbccddee\n\nmsg\n";
        assert!(commit_tree_sha(commit).is_err());
    }

    #[test]
    fn tag_target_sha_ignores_message_body() {
        let tag = b"type commit\ntag v1\n\nobject aabbccddee00112233445566778899aabbccddee\n";
        assert!(tag_target_sha(tag).is_err());
    }

    #[test]
    fn tag_target_sha_basic() {
        let tag = b"object aabbccddee00112233445566778899aabbccddee\ntype commit\ntag v1\ntagger T <t> 0 +0000\n\nmsg\n";
        let sha = tag_target_sha(tag).unwrap();
        assert_eq!(hex::encode(sha), "aabbccddee00112233445566778899aabbccddee");
    }

    #[test]
    fn entry_with_special_chars_in_name() {
        let sha = [0xBB; 20];
        let data = make_tree_entry("100644", "file with spaces.txt", &sha);
        let entries = parse_tree(&data).unwrap();
        assert_eq!(entries[0].name, "file with spaces.txt");
    }

    #[test]
    fn entry_with_dotfiles() {
        let sha = [0xCC; 20];
        let mut data = Vec::new();
        data.extend_from_slice(&make_tree_entry("100644", ".gitignore", &sha));
        data.extend_from_slice(&make_tree_entry("100644", ".editorconfig", &sha));
        let entries = parse_tree(&data).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, ".gitignore");
        assert_eq!(entries[1].name, ".editorconfig");
    }
}
