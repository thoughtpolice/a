// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Wire-protocol tests for [`crate::memory::MemoryS3`].
//!
//! Requests pass through `s3s::S3Service`, so these tests exercise the actual
//! path-style S3 routing, headers, XML codecs, range status, and multipart
//! protocol used by celld's object-store client.

use http::{Method, Request, Response, StatusCode};
use http_body_util::BodyExt;
use s3s::Body;
use s3s::service::S3Service;

use crate::memory::{MIN_PART_SIZE, MemoryS3};
use crate::service as s3_service;

#[path = "chaos_test.rs"]
mod campaign;
#[path = "faults_test.rs"]
mod faults;
#[path = "listing_test.rs"]
mod listing;
#[path = "multipart_test.rs"]
mod multipart;
#[path = "objects_test.rs"]
mod objects;

struct TestBody(Body);

impl From<Body> for TestBody {
    fn from(body: Body) -> Self {
        Self(body)
    }
}

impl From<&str> for TestBody {
    fn from(body: &str) -> Self {
        Self(body.to_owned().into())
    }
}

impl From<String> for TestBody {
    fn from(body: String) -> Self {
        Self(body.into())
    }
}

impl From<Vec<u8>> for TestBody {
    fn from(body: Vec<u8>) -> Self {
        Self(body.into())
    }
}

fn fixture() -> S3Service {
    s3_service(MemoryS3::with_buckets(["celld"]))
}

async fn call(service: &S3Service, request: Request<Body>) -> Response<Body> {
    service.call(request).await.expect("S3 HTTP service call")
}

fn with_headers(
    method: Method,
    uri: &str,
    body: impl Into<TestBody>,
    headers: &[(&str, &str)],
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body.into().0).expect("build S3 request")
}

fn request(method: Method, uri: &str, body: impl Into<TestBody>) -> Request<Body> {
    with_headers(method, uri, body, &[])
}

/// The status of a bodiless request, for the many "is it there" checks.
async fn status(service: &S3Service, method: Method, uri: &str) -> StatusCode {
    call(service, request(method, uri, Body::empty()))
        .await
        .status()
}

async fn body_text(response: Response<Body>) -> String {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect S3 response")
        .to_bytes();
    String::from_utf8(bytes.to_vec()).expect("S3 XML is UTF-8")
}

/// Read a body frame by frame until it ends or fails, returning the bytes
/// received first and the error text, if any.
async fn drain_body(mut body: Body) -> (usize, Option<String>) {
    let mut received = 0;
    while let Some(frame) = body.frame().await {
        match frame {
            Ok(frame) => received += frame.data_ref().map_or(0, |data| data.len()),
            Err(error) => return (received, Some(error.to_string())),
        }
    }
    (received, None)
}

fn xml_values(document: &str, name: &str) -> Vec<String> {
    let mut reader = quick_xml::Reader::from_str(document);
    let mut values = Vec::new();
    loop {
        match reader.read_event().expect("valid S3 XML") {
            quick_xml::events::Event::Start(element) if element.name().as_ref() == name => {
                let text = reader.read_text(element.name()).expect("XML text");
                let text = text.into_inner();
                values.push(
                    quick_xml::escape::unescape(&text)
                        .expect("XML entities")
                        .into_owned(),
                );
            }
            quick_xml::events::Event::Empty(element) if element.name().as_ref() == name => {
                values.push(String::new());
            }
            quick_xml::events::Event::Eof => break,
            _ => {}
        }
    }
    values
}

fn header(response: &Response<Body>, name: &str) -> String {
    response
        .headers()
        .get(name)
        .unwrap_or_else(|| panic!("missing {name}"))
        .to_str()
        .expect("ASCII header")
        .to_owned()
}

async fn expect_error(response: Response<Body>, expected: StatusCode, code: &str) {
    let actual = response.status();
    let body = body_text(response).await;
    assert_eq!(actual, expected, "{body}");
    assert_eq!(xml_values(&body, "Code"), [code], "{body}");
}

async fn put(service: &S3Service, uri: &str, body: impl Into<TestBody>) -> String {
    let response = call(service, request(Method::PUT, uri, body)).await;
    assert_eq!(response.status(), StatusCode::OK);
    header(&response, "etag")
}

/// GET `uri`, which must succeed, and return its body as text.
async fn get_text(service: &S3Service, uri: &str) -> String {
    let response = call(service, request(Method::GET, uri, Body::empty())).await;
    let actual = response.status();
    let body = body_text(response).await;
    assert_eq!(actual, StatusCode::OK, "{uri}: {body}");
    body
}

async fn initiate(service: &S3Service, key: &str, headers: &[(&str, &str)]) -> String {
    let response = call(
        service,
        with_headers(
            Method::POST,
            &format!("{key}?uploads"),
            Body::empty(),
            headers,
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    xml_values(&body_text(response).await, "UploadId")
        .pop()
        .unwrap()
}

async fn upload(
    service: &S3Service,
    key: &str,
    id: &str,
    number: i32,
    body: impl Into<TestBody>,
) -> String {
    put(
        service,
        &format!("{key}?uploadId={id}&partNumber={number}"),
        body,
    )
    .await
}

fn completion(parts: &[(i32, &str)]) -> String {
    let mut xml = "<CompleteMultipartUpload>".to_owned();
    for (number, etag) in parts {
        xml.push_str(&format!(
            "<Part><PartNumber>{number}</PartNumber><ETag>{etag}</ETag></Part>"
        ));
    }
    xml.push_str("</CompleteMultipartUpload>");
    xml
}

async fn complete(
    service: &S3Service,
    key: &str,
    id: &str,
    parts: &[(i32, &str)],
    headers: &[(&str, &str)],
) -> Response<Body> {
    call(
        service,
        with_headers(
            Method::POST,
            &format!("{key}?uploadId={id}"),
            completion(parts),
            headers,
        ),
    )
    .await
}

#[tokio::test]
async fn wire_protocol_round_trips_core_celld_operations() {
    let service = fixture();
    let key = "/celld/epochs/0001/state.json";
    let create = call(
        &service,
        with_headers(
            Method::PUT,
            key,
            "first-value",
            &[("if-none-match", "*"), ("x-amz-meta-purpose", "epoch")],
        ),
    )
    .await;
    assert_eq!(create.status(), StatusCode::OK);
    let first_etag = header(&create, "etag");

    let duplicate = with_headers(Method::PUT, key, "duplicate", &[("if-none-match", "*")]);
    assert_eq!(
        call(&service, duplicate).await.status(),
        StatusCode::PRECONDITION_FAILED
    );

    let range = with_headers(Method::GET, key, Body::empty(), &[("range", "bytes=1-5")]);
    let range = call(&service, range).await;
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(header(&range, "content-range"), "bytes 1-5/11");
    assert_eq!(body_text(range).await, "irst-");

    let head = call(&service, request(Method::HEAD, key, Body::empty())).await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(header(&head, "content-length"), "11");
    assert_eq!(header(&head, "x-amz-meta-purpose"), "epoch");

    let update = with_headers(
        Method::PUT,
        key,
        "second-value",
        &[("if-match", &first_etag)],
    );
    assert_eq!(call(&service, update).await.status(), StatusCode::OK);

    let list = get_text(&service, "/celld?list-type=2&prefix=epochs").await;
    assert_eq!(xml_values(&list, "Key"), ["epochs/0001/state.json"]);

    assert_eq!(
        status(&service, Method::DELETE, key).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        status(&service, Method::HEAD, key).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn wire_protocol_multipart_upload_round_trips() {
    let service = fixture();
    let key = "/celld/bundles/large.bin";
    let id = initiate(&service, key, &[]).await;
    let first = vec![b'a'; MIN_PART_SIZE];
    let second = vec![b'b'; 1024];
    let first_etag = upload(&service, key, &id, 1, first.clone()).await;
    let second_etag = upload(&service, key, &id, 2, second.clone()).await;
    let response = complete(
        &service,
        key,
        &id,
        &[(1, &first_etag), (2, &second_etag)],
        &[],
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        body_text(response).await
    );

    let get = call(&service, request(Method::GET, key, Body::empty())).await;
    assert_eq!(get.status(), StatusCode::OK);
    let body = get.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body.len(), first.len() + second.len());
    assert_eq!(&body[..first.len()], first.as_slice());
    assert_eq!(&body[first.len()..], second.as_slice());
}
