// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn query(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[tokio::test]
async fn bucket_lifecycle_recreates_idempotently_and_rejects_nonempty_deletion() {
    let service = s3_service(MemoryS3::default());
    assert!(xml_values(&get_text(&service, "/").await, "Name").is_empty());
    let create = call(&service, request(Method::PUT, "/new-bucket", Body::empty())).await;
    assert_eq!(create.status(), StatusCode::OK);
    assert_eq!(header(&create, "location"), "/new-bucket");
    let head = call(
        &service,
        request(Method::HEAD, "/new-bucket", Body::empty()),
    )
    .await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(header(&head, "x-amz-bucket-region"), "us-east-1");
    put(&service, "/new-bucket/key", "data").await;
    // us-east-1 re-creates a bucket you already own idempotently and keeps its
    // contents, unlike the 409 BucketAlreadyOwnedByYou other regions return.
    let again = call(&service, request(Method::PUT, "/new-bucket", Body::empty())).await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(header(&again, "location"), "/new-bucket");
    assert_eq!(get_text(&service, "/new-bucket/key").await, "data");
    expect_error(
        call(
            &service,
            request(Method::DELETE, "/new-bucket", Body::empty()),
        )
        .await,
        StatusCode::CONFLICT,
        "BucketNotEmpty",
    )
    .await;
    assert_eq!(get_text(&service, "/new-bucket/key").await, "data");
    call(
        &service,
        request(Method::DELETE, "/new-bucket/key", Body::empty()),
    )
    .await;
    assert_eq!(
        status(&service, Method::DELETE, "/new-bucket").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        status(&service, Method::HEAD, "/new-bucket").await,
        StatusCode::NOT_FOUND
    );
    expect_error(
        call(
            &service,
            request(Method::DELETE, "/new-bucket", Body::empty()),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NoSuchBucket",
    )
    .await;
    assert!(xml_values(&get_text(&service, "/").await, "Name").is_empty());
}

#[tokio::test]
async fn bucket_pagination_follows_tokens_to_completion_with_a_prefix() {
    let service = s3_service(MemoryS3::with_buckets([
        "page-e", "page-b", "other", "page-d", "page-a", "page-c",
    ]));
    let mut token: Option<String> = None;
    let mut names = Vec::new();
    for expected in [
        vec!["page-a", "page-b"],
        vec!["page-c", "page-d"],
        vec!["page-e"],
    ] {
        let mut uri = "/?max-buckets=2&prefix=page-".to_owned();
        if let Some(token) = &token {
            uri.push_str(&format!("&continuation-token={}", query(token)));
        }
        let xml = get_text(&service, &uri).await;
        let page = xml_values(&xml, "Name");
        assert_eq!(page, expected);
        assert_eq!(xml_values(&xml, "Prefix"), ["page-"]);
        assert_eq!(xml_values(&xml, "CreationDate").len(), page.len());
        let next = xml_values(&xml, "ContinuationToken").into_iter().next();
        if names.len() < 4 {
            assert!(next.is_some());
        } else {
            assert!(next.is_none());
        }
        assert_ne!(next, token);
        token = next;
        names.extend(page);
    }
    assert_eq!(names, ["page-a", "page-b", "page-c", "page-d", "page-e"]);
}

#[tokio::test]
async fn bucket_pagination_omits_tokens_for_exact_and_empty_pages() {
    let service = s3_service(MemoryS3::with_buckets(["bucket-b", "bucket-a"]));
    for uri in [
        "/",
        "/?max-buckets=2",
        "/?max-buckets=10",
        "/?prefix=absent",
        "/?continuation-token=z",
    ] {
        let xml = get_text(&service, uri).await;
        assert!(
            xml_values(&xml, "ContinuationToken").is_empty(),
            "{uri}: {xml}"
        );
    }
    assert!(xml_values(&get_text(&service, "/?prefix=absent").await, "Name").is_empty());
}

#[tokio::test]
async fn bucket_page_limits_are_validated() {
    let service = fixture();
    for max in [-1, 0, 10001] {
        expect_error(
            call(
                &service,
                request(Method::GET, &format!("/?max-buckets={max}"), Body::empty()),
            )
            .await,
            StatusCode::BAD_REQUEST,
            "InvalidArgument",
        )
        .await;
    }
    assert_eq!(
        xml_values(&get_text(&service, "/?max-buckets=10000").await, "Name"),
        ["celld"]
    );
}

#[tokio::test]
async fn object_listings_preserve_sorting_sizes_etags_and_xml_text() {
    let service = fixture();
    let mut etags = Vec::new();
    for (uri, value) in [
        ("/celld/prefix/b", "bb"),
        ("/celld/prefix/a%26%3C", "a"),
        ("/celld/unrelated", "c"),
    ] {
        etags.push(put(&service, uri, value).await);
    }
    let xml = get_text(&service, "/celld?list-type=2&prefix=prefix%2F").await;
    assert_eq!(xml_values(&xml, "Name"), ["celld"]);
    assert_eq!(xml_values(&xml, "Key"), ["prefix/a&<", "prefix/b"]);
    assert_eq!(xml_values(&xml, "Size"), ["1", "2"]);
    assert_eq!(
        xml_values(&xml, "ETag"),
        [etags[1].clone(), etags[0].clone()]
    );
    assert_eq!(xml_values(&xml, "LastModified").len(), 2);
    assert_eq!(xml_values(&xml, "KeyCount"), ["2"]);
    assert_eq!(xml_values(&xml, "IsTruncated"), ["false"]);
    assert!(xml_values(&xml, "EncodingType").is_empty());
    assert!(xml_values(&xml, "NextContinuationToken").is_empty());
}

#[tokio::test]
async fn delimiter_groups_count_toward_pages_and_are_not_repeated() {
    let service = fixture();
    for key in ["z", "b/second", "d/deep/child", "a", "b/first", "c"] {
        put(&service, &format!("/celld/{key}"), "data").await;
    }
    let mut token: Option<String> = None;
    for (keys, prefixes, truncated, count) in [
        (vec!["a"], vec!["b/"], "true", "2"),
        (vec!["c"], vec!["d/"], "true", "2"),
        (vec!["z"], vec![], "false", "1"),
    ] {
        let mut uri = "/celld?list-type=2&delimiter=%2F&max-keys=2".to_owned();
        if let Some(token) = &token {
            uri.push_str(&format!("&continuation-token={}", query(token)));
        }
        let xml = get_text(&service, &uri).await;
        assert_eq!(xml_values(&xml, "Key"), keys);
        assert_eq!(xml_values(&xml, "Prefix"), prefixes);
        assert_eq!(xml_values(&xml, "IsTruncated"), [truncated]);
        assert_eq!(xml_values(&xml, "KeyCount"), [count]);
        assert_eq!(
            xml_values(&xml, "ContinuationToken"),
            token.iter().cloned().collect::<Vec<_>>()
        );
        let next = xml_values(&xml, "NextContinuationToken").into_iter().next();
        assert_eq!(next.is_some(), truncated == "true");
        token = next;
    }
}

#[tokio::test]
async fn start_after_filters_common_prefixes_and_tokens_take_precedence() {
    let service = fixture();
    for key in ["a/child", "b", "c"] {
        put(&service, &format!("/celld/{key}"), "data").await;
    }
    let xml = get_text(
        &service,
        "/celld?list-type=2&delimiter=%2F&start-after=a%2Fchild&max-keys=1",
    )
    .await;
    assert_eq!(xml_values(&xml, "Key"), ["b"]);
    assert!(xml_values(&xml, "Prefix").is_empty());
    assert_eq!(xml_values(&xml, "StartAfter"), ["a/child"]);
    let token = xml_values(&xml, "NextContinuationToken").pop().unwrap();
    let xml = get_text(
        &service,
        &format!(
            "/celld?list-type=2&start-after=z&continuation-token={}",
            query(&token)
        ),
    )
    .await;
    assert_eq!(xml_values(&xml, "Key"), ["c"]);
}

#[tokio::test]
async fn empty_delimiters_and_zero_or_empty_pages_terminate_cleanly() {
    let service = fixture();
    put(&service, "/celld/a/b", "data").await;
    let xml = get_text(&service, "/celld?list-type=2&delimiter=").await;
    assert_eq!(xml_values(&xml, "Key"), ["a/b"]);
    for query in ["max-keys=0", "prefix=absent", "start-after=z"] {
        let xml = get_text(&service, &format!("/celld?list-type=2&{query}")).await;
        assert_eq!(xml_values(&xml, "KeyCount"), ["0"]);
        assert_eq!(xml_values(&xml, "IsTruncated"), ["false"]);
        assert!(xml_values(&xml, "Key").is_empty());
        assert!(xml_values(&xml, "NextContinuationToken").is_empty());
    }
    expect_error(
        call(
            &service,
            request(Method::GET, "/celld?list-type=2&max-keys=-1", Body::empty()),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "InvalidArgument",
    )
    .await;
}

#[tokio::test]
async fn object_pages_are_capped_at_one_thousand() {
    let service = fixture();
    for index in 0..1001 {
        put(&service, &format!("/celld/key-{index:04}"), "").await;
    }
    for suffix in ["", "&max-keys=2000"] {
        let xml = get_text(&service, &format!("/celld?list-type=2{suffix}")).await;
        assert_eq!(xml_values(&xml, "Key").len(), 1000);
        assert_eq!(xml_values(&xml, "MaxKeys"), ["1000"]);
        assert_eq!(xml_values(&xml, "IsTruncated"), ["true"]);
        let token = xml_values(&xml, "NextContinuationToken").pop().unwrap();
        let xml = get_text(
            &service,
            &format!("/celld?list-type=2&continuation-token={}", query(&token)),
        )
        .await;
        assert_eq!(xml_values(&xml, "Key"), ["key-1000"]);
        assert_eq!(xml_values(&xml, "IsTruncated"), ["false"]);
    }
}

#[tokio::test]
async fn url_encoding_preserves_key_identity_and_all_listing_fields() {
    let service = fixture();
    for (raw, encoded) in [
        ("literal%2Fname.txt", "literal%252Fname.txt"),
        ("space + name", "space%20%2B%20name"),
        ("café/雪", "caf%C3%A9%2F%E9%9B%AA"),
        ("xml<&>\"'", "xml%3C%26%3E%22%27"),
        ("unreserved-._~", "unreserved-._~"),
    ] {
        put(&service, &format!("/celld/{}", query(raw)), "data").await;
        let xml = get_text(
            &service,
            &format!("/celld?list-type=2&encoding-type=url&prefix={}", query(raw)),
        )
        .await;
        assert_eq!(xml_values(&xml, "EncodingType"), ["url"]);
        assert_eq!(xml_values(&xml, "Key"), [encoded]);
        assert_eq!(xml_values(&xml, "Prefix"), [encoded]);
        let listed = xml_values(&xml, "Key").pop().unwrap();
        assert_eq!(
            percent_encoding::percent_decode_str(&listed)
                .decode_utf8()
                .unwrap(),
            raw
        );
    }
    put(&service, "/celld/base%20%2B%25/dir%2B/child", "data").await;
    put(&service, "/celld/base%20%2B%25/z", "data").await;
    let xml = get_text(&service, "/celld?list-type=2&encoding-type=url&prefix=base%20%2B%25%2F&delimiter=%2F&start-after=base%20%2B%25%2Fa").await;
    assert_eq!(
        xml_values(&xml, "Prefix"),
        ["base%20%2B%25%2F", "base%20%2B%25%2Fdir%2B%2F"]
    );
    assert_eq!(xml_values(&xml, "Delimiter"), ["%2F"]);
    assert_eq!(xml_values(&xml, "StartAfter"), ["base%20%2B%25%2Fa"]);
    assert_eq!(xml_values(&xml, "Key"), ["base%20%2B%25%2Fz"]);
}

#[tokio::test]
async fn encoded_pagination_keeps_raw_order_and_opaque_tokens() {
    let service = fixture();
    // URL-encoded sorting would put %C3%A9 before z, reversing the last page.
    let keys = ["a%2Fb", "a+b", "z", "é"];
    for key in keys {
        put(&service, &format!("/celld/{}", query(key)), key.to_owned()).await;
    }
    let mut token: Option<String> = None;
    let mut seen = Vec::new();
    for index in 0..keys.len() {
        let mut uri = "/celld?list-type=2&encoding-type=url&max-keys=1".to_owned();
        if let Some(token) = &token {
            uri.push_str(&format!("&continuation-token={}", query(token)));
        }
        let xml = get_text(&service, &uri).await;
        let encoded = xml_values(&xml, "Key").pop().unwrap();
        let key = percent_encoding::percent_decode_str(&encoded)
            .decode_utf8()
            .unwrap()
            .into_owned();
        assert_eq!(
            get_text(&service, &format!("/celld/{}", query(&key))).await,
            key
        );
        seen.push(key);
        assert_eq!(
            xml_values(&xml, "ContinuationToken"),
            token.iter().cloned().collect::<Vec<_>>()
        );
        token = xml_values(&xml, "NextContinuationToken").into_iter().next();
        assert_eq!(token.is_some(), index + 1 < keys.len());
    }
    assert_eq!(seen, keys);
}
