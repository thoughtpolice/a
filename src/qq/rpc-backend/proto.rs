// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
//
// The protobuf<->domain conversion functions below are adapted from jj-lib's
// `simple_backend.rs`, `simple_op_store.rs`, and `op_store.rs` (Copyright The
// Jujutsu Authors, Apache-2.0). They are copied because the upstream
// converters are private to jj-lib, and the RPC backend needs the exact same
// wire encoding as the on-disk simple stores.

//! Domain <-> protobuf converters shared by the RPC backend and op stores.
//!
//! These mirror jj-lib's on-disk protobuf encoding so that the spec server only
//! ever stores opaque, content-addressed byte blobs.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use jj_lib::backend::ChangeId;
use jj_lib::backend::Commit;
use jj_lib::backend::CommitId;
use jj_lib::backend::CopyId;
use jj_lib::backend::FileId;
use jj_lib::backend::MillisSinceEpoch;
use jj_lib::backend::SecureSig;
use jj_lib::backend::Signature;
use jj_lib::backend::SymlinkId;
use jj_lib::backend::Timestamp;
use jj_lib::backend::Tree;
use jj_lib::backend::TreeId;
use jj_lib::backend::TreeValue;
use jj_lib::conflict_labels::ConflictLabels;
use jj_lib::merge::Merge;
use jj_lib::merge::MergeBuilder;
use jj_lib::object_id::ObjectId as _;
use jj_lib::op_store::Operation;
use jj_lib::op_store::OperationId;
use jj_lib::op_store::OperationMetadata;
use jj_lib::op_store::RefTarget;
use jj_lib::op_store::RemoteRef;
use jj_lib::op_store::RemoteRefState;
use jj_lib::op_store::RemoteView;
use jj_lib::op_store::TimestampRange;
use jj_lib::op_store::View;
use jj_lib::op_store::ViewId;
use jj_lib::ref_name::GitRefNameBuf;
use jj_lib::ref_name::RefNameBuf;
use jj_lib::ref_name::RemoteNameBuf;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::ref_name::WorkspaceNameBuf;
use jj_lib::repo_path::RepoPathComponentBuf;
use prost::Message as _;
use thiserror::Error;

// BLAKE2b-512 hash lengths for operation and view ids.
const OPERATION_ID_LENGTH: usize = 64;
const VIEW_ID_LENGTH: usize = 64;

#[allow(clippy::assigning_clones)]
pub fn commit_to_proto(commit: &Commit) -> jj_lib::protos::simple_store::Commit {
    let mut proto = jj_lib::protos::simple_store::Commit::default();
    for parent in &commit.parents {
        proto.parents.push(parent.to_bytes());
    }
    for predecessor in &commit.predecessors {
        proto.predecessors.push(predecessor.to_bytes());
    }
    proto.root_tree = commit.root_tree.iter().map(|id| id.to_bytes()).collect();
    if !commit.conflict_labels.is_resolved() {
        proto.conflict_labels = commit.conflict_labels.as_slice().to_owned();
    }
    proto.change_id = commit.change_id.to_bytes();
    proto.description = commit.description.clone();
    proto.author = Some(signature_to_proto(&commit.author));
    proto.committer = Some(signature_to_proto(&commit.committer));
    proto
}

pub(crate) fn commit_from_proto(mut proto: jj_lib::protos::simple_store::Commit) -> Commit {
    // Note how .take() sets the secure_sig field to None before we encode the data.
    // Needs to be done first since proto is partially moved a bunch below
    let secure_sig = proto.secure_sig.take().map(|sig| SecureSig {
        data: proto.encode_to_vec(),
        sig,
    });

    let parents = proto.parents.into_iter().map(CommitId::new).collect();
    let predecessors = proto.predecessors.into_iter().map(CommitId::new).collect();
    let merge_builder: MergeBuilder<_> = proto.root_tree.into_iter().map(TreeId::new).collect();
    let root_tree = merge_builder.build();
    let conflict_labels = ConflictLabels::from_vec(proto.conflict_labels);
    let change_id = ChangeId::new(proto.change_id);
    Commit {
        parents,
        predecessors,
        root_tree,
        conflict_labels: conflict_labels.into_merge(),
        change_id,
        description: proto.description,
        author: signature_from_proto(proto.author.unwrap_or_default()),
        committer: signature_from_proto(proto.committer.unwrap_or_default()),
        secure_sig,
    }
}

pub(crate) fn tree_to_proto(tree: &Tree) -> jj_lib::protos::simple_store::Tree {
    let mut proto = jj_lib::protos::simple_store::Tree::default();
    for entry in tree.entries() {
        proto
            .entries
            .push(jj_lib::protos::simple_store::tree::Entry {
                name: entry.name().as_internal_str().to_owned(),
                value: Some(tree_value_to_proto(entry.value())),
            });
    }
    proto
}

pub(crate) fn tree_from_proto(proto: jj_lib::protos::simple_store::Tree) -> Tree {
    // Serialized data should be sorted
    let entries = proto
        .entries
        .into_iter()
        .map(|proto_entry| {
            let value = tree_value_from_proto(proto_entry.value.unwrap());
            (RepoPathComponentBuf::new(proto_entry.name).unwrap(), value)
        })
        .collect();
    Tree::from_sorted_entries(entries)
}

pub(crate) fn tree_value_to_proto(value: &TreeValue) -> jj_lib::protos::simple_store::TreeValue {
    let mut proto = jj_lib::protos::simple_store::TreeValue::default();
    match value {
        TreeValue::File {
            id,
            executable,
            copy_id,
        } => {
            proto.value = Some(jj_lib::protos::simple_store::tree_value::Value::File(
                jj_lib::protos::simple_store::tree_value::File {
                    id: id.to_bytes(),
                    executable: *executable,
                    copy_id: copy_id.to_bytes(),
                },
            ));
        }
        TreeValue::Symlink(id) => {
            proto.value = Some(jj_lib::protos::simple_store::tree_value::Value::SymlinkId(
                id.to_bytes(),
            ));
        }
        TreeValue::GitSubmodule(_id) => {
            panic!("cannot store git submodules");
        }
        TreeValue::Tree(id) => {
            proto.value = Some(jj_lib::protos::simple_store::tree_value::Value::TreeId(
                id.to_bytes(),
            ));
        }
    }
    proto
}

pub(crate) fn tree_value_from_proto(proto: jj_lib::protos::simple_store::TreeValue) -> TreeValue {
    match proto.value.unwrap() {
        jj_lib::protos::simple_store::tree_value::Value::TreeId(id) => {
            TreeValue::Tree(TreeId::new(id))
        }
        jj_lib::protos::simple_store::tree_value::Value::File(
            jj_lib::protos::simple_store::tree_value::File {
                id,
                executable,
                copy_id,
            },
        ) => TreeValue::File {
            id: FileId::new(id),
            executable,
            copy_id: CopyId::new(copy_id),
        },
        jj_lib::protos::simple_store::tree_value::Value::SymlinkId(id) => {
            TreeValue::Symlink(SymlinkId::new(id))
        }
    }
}

pub(crate) fn signature_to_proto(signature: &Signature) -> jj_lib::protos::simple_store::commit::Signature {
    jj_lib::protos::simple_store::commit::Signature {
        name: signature.name.clone(),
        email: signature.email.clone(),
        timestamp: Some(jj_lib::protos::simple_store::commit::Timestamp {
            millis_since_epoch: signature.timestamp.timestamp.0,
            tz_offset: signature.timestamp.tz_offset,
        }),
    }
}

pub(crate) fn signature_from_proto(proto: jj_lib::protos::simple_store::commit::Signature) -> Signature {
    let timestamp = proto.timestamp.unwrap_or_default();
    Signature {
        name: proto.name,
        email: proto.email,
        timestamp: Timestamp {
            timestamp: MillisSinceEpoch(timestamp.millis_since_epoch),
            tz_offset: timestamp.tz_offset,
        },
    }
}

#[derive(Debug, Error)]
pub(crate) enum PostDecodeError {
    #[error("Invalid hash length (expected {expected} bytes, got {actual} bytes)")]
    InvalidHashLength { expected: usize, actual: usize },
    #[error("Invalid remote ref state value {0}")]
    InvalidRemoteRefStateValue(i32),
    #[error("Invalid number of ref target terms {0}")]
    EvenNumberOfRefTargetTerms(usize),
}

pub(crate) fn operation_id_from_proto(bytes: Vec<u8>) -> Result<OperationId, PostDecodeError> {
    if bytes.len() != OPERATION_ID_LENGTH {
        Err(PostDecodeError::InvalidHashLength {
            expected: OPERATION_ID_LENGTH,
            actual: bytes.len(),
        })
    } else {
        Ok(OperationId::new(bytes))
    }
}

pub(crate) fn view_id_from_proto(bytes: Vec<u8>) -> Result<ViewId, PostDecodeError> {
    if bytes.len() != VIEW_ID_LENGTH {
        Err(PostDecodeError::InvalidHashLength {
            expected: VIEW_ID_LENGTH,
            actual: bytes.len(),
        })
    } else {
        Ok(ViewId::new(bytes))
    }
}

pub(crate) fn timestamp_to_proto(timestamp: &Timestamp) -> jj_lib::protos::simple_op_store::Timestamp {
    jj_lib::protos::simple_op_store::Timestamp {
        millis_since_epoch: timestamp.timestamp.0,
        tz_offset: timestamp.tz_offset,
    }
}

pub(crate) fn timestamp_from_proto(proto: jj_lib::protos::simple_op_store::Timestamp) -> Timestamp {
    Timestamp {
        timestamp: MillisSinceEpoch(proto.millis_since_epoch),
        tz_offset: proto.tz_offset,
    }
}

pub(crate) fn operation_metadata_to_proto(
    metadata: &OperationMetadata,
) -> jj_lib::protos::simple_op_store::OperationMetadata {
    jj_lib::protos::simple_op_store::OperationMetadata {
        start_time: Some(timestamp_to_proto(&metadata.time.start)),
        end_time: Some(timestamp_to_proto(&metadata.time.end)),
        description: metadata.description.clone(),
        hostname: metadata.hostname.clone(),
        username: metadata.username.clone(),
        is_snapshot: metadata.is_snapshot,
        workspace_name: metadata.workspace_name.clone().map(Into::into),
        attributes: metadata
            .attributes
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    }
}

pub(crate) fn operation_metadata_from_proto(
    proto: jj_lib::protos::simple_op_store::OperationMetadata,
) -> OperationMetadata {
    let time = TimestampRange {
        start: timestamp_from_proto(proto.start_time.unwrap_or_default()),
        end: timestamp_from_proto(proto.end_time.unwrap_or_default()),
    };
    let workspace_name = proto.workspace_name.map(Into::into);
    OperationMetadata {
        time,
        description: proto.description,
        hostname: proto.hostname,
        username: proto.username,
        is_snapshot: proto.is_snapshot,
        workspace_name,
        attributes: proto.attributes.into_iter().collect(),
    }
}

pub(crate) fn commit_predecessors_map_to_proto(
    map: &BTreeMap<CommitId, Vec<CommitId>>,
) -> Vec<jj_lib::protos::simple_op_store::CommitPredecessors> {
    map.iter()
        .map(
            |(commit_id, predecessor_ids)| jj_lib::protos::simple_op_store::CommitPredecessors {
                commit_id: commit_id.to_bytes(),
                predecessor_ids: predecessor_ids.iter().map(|id| id.to_bytes()).collect(),
            },
        )
        .collect()
}

pub(crate) fn commit_predecessors_map_from_proto(
    proto: Vec<jj_lib::protos::simple_op_store::CommitPredecessors>,
) -> BTreeMap<CommitId, Vec<CommitId>> {
    proto
        .into_iter()
        .map(|entry| {
            let commit_id = CommitId::new(entry.commit_id);
            let predecessor_ids = entry
                .predecessor_ids
                .into_iter()
                .map(CommitId::new)
                .collect();
            (commit_id, predecessor_ids)
        })
        .collect()
}

pub(crate) fn operation_to_proto(operation: &Operation) -> jj_lib::protos::simple_op_store::Operation {
    let (commit_predecessors, stores_commit_predecessors) = match &operation.commit_predecessors {
        Some(map) => (commit_predecessors_map_to_proto(map), true),
        None => (vec![], false),
    };
    let parents = operation.parents.iter().map(|id| id.to_bytes()).collect();
    jj_lib::protos::simple_op_store::Operation {
        view_id: operation.view_id.as_bytes().to_vec(),
        parents,
        metadata: Some(operation_metadata_to_proto(&operation.metadata)),
        commit_predecessors,
        stores_commit_predecessors,
    }
}

pub(crate) fn operation_from_proto(
    proto: jj_lib::protos::simple_op_store::Operation,
) -> Result<Operation, PostDecodeError> {
    let parents = proto
        .parents
        .into_iter()
        .map(operation_id_from_proto)
        .collect::<Result<Vec<_>, _>>()?;
    let view_id = view_id_from_proto(proto.view_id)?;
    let metadata = operation_metadata_from_proto(proto.metadata.unwrap_or_default());
    let commit_predecessors = proto
        .stores_commit_predecessors
        .then(|| commit_predecessors_map_from_proto(proto.commit_predecessors));
    Ok(Operation {
        view_id,
        parents,
        metadata,
        commit_predecessors,
    })
}

pub(crate) fn view_to_proto(view: &View) -> jj_lib::protos::simple_op_store::View {
    let wc_commit_ids = view
        .wc_commit_ids
        .iter()
        .map(|(name, id)| (name.into(), id.to_bytes()))
        .collect();
    let head_ids = view.head_ids.iter().map(|id| id.to_bytes()).collect();

    let bookmarks = bookmark_views_to_proto_legacy(&view.local_bookmarks, &view.remote_views);

    let local_tags = view
        .local_tags
        .iter()
        .map(|(name, target)| jj_lib::protos::simple_op_store::Tag {
            name: name.into(),
            target: ref_target_to_proto(target),
        })
        .collect();

    let remote_views = remote_views_to_proto(&view.remote_views);

    let git_refs = view
        .git_refs
        .iter()
        .map(|(name, target)| {
            #[allow(deprecated)]
            jj_lib::protos::simple_op_store::GitRef {
                name: name.into(),
                commit_id: Default::default(),
                target: ref_target_to_proto(target),
            }
        })
        .collect();

    let git_head = ref_target_to_proto(&view.git_head);

    #[allow(deprecated)]
    jj_lib::protos::simple_op_store::View {
        head_ids,
        wc_commit_id: Default::default(),
        wc_commit_ids,
        bookmarks,
        local_tags,
        remote_views,
        git_refs,
        git_head_legacy: Default::default(),
        git_head,
        // New/loaded view should have been migrated to the latest format
        has_git_refs_migrated_to_remote_tags: true,
    }
}

pub(crate) fn view_from_proto(proto: jj_lib::protos::simple_op_store::View) -> Result<View, PostDecodeError> {
    // TODO: validate commit id length?
    // For compatibility with old repos before we had support for multiple working
    // copies
    let mut wc_commit_ids = BTreeMap::new();
    #[allow(deprecated)]
    if !proto.wc_commit_id.is_empty() {
        wc_commit_ids.insert(
            WorkspaceName::DEFAULT.to_owned(),
            CommitId::new(proto.wc_commit_id),
        );
    }
    for (name, commit_id) in proto.wc_commit_ids {
        wc_commit_ids.insert(WorkspaceNameBuf::from(name), CommitId::new(commit_id));
    }
    let head_ids = proto.head_ids.into_iter().map(CommitId::new).collect();

    let (local_bookmarks, mut remote_views) = bookmark_views_from_proto_legacy(proto.bookmarks)?;

    let local_tags = proto
        .local_tags
        .into_iter()
        .map(|tag_proto| {
            let name: RefNameBuf = tag_proto.name.into();
            (name, ref_target_from_proto(tag_proto.target))
        })
        .collect();

    let git_refs: BTreeMap<_, _> = proto
        .git_refs
        .into_iter()
        .map(|git_ref| {
            let name: GitRefNameBuf = git_ref.name.into();
            let target = if git_ref.target.is_some() {
                ref_target_from_proto(git_ref.target)
            } else {
                // Legacy format
                #[allow(deprecated)]
                RefTarget::normal(CommitId::new(git_ref.commit_id))
            };
            (name, target)
        })
        .collect();

    // Use legacy remote_views only when new data isn't available (jj < 0.34)
    if !proto.remote_views.is_empty() {
        remote_views = remote_views_from_proto(proto.remote_views)?;
    }

    #[allow(deprecated)]
    let git_head = if proto.git_head.is_some() {
        ref_target_from_proto(proto.git_head)
    } else if !proto.git_head_legacy.is_empty() {
        RefTarget::normal(CommitId::new(proto.git_head_legacy))
    } else {
        RefTarget::absent()
    };

    Ok(View {
        head_ids,
        local_bookmarks,
        local_tags,
        remote_views,
        git_refs,
        git_head,
        wc_commit_ids,
    })
}

pub(crate) fn bookmark_views_to_proto_legacy(
    local_bookmarks: &BTreeMap<RefNameBuf, RefTarget>,
    remote_views: &BTreeMap<RemoteNameBuf, RemoteView>,
) -> Vec<jj_lib::protos::simple_op_store::Bookmark> {
    // jj-lib uses a merge-join over local and remote refs here. We keep it simple
    // with a sorted set of names: the result round-trips identically because the
    // view id is hashed from the domain `View`, not from these proto bytes.
    let mut names: BTreeSet<&RefNameBuf> = local_bookmarks.keys().collect();
    for remote_view in remote_views.values() {
        names.extend(remote_view.bookmarks.keys());
    }
    names
        .into_iter()
        .map(|name| {
            let local_target =
                ref_target_to_proto(local_bookmarks.get(name).unwrap_or(RefTarget::absent_ref()));
            // TODO: Drop serialization to the old format in jj 0.40 or so.
            let remote_bookmarks = remote_views
                .iter()
                .filter_map(|(remote_name, remote_view)| {
                    let remote_ref = remote_view.bookmarks.get(name)?;
                    #[allow(deprecated)]
                    Some(jj_lib::protos::simple_op_store::RemoteBookmark {
                        remote_name: remote_name.as_str().to_owned(),
                        target: ref_target_to_proto(&remote_ref.target),
                        state: Some(remote_ref_state_to_proto(remote_ref.state)),
                    })
                })
                .collect();
            #[allow(deprecated)]
            jj_lib::protos::simple_op_store::Bookmark {
                name: name.as_str().to_owned(),
                local_target,
                remote_bookmarks,
            }
        })
        .collect()
}

type BookmarkViews = (
    BTreeMap<RefNameBuf, RefTarget>,
    BTreeMap<RemoteNameBuf, RemoteView>,
);

pub(crate) fn bookmark_views_from_proto_legacy(
    bookmarks_legacy: Vec<jj_lib::protos::simple_op_store::Bookmark>,
) -> Result<BookmarkViews, PostDecodeError> {
    let mut local_bookmarks: BTreeMap<RefNameBuf, RefTarget> = BTreeMap::new();
    let mut remote_views: BTreeMap<RemoteNameBuf, RemoteView> = BTreeMap::new();
    for bookmark_proto in bookmarks_legacy {
        let bookmark_name: RefNameBuf = bookmark_proto.name.into();
        let local_target = ref_target_from_proto(bookmark_proto.local_target);
        #[allow(deprecated)]
        let remote_bookmarks = bookmark_proto.remote_bookmarks;
        for remote_bookmark in remote_bookmarks {
            let remote_name: RemoteNameBuf = remote_bookmark.remote_name.into();
            let state = match remote_bookmark.state {
                Some(n) => remote_ref_state_from_proto(n)?,
                // Legacy view saved by jj < 0.11. The proto field is not
                // changed to non-optional type because that would break forward
                // compatibility. Zero may be omitted if the field is optional.
                None => RemoteRefState::New,
            };
            let remote_view = remote_views.entry(remote_name).or_default();
            let remote_ref = RemoteRef {
                target: ref_target_from_proto(remote_bookmark.target),
                state,
            };
            remote_view
                .bookmarks
                .insert(bookmark_name.clone(), remote_ref);
        }
        if local_target.is_present() {
            local_bookmarks.insert(bookmark_name, local_target);
        }
    }
    Ok((local_bookmarks, remote_views))
}

pub(crate) fn remote_views_to_proto(
    remote_views: &BTreeMap<RemoteNameBuf, RemoteView>,
) -> Vec<jj_lib::protos::simple_op_store::RemoteView> {
    remote_views
        .iter()
        .map(|(name, view)| jj_lib::protos::simple_op_store::RemoteView {
            name: name.into(),
            bookmarks: remote_refs_to_proto(&view.bookmarks),
            tags: remote_refs_to_proto(&view.tags),
        })
        .collect()
}

pub(crate) fn remote_views_from_proto(
    remote_views_proto: Vec<jj_lib::protos::simple_op_store::RemoteView>,
) -> Result<BTreeMap<RemoteNameBuf, RemoteView>, PostDecodeError> {
    remote_views_proto
        .into_iter()
        .map(|proto| {
            let name: RemoteNameBuf = proto.name.into();
            let view = RemoteView {
                bookmarks: remote_refs_from_proto(proto.bookmarks)?,
                tags: remote_refs_from_proto(proto.tags)?,
            };
            Ok((name, view))
        })
        .collect()
}

pub(crate) fn remote_refs_to_proto(
    remote_refs: &BTreeMap<RefNameBuf, RemoteRef>,
) -> Vec<jj_lib::protos::simple_op_store::RemoteRef> {
    remote_refs
        .iter()
        .map(
            |(name, remote_ref)| jj_lib::protos::simple_op_store::RemoteRef {
                name: name.into(),
                target_terms: ref_target_to_terms_proto(&remote_ref.target),
                state: remote_ref_state_to_proto(remote_ref.state),
            },
        )
        .collect()
}

pub(crate) fn remote_refs_from_proto(
    remote_refs_proto: Vec<jj_lib::protos::simple_op_store::RemoteRef>,
) -> Result<BTreeMap<RefNameBuf, RemoteRef>, PostDecodeError> {
    remote_refs_proto
        .into_iter()
        .map(|proto| {
            let name: RefNameBuf = proto.name.into();
            let remote_ref = RemoteRef {
                target: ref_target_from_terms_proto(proto.target_terms)?,
                state: remote_ref_state_from_proto(proto.state)?,
            };
            Ok((name, remote_ref))
        })
        .collect()
}

pub(crate) fn ref_target_to_terms_proto(
    value: &RefTarget,
) -> Vec<jj_lib::protos::simple_op_store::RefTargetTerm> {
    value
        .as_merge()
        .iter()
        .map(|term| term.as_ref().map(|id| id.to_bytes()))
        .map(|value| jj_lib::protos::simple_op_store::RefTargetTerm { value })
        .collect()
}

pub(crate) fn ref_target_from_terms_proto(
    proto: Vec<jj_lib::protos::simple_op_store::RefTargetTerm>,
) -> Result<RefTarget, PostDecodeError> {
    // jj-lib collects into a SmallVec here; a Vec works just as well because
    // `Merge::from_vec` accepts `impl Into<SmallVec<[T; 1]>>`.
    let terms: Vec<_> = proto
        .into_iter()
        .map(|jj_lib::protos::simple_op_store::RefTargetTerm { value }| value.map(CommitId::new))
        .collect();
    if terms.len().is_multiple_of(2) {
        Err(PostDecodeError::EvenNumberOfRefTargetTerms(terms.len()))
    } else {
        Ok(RefTarget::from_merge(Merge::from_vec(terms)))
    }
}

pub(crate) fn ref_target_to_proto(value: &RefTarget) -> Option<jj_lib::protos::simple_op_store::RefTarget> {
    let term_to_proto =
        |term: &Option<CommitId>| jj_lib::protos::simple_op_store::ref_conflict::Term {
            value: term.as_ref().map(|id| id.to_bytes()),
        };
    let merge = value.as_merge();
    let conflict_proto = jj_lib::protos::simple_op_store::RefConflict {
        removes: merge.removes().map(term_to_proto).collect(),
        adds: merge.adds().map(term_to_proto).collect(),
    };
    let proto = jj_lib::protos::simple_op_store::RefTarget {
        value: Some(jj_lib::protos::simple_op_store::ref_target::Value::Conflict(
            conflict_proto,
        )),
    };
    Some(proto)
}
pub(crate) fn ref_target_from_proto(
    maybe_proto: Option<jj_lib::protos::simple_op_store::RefTarget>,
) -> RefTarget {
    // TODO: Delete legacy format handling when we decide to drop support for views
    // saved by jj <= 0.8.
    let Some(proto) = maybe_proto else {
        // Legacy absent id
        return RefTarget::absent();
    };
    match proto.value.unwrap() {
        #[allow(deprecated)]
        jj_lib::protos::simple_op_store::ref_target::Value::CommitId(id) => {
            // Legacy non-conflicting id
            RefTarget::normal(CommitId::new(id))
        }
        #[allow(deprecated)]
        jj_lib::protos::simple_op_store::ref_target::Value::ConflictLegacy(conflict) => {
            // Legacy conflicting ids
            let removes = conflict.removes.into_iter().map(CommitId::new);
            let adds = conflict.adds.into_iter().map(CommitId::new);
            RefTarget::from_legacy_form(removes, adds)
        }
        jj_lib::protos::simple_op_store::ref_target::Value::Conflict(conflict) => {
            let term_from_proto = |term: jj_lib::protos::simple_op_store::ref_conflict::Term| {
                term.value.map(CommitId::new)
            };
            let removes = conflict.removes.into_iter().map(term_from_proto);
            let adds = conflict.adds.into_iter().map(term_from_proto);
            RefTarget::from_merge(Merge::from_removes_adds(removes, adds))
        }
    }
}

pub(crate) fn remote_ref_state_to_proto(state: RemoteRefState) -> i32 {
    let proto_state = match state {
        RemoteRefState::New => jj_lib::protos::simple_op_store::RemoteRefState::New,
        RemoteRefState::Tracked => jj_lib::protos::simple_op_store::RemoteRefState::Tracked,
    };
    proto_state as i32
}

pub(crate) fn remote_ref_state_from_proto(proto_value: i32) -> Result<RemoteRefState, PostDecodeError> {
    let proto_state = proto_value
        .try_into()
        .map_err(|prost::UnknownEnumValue(n)| PostDecodeError::InvalidRemoteRefStateValue(n))?;
    let state = match proto_state {
        jj_lib::protos::simple_op_store::RemoteRefState::New => RemoteRefState::New,
        jj_lib::protos::simple_op_store::RemoteRefState::Tracked => RemoteRefState::Tracked,
    };
    Ok(state)
}
