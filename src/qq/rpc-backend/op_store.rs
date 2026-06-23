// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The RPC [`OpStore`]: operations and views are proxied to the HTTP server.

use std::path::Path;
use std::time::SystemTime;

use async_trait::async_trait;
use jj_lib::backend::BackendInitError;
use jj_lib::backend::BackendLoadError;
use jj_lib::content_hash::blake2b_hash;
use jj_lib::object_id::HexPrefix;
use jj_lib::object_id::ObjectId;
use jj_lib::object_id::PrefixResolution;
use jj_lib::op_store::OpStore;
use jj_lib::op_store::OpStoreError;
use jj_lib::op_store::OpStoreResult;
use jj_lib::op_store::Operation;
use jj_lib::op_store::OperationId;
use jj_lib::op_store::RootOperationData;
use jj_lib::op_store::View;
use jj_lib::op_store::ViewId;
use jj_lib::settings::UserSettings;
use prost::Message as _;
use http::StatusCode;

use crate::http::RpcClient;
use crate::proto;

// BLAKE2b-512 hash lengths, matching jj's simple op store.
const OPERATION_ID_LENGTH: usize = 64;
const VIEW_ID_LENGTH: usize = 64;

/// A jj operation store that proxies operation/view reads and writes to HTTP.
#[derive(Debug)]
pub struct RpcOpStore {
    client: RpcClient,
    root_data: RootOperationData,
    root_operation_id: OperationId,
    root_view_id: ViewId,
}

impl RpcOpStore {
    pub fn name() -> &'static str {
        "rpc_op_store"
    }

    fn new(client: RpcClient, root_data: RootOperationData) -> Self {
        Self {
            client,
            root_data,
            root_operation_id: OperationId::from_bytes(&[0; OPERATION_ID_LENGTH]),
            root_view_id: ViewId::from_bytes(&[0; VIEW_ID_LENGTH]),
        }
    }

    pub fn init(
        _settings: &UserSettings,
        _store_path: &Path,
        root_data: RootOperationData,
    ) -> Result<Self, BackendInitError> {
        let client = RpcClient::from_env().map_err(|err| BackendInitError(err.into()))?;
        Ok(Self::new(client, root_data))
    }

    pub fn load(
        _settings: &UserSettings,
        _store_path: &Path,
        root_data: RootOperationData,
    ) -> Result<Self, BackendLoadError> {
        let client = RpcClient::from_env().map_err(|err| BackendLoadError(err.into()))?;
        Ok(Self::new(client, root_data))
    }
}

fn read_error(
    id: &impl ObjectId,
    err: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> OpStoreError {
    OpStoreError::ReadObject {
        object_type: id.object_type(),
        hash: id.hex(),
        source: err.into(),
    }
}

fn not_found(id: &impl ObjectId) -> OpStoreError {
    OpStoreError::ObjectNotFound {
        object_type: id.object_type(),
        hash: id.hex(),
        source: "object not found on RPC server".into(),
    }
}

fn write_error(
    object_type: &'static str,
    err: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> OpStoreError {
    OpStoreError::WriteObject {
        object_type,
        source: err.into(),
    }
}

/// Combines the server's resolution with the locally-known virtual root
/// operation, which the server doesn't store.
fn combine_root_resolution(
    matches_root: bool,
    root: &OperationId,
    server: PrefixResolution<OperationId>,
) -> PrefixResolution<OperationId> {
    if !matches_root {
        return server;
    }
    match server {
        PrefixResolution::NoMatch => PrefixResolution::SingleMatch(root.clone()),
        PrefixResolution::SingleMatch(_) | PrefixResolution::AmbiguousMatch => {
            PrefixResolution::AmbiguousMatch
        }
    }
}

#[async_trait]
impl OpStore for RpcOpStore {
    fn name(&self) -> &str {
        Self::name()
    }

    fn root_operation_id(&self) -> &OperationId {
        &self.root_operation_id
    }

    async fn read_view(&self, id: &ViewId) -> OpStoreResult<View> {
        if *id == self.root_view_id {
            return Ok(View::make_root(self.root_data.root_commit_id.clone()));
        }
        let body = self
            .client
            .get(&format!("read_view/{}", id.hex()))
            .await
            .map_err(|err| read_error(id, err))?
            .ok_or_else(|| not_found(id))?;
        let proto = jj_lib::protos::simple_op_store::View::decode(&*body)
            .map_err(|err| read_error(id, err))?;
        proto::view_from_proto(proto).map_err(|err| read_error(id, err))
    }

    async fn write_view(&self, view: &View) -> OpStoreResult<ViewId> {
        let proto = proto::view_to_proto(view);
        let id = ViewId::new(blake2b_hash(view).to_vec());
        self.client
            .post(&format!("write_view/{}", id.hex()), proto.encode_to_vec())
            .await
            .map_err(|err| write_error("view", err))?;
        Ok(id)
    }

    async fn read_operation(&self, id: &OperationId) -> OpStoreResult<Operation> {
        if *id == self.root_operation_id {
            return Ok(Operation::make_root(self.root_view_id.clone()));
        }
        let body = self
            .client
            .get(&format!("read_operation/{}", id.hex()))
            .await
            .map_err(|err| read_error(id, err))?
            .ok_or_else(|| not_found(id))?;
        let proto = jj_lib::protos::simple_op_store::Operation::decode(&*body)
            .map_err(|err| read_error(id, err))?;
        let mut operation = proto::operation_from_proto(proto).map_err(|err| read_error(id, err))?;
        if operation.parents.is_empty() {
            operation.parents.push(self.root_operation_id.clone());
        }
        Ok(operation)
    }

    async fn write_operation(&self, operation: &Operation) -> OpStoreResult<OperationId> {
        assert!(!operation.parents.is_empty());
        let proto = proto::operation_to_proto(operation);
        let id = OperationId::new(blake2b_hash(operation).to_vec());
        self.client
            .post(&format!("write_operation/{}", id.hex()), proto.encode_to_vec())
            .await
            .map_err(|err| write_error("operation", err))?;
        Ok(id)
    }

    async fn resolve_operation_id_prefix(
        &self,
        prefix: &HexPrefix,
    ) -> OpStoreResult<PrefixResolution<OperationId>> {
        let matches_root = prefix.matches(&self.root_operation_id);
        let (status, body) = self
            .client
            .get_raw(&format!("resolve_operation_id_prefix/{}", prefix.hex()))
            .await
            .map_err(|err| OpStoreError::Other(Box::new(err)))?;
        let server = match status {
            StatusCode::OK => {
                let hex = String::from_utf8(body)
                    .map_err(|err| OpStoreError::Other(Box::new(err)))?;
                let id = OperationId::try_from_hex(hex.trim()).ok_or_else(|| {
                    OpStoreError::Other("invalid operation id hex from RPC server".into())
                })?;
                PrefixResolution::SingleMatch(id)
            }
            StatusCode::NOT_FOUND => PrefixResolution::NoMatch,
            StatusCode::CONFLICT => PrefixResolution::AmbiguousMatch,
            other => {
                return Err(OpStoreError::Other(
                    format!("unexpected status {other} resolving operation id prefix").into(),
                ));
            }
        };
        Ok(combine_root_resolution(
            matches_root,
            &self.root_operation_id,
            server,
        ))
    }

    async fn gc(&self, _head_ids: &[OperationId], _keep_newer: SystemTime) -> OpStoreResult<()> {
        // The spec server keeps everything; gc is a no-op for this prototype.
        Ok(())
    }
}
