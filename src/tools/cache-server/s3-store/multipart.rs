// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`MultipartUpload`] implementation over S3 multipart uploads.

use std::sync::{Arc, Mutex};

use object_store::path::Path;
use object_store::{MultipartUpload, PutPayload, PutResult, UploadPart};

use crate::client::{S3Client, STORE};

/// An in-progress S3 multipart upload.
///
/// Parts may be uploaded concurrently: each [`put_part`](MultipartUpload)
/// call reserves the next part number immediately and returns a future that
/// performs the actual `UploadPart` request.
#[derive(Debug)]
pub(crate) struct S3MultipartUpload {
    state: Arc<UploadState>,
    part_idx: usize,
}

#[derive(Debug)]
struct UploadState {
    client: Arc<S3Client>,
    location: Path,
    upload_id: String,
    /// ETags of completed parts, indexed by zero-based part index.
    parts: Mutex<Vec<Option<String>>>,
}

impl S3MultipartUpload {
    pub(crate) fn new(client: Arc<S3Client>, location: Path, upload_id: String) -> Self {
        Self {
            state: Arc::new(UploadState {
                client,
                location,
                upload_id,
                parts: Mutex::new(Vec::new()),
            }),
            part_idx: 0,
        }
    }
}

#[async_trait::async_trait]
impl MultipartUpload for S3MultipartUpload {
    fn put_part(&mut self, data: PutPayload) -> UploadPart {
        let idx = self.part_idx;
        self.part_idx += 1;
        let state = Arc::clone(&self.state);
        Box::pin(async move {
            let e_tag = state
                .client
                .put_part(&state.location, &state.upload_id, idx, data)
                .await?;
            let mut parts = state.parts.lock().expect("parts mutex never poisoned");
            if parts.len() <= idx {
                parts.resize(idx + 1, None);
            }
            parts[idx] = Some(e_tag);
            Ok(())
        })
    }

    async fn complete(&mut self) -> object_store::Result<PutResult> {
        let mut part_etags = {
            let parts = self.state.parts.lock().expect("parts mutex never poisoned");
            parts
                .iter()
                .enumerate()
                .map(|(idx, e_tag)| {
                    e_tag.clone().ok_or_else(|| object_store::Error::Generic {
                        store: STORE,
                        source: format!("part {idx} was not uploaded before complete").into(),
                    })
                })
                .collect::<object_store::Result<Vec<_>>>()?
        };
        if part_etags.len() != self.part_idx {
            return Err(object_store::Error::Generic {
                store: STORE,
                source: format!(
                    "{} of {} parts uploaded before complete",
                    part_etags.len(),
                    self.part_idx,
                )
                .into(),
            });
        }

        // completing an upload with zero parts is invalid; upload one empty
        // part so empty multipart writes still produce an (empty) object
        if part_etags.is_empty() {
            let e_tag = self
                .state
                .client
                .put_part(
                    &self.state.location,
                    &self.state.upload_id,
                    0,
                    PutPayload::new(),
                )
                .await?;
            part_etags.push(e_tag);
        }

        self.state
            .client
            .complete_multipart(&self.state.location, &self.state.upload_id, part_etags)
            .await
    }

    async fn abort(&mut self) -> object_store::Result<()> {
        self.state
            .client
            .abort_multipart(&self.state.location, &self.state.upload_id)
            .await
    }
}
