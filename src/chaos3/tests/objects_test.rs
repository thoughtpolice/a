// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

const OLD_DATE: &str = "Sat, 01 Jan 2000 00:00:00 GMT";
const FUTURE_DATE: &str = "Fri, 01 Jan 2100 00:00:00 GMT";

#[tokio::test]
async fn binary_objects_preserve_headers_and_metadata() {
    let service = fixture();
    let bytes = vec![0, 255, 128, 1, b'\r', b'\n'];
    let headers = [
        ("content-type", "application/octet-stream"),
        ("cache-control", "max-age=60"),
        ("content-disposition", "attachment; filename=data.bin"),
        ("content-encoding", "identity"),
        ("content-language", "en"),
        ("x-amz-meta-purpose", "test value"),
        ("x-amz-meta-other", "second"),
    ];
    let response = call(
        &service,
        with_headers(Method::PUT, "/celld/binary", bytes.clone(), &headers),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let etag = header(&response, "etag");
    for method in [Method::GET, Method::HEAD] {
        let response = call(
            &service,
            request(method.clone(), "/celld/binary", Body::empty()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header(&response, "etag"), etag);
        assert_eq!(header(&response, "content-length"), "6");
        assert_eq!(header(&response, "accept-ranges"), "bytes");
        for (name, value) in headers {
            assert_eq!(header(&response, name), value);
        }
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            body.as_ref(),
            if method == Method::GET {
                &bytes[..]
            } else {
                &[]
            }
        );
    }
    put(&service, "/celld/binary", "replacement").await;
    let head = call(
        &service,
        request(Method::HEAD, "/celld/binary", Body::empty()),
    )
    .await;
    assert_ne!(header(&head, "etag"), etag);
    assert!(!head.headers().contains_key("x-amz-meta-purpose"));
    assert!(!head.headers().contains_key("cache-control"));
}

#[tokio::test]
async fn missing_buckets_and_objects_have_distinct_errors() {
    let service = fixture();
    for method in [Method::GET, Method::PUT, Method::DELETE] {
        expect_error(
            call(&service, request(method, "/absent/key", Body::empty())).await,
            StatusCode::NOT_FOUND,
            "NoSuchBucket",
        )
        .await;
    }
    expect_error(
        call(
            &service,
            request(Method::GET, "/celld/absent", Body::empty()),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NoSuchKey",
    )
    .await;
    assert_eq!(
        status(&service, Method::HEAD, "/celld/absent").await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn full_and_ranged_reads_cover_inclusive_open_and_suffix_bounds() {
    let service = fixture();
    put(&service, "/celld/range", "0123456789").await;
    for (range, expected, content_range) in [
        ("bytes=0-0", "0", "bytes 0-0/10"),
        ("bytes=3-6", "3456", "bytes 3-6/10"),
        ("bytes=9-9", "9", "bytes 9-9/10"),
        ("bytes=7-", "789", "bytes 7-9/10"),
        ("bytes=7-999", "789", "bytes 7-9/10"),
        ("bytes=-3", "789", "bytes 7-9/10"),
        ("bytes=-100", "0123456789", "bytes 0-9/10"),
        ("bytes=0-9", "0123456789", "bytes 0-9/10"),
    ] {
        let response = call(
            &service,
            with_headers(
                Method::GET,
                "/celld/range",
                Body::empty(),
                &[("range", range)],
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(header(&response, "content-range"), content_range, "{range}");
        assert_eq!(
            header(&response, "content-length"),
            expected.len().to_string(),
            "{range}"
        );
        assert_eq!(body_text(response).await, expected, "{range}");
    }
    let get = call(
        &service,
        request(Method::GET, "/celld/range", Body::empty()),
    )
    .await;
    assert_eq!(get.status(), StatusCode::OK);
    assert!(!get.headers().contains_key("content-range"));
    assert_eq!(body_text(get).await, "0123456789");
}

#[tokio::test]
async fn unsatisfiable_ranges_leave_the_object_readable() {
    let service = fixture();
    put(&service, "/celld/range", "123").await;
    for range in ["bytes=3-", "bytes=100-200", "bytes=-0"] {
        expect_error(
            call(
                &service,
                with_headers(
                    Method::GET,
                    "/celld/range",
                    Body::empty(),
                    &[("range", range)],
                ),
            )
            .await,
            StatusCode::RANGE_NOT_SATISFIABLE,
            "InvalidRange",
        )
        .await;
    }
    assert_eq!(get_text(&service, "/celld/range").await, "123");
}

#[tokio::test]
async fn empty_objects_support_full_reads_and_reject_ranges() {
    let service = fixture();
    put(&service, "/celld/empty", Body::empty()).await;
    for method in [Method::GET, Method::HEAD] {
        for range in ["bytes=-1", "bytes=-100", "bytes=0-0", "bytes=0-"] {
            let response = call(
                &service,
                with_headers(
                    method.clone(),
                    "/celld/empty",
                    Body::empty(),
                    &[("range", range)],
                ),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{method} {range}"
            );
        }
        let response = call(&service, request(method, "/celld/empty", Body::empty())).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header(&response, "content-length"), "0");
        assert_eq!(
            header(&response, "etag"),
            "\"d41d8cd98f00b204e9800998ecf8427e\""
        );
        assert!(body_text(response).await.is_empty());
    }
}

#[tokio::test]
async fn returned_last_modified_round_trips_in_conditional_reads() {
    let service = fixture();
    put(&service, "/celld/dated", "data").await;
    let head = call(
        &service,
        request(Method::HEAD, "/celld/dated", Body::empty()),
    )
    .await;
    let last_modified = header(&head, "last-modified");
    for method in [Method::GET, Method::HEAD] {
        for (name, date, expected) in [
            (
                "if-modified-since",
                last_modified.as_str(),
                StatusCode::NOT_MODIFIED,
            ),
            (
                "if-unmodified-since",
                last_modified.as_str(),
                StatusCode::OK,
            ),
            ("if-modified-since", OLD_DATE, StatusCode::OK),
            (
                "if-unmodified-since",
                OLD_DATE,
                StatusCode::PRECONDITION_FAILED,
            ),
            ("if-modified-since", FUTURE_DATE, StatusCode::NOT_MODIFIED),
            ("if-unmodified-since", FUTURE_DATE, StatusCode::OK),
        ] {
            let response = call(
                &service,
                with_headers(
                    method.clone(),
                    "/celld/dated",
                    Body::empty(),
                    &[(name, date)],
                ),
            )
            .await;
            assert_eq!(response.status(), expected, "{method} {name}: {date}");
        }
    }
}

#[tokio::test]
async fn read_etags_and_dates_follow_http_precondition_precedence() {
    let service = fixture();
    let etag = put(&service, "/celld/conditional", "data").await;
    let stale = "\"stale\"";
    for method in [Method::GET, Method::HEAD] {
        for (headers, expected) in [
            (vec![("if-match", etag.as_str())], StatusCode::OK),
            (vec![("if-match", "*")], StatusCode::OK),
            (vec![("if-match", stale)], StatusCode::PRECONDITION_FAILED),
            (
                vec![("if-none-match", etag.as_str())],
                StatusCode::NOT_MODIFIED,
            ),
            (vec![("if-none-match", "*")], StatusCode::NOT_MODIFIED),
            (vec![("if-none-match", stale)], StatusCode::OK),
            (
                vec![
                    ("if-match", etag.as_str()),
                    ("if-unmodified-since", OLD_DATE),
                ],
                StatusCode::OK,
            ),
            (
                vec![("if-match", stale), ("if-unmodified-since", FUTURE_DATE)],
                StatusCode::PRECONDITION_FAILED,
            ),
            (
                vec![("if-none-match", stale), ("if-modified-since", FUTURE_DATE)],
                StatusCode::OK,
            ),
            (
                vec![
                    ("if-none-match", etag.as_str()),
                    ("if-modified-since", OLD_DATE),
                ],
                StatusCode::NOT_MODIFIED,
            ),
            (
                vec![("if-match", stale), ("if-none-match", etag.as_str())],
                StatusCode::PRECONDITION_FAILED,
            ),
            (
                vec![
                    ("if-unmodified-since", OLD_DATE),
                    ("if-none-match", etag.as_str()),
                ],
                StatusCode::PRECONDITION_FAILED,
            ),
            (
                vec![
                    ("if-unmodified-since", OLD_DATE),
                    ("if-modified-since", FUTURE_DATE),
                ],
                StatusCode::PRECONDITION_FAILED,
            ),
            (
                vec![
                    ("if-match", etag.as_str()),
                    ("if-modified-since", FUTURE_DATE),
                ],
                StatusCode::NOT_MODIFIED,
            ),
        ] {
            let response = call(
                &service,
                with_headers(
                    method.clone(),
                    "/celld/conditional",
                    Body::empty(),
                    &headers,
                ),
            )
            .await;
            assert_eq!(response.status(), expected, "{method} {headers:?}");
        }
    }
}

#[tokio::test]
async fn read_preconditions_are_checked_before_ranges() {
    let service = fixture();
    let etag = put(&service, "/celld/conditional", "data").await;
    for (name, value, expected) in [
        ("if-none-match", etag.as_str(), StatusCode::NOT_MODIFIED),
        ("if-match", "\"stale\"", StatusCode::PRECONDITION_FAILED),
    ] {
        let response = call(
            &service,
            with_headers(
                Method::GET,
                "/celld/conditional",
                Body::empty(),
                &[(name, value), ("range", "bytes=100-")],
            ),
        )
        .await;
        assert_eq!(response.status(), expected);
    }
}

#[tokio::test]
async fn conditional_puts_are_atomic_and_failed_writes_preserve_data() {
    let service = fixture();
    // An If-Match write against a key that does not exist reports NoSuchKey,
    // as AWS conditional writes do, rather than a precondition failure.
    for condition in ["*", "\"missing\""] {
        expect_error(
            call(
                &service,
                with_headers(
                    Method::PUT,
                    "/celld/cas",
                    "wrong",
                    &[("if-match", condition)],
                ),
            )
            .await,
            StatusCode::NOT_FOUND,
            "NoSuchKey",
        )
        .await;
    }
    let etag = put(&service, "/celld/cas", "original").await;
    for (name, value) in [
        ("if-match", "\"stale\""),
        ("if-none-match", "*"),
        ("if-none-match", etag.as_str()),
    ] {
        expect_error(
            call(
                &service,
                with_headers(Method::PUT, "/celld/cas", "wrong", &[(name, value)]),
            )
            .await,
            StatusCode::PRECONDITION_FAILED,
            "PreconditionFailed",
        )
        .await;
        let get = call(&service, request(Method::GET, "/celld/cas", Body::empty())).await;
        assert_eq!(header(&get, "etag"), etag);
        assert_eq!(body_text(get).await, "original");
    }
    let update = call(
        &service,
        with_headers(
            Method::PUT,
            "/celld/cas",
            "updated",
            &[("if-match", etag.as_str())],
        ),
    )
    .await;
    assert_eq!(update.status(), StatusCode::OK);
    assert_ne!(header(&update, "etag"), etag);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_conditional_writers_have_exactly_one_winner() {
    let service = fixture();
    for uri in ["/celld/create-race", "/celld/update-race"] {
        let existing = if uri.ends_with("update-race") {
            Some(put(&service, uri, "old").await)
        } else {
            None
        };
        let (name, value) = existing
            .as_ref()
            .map_or(("if-none-match", "*"), |etag| ("if-match", etag.as_str()));
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(8));
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..8 {
            let service = service.clone();
            let barrier = barrier.clone();
            let request = with_headers(
                Method::PUT,
                uri,
                format!("writer-{index}"),
                &[(name, value)],
            );
            tasks.spawn(async move {
                barrier.wait().await;
                (index, call(&service, request).await.status())
            });
        }
        let mut winners = Vec::new();
        while let Some(result) = tasks.join_next().await {
            let (index, status) = result.unwrap();
            if status == StatusCode::OK {
                winners.push(index);
            } else {
                assert_eq!(status, StatusCode::PRECONDITION_FAILED);
            }
        }
        assert_eq!(winners.len(), 1);
        let get = call(&service, request(Method::GET, uri, Body::empty())).await;
        assert_eq!(body_text(get).await, format!("writer-{}", winners[0]));
    }
}

#[tokio::test]
async fn conditional_and_repeated_deletes_preserve_the_right_object() {
    let service = fixture();
    let etag = put(&service, "/celld/deleted", "data").await;
    expect_error(
        call(
            &service,
            with_headers(
                Method::DELETE,
                "/celld/deleted",
                Body::empty(),
                &[("if-match", "\"wrong\"")],
            ),
        )
        .await,
        StatusCode::PRECONDITION_FAILED,
        "PreconditionFailed",
    )
    .await;
    assert_eq!(get_text(&service, "/celld/deleted").await, "data");
    let deleted = call(
        &service,
        with_headers(
            Method::DELETE,
            "/celld/deleted",
            Body::empty(),
            &[("if-match", &etag)],
        ),
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        status(&service, Method::DELETE, "/celld/deleted").await,
        StatusCode::NO_CONTENT
    );
    expect_error(
        call(
            &service,
            request(Method::GET, "/celld/deleted", Body::empty()),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NoSuchKey",
    )
    .await;
    // A conditional delete of the now-absent key reports NoSuchKey, matching the
    // conditional PUT path rather than the unconditional idempotent delete.
    expect_error(
        call(
            &service,
            with_headers(
                Method::DELETE,
                "/celld/deleted",
                Body::empty(),
                &[("if-match", &etag)],
            ),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NoSuchKey",
    )
    .await;
}

#[tokio::test]
async fn batch_delete_reports_missing_keys_and_supports_quiet_mode() {
    let service = fixture();
    for quiet in [false, true] {
        put(&service, "/celld/remove%26me", "data").await;
        put(&service, "/celld/keep", "preserved").await;
        let xml = format!(
            "<Delete><Quiet>{quiet}</Quiet><Object><Key>remove&amp;me</Key></Object><Object><Key>missing</Key></Object></Delete>"
        );
        let response = call(&service, request(Method::POST, "/celld?delete", xml)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let xml = body_text(response).await;
        assert_eq!(
            xml_values(&xml, "Key"),
            if quiet {
                vec![]
            } else {
                vec!["remove&me", "missing"]
            }
        );
        assert_eq!(
            status(&service, Method::HEAD, "/celld/remove%26me").await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(get_text(&service, "/celld/keep").await, "preserved");
    }
}

#[tokio::test]
async fn a_failed_request_stream_does_not_publish_partial_data() {
    let service = fixture();
    let etag = put(&service, "/celld/stream", "original").await;
    let stream = s3s::dto::StreamingBlob::wrap(futures::stream::iter([
        Ok(bytes::Bytes::from_static(b"partial")),
        Err(std::io::Error::other("test stream interrupted")),
    ]));
    expect_error(
        call(
            &service,
            request(Method::PUT, "/celld/stream", Body::from(stream)),
        )
        .await,
        StatusCode::INTERNAL_SERVER_ERROR,
        "InternalError",
    )
    .await;
    let get = call(
        &service,
        request(Method::GET, "/celld/stream", Body::empty()),
    )
    .await;
    assert_eq!(header(&get, "etag"), etag);
    assert_eq!(body_text(get).await, "original");
}

#[tokio::test]
async fn copy_object_duplicates_content_metadata_and_honours_conditions() {
    let service = s3_service(MemoryS3::with_buckets(["celld", "backup"]));
    let source = call(
        &service,
        with_headers(
            Method::PUT,
            "/celld/source",
            "payload",
            &[
                ("content-type", "text/plain"),
                ("x-amz-meta-team", "orchestra"),
            ],
        ),
    )
    .await;
    assert_eq!(source.status(), StatusCode::OK);
    let source_etag = header(&source, "etag");

    // The default (COPY) directive duplicates the body, metadata, and content
    // headers, and the destination keeps the single-part source ETag.
    let copy = call(
        &service,
        with_headers(
            Method::PUT,
            "/celld/copy",
            Body::empty(),
            &[("x-amz-copy-source", "/celld/source")],
        ),
    )
    .await;
    assert_eq!(copy.status(), StatusCode::OK);
    let xml = body_text(copy).await;
    assert_eq!(xml_values(&xml, "ETag"), [source_etag.clone()]);
    assert_eq!(xml_values(&xml, "LastModified").len(), 1);
    let head = call(
        &service,
        request(Method::HEAD, "/celld/copy", Body::empty()),
    )
    .await;
    assert_eq!(header(&head, "etag"), source_etag);
    assert_eq!(header(&head, "content-type"), "text/plain");
    assert_eq!(header(&head, "x-amz-meta-team"), "orchestra");
    assert_eq!(get_text(&service, "/celld/copy").await, "payload");

    // Copies may cross buckets.
    let cross = call(
        &service,
        with_headers(
            Method::PUT,
            "/backup/source",
            Body::empty(),
            &[("x-amz-copy-source", "/celld/source")],
        ),
    )
    .await;
    assert_eq!(cross.status(), StatusCode::OK);
    assert_eq!(
        header(
            &call(
                &service,
                request(Method::HEAD, "/backup/source", Body::empty())
            )
            .await,
            "etag"
        ),
        source_etag
    );

    // REPLACE swaps metadata and content headers while keeping the bytes.
    let replace = call(
        &service,
        with_headers(
            Method::PUT,
            "/celld/copy",
            Body::empty(),
            &[
                ("x-amz-copy-source", "/celld/source"),
                ("x-amz-metadata-directive", "REPLACE"),
                ("content-type", "application/json"),
                ("x-amz-meta-team", "celld"),
            ],
        ),
    )
    .await;
    assert_eq!(replace.status(), StatusCode::OK);
    let head = call(
        &service,
        request(Method::HEAD, "/celld/copy", Body::empty()),
    )
    .await;
    assert_eq!(header(&head, "content-type"), "application/json");
    assert_eq!(header(&head, "x-amz-meta-team"), "celld");
    assert_eq!(header(&head, "etag"), source_etag);

    // Copy-source preconditions gate the copy with a precondition failure.
    for guard in [
        ("x-amz-copy-source-if-match", "\"deadbeef\""),
        ("x-amz-copy-source-if-none-match", "*"),
    ] {
        expect_error(
            call(
                &service,
                with_headers(
                    Method::PUT,
                    "/celld/guarded",
                    Body::empty(),
                    &[("x-amz-copy-source", "/celld/source"), guard],
                ),
            )
            .await,
            StatusCode::PRECONDITION_FAILED,
            "PreconditionFailed",
        )
        .await;
    }

    // A missing source is NoSuchKey; an in-place COPY without REPLACE is rejected.
    expect_error(
        call(
            &service,
            with_headers(
                Method::PUT,
                "/celld/copy",
                Body::empty(),
                &[("x-amz-copy-source", "/celld/absent")],
            ),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NoSuchKey",
    )
    .await;
    expect_error(
        call(
            &service,
            with_headers(
                Method::PUT,
                "/celld/source",
                Body::empty(),
                &[("x-amz-copy-source", "/celld/source")],
            ),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "InvalidRequest",
    )
    .await;
}

/// Base64 checksums of `body`, computed with the same primitives the store uses.
fn body_checksums(body: &[u8]) -> s3s::dto::Checksum {
    use s3s::checksum::ChecksumHasher;
    use s3s::crypto::{Crc32, Md5, Sha256};
    let mut hasher = ChecksumHasher::default();
    hasher.crc32 = Some(Crc32::default());
    hasher.md5 = Some(Md5::default());
    hasher.sha256 = Some(Sha256::default());
    hasher.update(body);
    hasher.finalize()
}

#[tokio::test]
async fn body_checksums_are_verified_and_mismatches_are_rejected() {
    let service = fixture();
    let body = "checksum payload";
    let good = body_checksums(body.as_bytes());
    let bad = body_checksums(b"a completely different payload");

    for (name, value) in [
        ("content-md5", good.checksum_md5.clone().unwrap()),
        ("x-amz-checksum-crc32", good.checksum_crc32.clone().unwrap()),
        (
            "x-amz-checksum-sha256",
            good.checksum_sha256.clone().unwrap(),
        ),
    ] {
        let response = call(
            &service,
            with_headers(Method::PUT, "/celld/ok", body, &[(name, value.as_str())]),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{name}");
    }

    for (name, value) in [
        ("content-md5", bad.checksum_md5.clone().unwrap()),
        ("x-amz-checksum-crc32", bad.checksum_crc32.clone().unwrap()),
        (
            "x-amz-checksum-sha256",
            bad.checksum_sha256.clone().unwrap(),
        ),
    ] {
        expect_error(
            call(
                &service,
                with_headers(Method::PUT, "/celld/bad", body, &[(name, value.as_str())]),
            )
            .await,
            StatusCode::BAD_REQUEST,
            "BadDigest",
        )
        .await;
    }

    // A rejected write must leave nothing behind.
    assert_eq!(
        status(&service, Method::HEAD, "/celld/bad").await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn expires_header_is_stored_and_returned_on_reads() {
    let service = fixture();
    let expires = "Fri, 01 Jan 2027 00:00:00 GMT";
    assert_eq!(
        call(
            &service,
            with_headers(Method::PUT, "/celld/dated", "body", &[("expires", expires)]),
        )
        .await
        .status(),
        StatusCode::OK
    );
    let get = call(
        &service,
        request(Method::GET, "/celld/dated", Body::empty()),
    )
    .await;
    let head = call(
        &service,
        request(Method::HEAD, "/celld/dated", Body::empty()),
    )
    .await;
    // Both reads return the header and agree on its value.
    let value = header(&get, "expires");
    assert!(value.contains("2027"), "{value}");
    assert_eq!(header(&head, "expires"), value);
}
