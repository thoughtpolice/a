// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fault scenarios exercised through the same S3 protocol adapter as clients.

use std::time::Duration;

use faultline::{Action, Injector};

use crate::faults::{BODY_CHUNK_SIZE, BodyFault, S3Fault};

use super::*;

const DEADLINE: Duration = Duration::from_secs(5);

fn fault_fixture() -> (Injector<S3Fault>, S3Service) {
    let faults = Injector::with_seed(7);
    let store = MemoryS3::with_buckets_and_faults(["celld"], faults.clone());
    (faults, s3_service(store))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finite_faults_are_shared_by_clones_and_isolated_between_stores() {
    let store = MemoryS3::with_buckets(["celld"]);
    let faults = store.faults().injector().clone();
    let service = s3_service(store.clone());
    let sibling = s3_service(store);
    let isolated = fixture();
    let key = "/celld/shared-limit";
    put(&service, key, "shared data").await;
    put(&isolated, key, "isolated data").await;
    let guard = faults
        .point("s3.get_object.before")
        .scoped(Action::Return(S3Fault::SlowDown).times(2))
        .unwrap();

    assert_eq!(get_text(&isolated, key).await, "isolated data");
    assert_eq!(guard.snapshot().hits, 0);

    let mut requests = tokio::task::JoinSet::new();
    for index in 0..16 {
        let service = if index % 2 == 0 { &service } else { &sibling }.clone();
        requests.spawn(async move {
            let response = call(&service, request(Method::GET, key, Body::empty())).await;
            let status = response.status();
            match status {
                StatusCode::SERVICE_UNAVAILABLE => {
                    expect_error(response, StatusCode::SERVICE_UNAVAILABLE, "SlowDown").await;
                }
                StatusCode::OK => assert_eq!(body_text(response).await, "shared data"),
                unexpected => panic!("unexpected GET status {unexpected}"),
            }
            status
        });
    }
    let mut failures = 0;
    while let Some(result) = tokio::time::timeout(DEADLINE, requests.join_next())
        .await
        .expect("concurrent requests finish")
    {
        if result.unwrap() == StatusCode::SERVICE_UNAVAILABLE {
            failures += 1;
        }
    }
    assert_eq!(failures, 2);
    assert_eq!(guard.snapshot().hits, 16);
    assert_eq!(guard.snapshot().triggered, 2);
    assert_eq!(get_text(&service, key).await, "shared data");
    assert_eq!(get_text(&sibling, key).await, "shared data");
    assert_eq!(get_text(&isolated, key).await, "isolated data");
}

#[tokio::test]
async fn failed_put_before_mutation_preserves_existing_and_missing_objects() {
    let (faults, service) = fault_fixture();
    let existing = "/celld/existing";
    let missing = "/celld/missing";
    put(&service, existing, "original").await;
    let _guard = faults
        .point("s3.put_object.before")
        .scoped(Action::Return(S3Fault::InternalError).times(2))
        .unwrap();

    for key in [existing, missing] {
        let response = call(&service, request(Method::PUT, key, "replacement")).await;
        expect_error(response, StatusCode::INTERNAL_SERVER_ERROR, "InternalError").await;
    }
    assert_eq!(get_text(&service, existing).await, "original");
    assert_eq!(
        status(&service, Method::HEAD, missing).await,
        StatusCode::NOT_FOUND
    );
    put(&service, missing, "recovered").await;
    assert_eq!(get_text(&service, missing).await, "recovered");
}

#[tokio::test]
async fn failed_put_after_commit_retains_object_and_conditional_retry_semantics() {
    let (faults, service) = fault_fixture();
    let key = "/celld/committed-put";
    let _guard = faults
        .point("s3.put_object.after_commit")
        .scoped(Action::Return(S3Fault::ServiceUnavailable).times(1))
        .unwrap();

    let response = call(
        &service,
        with_headers(Method::PUT, key, "committed", &[("if-none-match", "*")]),
    )
    .await;
    expect_error(
        response,
        StatusCode::SERVICE_UNAVAILABLE,
        "ServiceUnavailable",
    )
    .await;
    assert_eq!(get_text(&service, key).await, "committed");

    let retry = call(
        &service,
        with_headers(Method::PUT, key, "retried", &[("if-none-match", "*")]),
    )
    .await;
    expect_error(retry, StatusCode::PRECONDITION_FAILED, "PreconditionFailed").await;
    assert_eq!(get_text(&service, key).await, "committed");
}

#[tokio::test]
async fn paused_put_after_commit_allows_other_requests_and_releases_on_drop() {
    let (faults, service) = fault_fixture();
    let key = "/celld/paused-put";
    let guard = faults
        .point("s3.put_object.after_commit")
        .scoped(Action::Pause.times(1))
        .unwrap();
    let writer = service.clone();
    let write = tokio::spawn(async move { put(&writer, key, "visible before response").await });
    tokio::time::timeout(DEADLINE, guard.wait_for_pauses(1))
        .await
        .expect("PUT reaches the pause after committing");
    assert!(!write.is_finished());

    assert_eq!(
        tokio::time::timeout(DEADLINE, get_text(&service, key))
            .await
            .expect("paused PUT holds no store lock"),
        "visible before response"
    );
    tokio::time::timeout(DEADLINE, put(&service, "/celld/other", "other request"))
        .await
        .expect("a second PUT is unaffected by the consumed pause");
    assert!(!write.is_finished());

    drop(guard);
    tokio::time::timeout(DEADLINE, write)
        .await
        .expect("dropping the guard resumes the paused PUT")
        .expect("PUT task succeeds");
    assert_eq!(get_text(&service, key).await, "visible before response");
}

#[tokio::test(start_paused = true)]
async fn delayed_get_yields_the_runtime_and_respects_its_deadline() {
    let (faults, service) = fault_fixture();
    let key = "/celld/delayed-get";
    put(&service, key, "payload").await;
    let guard = faults
        .point("s3.get_object.before")
        .scoped(Action::Sleep(Duration::from_secs(10)).times(1))
        .unwrap();
    let reader = service.clone();
    let read = tokio::spawn(async move { get_text(&reader, key).await });
    tokio::time::timeout(DEADLINE, guard.wait_for_hits(1))
        .await
        .expect("GET selects the delay");

    assert_eq!(get_text(&service, key).await, "payload");
    put(&service, "/celld/while-delayed", "independent PUT").await;
    assert!(!read.is_finished());
    tokio::time::advance(Duration::from_secs(9)).await;
    tokio::task::yield_now().await;
    assert!(!read.is_finished());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        tokio::time::timeout(DEADLINE, read)
            .await
            .expect("GET resumes at the delay deadline")
            .expect("GET task succeeds"),
        "payload"
    );
    assert_eq!(guard.snapshot().triggered, 1);
}

#[tokio::test]
async fn failed_multipart_completion_after_commit_keeps_object_and_consumes_upload() {
    let (faults, service) = fault_fixture();
    let key = "/celld/committed-multipart";
    let id = initiate(&service, key, &[]).await;
    let etag = upload(&service, key, &id, 1, "assembled object").await;
    let _guard = faults
        .point("s3.complete_multipart_upload.after_commit")
        .scoped(Action::Return(S3Fault::ServiceUnavailable).times(1))
        .unwrap();

    let response = complete(&service, key, &id, &[(1, &etag)], &[]).await;
    expect_error(
        response,
        StatusCode::SERVICE_UNAVAILABLE,
        "ServiceUnavailable",
    )
    .await;
    assert_eq!(get_text(&service, key).await, "assembled object");
    let retry = complete(&service, key, &id, &[(1, &etag)], &[]).await;
    expect_error(retry, StatusCode::NOT_FOUND, "NoSuchUpload").await;
    assert_eq!(get_text(&service, key).await, "assembled object");
}

#[tokio::test]
async fn failed_delete_after_commit_removes_object_and_allows_idempotent_retry() {
    let (faults, service) = fault_fixture();
    let key = "/celld/committed-delete";
    put(&service, key, "remove me").await;
    let _guard = faults
        .point("s3.delete_object.after_commit")
        .scoped(Action::Return(S3Fault::ServiceUnavailable).times(1))
        .unwrap();

    let response = call(&service, request(Method::DELETE, key, Body::empty())).await;
    expect_error(
        response,
        StatusCode::SERVICE_UNAVAILABLE,
        "ServiceUnavailable",
    )
    .await;
    assert_eq!(
        status(&service, Method::HEAD, key).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        status(&service, Method::DELETE, key).await,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn truncated_body_delivers_the_chunks_before_the_fault_then_recovers() {
    let store = MemoryS3::with_buckets(["celld"]);
    let body_point = store.faults().bodies().point("s3.get_object.body");
    let service = s3_service(store);
    let key = "/celld/chunked";
    let contents = vec![b'x'; 2 * BODY_CHUNK_SIZE + 1];
    put(&service, key, contents.clone()).await;
    let guard = body_point
        .scoped(
            Action::Off
                .times(1)
                .or_else(Action::Return(BodyFault::Truncate).times(1)),
        )
        .unwrap();

    // The headers promise the whole object before the second chunk fails.
    let response = call(&service, request(Method::GET, key, Body::empty())).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        header(&response, "content-length"),
        contents.len().to_string()
    );
    let (received, error) = drain_body(response.into_body()).await;
    assert_eq!(received, BODY_CHUNK_SIZE);
    assert!(
        error
            .as_deref()
            .is_some_and(|error| error.contains("truncated by chaos3")),
        "{error:?}"
    );
    assert_eq!(guard.snapshot().hits, 2);

    // The plan is exhausted, so the next read streams every chunk.
    let response = call(&service, request(Method::GET, key, Body::empty())).await;
    assert_eq!(
        drain_body(response.into_body()).await,
        (contents.len(), None)
    );
    assert_eq!(guard.snapshot().hits, 5);
    assert_eq!(status(&service, Method::HEAD, key).await, StatusCode::OK);
    assert_eq!(guard.snapshot().hits, 5, "HEAD streams no body");
}
