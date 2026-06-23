// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The RPC [`OpHeadsStore`]: the mutable head-operation set lives on the server.

use std::path::Path;

use async_trait::async_trait;
use jj_lib::backend::BackendInitError;
use jj_lib::backend::BackendLoadError;
use jj_lib::object_id::ObjectId;
use jj_lib::op_heads_store::OpHeadsStore;
use jj_lib::op_heads_store::OpHeadsStoreError;
use jj_lib::op_heads_store::OpHeadsStoreLock;
use jj_lib::op_store::OperationId;
use jj_lib::settings::UserSettings;
use pollster::FutureExt as _;

use crate::http::RpcClient;

/// A jj operation-heads store that keeps the head set on the HTTP server.
#[derive(Debug)]
pub struct RpcOpHeadsStore {
    client: RpcClient,
}

impl RpcOpHeadsStore {
    pub fn name() -> &'static str {
        "rpc_op_heads"
    }

    pub fn init(
        _settings: &UserSettings,
        _store_path: &Path,
        root_op_id: &OperationId,
    ) -> Result<Self, BackendInitError> {
        let client = RpcClient::from_env().map_err(|err| BackendInitError(err.into()))?;
        let store = Self { client };
        // Seed the server with the root operation as the initial head.
        store
            .update_op_heads(&[], root_op_id)
            .block_on()
            .map_err(|err| BackendInitError(err.into()))?;
        Ok(store)
    }

    pub fn load(_settings: &UserSettings, _store_path: &Path) -> Result<Self, BackendLoadError> {
        let client = RpcClient::from_env().map_err(|err| BackendLoadError(err.into()))?;
        Ok(Self { client })
    }
}

/// Encodes an update as text: the new head on line 1, old heads to remove after.
fn encode_update(old_ids: &[OperationId], new_id: &OperationId) -> Vec<u8> {
    let mut body = String::new();
    body.push_str(&new_id.hex());
    body.push('\n');
    for old in old_ids {
        body.push_str(&old.hex());
        body.push('\n');
    }
    body.into_bytes()
}

/// A no-op lock: the server is the source of truth for atomicity.
struct RpcOpHeadsStoreLock;
impl OpHeadsStoreLock for RpcOpHeadsStoreLock {}

#[async_trait]
impl OpHeadsStore for RpcOpHeadsStore {
    fn name(&self) -> &str {
        Self::name()
    }

    async fn update_op_heads(
        &self,
        old_ids: &[OperationId],
        new_id: &OperationId,
    ) -> Result<(), OpHeadsStoreError> {
        self.client
            .post("op_heads/update", encode_update(old_ids, new_id))
            .await
            .map_err(|err| OpHeadsStoreError::Write {
                new_op_id: new_id.clone(),
                source: Box::new(err),
            })?;
        Ok(())
    }

    async fn get_op_heads(&self) -> Result<Vec<OperationId>, OpHeadsStoreError> {
        let body = self
            .client
            .get("op_heads")
            .await
            .map_err(|err| OpHeadsStoreError::Read(Box::new(err)))?
            .ok_or_else(|| OpHeadsStoreError::Read("op_heads endpoint returned 404".into()))?;
        let text = String::from_utf8(body).map_err(|err| OpHeadsStoreError::Read(Box::new(err)))?;
        let mut op_heads = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let id = OperationId::try_from_hex(line)
                .ok_or_else(|| OpHeadsStoreError::Read(format!("invalid operation id hex: {line}").into()))?;
            op_heads.push(id);
        }
        op_heads.sort();
        if op_heads.is_empty() {
            Err(OpHeadsStoreError::Read(
                "Corrupt repository: no head operation".into(),
            ))
        } else {
            Ok(op_heads)
        }
    }

    async fn lock(&self) -> Result<Box<dyn OpHeadsStoreLock + '_>, OpHeadsStoreError> {
        Ok(Box::new(RpcOpHeadsStoreLock))
    }
}
