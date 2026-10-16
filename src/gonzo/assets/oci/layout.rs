// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Lay out a resolved image as an OCI Image Layout.
//!
//! The layout follows the OCI Image Layout spec v1.0.0:
//!
//! ```text
//! oci-layout             -> {"imageLayoutVersion":"1.0.0"}
//! index.json             -> top-level index pointing at the single manifest
//! blobs/sha256/<hex>     -> raw bytes for manifest, config, and each layer
//! ```

use std::collections::HashSet;

use bytes::Bytes;

use crate::manifest::Descriptor;

/// A single file in an OCI Image Layout whose contents are at hand.
#[derive(Debug, Clone)]
pub struct OciFile {
    /// Layout-relative path, e.g. `oci-layout`, `index.json`, `blobs/sha256/<hex>`.
    pub path: String,
    /// Raw contents.
    pub data: Bytes,
}

/// A fetched blob ready to be placed under `blobs/sha256/…`.
#[derive(Debug, Clone)]
pub struct OciBlob {
    /// Full digest, e.g. `sha256:abcd…`.
    pub digest: String,
    /// Media type from the descriptor.
    pub media_type: String,
    /// Raw bytes. Size is `data.len()`.
    pub data: Bytes,
}

/// An image's OCI Image Layout: the files already fetched, and the layers
/// still to download into it.
#[derive(Debug)]
pub struct OciLayout {
    /// `oci-layout`, `index.json`, and the manifest and config under
    /// `blobs/`, in path order.
    pub files: Vec<OciFile>,
    /// The layers, each to be downloaded to [`blob_path`] of its digest:
    /// one per digest, none that is already among `files`.
    pub layers: Vec<Descriptor>,
}

/// Where the blob `digest` (`sha256:<hex>`, already validated) lives in a
/// layout.
pub fn blob_path(digest: &str) -> String {
    let hex = crate::uri::digest_hex(digest).unwrap_or(digest);
    format!("blobs/sha256/{hex}")
}

/// Lay out the image `manifest` describes: its config and layers, under an
/// `index.json` that names the manifest as `ref_name`.
pub fn build_layout(
    ref_name: &str,
    manifest: &OciBlob,
    config: &OciBlob,
    layers: &[Descriptor],
) -> OciLayout {
    let mut files = Vec::with_capacity(4);

    files.push(OciFile {
        path: "oci-layout".to_string(),
        data: Bytes::from_static(br#"{"imageLayoutVersion":"1.0.0"}"#),
    });

    let index_json = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": manifest.media_type,
            "digest": manifest.digest,
            "size": manifest.data.len(),
            "annotations": {
                "org.opencontainers.image.ref.name": ref_name,
            },
        }],
    });
    files.push(OciFile {
        path: "index.json".to_string(),
        data: Bytes::from(serde_json::to_vec(&index_json).expect("json serialize")),
    });

    let mut blobs = vec![blob_file(manifest), blob_file(config)];
    blobs.sort_by(|a, b| a.path.cmp(&b.path));
    blobs.dedup_by(|a, b| a.path == b.path);
    files.extend(blobs);

    // A layout names a blob once, however many descriptors use it (an empty
    // layer, say, may appear more than once).
    let mut seen: HashSet<&str> = [manifest.digest.as_str(), config.digest.as_str()].into();
    let layers = layers
        .iter()
        .filter(|layer| seen.insert(layer.digest.as_str()))
        .cloned()
        .collect();

    OciLayout { files, layers }
}

fn blob_file(blob: &OciBlob) -> OciFile {
    OciFile {
        path: blob_path(&blob.digest),
        data: blob.data.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(digest: &str, mt: &str, data: &'static [u8]) -> OciBlob {
        OciBlob {
            digest: digest.to_string(),
            media_type: mt.to_string(),
            data: Bytes::from_static(data),
        }
    }

    fn layer(digest: &str) -> Descriptor {
        Descriptor {
            media_type: "application/vnd.oci.image.layer.v1.tar+gzip".to_string(),
            digest: digest.to_string(),
            size: 11,
            platform: None,
        }
    }

    const M: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const C: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const L: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

    fn manifest() -> OciBlob {
        blob(M, "application/vnd.oci.image.manifest.v1+json", b"{}")
    }

    fn config() -> OciBlob {
        blob(C, "application/vnd.oci.image.config.v1+json", b"{}")
    }

    #[test]
    fn layout_has_layout_and_index_first() {
        let layout = build_layout(
            "oci://reg/repo@sha256:1111",
            &manifest(),
            &config(),
            &[layer(L)],
        );

        let paths: Vec<&str> = layout.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "oci-layout",
                "index.json",
                &blob_path(M)[..],
                &blob_path(C)[..],
            ]
        );
        assert_eq!(layout.layers.len(), 1);
        assert_eq!(blob_path(L), format!("blobs/sha256/{}", &L[7..]));
    }

    #[test]
    fn index_references_manifest() {
        let layout = build_layout("oci://reg/repo@sha256:abcdef", &manifest(), &config(), &[]);
        let index = layout
            .files
            .iter()
            .find(|f| f.path == "index.json")
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&index.data).unwrap();
        assert_eq!(parsed["manifests"][0]["digest"], M);
        assert_eq!(
            parsed["manifests"][0]["annotations"]["org.opencontainers.image.ref.name"],
            "oci://reg/repo@sha256:abcdef"
        );
    }

    #[test]
    fn oci_layout_file_is_spec_compliant() {
        let layout = build_layout("oci://reg/repo@sha256:x", &manifest(), &config(), &[]);
        let file = layout
            .files
            .iter()
            .find(|f| f.path == "oci-layout")
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&file.data).unwrap();
        assert_eq!(parsed["imageLayoutVersion"], "1.0.0");
    }

    #[test]
    fn each_blob_is_laid_out_once() {
        // A layer repeated, and one that is the config's own bytes.
        let layout = build_layout(
            "oci://reg/repo@sha256:x",
            &manifest(),
            &config(),
            &[layer(L), layer(C), layer(L)],
        );
        assert_eq!(layout.files.len(), 4);
        let layers: Vec<&str> = layout.layers.iter().map(|l| l.digest.as_str()).collect();
        assert_eq!(layers, [L]);
    }
}
