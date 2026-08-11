// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git ref discovery: parsing the `/info/refs?service=git-upload-pack` response.
//!
//! # Smart HTTP ref discovery
//!
//! When a client sends `GET <repo>/info/refs?service=git-upload-pack`, the
//! server responds with a pkt-line encoded list of all advertised refs and
//! the server's capabilities:
//!
//! ```text
//! 001e# service=git-upload-pack\n
//! 0000                                          ← flush (end of service announcement)
//! 00a0<sha-1> HEAD\0multi_ack_detailed side-band-64k ofs-delta shallow\n
//! 003f<sha-1> refs/heads/main\n
//! 003e<sha-1> refs/tags/v1.0\n
//! 0000                                          ← flush (end of ref listing)
//! ```
//!
//! Key details:
//!
//! - The first data line after the flush is special: it carries the server's
//!   capabilities after a NUL (`\0`) byte.
//! - All subsequent ref lines are plain `{sha} {refname}\n`.
//! - SHA-1 hashes are always lowercase 40-character hex strings.
//! - The service line and the ref list are separated by a flush packet.
//!
//! # Ref resolution
//!
//! [`resolve_ref`] maps a user-friendly name to a SHA-1 by trying, in order:
//! exact match, `refs/heads/{name}`, `refs/tags/{name}`, then `HEAD`.

use std::collections::HashMap;

use crate::GitFetchError;
use crate::objects::parse_sha1_hex;
use crate::pktline::{PktLine, parse_pkt_lines};

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/// Parsed result from a Git smart HTTP ref discovery response.
#[derive(Debug, Clone)]
pub struct RefInfo {
    /// Map of ref name (e.g. `refs/heads/main`) to 20-byte SHA-1 hash.
    pub refs: HashMap<String, [u8; 20]>,
    /// Server capabilities advertised in the first ref line.
    pub capabilities: Vec<String>,
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

/// Parse a ref discovery response from `GET /info/refs?service=git-upload-pack`.
///
/// The response is a sequence of pkt-lines:
/// 1. Service announcement: `# service=git-upload-pack\n`
/// 2. Flush
/// 3. First ref line: `{sha} {refname}\0{capabilities}\n`
/// 4. Subsequent ref lines: `{sha} {refname}\n`
/// 5. Flush
pub fn parse_ref_discovery(data: &[u8]) -> Result<RefInfo, GitFetchError> {
    let pkt_lines = parse_pkt_lines(data)?;

    let mut refs = HashMap::new();
    let mut capabilities = Vec::new();
    let mut seen_service_line = false;
    let mut seen_first_flush = false;
    let mut is_first_ref = true;

    for line in &pkt_lines {
        match line {
            PktLine::Flush => {
                if !seen_first_flush {
                    seen_first_flush = true;
                } else {
                    break;
                }
            }
            PktLine::Delimiter => {}
            PktLine::Data(payload) => {
                let text = std::str::from_utf8(payload).map_err(|_| {
                    GitFetchError::InvalidPackfile("non-UTF8 ref discovery line".into())
                })?;
                let text = text.trim_end_matches('\n');

                // Servers report failures (missing repo, access denied) as an
                // ERR line, which may appear anywhere in the response.
                if let Some(msg) = text.strip_prefix("ERR ") {
                    return Err(GitFetchError::RequestFailed(format!(
                        "remote error: {}",
                        msg.trim()
                    )));
                }

                // Skip the service announcement line
                if text.starts_with("# service=") {
                    seen_service_line = true;
                    continue;
                }

                // Don't parse ref lines until after the service line + flush
                if !seen_service_line || !seen_first_flush {
                    continue;
                }

                if is_first_ref {
                    // First ref line has capabilities after \0
                    let (ref_part, caps_part) = if let Some(idx) = text.find('\0') {
                        (&text[..idx], Some(&text[idx + 1..]))
                    } else {
                        (text, None)
                    };

                    if let Some(caps) = caps_part {
                        capabilities = caps
                            .split(' ')
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .collect();
                    }

                    parse_ref_line(ref_part, &mut refs)?;
                    is_first_ref = false;
                } else {
                    parse_ref_line(text, &mut refs)?;
                }
            }
        }
    }

    Ok(RefInfo { refs, capabilities })
}

/// Parse a single ref line: `{40-char-hex-sha} {refname}`.
fn parse_ref_line(line: &str, refs: &mut HashMap<String, [u8; 20]>) -> Result<(), GitFetchError> {
    if line.len() < 42 {
        return Err(GitFetchError::InvalidPackfile(format!(
            "ref line too short: {line:?}"
        )));
    }
    // Check the separator byte before slicing: byte 40 being ASCII space
    // guarantees both 40 and 41 are char boundaries, so the slices below
    // cannot panic even when the server sends multi-byte UTF-8.
    if line.as_bytes()[40] != b' ' {
        return Err(GitFetchError::InvalidPackfile(format!(
            "expected space after SHA in ref line: {line:?}"
        )));
    }
    let sha_hex = &line[..40];
    let refname = &line[41..];
    let sha = parse_sha1_hex(sha_hex)?;
    refs.insert(refname.to_string(), sha);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------------------------------------------

/// Resolve a user-provided ref name to a SHA-1 hash.
///
/// Tries in order:
/// 1. Exact match (e.g. `refs/heads/main`, or `HEAD` itself)
/// 2. `refs/heads/{name}`
/// 3. `refs/tags/{name}`
pub fn resolve_ref(info: &RefInfo, name: &str) -> Option<[u8; 20]> {
    // Exact match
    if let Some(sha) = info.refs.get(name) {
        return Some(*sha);
    }
    // Try as branch
    if let Some(sha) = info.refs.get(&format!("refs/heads/{name}")) {
        return Some(*sha);
    }
    // Try as tag
    if let Some(sha) = info.refs.get(&format!("refs/tags/{name}")) {
        return Some(*sha);
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pktline::encode_pkt_line;

    fn build_ref_discovery(refs_list: &[(&str, &str)], caps: &str) -> Vec<u8> {
        let mut buf = Vec::new();

        // Service announcement
        buf.extend_from_slice(&encode_pkt_line(b"# service=git-upload-pack\n"));
        buf.extend_from_slice(b"0000"); // flush

        // First ref with capabilities
        if let Some((first_ref_name, first_sha)) = refs_list.first() {
            let line = format!("{first_sha} {first_ref_name}\0{caps}\n");
            buf.extend_from_slice(&encode_pkt_line(line.as_bytes()));
        }

        // Subsequent refs
        for (ref_name, ref_sha) in refs_list.iter().skip(1) {
            let line = format!("{ref_sha} {ref_name}\n");
            buf.extend_from_slice(&encode_pkt_line(line.as_bytes()));
        }

        buf.extend_from_slice(b"0000"); // flush
        buf
    }

    #[test]
    fn parse_basic_ref_discovery() {
        let sha = "aabbccddee00112233445566778899aabbccddee";
        let data = build_ref_discovery(
            &[("HEAD", sha), ("refs/heads/main", sha)],
            "multi_ack_detailed side-band-64k ofs-delta shallow",
        );

        let info = parse_ref_discovery(&data).unwrap();
        assert_eq!(info.refs.len(), 2);
        assert!(info.refs.contains_key("HEAD"));
        assert!(info.refs.contains_key("refs/heads/main"));
        assert_eq!(
            info.capabilities,
            vec![
                "multi_ack_detailed",
                "side-band-64k",
                "ofs-delta",
                "shallow",
            ]
        );
    }

    #[test]
    fn parse_single_ref_with_capabilities() {
        let sha = "0000000000000000000000000000000000000000";
        let data = build_ref_discovery(&[("HEAD", sha)], "agent=git/2.0");

        let info = parse_ref_discovery(&data).unwrap();
        assert_eq!(info.refs.len(), 1);
        assert!(info.refs.contains_key("HEAD"));
        assert_eq!(info.capabilities, vec!["agent=git/2.0"]);
    }

    #[test]
    fn parse_multiple_refs() {
        let sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let sha3 = "cccccccccccccccccccccccccccccccccccccccc";
        let data = build_ref_discovery(
            &[
                ("HEAD", sha1),
                ("refs/heads/main", sha2),
                ("refs/tags/v1.0", sha3),
            ],
            "caps",
        );

        let info = parse_ref_discovery(&data).unwrap();
        assert_eq!(info.refs.len(), 3);
        assert_eq!(hex::encode(info.refs["HEAD"]), sha1);
        assert_eq!(hex::encode(info.refs["refs/heads/main"]), sha2);
        assert_eq!(hex::encode(info.refs["refs/tags/v1.0"]), sha3);
    }

    #[test]
    fn resolve_ref_exact_match() {
        let sha = [0xaa; 20];
        let info = RefInfo {
            refs: HashMap::from([("refs/heads/main".into(), sha)]),
            capabilities: vec![],
        };
        assert_eq!(resolve_ref(&info, "refs/heads/main"), Some(sha));
    }

    #[test]
    fn resolve_ref_short_branch_name() {
        let sha = [0xbb; 20];
        let info = RefInfo {
            refs: HashMap::from([("refs/heads/develop".into(), sha)]),
            capabilities: vec![],
        };
        assert_eq!(resolve_ref(&info, "develop"), Some(sha));
    }

    #[test]
    fn resolve_ref_short_tag_name() {
        let sha = [0xcc; 20];
        let info = RefInfo {
            refs: HashMap::from([("refs/tags/v2.0".into(), sha)]),
            capabilities: vec![],
        };
        assert_eq!(resolve_ref(&info, "v2.0"), Some(sha));
    }

    #[test]
    fn resolve_ref_branch_preferred_over_tag() {
        let branch_sha = [0x11; 20];
        let tag_sha = [0x22; 20];
        let info = RefInfo {
            refs: HashMap::from([
                ("refs/heads/release".into(), branch_sha),
                ("refs/tags/release".into(), tag_sha),
            ]),
            capabilities: vec![],
        };
        // Branch should win
        assert_eq!(resolve_ref(&info, "release"), Some(branch_sha));
    }

    #[test]
    fn resolve_ref_head_fallback() {
        let sha = [0xdd; 20];
        let info = RefInfo {
            refs: HashMap::from([("HEAD".into(), sha)]),
            capabilities: vec![],
        };
        assert_eq!(resolve_ref(&info, "HEAD"), Some(sha));
    }

    #[test]
    fn parse_err_line_surfaces_message() {
        // A server that rejects the request sends "ERR <msg>" instead of a
        // ref advertisement (it may appear before the service line).
        let mut buf = Vec::new();
        buf.extend_from_slice(&encode_pkt_line(
            b"ERR access denied or repository not exported\n",
        ));
        buf.extend_from_slice(b"0000");
        let err = parse_ref_discovery(&buf).unwrap_err();
        assert!(format!("{err}").contains("access denied"), "{err}");
    }

    #[test]
    fn parse_err_line_after_service_announcement() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&encode_pkt_line(b"# service=git-upload-pack\n"));
        buf.extend_from_slice(b"0000");
        buf.extend_from_slice(&encode_pkt_line(b"ERR repository not found\n"));
        buf.extend_from_slice(b"0000");
        let err = parse_ref_discovery(&buf).unwrap_err();
        assert!(format!("{err}").contains("repository not found"), "{err}");
    }

    #[test]
    fn parse_ref_line_multibyte_utf8_no_panic() {
        // 39 ASCII bytes then a 2-byte UTF-8 char straddling byte index 40:
        // slicing at 40 would panic on a non-char-boundary. Must error.
        let mut refs = HashMap::new();
        let line = format!("{}é more", "a".repeat(39));
        assert_eq!(line.as_bytes().len(), 39 + 2 + 5);
        let err = parse_ref_line(&line, &mut refs).unwrap_err();
        assert!(format!("{err}").contains("expected space"), "{err}");
    }

    #[test]
    fn parse_ref_line_multibyte_utf8_refname() {
        // Non-ASCII is fine in the refname part.
        let mut refs = HashMap::new();
        let sha = "aabbccddee00112233445566778899aabbccddee";
        parse_ref_line(&format!("{sha} refs/heads/día"), &mut refs).unwrap();
        assert!(refs.contains_key("refs/heads/día"));
    }

    #[test]
    fn parse_ref_discovery_multibyte_line_no_panic() {
        // Same panic scenario driven through the public entry point.
        let mut buf = Vec::new();
        buf.extend_from_slice(&encode_pkt_line(b"# service=git-upload-pack\n"));
        buf.extend_from_slice(b"0000");
        let line = format!("{}é 0123456789\n", "a".repeat(39));
        buf.extend_from_slice(&encode_pkt_line(line.as_bytes()));
        buf.extend_from_slice(b"0000");
        assert!(parse_ref_discovery(&buf).is_err());
    }

    #[test]
    fn resolve_ref_not_found() {
        let info = RefInfo {
            refs: HashMap::from([("refs/heads/main".into(), [0; 20])]),
            capabilities: vec![],
        };
        assert_eq!(resolve_ref(&info, "nonexistent"), None);
    }
}
