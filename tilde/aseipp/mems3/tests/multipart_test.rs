// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn undersized_nonfinal_parts_fail_without_publishing_and_can_be_repaired() {
    let service = fixture();
    let key = "/celld/threshold";
    let original = put(&service, key, "original").await;
    let id = initiate(&service, key, &[]).await;
    let first = upload(&service, key, &id, 1, vec![b'a'; MIN_PART_SIZE - 1]).await;
    let last = upload(&service, key, &id, 2, "z").await;
    expect_error(
        complete(&service, key, &id, &[(1, &first), (2, &last)], &[]).await,
        StatusCode::BAD_REQUEST,
        "EntityTooSmall",
    )
    .await;
    let get = call(&service, request(Method::GET, key, Body::empty())).await;
    assert_eq!(header(&get, "etag"), original);
    assert_eq!(body_text(get).await, "original");

    let repaired = upload(&service, key, &id, 1, vec![b'a'; MIN_PART_SIZE]).await;
    assert_eq!(
        complete(&service, key, &id, &[(1, &repaired), (2, &last)], &[])
            .await
            .status(),
        StatusCode::OK
    );
    let get = call(&service, request(Method::GET, key, Body::empty())).await;
    assert_eq!(
        header(&get, "content-length"),
        (MIN_PART_SIZE + 1).to_string()
    );
    let bytes = get.into_body().collect().await.unwrap().to_bytes();
    assert!(bytes[..MIN_PART_SIZE].iter().all(|byte| *byte == b'a'));
    assert_eq!(bytes[MIN_PART_SIZE], b'z');
}

#[tokio::test]
async fn every_nonfinal_part_must_meet_the_size_minimum() {
    let service = fixture();
    let key = "/celld/middle";
    let id = initiate(&service, key, &[]).await;
    let first = upload(&service, key, &id, 1, vec![b'a'; MIN_PART_SIZE]).await;
    let middle = upload(&service, key, &id, 2, "small").await;
    let last = upload(&service, key, &id, 3, "end").await;
    expect_error(
        complete(
            &service,
            key,
            &id,
            &[(1, &first), (2, &middle), (3, &last)],
            &[],
        )
        .await,
        StatusCode::BAD_REQUEST,
        "EntityTooSmall",
    )
    .await;
    assert_eq!(
        status(&service, Method::HEAD, key).await,
        StatusCode::NOT_FOUND
    );
    // Only the selected parts are completed; part numbers need not be consecutive.
    assert_eq!(
        complete(&service, key, &id, &[(1, &first), (3, &last)], &[])
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn small_or_empty_single_parts_and_empty_final_parts_are_valid() {
    let service = fixture();
    for value in ["small", ""] {
        let key = "/celld/single";
        let id = initiate(&service, key, &[]).await;
        let tag = upload(&service, key, &id, 10000, value.to_owned()).await;
        assert_eq!(
            complete(&service, key, &id, &[(10000, &tag)], &[])
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(get_text(&service, key).await, value);
    }
    let key = "/celld/empty-final";
    let id = initiate(&service, key, &[]).await;
    let first = upload(&service, key, &id, 1, vec![b'a'; MIN_PART_SIZE]).await;
    let last = upload(&service, key, &id, 2, "").await;
    assert_eq!(
        complete(&service, key, &id, &[(1, &first), (2, &last)], &[])
            .await
            .status(),
        StatusCode::OK
    );
    let head = call(&service, request(Method::HEAD, key, Body::empty())).await;
    assert_eq!(header(&head, "content-length"), MIN_PART_SIZE.to_string());
}

#[tokio::test]
async fn invalid_etags_missing_parts_and_bad_order_leave_the_upload_usable() {
    let service = fixture();
    let key = "/celld/validate";
    let id = initiate(&service, key, &[]).await;
    let first = upload(&service, key, &id, 1, vec![b'a'; MIN_PART_SIZE]).await;
    let second = upload(&service, key, &id, 2, vec![b'b'; MIN_PART_SIZE]).await;
    for (parts, code) in [
        (vec![(1, "\"wrong\"")], "InvalidPart"),
        (vec![(3, first.as_str())], "InvalidPart"),
        (
            vec![(2, second.as_str()), (1, first.as_str())],
            "InvalidPartOrder",
        ),
        (
            vec![(1, first.as_str()), (1, first.as_str())],
            "InvalidPartOrder",
        ),
    ] {
        expect_error(
            complete(&service, key, &id, &parts, &[]).await,
            StatusCode::BAD_REQUEST,
            code,
        )
        .await;
        assert_eq!(
            status(&service, Method::HEAD, key).await,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        complete(&service, key, &id, &[(1, &first), (2, &second)], &[])
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn completion_requires_parts_numbers_and_etags() {
    let service = fixture();
    let key = "/celld/required";
    let id = initiate(&service, key, &[]).await;
    let tag = upload(&service, key, &id, 1, "data").await;
    for (xml, code) in [
        ("<CompleteMultipartUpload/>".to_owned(), "MalformedXML"),
        ("<CompleteMultipartUpload><Part><PartNumber>1</PartNumber></Part></CompleteMultipartUpload>".to_owned(), "InvalidPart"),
        (format!("<CompleteMultipartUpload><Part><ETag>{tag}</ETag></Part></CompleteMultipartUpload>"), "InvalidPart"),
    ] {
        expect_error(call(&service, request(Method::POST, &format!("{key}?uploadId={id}"), xml)).await,
            StatusCode::BAD_REQUEST, code).await;
    }
    assert_eq!(
        complete(&service, key, &id, &[(1, &tag)], &[])
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn upload_part_numbers_are_bounded_and_replacement_invalidates_the_old_etag() {
    let service = fixture();
    let key = "/celld/replace-part";
    let id = initiate(&service, key, &[]).await;
    for number in [-1, 0, 10001] {
        expect_error(
            call(
                &service,
                request(
                    Method::PUT,
                    &format!("{key}?uploadId={id}&partNumber={number}"),
                    "wrong",
                ),
            )
            .await,
            StatusCode::BAD_REQUEST,
            "InvalidArgument",
        )
        .await;
    }
    let old = upload(&service, key, &id, 1, "old").await;
    let new = upload(&service, key, &id, 1, "new").await;
    assert_ne!(old, new);
    expect_error(
        complete(&service, key, &id, &[(1, &old)], &[]).await,
        StatusCode::BAD_REQUEST,
        "InvalidPart",
    )
    .await;
    assert_eq!(
        complete(&service, key, &id, &[(1, &new)], &[])
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(get_text(&service, key).await, "new");
}

#[tokio::test]
async fn multipart_metadata_and_etags_survive_completion_and_conditional_reads() {
    let service = fixture();
    let key = "/celld/metadata";
    let headers = [
        ("content-type", "application/octet-stream"),
        ("content-language", "fr"),
        ("content-encoding", "identity"),
        ("content-disposition", "attachment"),
        ("cache-control", "no-cache"),
        ("x-amz-meta-purpose", "multipart"),
    ];
    let id = initiate(&service, key, &headers).await;
    let tag = upload(&service, key, &id, 1, "data").await;
    let response = complete(&service, key, &id, &[(1, &tag)], &[]).await;
    assert_eq!(response.status(), StatusCode::OK);
    let xml = body_text(response).await;
    let tag = xml_values(&xml, "ETag").pop().unwrap();
    assert_eq!(xml_values(&xml, "Key"), ["metadata"]);
    assert_eq!(xml_values(&xml, "Bucket"), ["celld"]);
    for method in [Method::GET, Method::HEAD] {
        let response = call(&service, request(method.clone(), key, Body::empty())).await;
        assert_eq!(header(&response, "etag"), tag);
        for (name, expected) in headers {
            assert_eq!(header(&response, name), expected);
        }
        let last_modified = header(&response, "last-modified");
        assert_eq!(
            call(
                &service,
                with_headers(
                    method,
                    key,
                    Body::empty(),
                    &[("if-modified-since", &last_modified)]
                )
            )
            .await
            .status(),
            StatusCode::NOT_MODIFIED
        );
    }
    assert_eq!(
        call(
            &service,
            with_headers(Method::GET, key, Body::empty(), &[("if-none-match", &tag)])
        )
        .await
        .status(),
        StatusCode::NOT_MODIFIED
    );
}

#[tokio::test]
async fn conditional_completion_does_not_consume_uploads_or_overwrite_conflicts() {
    let service = fixture();
    let key = "/celld/conditional-multipart";
    let old = put(&service, key, "original").await;
    let id = initiate(&service, key, &[]).await;
    let part = upload(&service, key, &id, 1, "updated").await;
    for (name, value) in [("if-none-match", "*"), ("if-match", "\"wrong\"")] {
        expect_error(
            complete(&service, key, &id, &[(1, &part)], &[(name, value)]).await,
            StatusCode::PRECONDITION_FAILED,
            "PreconditionFailed",
        )
        .await;
        let get = call(&service, request(Method::GET, key, Body::empty())).await;
        assert_eq!(header(&get, "etag"), old);
        assert_eq!(body_text(get).await, "original");
    }
    assert_eq!(
        complete(&service, key, &id, &[(1, &part)], &[("if-match", &old)])
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(get_text(&service, key).await, "updated");
    expect_error(
        complete(&service, key, &id, &[(1, &part)], &[]).await,
        StatusCode::NOT_FOUND,
        "NoSuchUpload",
    )
    .await;
}

#[tokio::test]
async fn upload_ids_are_unique_and_scoped_to_their_bucket_and_key() {
    let service = s3_service(MemoryS3::with_buckets(["celld", "other"]));
    let key = "/celld/scoped";
    let id = initiate(&service, key, &[]).await;
    let other_id = initiate(&service, key, &[]).await;
    assert_ne!(id, other_id);
    let tag = upload(&service, key, &id, 1, "data").await;
    for wrong in ["/celld/wrong", "/other/scoped"] {
        expect_error(
            call(
                &service,
                request(
                    Method::PUT,
                    &format!("{wrong}?uploadId={id}&partNumber=1"),
                    "wrong",
                ),
            )
            .await,
            StatusCode::NOT_FOUND,
            "NoSuchUpload",
        )
        .await;
        expect_error(
            complete(&service, wrong, &id, &[(1, &tag)], &[]).await,
            StatusCode::NOT_FOUND,
            "NoSuchUpload",
        )
        .await;
        expect_error(
            call(
                &service,
                request(
                    Method::DELETE,
                    &format!("{wrong}?uploadId={id}"),
                    Body::empty(),
                ),
            )
            .await,
            StatusCode::NOT_FOUND,
            "NoSuchUpload",
        )
        .await;
    }
    assert_eq!(
        complete(&service, key, &id, &[(1, &tag)], &[])
            .await
            .status(),
        StatusCode::OK
    );
    let tag = upload(&service, key, &other_id, 1, "second upload").await;
    expect_error(
        complete(
            &service,
            key,
            &other_id,
            &[(1, &tag)],
            &[("if-none-match", "*")],
        )
        .await,
        StatusCode::PRECONDITION_FAILED,
        "PreconditionFailed",
    )
    .await;
}

#[tokio::test]
async fn abort_discards_parts_and_preserves_an_existing_object() {
    let service = fixture();
    let key = "/celld/aborted";
    put(&service, key, "original").await;
    let id = initiate(&service, key, &[]).await;
    let tag = upload(&service, key, &id, 1, "unpublished").await;
    assert_eq!(
        status(&service, Method::DELETE, &format!("{key}?uploadId={id}")).await,
        StatusCode::NO_CONTENT
    );
    expect_error(
        complete(&service, key, &id, &[(1, &tag)], &[]).await,
        StatusCode::NOT_FOUND,
        "NoSuchUpload",
    )
    .await;
    expect_error(
        call(
            &service,
            request(
                Method::PUT,
                &format!("{key}?uploadId={id}&partNumber=1"),
                "wrong",
            ),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NoSuchUpload",
    )
    .await;
    expect_error(
        call(
            &service,
            request(
                Method::DELETE,
                &format!("{key}?uploadId={id}"),
                Body::empty(),
            ),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NoSuchUpload",
    )
    .await;
    assert_eq!(get_text(&service, key).await, "original");
}

#[tokio::test]
async fn deleting_and_recreating_a_bucket_does_not_resurrect_old_uploads() {
    let service = fixture();
    let key = "/celld/stale";
    let id = initiate(&service, key, &[]).await;
    let tag = upload(&service, key, &id, 1, "old bucket data").await;
    assert_eq!(
        status(&service, Method::DELETE, "/celld").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        status(&service, Method::PUT, "/celld").await,
        StatusCode::OK
    );
    expect_error(
        complete(&service, key, &id, &[(1, &tag)], &[]).await,
        StatusCode::NOT_FOUND,
        "NoSuchUpload",
    )
    .await;
    assert_eq!(
        status(&service, Method::HEAD, key).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn completed_multipart_etag_uses_the_aws_md5_of_md5s_formula() {
    let service = fixture();
    let key = "/celld/etag-formula";
    let id = initiate(&service, key, &[]).await;
    let first = upload(&service, key, &id, 1, vec![b'a'; MIN_PART_SIZE]).await;
    let last = upload(&service, key, &id, 2, "z").await;
    let response = complete(&service, key, &id, &[(1, &first), (2, &last)], &[]).await;
    assert_eq!(response.status(), StatusCode::OK);
    let final_etag = xml_values(&body_text(response).await, "ETag")
        .pop()
        .unwrap();
    // MD5(MD5(5 MiB of 'a') || MD5('z')) with the part count appended, computed
    // outside this crate and shared with tests/hurl/multipart.hurl.
    assert_eq!(final_etag, "\"8563290c5210e22ffe276e2320dc9d21-2\"");

    // GET and HEAD echo the same ETag the completion returned.
    let head = call(&service, request(Method::HEAD, key, Body::empty())).await;
    assert_eq!(header(&head, "etag"), final_etag);
}
