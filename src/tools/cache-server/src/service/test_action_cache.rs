// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;

#[tokio::test]
async fn action_cache_put_and_get() {
    let store = make_store().await;
    let ac = make_ac(store);

    let action_data = b"fake action";
    let action_result = ActionResult {
        exit_code: 42,
        stdout_raw: Bytes::from_static(b"test stdout"),
        stderr_raw: Bytes::from_static(b"test stderr"),
        ..Default::default()
    };

    ac.update_action_result(tonic::Request::new(
        protos::build::bazel::remote::execution::v2::UpdateActionResultRequest {
            instance_name: String::new(),
            action_digest: Some(make_digest(action_data)),
            action_result: Some(action_result.clone()),
            results_cache_policy: None,
            digest_function: 0,
        },
    ))
    .await
    .unwrap();

    let resp = ac
        .get_action_result(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetActionResultRequest {
                instance_name: String::new(),
                action_digest: Some(make_digest(action_data)),
                inline_stdout: false,
                inline_stderr: false,
                inline_output_files: vec![],
                digest_function: 0,
            },
        ))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.exit_code, 42);
    assert_eq!(resp.stdout_raw, Bytes::from_static(b"test stdout"));
    assert_eq!(resp.stderr_raw, Bytes::from_static(b"test stderr"));
}

#[tokio::test]
async fn action_cache_get_not_found() {
    let store = make_store().await;
    let ac = make_ac(store);

    let result = ac
        .get_action_result(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetActionResultRequest {
                instance_name: String::new(),
                action_digest: Some(make_digest(b"missing")),
                inline_stdout: false,
                inline_stderr: false,
                inline_output_files: vec![],
                digest_function: 0,
            },
        ))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::NotFound);
}

#[tokio::test]
async fn action_cache_overwrite() {
    let store = make_store().await;
    let ac = make_ac(store);

    let action_data = b"overwrite action";

    // First write
    ac.update_action_result(tonic::Request::new(
        protos::build::bazel::remote::execution::v2::UpdateActionResultRequest {
            instance_name: String::new(),
            action_digest: Some(make_digest(action_data)),
            action_result: Some(ActionResult {
                exit_code: 1,
                ..Default::default()
            }),
            results_cache_policy: None,
            digest_function: 0,
        },
    ))
    .await
    .unwrap();

    // Overwrite
    ac.update_action_result(tonic::Request::new(
        protos::build::bazel::remote::execution::v2::UpdateActionResultRequest {
            instance_name: String::new(),
            action_digest: Some(make_digest(action_data)),
            action_result: Some(ActionResult {
                exit_code: 42,
                ..Default::default()
            }),
            results_cache_policy: None,
            digest_function: 0,
        },
    ))
    .await
    .unwrap();

    let resp = ac
        .get_action_result(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetActionResultRequest {
                instance_name: String::new(),
                action_digest: Some(make_digest(action_data)),
                inline_stdout: false,
                inline_stderr: false,
                inline_output_files: vec![],
                digest_function: 0,
            },
        ))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.exit_code, 42);
}

// =================================================================================================================
// A hit implies its outputs are stored
// =================================================================================================================

use protos::build::bazel::remote::execution::v2::{
    GetActionResultRequest, OutputDirectory, OutputFile, Tree, UpdateActionResultRequest,
};

async fn put_result(ac: &ActionCacheService, action: &[u8], result: ActionResult) {
    ac.update_action_result(tonic::Request::new(UpdateActionResultRequest {
        instance_name: String::new(),
        action_digest: Some(make_digest(action)),
        action_result: Some(result),
        results_cache_policy: None,
        digest_function: 0,
    }))
    .await
    .unwrap();
}

async fn get_result(ac: &ActionCacheService, action: &[u8]) -> Result<ActionResult, tonic::Status> {
    ac.get_action_result(tonic::Request::new(GetActionResultRequest {
        instance_name: String::new(),
        action_digest: Some(make_digest(action)),
        inline_stdout: false,
        inline_stderr: false,
        inline_output_files: vec![],
        digest_function: 0,
    }))
    .await
    .map(tonic::Response::into_inner)
}

async fn put_blob(store: &CacheStore, data: &[u8]) -> Digest {
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::copy_from_slice(data), Compression::Identity)
        .await
        .unwrap();
    make_digest(data)
}

fn output_file(digest: Digest) -> OutputFile {
    OutputFile {
        path: "out".into(),
        digest: Some(digest),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_hit_needs_its_output_files_stored() {
    let store = make_store().await;
    let ac = make_ac(store.clone());

    let stored = put_blob(&store, b"stored output").await;
    let stdout = put_blob(&store, b"stdout").await;
    put_result(
        &ac,
        b"all there",
        ActionResult {
            output_files: vec![output_file(stored.clone())],
            stdout_digest: Some(stdout),
            // The empty blob counts as stored without an upload.
            stderr_digest: Some(make_digest(b"")),
            ..Default::default()
        },
    )
    .await;
    get_result(&ac, b"all there").await.expect("a hit");

    put_result(
        &ac,
        b"one gone",
        ActionResult {
            output_files: vec![
                output_file(stored),
                output_file(make_digest(b"never uploaded")),
            ],
            ..Default::default()
        },
    )
    .await;
    let err = get_result(&ac, b"one gone").await.unwrap_err();
    assert_eq!(err.code(), tonic::Code::NotFound, "{err:?}");
}

#[tokio::test]
async fn a_hit_needs_the_files_of_its_output_directories_stored() {
    let store = make_store().await;
    let ac = make_ac(store.clone());

    let present = put_blob(&store, b"in the tree").await;
    let tree_of = |file: Digest| Tree {
        root: Some(Directory {
            files: vec![FileNode {
                name: "f".into(),
                digest: Some(file),
                ..Default::default()
            }],
            ..Default::default()
        }),
        children: vec![],
    };
    for (action, file, hit) in [
        (&b"tree ok"[..], present, true),
        (
            &b"tree missing a file"[..],
            make_digest(b"not in the tree"),
            false,
        ),
    ] {
        let tree = put_blob(&store, &tree_of(file).encode_to_vec()).await;
        put_result(
            &ac,
            action,
            ActionResult {
                output_directories: vec![OutputDirectory {
                    path: "dir".into(),
                    tree_digest: Some(tree),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .await;
        assert_eq!(get_result(&ac, action).await.is_ok(), hit, "{action:?}");
    }
}

/// An output FindMissingBlobs would already call missing (past half its
/// TTL) makes the result a miss, so the client reruns the action and its
/// uploads renew the outputs.
#[tokio::test]
async fn a_hit_needs_its_outputs_fresh() {
    ensure_telemetry();
    let store = Arc::new(
        CacheStore::open(
            StoreBackend::Memory,
            CacheStoreSettings {
                default_ttl: Some(jiff::SignedDuration::from_secs(2)),
                ..Default::default()
            },
        )
        .await
        .unwrap(),
    );
    let ac = make_ac(store.clone());
    let output = put_blob(&store, b"ages").await;
    put_result(
        &ac,
        b"aging",
        ActionResult {
            output_files: vec![output_file(output)],
            ..Default::default()
        },
    )
    .await;
    get_result(&ac, b"aging").await.expect("fresh: a hit");
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let err = get_result(&ac, b"aging").await.unwrap_err();
    assert_eq!(err.code(), tonic::Code::NotFound, "{err:?}");
}
