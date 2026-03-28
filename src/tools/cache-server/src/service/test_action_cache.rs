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
