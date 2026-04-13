// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! OCI Image Spec / Docker Distribution manifest parsing and platform selection.

use serde::Deserialize;

use crate::OciFetchError;

pub const MT_OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
pub const MT_OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
pub const MT_DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";
pub const MT_DOCKER_LIST: &str = "application/vnd.docker.distribution.manifest.list.v2+json";
pub const MT_OCI_CONFIG: &str = "application/vnd.oci.image.config.v1+json";
pub const MT_DOCKER_CONFIG: &str = "application/vnd.docker.container.image.v1+json";

/// `Accept` header value for a manifest GET. Lists both OCI and Docker
/// media types so a single request can land on either image manifests or
/// multi-platform indices.
pub const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, \
    application/vnd.oci.image.manifest.v1+json, \
    application/vnd.docker.distribution.manifest.list.v2+json, \
    application/vnd.docker.distribution.manifest.v2+json";

/// `Accept` header for a config blob GET.
pub const CONFIG_ACCEPT: &str =
    "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json";

#[derive(Debug, Clone, Deserialize)]
pub struct Descriptor {
    #[serde(rename = "mediaType", default)]
    pub media_type: String,
    pub digest: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub platform: Option<Platform>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Platform {
    pub os: String,
    pub architecture: String,
    #[serde(default)]
    pub variant: Option<String>,
}

impl Platform {
    pub fn display(&self) -> String {
        match &self.variant {
            Some(v) => format!("{}/{}/{}", self.os, self.architecture, v),
            None => format!("{}/{}", self.os, self.architecture),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ImageIndex {
    pub manifests: Vec<Descriptor>,
}

#[derive(Debug, Deserialize)]
pub struct ImageManifest {
    pub config: Descriptor,
    pub layers: Vec<Descriptor>,
}

/// Parsed manifest body — either an image index or an image manifest.
#[derive(Debug)]
pub enum ParsedManifest {
    Index(ImageIndex),
    Manifest(ImageManifest),
}

/// Parse a manifest JSON body into the correct variant.
///
/// Detection prefers the `mediaType` field (OCI v1), falling back to
/// structural detection via `manifests` vs `layers` for older docs.
pub fn parse_manifest(body: &[u8]) -> Result<ParsedManifest, OciFetchError> {
    #[derive(Deserialize)]
    struct Peek {
        #[serde(rename = "mediaType", default)]
        media_type: Option<String>,
        #[serde(default)]
        manifests: Option<serde_json::Value>,
        #[serde(default)]
        layers: Option<serde_json::Value>,
    }

    let peek: Peek = serde_json::from_slice(body)
        .map_err(|e| OciFetchError::ManifestParse(format!("JSON parse: {e}")))?;

    let is_index = match (
        peek.media_type.as_deref(),
        peek.manifests.is_some(),
        peek.layers.is_some(),
    ) {
        (Some(mt), _, _) if mt == MT_OCI_INDEX || mt == MT_DOCKER_LIST => true,
        (Some(mt), _, _) if mt == MT_OCI_MANIFEST || mt == MT_DOCKER_MANIFEST => false,
        (Some(mt), _, _) => return Err(OciFetchError::UnsupportedMediaType(mt.to_string())),
        (None, true, false) => true,
        (None, false, true) => false,
        (None, true, true) => {
            return Err(OciFetchError::ManifestParse(
                "document has both `manifests` and `layers` arrays".to_string(),
            ));
        }
        (None, false, false) => {
            return Err(OciFetchError::ManifestParse(
                "document has neither `manifests` nor `layers` and no mediaType".to_string(),
            ));
        }
    };

    if is_index {
        let idx = serde_json::from_slice(body)
            .map_err(|e| OciFetchError::ManifestParse(format!("image index: {e}")))?;
        Ok(ParsedManifest::Index(idx))
    } else {
        let m = serde_json::from_slice(body)
            .map_err(|e| OciFetchError::ManifestParse(format!("image manifest: {e}")))?;
        Ok(ParsedManifest::Manifest(m))
    }
}

/// Select a manifest from an image index matching the wanted platform.
///
/// Returns the digest of the chosen manifest.
pub fn select_platform(index: &ImageIndex, wanted: &Platform) -> Result<String, OciFetchError> {
    let mut available = Vec::new();
    for desc in &index.manifests {
        if let Some(p) = &desc.platform {
            if platform_matches(p, wanted) {
                return Ok(desc.digest.clone());
            }
            available.push(p.display());
        }
    }
    Err(OciFetchError::NoMatchingPlatform {
        wanted: wanted.display(),
        available,
    })
}

fn platform_matches(have: &Platform, want: &Platform) -> bool {
    if have.os != want.os || have.architecture != want.architecture {
        return false;
    }
    match (&have.variant, &want.variant) {
        (Some(a), Some(b)) => a == b,
        (None, None) => true,
        // A descriptor without a variant matches any requested variant, and
        // a request without a variant accepts any descriptor variant. This
        // matches containerd's default matcher behavior.
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plat(os: &str, arch: &str) -> Platform {
        Platform {
            os: os.into(),
            architecture: arch.into(),
            variant: None,
        }
    }

    #[test]
    fn detect_index_by_media_type() {
        let body = br#"{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}"#;
        assert!(matches!(
            parse_manifest(body).unwrap(),
            ParsedManifest::Index(_)
        ));
    }

    #[test]
    fn detect_manifest_by_media_type() {
        let body = br#"{"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"digest":"sha256:x"},"layers":[]}"#;
        assert!(matches!(
            parse_manifest(body).unwrap(),
            ParsedManifest::Manifest(_)
        ));
    }

    #[test]
    fn detect_index_by_shape() {
        let body = br#"{"schemaVersion":2,"manifests":[]}"#;
        assert!(matches!(
            parse_manifest(body).unwrap(),
            ParsedManifest::Index(_)
        ));
    }

    #[test]
    fn detect_manifest_by_shape() {
        let body = br#"{"schemaVersion":2,"config":{"digest":"sha256:x"},"layers":[]}"#;
        assert!(matches!(
            parse_manifest(body).unwrap(),
            ParsedManifest::Manifest(_)
        ));
    }

    #[test]
    fn detect_unsupported_media_type() {
        let body = br#"{"mediaType":"application/vnd.oci.artifact.manifest.v1+json"}"#;
        let err = parse_manifest(body).unwrap_err();
        assert!(matches!(err, OciFetchError::UnsupportedMediaType(_)));
    }

    #[test]
    fn select_picks_matching_platform() {
        let idx = ImageIndex {
            manifests: vec![
                Descriptor {
                    media_type: MT_OCI_MANIFEST.into(),
                    digest: "sha256:arm64".into(),
                    size: 100,
                    platform: Some(plat("linux", "arm64")),
                },
                Descriptor {
                    media_type: MT_OCI_MANIFEST.into(),
                    digest: "sha256:amd64".into(),
                    size: 100,
                    platform: Some(plat("linux", "amd64")),
                },
            ],
        };
        let chosen = select_platform(&idx, &plat("linux", "amd64")).unwrap();
        assert_eq!(chosen, "sha256:amd64");
    }

    #[test]
    fn select_no_match_errors() {
        let idx = ImageIndex {
            manifests: vec![Descriptor {
                media_type: MT_OCI_MANIFEST.into(),
                digest: "sha256:arm64".into(),
                size: 100,
                platform: Some(plat("linux", "arm64")),
            }],
        };
        let err = select_platform(&idx, &plat("linux", "amd64")).unwrap_err();
        match err {
            OciFetchError::NoMatchingPlatform { wanted, available } => {
                assert_eq!(wanted, "linux/amd64");
                assert_eq!(available, vec!["linux/arm64".to_string()]);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }
}
