// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A minimal "cloud" backend for jj that proxies every storage operation to an
//! HTTP server named by the `QQ_RPC_BACKEND_URL` environment variable.
//!
//! The backend implements jj's three storage traits — [`jj_lib::backend::Backend`],
//! [`jj_lib::op_store::OpStore`] and [`jj_lib::op_heads_store::OpHeadsStore`] —
//! translating each method 1:1 into an HTTP request. Object ids are
//! content-addressed and computed on the client, so the server is just a dumb
//! content-addressed blob store (plus a mutable op-heads pointer). The default
//! index, submodule store and working copy stay local, so a repo's `.jj`
//! directory holds no object data.

#![allow(missing_docs)]

mod backend;
mod http;
mod op_heads;
mod op_store;
mod proto;

use std::path::Path;
use std::sync::Arc;

use jj_lib::repo::BackendInitializer;
use jj_lib::repo::OpHeadsStoreInitializer;
use jj_lib::repo::OpStoreInitializer;
use jj_lib::repo::ReadonlyRepo;
use jj_lib::repo::StoreFactories;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::settings::UserSettings;
use jj_lib::signing::Signer;
use jj_lib::workspace::Workspace;
use jj_lib::workspace::WorkspaceInitError;
use jj_lib::workspace::default_working_copy_factory;
use pollster::FutureExt as _;

pub use backend::RpcBackend;
pub use op_heads::RpcOpHeadsStore;
pub use op_store::RpcOpStore;

/// Returns the [`StoreFactories`] additions for loading RPC-backed repos.
///
/// Merge these into the CLI's default factories with
/// `CliRunner::add_store_factories`.
pub fn store_factories() -> StoreFactories {
    let mut factories = StoreFactories::empty();
    factories.add_backend(
        RpcBackend::name(),
        Box::new(|settings, store_path| Ok(Box::new(RpcBackend::load(settings, store_path)?))),
    );
    factories.add_op_store(
        RpcOpStore::name(),
        Box::new(|settings, store_path, root_data| {
            Ok(Box::new(RpcOpStore::load(settings, store_path, root_data)?))
        }),
    );
    factories.add_op_heads_store(
        RpcOpHeadsStore::name(),
        Box::new(|settings, store_path| Ok(Box::new(RpcOpHeadsStore::load(settings, store_path)?))),
    );
    factories
}

/// Initializes a new RPC-backed workspace rooted at `workspace_root`.
///
/// Reuses jj's default index store, submodule store and local working copy; only
/// the commit/operation/op-heads stores are RPC-backed. Requires
/// `QQ_RPC_BACKEND_URL` to be set, and contacts the server to write the initial
/// operation, view and working-copy commit.
pub fn init_workspace(
    settings: &UserSettings,
    workspace_root: &Path,
) -> Result<(Workspace, Arc<ReadonlyRepo>), WorkspaceInitError> {
    let backend_initializer: &BackendInitializer =
        &|settings, store_path| Ok(Box::new(RpcBackend::init(settings, store_path)?));
    let op_store_initializer: &OpStoreInitializer = &|settings, store_path, root_data| {
        Ok(Box::new(RpcOpStore::init(settings, store_path, root_data)?))
    };
    let op_heads_store_initializer: &OpHeadsStoreInitializer = &|settings, store_path, root_op_id| {
        Ok(Box::new(RpcOpHeadsStore::init(settings, store_path, root_op_id)?))
    };
    let signer = Signer::from_settings(settings)?;
    Workspace::init_with_factories(
        settings,
        workspace_root,
        backend_initializer,
        signer,
        op_store_initializer,
        op_heads_store_initializer,
        ReadonlyRepo::default_index_store_initializer(),
        ReadonlyRepo::default_submodule_store_initializer(),
        &*default_working_copy_factory(),
        WorkspaceName::DEFAULT.to_owned(),
    )
    .block_on()
}
