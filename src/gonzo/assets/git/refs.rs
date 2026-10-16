// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git ref discovery: the `/info/refs?service=git-upload-pack` response,
//! protocol v2 `ls-refs`, and ref resolution.
//!
//! # Ref discovery
//!
//! A protocol v0 server answers `GET <repo>/info/refs?service=git-upload-pack`
//! with every ref it has, the first carrying its capabilities after a NUL:
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
//! Asked for protocol v2 (the `Git-Protocol: version=2` header), a server
//! that speaks it answers with its capabilities instead, one per line, and
//! lists refs only when sent an `ls-refs` command:
//!
//! ```text
//! 000eversion 2\n
//! 0022agent=git/github-8f3b8a7d4c\n
//! 0013ls-refs=unborn\n
//! 0027fetch=shallow wait-for-done filter\n
//! 0000
//! ```
//!
//! The service announcement is optional before a v2 advertisement (git's
//! own HTTP backend leaves it out, some hosts send it), and a v1 server
//! prefixes its v0 advertisement with `version 1`.
//!
//! # Ref resolution
//!
//! [`resolve_ref`] maps a user-friendly name to a SHA-1 by trying, in order:
//! exact match, `refs/heads/{name}`, then `refs/tags/{name}`.

use std::collections::HashMap;

use crate::pktline::{self, PktLine, parse_pkt_lines};
use crate::{GitFetchError, parse_object_id};

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/// The protocol a server answered ref discovery in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    /// Protocol v0 (or v1, which differs only in announcing itself).
    V0,
    /// Protocol v2.
    V2,
}

/// Parsed result from a Git smart HTTP ref discovery response.
#[derive(Debug, Clone)]
pub struct RefInfo {
    /// The protocol the server speaks.
    pub protocol: Protocol,
    /// Map of ref name (e.g. `refs/heads/main`) to 20-byte SHA-1 hash. A v2
    /// server lists refs only on request ([`parse_ls_refs`]), so discovery
    /// leaves this empty.
    pub refs: HashMap<String, [u8; 20]>,
    /// Server capabilities: upload-pack's (`ofs-delta`, `shallow`, ...)
    /// under v0, the capability advertisement (`fetch=shallow filter`, ...)
    /// under v2.
    pub capabilities: Vec<String>,
}

/// Longest ref name sent to a server. Git imposes no limit of its own, but
/// a name must fit in a pkt-line, and real ones are far shorter.
const MAX_REF_NAME_LEN: usize = 4096;

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

/// Parse a ref discovery response from `GET /info/refs?service=git-upload-pack`.
///
/// The response is a sequence of pkt-lines:
/// 1. Optionally, a service announcement (`# service=git-upload-pack\n`)
///    and a flush
/// 2. Either `version 2` and the v2 capabilities, one per line, or (after
///    an optional `version 1`) the v0 ref lines:
///    `{sha} {refname}\0{capabilities}\n` first, then `{sha} {refname}\n`
/// 3. Flush
pub fn parse_ref_discovery(data: &[u8]) -> Result<RefInfo, GitFetchError> {
    let pkt_lines = parse_pkt_lines(data)?;

    let mut info = RefInfo {
        protocol: Protocol::V0,
        refs: HashMap::new(),
        capabilities: Vec::new(),
    };
    let mut lines = pkt_lines.iter().peekable();

    // The service announcement and the flush closing it.
    if let Some(PktLine::Data(first)) = lines.peek() {
        if first.starts_with(b"# service=") {
            lines.next();
            if let Some(PktLine::Flush) = lines.peek() {
                lines.next();
            }
        }
    }

    let mut is_first_ref = true;
    for line in lines {
        let payload = match line {
            PktLine::Flush => break,
            PktLine::Delimiter => continue,
            PktLine::Data(payload) => payload,
        };
        let text = text_line(payload, "ref discovery")?;

        if info.protocol == Protocol::V2 {
            info.capabilities.push(text.to_string());
            continue;
        }
        if is_first_ref {
            match text {
                "version 2" => {
                    info.protocol = Protocol::V2;
                    continue;
                }
                "version 1" => continue,
                _ => {}
            }
            // First ref line has capabilities after \0
            let (ref_part, caps_part) = match text.split_once('\0') {
                Some((r, c)) => (r, Some(c)),
                None => (text, None),
            };
            if let Some(caps) = caps_part {
                info.capabilities = caps
                    .split(' ')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
            }
            parse_ref_line(ref_part, &mut info.refs)?;
            is_first_ref = false;
        } else {
            parse_ref_line(text, &mut info.refs)?;
        }
    }

    Ok(info)
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
    let sha = parse_object_id(sha_hex)?;
    refs.insert(refname.to_string(), sha);
    Ok(())
}

/// The value of the v2 capability `name`: `Some("")` for a bare `name`,
/// `Some("a b")` for `name=a b`, `None` when not offered.
pub fn v2_capability<'a>(capabilities: &'a [String], name: &str) -> Option<&'a str> {
    capabilities.iter().find_map(|cap| {
        let rest = cap.strip_prefix(name)?;
        if rest.is_empty() {
            Some("")
        } else {
            rest.strip_prefix('=')
        }
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol v2 ls-refs
// ---------------------------------------------------------------------------------------------------------------

/// Build an `ls-refs` request listing just the refs that [`resolve_ref`]
/// would try for each of `names`.
///
/// ```text
/// command=ls-refs
/// 0001                    ← delimiter
/// ref-prefix <candidate>  ← one per candidate
/// 0000                    ← flush
/// ```
///
/// A name that no ref could have (control characters, spaces, oversized)
/// is refused rather than sent.
pub fn ls_refs_request(names: &[&str]) -> Result<Vec<u8>, GitFetchError> {
    let mut buf = pktline::encode_pkt_line(b"command=ls-refs\n");
    buf.extend_from_slice(pktline::DELIM_PKT);
    for name in names {
        if name.is_empty()
            || name.len() > MAX_REF_NAME_LEN
            || name.bytes().any(|b| b.is_ascii_control() || b == b' ')
        {
            return Err(GitFetchError::RefNotFound(format!(
                "invalid ref name {name:?}"
            )));
        }
        for candidate in ref_candidates(name) {
            let line = format!("ref-prefix {candidate}\n");
            buf.extend_from_slice(&pktline::encode_pkt_line(line.as_bytes()));
        }
    }
    buf.extend_from_slice(pktline::FLUSH_PKT);
    Ok(buf)
}

/// The text of a line of a `what` response, without its newline.
///
/// Servers report failures (missing repo, access denied) as an ERR line,
/// which may appear anywhere in the response: as an error here.
fn text_line<'a>(payload: &'a [u8], what: &str) -> Result<&'a str, GitFetchError> {
    let text = std::str::from_utf8(payload)
        .map_err(|_| GitFetchError::InvalidPackfile(format!("non-UTF8 {what} line")))?
        .trim_end_matches('\n');
    if let Some(msg) = text.strip_prefix("ERR ") {
        return Err(GitFetchError::RequestFailed(format!(
            "remote error: {}",
            msg.trim()
        )));
    }
    Ok(text)
}

/// Parse an `ls-refs` response: `{sha} {refname}[ {attribute}...]` lines
/// ending in a flush.
pub fn parse_ls_refs(data: &[u8]) -> Result<HashMap<String, [u8; 20]>, GitFetchError> {
    let mut refs = HashMap::new();
    for line in parse_pkt_lines(data)? {
        let payload = match line {
            PktLine::Flush => break,
            PktLine::Delimiter => continue,
            PktLine::Data(payload) => payload,
        };
        let text = text_line(&payload, "ls-refs")?;
        // Ref names cannot contain spaces, so attributes (`peeled:<sha>`,
        // `symref-target:<ref>`) follow the next one.
        let end = text
            .match_indices(' ')
            .nth(1)
            .map_or(text.len(), |(i, _)| i);
        parse_ref_line(&text[..end], &mut refs)?;
    }
    Ok(refs)
}

// ---------------------------------------------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------------------------------------------

/// The ref names `name` may stand for, in order of preference.
fn ref_candidates(name: &str) -> [String; 3] {
    [
        name.to_string(),
        format!("refs/heads/{name}"),
        format!("refs/tags/{name}"),
    ]
}

/// Resolve a user-provided ref name to a SHA-1 hash.
///
/// Tries in order:
/// 1. Exact match (e.g. `refs/heads/main`, or `HEAD` itself)
/// 2. `refs/heads/{name}`
/// 3. `refs/tags/{name}`
pub fn resolve_ref(info: &RefInfo, name: &str) -> Option<[u8; 20]> {
    ref_candidates(name)
        .iter()
        .find_map(|candidate| info.refs.get(candidate).copied())
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
            protocol: Protocol::V0,
        };
        assert_eq!(resolve_ref(&info, "refs/heads/main"), Some(sha));
    }

    #[test]
    fn resolve_ref_short_branch_name() {
        let sha = [0xbb; 20];
        let info = RefInfo {
            refs: HashMap::from([("refs/heads/develop".into(), sha)]),
            capabilities: vec![],
            protocol: Protocol::V0,
        };
        assert_eq!(resolve_ref(&info, "develop"), Some(sha));
    }

    #[test]
    fn resolve_ref_short_tag_name() {
        let sha = [0xcc; 20];
        let info = RefInfo {
            refs: HashMap::from([("refs/tags/v2.0".into(), sha)]),
            capabilities: vec![],
            protocol: Protocol::V0,
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
            protocol: Protocol::V0,
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
            protocol: Protocol::V0,
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
            protocol: Protocol::V0,
        };
        assert_eq!(resolve_ref(&info, "nonexistent"), None);
    }

    fn pkt(lines: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        for line in lines {
            match *line {
                "0000" => buf.extend_from_slice(b"0000"),
                "0001" => buf.extend_from_slice(b"0001"),
                text => buf.extend_from_slice(&encode_pkt_line(text.as_bytes())),
            }
        }
        buf
    }

    const SHA: &str = "aabbccddee00112233445566778899aabbccddee";

    #[test]
    fn parse_v2_advertisement_with_and_without_service_line() {
        let caps = [
            "version 2\n",
            "agent=git/2.45\n",
            "ls-refs=unborn\n",
            "fetch=shallow wait-for-done filter\n",
            "0000",
        ];
        let with_service: Vec<&str> = ["# service=git-upload-pack\n", "0000"]
            .into_iter()
            .chain(caps)
            .collect();
        for data in [pkt(&caps), pkt(&with_service)] {
            let info = parse_ref_discovery(&data).unwrap();
            assert_eq!(info.protocol, Protocol::V2);
            assert!(info.refs.is_empty());
            assert_eq!(
                v2_capability(&info.capabilities, "fetch"),
                Some("shallow wait-for-done filter")
            );
            assert_eq!(v2_capability(&info.capabilities, "ls-refs"), Some("unborn"));
            assert_eq!(v2_capability(&info.capabilities, "ls"), None);
            assert_eq!(v2_capability(&info.capabilities, "object-format"), None);
        }
    }

    #[test]
    fn parse_v1_advertisement() {
        let first = format!("{SHA} HEAD\0side-band-64k shallow\n");
        let data = pkt(&[
            "# service=git-upload-pack\n",
            "0000",
            "version 1\n",
            &first,
            "0000",
        ]);
        let info = parse_ref_discovery(&data).unwrap();
        assert_eq!(info.protocol, Protocol::V0);
        assert_eq!(info.capabilities, vec!["side-band-64k", "shallow"]);
        assert_eq!(hex::encode(info.refs["HEAD"]), SHA);
    }

    #[test]
    fn parse_v0_advertisement_without_service_line() {
        let first = format!("{SHA} refs/heads/main\0ofs-delta\n");
        let info = parse_ref_discovery(&pkt(&[&first, "0000"])).unwrap();
        assert_eq!(info.protocol, Protocol::V0);
        assert!(info.refs.contains_key("refs/heads/main"));
    }

    #[test]
    fn ls_refs_request_lists_every_candidate() {
        let request = ls_refs_request(&["HEAD", "main"]).unwrap();
        let lines: Vec<String> = parse_pkt_lines(&request)
            .unwrap()
            .into_iter()
            .map(|l| match l {
                PktLine::Data(d) => String::from_utf8(d.to_vec()).unwrap(),
                PktLine::Flush => "0000".into(),
                PktLine::Delimiter => "0001".into(),
            })
            .collect();
        assert_eq!(
            lines,
            [
                "command=ls-refs\n",
                "0001",
                "ref-prefix HEAD\n",
                "ref-prefix refs/heads/HEAD\n",
                "ref-prefix refs/tags/HEAD\n",
                "ref-prefix main\n",
                "ref-prefix refs/heads/main\n",
                "ref-prefix refs/tags/main\n",
                "0000",
            ]
        );
    }

    #[test]
    fn ls_refs_request_refuses_names_no_ref_could_have() {
        let long = "a".repeat(MAX_REF_NAME_LEN + 1);
        for bad in ["", "a b", "a\nref-prefix refs/", "nul\0", long.as_str()] {
            assert!(
                matches!(ls_refs_request(&[bad]), Err(GitFetchError::RefNotFound(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn parse_ls_refs_drops_attributes() {
        let peeled = format!("{SHA} refs/tags/v1 peeled:{}\n", "11".repeat(20));
        let symref = format!("{} HEAD symref-target:refs/heads/main\n", "22".repeat(20));
        let plain = format!("{} refs/heads/main\n", "22".repeat(20));
        let refs = parse_ls_refs(&pkt(&[&peeled, &symref, &plain, "0000"])).unwrap();
        assert_eq!(hex::encode(refs["refs/tags/v1"]), SHA);
        assert_eq!(refs["HEAD"], [0x22; 20]);
        assert_eq!(refs["refs/heads/main"], [0x22; 20]);
        assert_eq!(refs.len(), 3);
    }

    #[test]
    fn parse_ls_refs_surfaces_errors() {
        let err = parse_ls_refs(&pkt(&["ERR unknown command\n", "0000"])).unwrap_err();
        assert!(err.to_string().contains("unknown command"), "{err}");
        assert!(parse_ls_refs(&pkt(&["not a ref line\n", "0000"])).is_err());
    }
}
