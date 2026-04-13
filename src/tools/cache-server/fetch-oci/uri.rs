// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Parse `oci://` and `docker://` URIs into registry/repository/digest triples.

use crate::OciFetchError;

/// A digest-pinned OCI reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OciReference {
    /// Registry host, optionally with `:port`. Lower-cased.
    pub registry: String,
    /// Repository path, e.g. `library/alpine` or `distroless/base`.
    pub repository: String,
    /// Content digest, e.g. `sha256:abcd…` (64 lowercase hex chars).
    pub digest: String,
}

/// Returns `true` for `oci://…` or `docker://…` URIs (case-insensitive).
pub fn is_oci_uri(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    lower.starts_with("oci://") || lower.starts_with("docker://")
}

/// Parse an `oci://` or `docker://` URI.
///
/// Format: `{scheme}://{registry}/{repository}@sha256:{64-hex}`.
///
/// `docker.io` is normalized to `registry-1.docker.io`, matching the Docker
/// client's well-known legacy redirect.
pub fn parse_oci_uri(uri: &str) -> Result<OciReference, OciFetchError> {
    let lower = uri.to_ascii_lowercase();
    let rest = if lower.starts_with("oci://") {
        &uri[6..]
    } else if lower.starts_with("docker://") {
        &uri[9..]
    } else {
        return Err(OciFetchError::InvalidUri(format!(
            "unsupported scheme (expected oci:// or docker://): {uri}"
        )));
    };

    let (registry_and_repo, digest) = rest.rsplit_once('@').ok_or_else(|| {
        OciFetchError::UnsupportedReference(format!(
            "reference must be digest-pinned with @sha256:… suffix: {uri}"
        ))
    })?;

    validate_digest(digest)?;

    let (registry, repository) = registry_and_repo
        .split_once('/')
        .ok_or_else(|| OciFetchError::InvalidUri(format!("missing repository path in {uri}")))?;

    if registry.is_empty() {
        return Err(OciFetchError::InvalidUri(format!(
            "empty registry in {uri}"
        )));
    }
    if repository.is_empty() {
        return Err(OciFetchError::InvalidUri(format!(
            "empty repository in {uri}"
        )));
    }

    let registry = normalize_registry(registry);

    Ok(OciReference {
        registry,
        repository: repository.to_string(),
        digest: digest.to_string(),
    })
}

/// Validate that a digest is of the form `sha256:<64-lowercase-hex>` and
/// return the hex portion.
pub fn digest_hex(digest: &str) -> Result<&str, OciFetchError> {
    let (algo, hex) = digest.split_once(':').ok_or_else(|| {
        OciFetchError::UnsupportedReference(format!(
            "digest missing algorithm prefix (expected sha256:…): {digest}"
        ))
    })?;
    if algo != "sha256" {
        return Err(OciFetchError::UnsupportedReference(format!(
            "only sha256 digests are supported, got {algo}"
        )));
    }
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(OciFetchError::UnsupportedReference(format!(
            "sha256 digest must be 64 lowercase hex chars: {digest}"
        )));
    }
    Ok(hex)
}

/// Validate that a digest is well-formed. See [`digest_hex`] for the returning variant.
pub fn validate_digest(digest: &str) -> Result<(), OciFetchError> {
    digest_hex(digest).map(|_| ())
}

fn normalize_registry(registry: &str) -> String {
    let lower = registry.to_ascii_lowercase();
    if lower == "docker.io" {
        "registry-1.docker.io".to_string()
    } else {
        lower
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn is_oci_uri_variants() {
        assert!(is_oci_uri("oci://ghcr.io/foo/bar@sha256:abc"));
        assert!(is_oci_uri("OCI://ghcr.io/foo/bar@sha256:abc"));
        assert!(is_oci_uri("docker://docker.io/foo/bar@sha256:abc"));
        assert!(is_oci_uri("Docker://x"));
        assert!(!is_oci_uri("http://example.com/"));
        assert!(!is_oci_uri(""));
    }

    #[test]
    fn parse_oci_ok() {
        let r = parse_oci_uri(&format!("oci://ghcr.io/foo/bar@{D}")).unwrap();
        assert_eq!(r.registry, "ghcr.io");
        assert_eq!(r.repository, "foo/bar");
        assert_eq!(r.digest, D);
    }

    #[test]
    fn parse_docker_alias() {
        let r = parse_oci_uri(&format!("docker://docker.io/library/alpine@{D}")).unwrap();
        assert_eq!(r.registry, "registry-1.docker.io");
        assert_eq!(r.repository, "library/alpine");
    }

    #[test]
    fn parse_docker_scheme_preserves_host_case() {
        // Registry is lower-cased but repository keeps its case.
        let r = parse_oci_uri(&format!("oci://Example.Com/Foo/Bar@{D}")).unwrap();
        assert_eq!(r.registry, "example.com");
        assert_eq!(r.repository, "Foo/Bar");
    }

    #[test]
    fn parse_with_port() {
        let r = parse_oci_uri(&format!("oci://127.0.0.1:5000/local/img@{D}")).unwrap();
        assert_eq!(r.registry, "127.0.0.1:5000");
        assert_eq!(r.repository, "local/img");
    }

    #[test]
    fn parse_tag_rejected() {
        let err = parse_oci_uri("oci://ghcr.io/foo/bar:latest").unwrap_err();
        assert!(matches!(err, OciFetchError::UnsupportedReference(_)));
    }

    #[test]
    fn parse_missing_scheme() {
        let err = parse_oci_uri(&format!("ghcr.io/foo/bar@{D}")).unwrap_err();
        assert!(matches!(err, OciFetchError::InvalidUri(_)));
    }

    #[test]
    fn parse_missing_repo() {
        let err = parse_oci_uri(&format!("oci://ghcr.io@{D}")).unwrap_err();
        assert!(matches!(err, OciFetchError::InvalidUri(_)));
    }

    #[test]
    fn parse_non_sha256_digest() {
        let err = parse_oci_uri(
            "oci://ghcr.io/foo/bar@sha512:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
        )
        .unwrap_err();
        assert!(matches!(err, OciFetchError::UnsupportedReference(_)));
    }

    #[test]
    fn parse_digest_wrong_length() {
        let err = parse_oci_uri("oci://ghcr.io/foo/bar@sha256:abc").unwrap_err();
        assert!(matches!(err, OciFetchError::UnsupportedReference(_)));
    }

    #[test]
    fn parse_digest_uppercase_rejected() {
        let bad = "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
        let err = parse_oci_uri(&format!("oci://ghcr.io/foo/bar@{bad}")).unwrap_err();
        assert!(matches!(err, OciFetchError::UnsupportedReference(_)));
    }
}
