// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Assemble an OCI Image Layout from fetched blobs.
//!
//! The layout follows the OCI Image Layout spec v1.0.0:
//!
//! ```text
//! oci-layout             -> {"imageLayoutVersion":"1.0.0"}
//! index.json             -> top-level index pointing at the single manifest
//! blobs/sha256/<hex>     -> raw bytes for manifest, config, and each layer
//! ```

use bytes::Bytes;

/// A single file in the produced OCI Image Layout.
#[derive(Debug, Clone)]
pub struct OciFile {
    /// Layout-relative path, e.g. `oci-layout`, `index.json`, `blobs/sha256/<hex>`.
    pub path: String,
    /// Raw contents.
    pub data: Bytes,
}

/// The complete OCI Image Layout produced by `fetch_oci_image`.
#[derive(Debug)]
pub struct OciImageFetch {
    /// Every file in the layout, in deterministic order.
    pub files: Vec<OciFile>,
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

/// Build an OCI Image Layout from the fetched manifest, config, and layers.
pub fn build_layout(
    original_uri: &str,
    manifest: OciBlob,
    config: OciBlob,
    layers: Vec<OciBlob>,
) -> OciImageFetch {
    let mut files = Vec::with_capacity(3 + 1 + layers.len());

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
                "org.opencontainers.image.ref.name": original_uri,
            },
        }],
    });
    files.push(OciFile {
        path: "index.json".to_string(),
        data: Bytes::from(serde_json::to_vec(&index_json).expect("json serialize")),
    });

    let mut blob_files = Vec::with_capacity(1 + 1 + layers.len());
    blob_files.push(blob_to_file(&manifest));
    blob_files.push(blob_to_file(&config));
    for l in &layers {
        blob_files.push(blob_to_file(l));
    }
    blob_files.sort_by(|a, b| a.path.cmp(&b.path));
    files.extend(blob_files);

    OciImageFetch { files }
}

fn blob_to_file(blob: &OciBlob) -> OciFile {
    let hex = crate::uri::digest_hex(&blob.digest).unwrap_or(&blob.digest);
    OciFile {
        path: format!("blobs/sha256/{hex}"),
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

    #[test]
    fn layout_has_layout_and_index_first() {
        let m = blob(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "application/vnd.oci.image.manifest.v1+json",
            b"{}",
        );
        let c = blob(
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            "application/vnd.oci.image.config.v1+json",
            b"{}",
        );
        let l = blob(
            "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            "application/vnd.oci.image.layer.v1.tar+gzip",
            b"layer-bytes",
        );
        let fetch = build_layout("oci://reg/repo@sha256:1111", m, c, vec![l]);

        assert_eq!(fetch.files[0].path, "oci-layout");
        assert_eq!(fetch.files[1].path, "index.json");
        // Remaining files are blobs/sha256/<hex> sorted by path.
        for f in &fetch.files[2..] {
            assert!(f.path.starts_with("blobs/sha256/"));
        }
        assert_eq!(fetch.files.len(), 5);
    }

    #[test]
    fn index_references_manifest() {
        let m = blob(
            "sha256:abcdef0000000000000000000000000000000000000000000000000000000000",
            "application/vnd.oci.image.manifest.v1+json",
            b"{}",
        );
        let c = blob(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "application/vnd.oci.image.config.v1+json",
            b"{}",
        );
        let fetch = build_layout("oci://reg/repo@sha256:abcdef", m, c, vec![]);
        let index = fetch.files.iter().find(|f| f.path == "index.json").unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&index.data).unwrap();
        assert_eq!(
            parsed["manifests"][0]["digest"],
            "sha256:abcdef0000000000000000000000000000000000000000000000000000000000"
        );
        assert_eq!(
            parsed["manifests"][0]["annotations"]["org.opencontainers.image.ref.name"],
            "oci://reg/repo@sha256:abcdef"
        );
    }

    #[test]
    fn oci_layout_file_is_spec_compliant() {
        let m = blob(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "application/vnd.oci.image.manifest.v1+json",
            b"{}",
        );
        let c = blob(
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            "application/vnd.oci.image.config.v1+json",
            b"{}",
        );
        let fetch = build_layout("oci://reg/repo@sha256:x", m, c, vec![]);
        let layout = fetch.files.iter().find(|f| f.path == "oci-layout").unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&layout.data).unwrap();
        assert_eq!(parsed["imageLayoutVersion"], "1.0.0");
    }
}
