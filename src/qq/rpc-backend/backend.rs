// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The RPC commit [`Backend`]: every object read/write becomes one HTTP call.

use std::path::Path;
use std::pin::Pin;
use std::time::SystemTime;

use async_trait::async_trait;
use futures::AsyncRead;
use futures::AsyncReadExt as _;
use futures::StreamExt as _;
use futures::stream;
use futures::stream::BoxStream;
use jj_lib::backend::Backend;
use jj_lib::backend::BackendError;
use jj_lib::backend::BackendInitError;
use jj_lib::backend::BackendLoadError;
use jj_lib::backend::BackendResult;
use jj_lib::backend::ChangeId;
use jj_lib::backend::Commit;
use jj_lib::backend::CommitId;
use jj_lib::backend::CopyHistory;
use jj_lib::backend::CopyId;
use jj_lib::backend::CopyRecord;
use jj_lib::backend::FileId;
use jj_lib::backend::RelatedCopy;
use jj_lib::backend::SecureSig;
use jj_lib::backend::SigningFn;
use jj_lib::backend::SymlinkId;
use jj_lib::backend::Tree;
use jj_lib::backend::TreeId;
use jj_lib::backend::make_root_commit;
use jj_lib::content_hash::blake2b_hash;
use jj_lib::index::Index;
use jj_lib::object_id::ObjectId;
use jj_lib::repo_path::RepoPath;
use jj_lib::repo_path::RepoPathBuf;
use jj_lib::settings::UserSettings;
use prost::Message as _;

use crate::http::RpcClient;
use crate::http::RpcError;
use crate::proto;

// BLAKE2b-512 hash lengths, matching jj's simple backend.
const COMMIT_ID_LENGTH: usize = 64;
const CHANGE_ID_LENGTH: usize = 16;
// BLAKE2b-512 hash of the empty tree, identical to jj's simple backend.
const EMPTY_TREE_ID_HEX: &str = "482ae5a29fbe856c7272f2071b8b0f0359ee2d89ff392b8a900643fbd0836eccd0\
67b8bf41909e206c90d45d6e7d8b6686b93ecaee5fe1a9060d87b672101310";

/// A jj commit backend that proxies every object read/write to an HTTP server.
#[derive(Debug)]
pub struct RpcBackend {
    client: RpcClient,
    root_commit_id: CommitId,
    root_change_id: ChangeId,
    empty_tree_id: TreeId,
}

impl RpcBackend {
    pub fn name() -> &'static str {
        "rpc"
    }

    fn new(client: RpcClient) -> Self {
        Self {
            client,
            root_commit_id: CommitId::from_bytes(&[0; COMMIT_ID_LENGTH]),
            root_change_id: ChangeId::from_bytes(&[0; CHANGE_ID_LENGTH]),
            empty_tree_id: TreeId::from_hex(EMPTY_TREE_ID_HEX),
        }
    }

    /// Creates a backend for a new repo. There is nothing to provision locally;
    /// the empty tree is served virtually by [`RpcBackend::read_tree`].
    pub fn init(_settings: &UserSettings, _store_path: &Path) -> Result<Self, BackendInitError> {
        let client = RpcClient::from_env().map_err(|err| BackendInitError(err.into()))?;
        Ok(Self::new(client))
    }

    /// Loads the backend for an existing repo.
    pub fn load(_settings: &UserSettings, _store_path: &Path) -> Result<Self, BackendLoadError> {
        let client = RpcClient::from_env().map_err(|err| BackendLoadError(err.into()))?;
        Ok(Self::new(client))
    }
}

fn to_other(err: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> BackendError {
    BackendError::Other(err.into())
}

fn read_error(id: &impl ObjectId, err: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> BackendError {
    BackendError::ReadObject {
        object_type: id.object_type(),
        hash: id.hex(),
        source: err.into(),
    }
}

fn not_found(id: &impl ObjectId) -> BackendError {
    BackendError::ObjectNotFound {
        object_type: id.object_type(),
        hash: id.hex(),
        source: "object not found on RPC server".into(),
    }
}

fn write_error(object_type: &'static str, err: RpcError) -> BackendError {
    BackendError::WriteObject {
        object_type,
        source: Box::new(err),
    }
}

#[async_trait]
impl Backend for RpcBackend {
    fn name(&self) -> &str {
        Self::name()
    }

    fn commit_id_length(&self) -> usize {
        COMMIT_ID_LENGTH
    }

    fn change_id_length(&self) -> usize {
        CHANGE_ID_LENGTH
    }

    fn root_commit_id(&self) -> &CommitId {
        &self.root_commit_id
    }

    fn root_change_id(&self) -> &ChangeId {
        &self.root_change_id
    }

    fn empty_tree_id(&self) -> &TreeId {
        &self.empty_tree_id
    }

    fn concurrency(&self) -> usize {
        // The backend is a cloud proxy, so allow plenty of concurrent requests.
        100
    }

    async fn read_file(
        &self,
        _path: &RepoPath,
        id: &FileId,
    ) -> BackendResult<Pin<Box<dyn AsyncRead + Send>>> {
        let body = self
            .client
            .get(&format!("read_file/{}", id.hex()))
            .await
            .map_err(|err| read_error(id, err))?
            .ok_or_else(|| not_found(id))?;
        Ok(Box::pin(futures::io::Cursor::new(body)))
    }

    async fn write_file(
        &self,
        _path: &RepoPath,
        contents: &mut (dyn AsyncRead + Send + Unpin),
    ) -> BackendResult<FileId> {
        let mut buf = Vec::new();
        contents.read_to_end(&mut buf).await.map_err(to_other)?;
        let id = FileId::new(blake2b_hash(&buf).to_vec());
        self.client
            .post(&format!("write_file/{}", id.hex()), buf)
            .await
            .map_err(|err| write_error("file", err))?;
        Ok(id)
    }

    async fn read_symlink(&self, _path: &RepoPath, id: &SymlinkId) -> BackendResult<String> {
        let body = self
            .client
            .get(&format!("read_symlink/{}", id.hex()))
            .await
            .map_err(|err| read_error(id, err))?
            .ok_or_else(|| not_found(id))?;
        String::from_utf8(body).map_err(to_other)
    }

    async fn write_symlink(&self, _path: &RepoPath, target: &str) -> BackendResult<SymlinkId> {
        let id = SymlinkId::new(blake2b_hash(target).to_vec());
        self.client
            .post(&format!("write_symlink/{}", id.hex()), target.as_bytes().to_vec())
            .await
            .map_err(|err| write_error("symlink", err))?;
        Ok(id)
    }

    async fn read_copy(&self, _id: &CopyId) -> BackendResult<CopyHistory> {
        Err(BackendError::Unsupported(
            "the RPC backend doesn't support copies".to_string(),
        ))
    }

    async fn write_copy(&self, _contents: &CopyHistory) -> BackendResult<CopyId> {
        Err(BackendError::Unsupported(
            "the RPC backend doesn't support copies".to_string(),
        ))
    }

    async fn get_related_copies(&self, _copy_id: &CopyId) -> BackendResult<Vec<RelatedCopy>> {
        Err(BackendError::Unsupported(
            "the RPC backend doesn't support copies".to_string(),
        ))
    }

    async fn read_tree(&self, _path: &RepoPath, id: &TreeId) -> BackendResult<Tree> {
        if *id == self.empty_tree_id {
            return Ok(Tree::default());
        }
        let body = self
            .client
            .get(&format!("read_tree/{}", id.hex()))
            .await
            .map_err(|err| read_error(id, err))?
            .ok_or_else(|| not_found(id))?;
        let proto = jj_lib::protos::simple_store::Tree::decode(&*body).map_err(|err| read_error(id, err))?;
        Ok(proto::tree_from_proto(proto))
    }

    async fn write_tree(&self, _path: &RepoPath, contents: &Tree) -> BackendResult<TreeId> {
        let proto = proto::tree_to_proto(contents);
        let id = TreeId::new(blake2b_hash(contents).to_vec());
        self.client
            .post(&format!("write_tree/{}", id.hex()), proto.encode_to_vec())
            .await
            .map_err(|err| write_error("tree", err))?;
        Ok(id)
    }

    async fn read_commit(&self, id: &CommitId) -> BackendResult<Commit> {
        if *id == self.root_commit_id {
            return Ok(make_root_commit(
                self.root_change_id.clone(),
                self.empty_tree_id.clone(),
            ));
        }
        let body = self
            .client
            .get(&format!("read_commit/{}", id.hex()))
            .await
            .map_err(|err| read_error(id, err))?
            .ok_or_else(|| not_found(id))?;
        let proto = jj_lib::protos::simple_store::Commit::decode(&*body).map_err(|err| read_error(id, err))?;
        Ok(proto::commit_from_proto(proto))
    }

    async fn write_commit(
        &self,
        mut contents: Commit,
        sign_with: Option<&mut SigningFn>,
    ) -> BackendResult<(CommitId, Commit)> {
        assert!(contents.secure_sig.is_none(), "commit.secure_sig was set");
        if contents.parents.is_empty() {
            return Err(BackendError::Other(
                "Cannot write a commit with no parents".into(),
            ));
        }

        let mut proto = proto::commit_to_proto(&contents);
        if let Some(sign) = sign_with {
            let data = proto.encode_to_vec();
            let sig = sign(&data).map_err(to_other)?;
            proto.secure_sig = Some(sig.clone());
            contents.secure_sig = Some(SecureSig { data, sig });
        }

        let id = CommitId::new(blake2b_hash(&contents).to_vec());
        self.client
            .post(&format!("write_commit/{}", id.hex()), proto.encode_to_vec())
            .await
            .map_err(|err| write_error("commit", err))?;
        Ok((id, contents))
    }

    fn get_copy_records(
        &self,
        _paths: Option<&[RepoPathBuf]>,
        _root: &CommitId,
        _head: &CommitId,
    ) -> BackendResult<BoxStream<'_, BackendResult<CopyRecord>>> {
        Ok(stream::empty().boxed())
    }

    fn gc(&self, _index: &dyn Index, _keep_newer: SystemTime) -> BackendResult<()> {
        // The spec server keeps everything; gc is a no-op for this prototype.
        Ok(())
    }
}
