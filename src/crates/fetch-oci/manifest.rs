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

    /// The platform an image config describes, if it says.
    pub fn of_config(config: &[u8]) -> Option<Platform> {
        serde_json::from_slice(config).ok()
    }
}

impl std::str::FromStr for Platform {
    type Err = String;

    /// Parse `os/architecture` or `os/architecture/variant`, as in
    /// `linux/arm64/v8`.
    fn from_str(s: &str) -> Result<Self, String> {
        let parts: Vec<&str> = s.split('/').collect();
        if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty()) {
            return Err(format!(
                "platform {s:?} is not os/architecture or os/architecture/variant"
            ));
        }
        Ok(Platform {
            os: parts[0].to_string(),
            architecture: parts[1].to_string(),
            variant: parts.get(2).map(|v| v.to_string()),
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct ImageIndex {
    pub manifests: Vec<Descriptor>,
}

#[derive(Debug, Deserialize)]
pub struct ImageManifest {
    /// The manifest's own media type; OCI manifests may leave it out.
    #[serde(rename = "mediaType", default)]
    pub media_type: Option<String>,
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

/// Select a manifest from an image index matching the wanted platform: the
/// first that matches, in the index's order.
pub fn select_platform<'a>(
    index: &'a ImageIndex,
    wanted: &Platform,
) -> Result<&'a Descriptor, OciFetchError> {
    let mut available = Vec::new();
    for desc in &index.manifests {
        if let Some(p) = &desc.platform {
            if platform_matches(p, wanted) {
                return Ok(desc);
            }
            available.push(p.display());
        }
    }
    Err(OciFetchError::NoMatchingPlatform {
        wanted: wanted.display(),
        available,
    })
}

pub fn platform_matches(have: &Platform, want: &Platform) -> bool {
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
        assert_eq!(chosen.digest, "sha256:amd64");
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

    #[test]
    fn platforms_parse_with_and_without_variants() {
        assert_eq!("linux/amd64".parse(), Ok(plat("linux", "amd64")));
        assert_eq!(
            "linux/arm64/v8"
                .parse::<Platform>()
                .unwrap()
                .variant
                .as_deref(),
            Some("v8")
        );
        for bad in ["linux", "linux/", "/amd64", "linux/arm/v7/extra", ""] {
            assert!(bad.parse::<Platform>().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_config_names_its_platform() {
        let config = br#"{"architecture":"arm64","os":"linux","variant":"v8","rootfs":{}}"#;
        let platform = Platform::of_config(config).unwrap();
        assert_eq!(platform.display(), "linux/arm64/v8");
        assert_eq!(Platform::of_config(b"{}"), None);
    }
}
