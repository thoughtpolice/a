// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! XML request/response binding tests.

use crate::xml;

#[test]
fn list_bucket_result() {
    // interleaved Contents/CommonPrefixes, XML-escaped keys, and fields we
    // deliberately ignore (Name, KeyCount, ...)
    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <Prefix></Prefix>
  <KeyCount>3</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <Contents>
    <Key>a &amp; b.txt</Key>
    <LastModified>2009-10-12T17:50:30.000Z</LastModified>
    <ETag>&quot;fba9dede5f27731c9771645a39863328&quot;</ETag>
    <Size>434234</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes>
    <Prefix>photos/</Prefix>
  </CommonPrefixes>
  <Contents>
    <Key>plain.txt</Key>
    <LastModified>2026-01-01T00:00:00Z</LastModified>
    <Size>0</Size>
  </Contents>
  <CommonPrefixes>
    <Prefix>videos/</Prefix>
  </CommonPrefixes>
  <NextContinuationToken>token-123</NextContinuationToken>
</ListBucketResult>"#;

    let parsed: xml::ListBucketResult = xml::parse(body.as_bytes()).unwrap();

    assert_eq!(parsed.next_continuation_token.as_deref(), Some("token-123"));
    assert_eq!(parsed.contents.len(), 2);
    assert_eq!(parsed.contents[0].key, "a & b.txt");
    assert_eq!(parsed.contents[0].size, 434234);
    assert_eq!(
        parsed.contents[0].e_tag.as_deref(),
        Some("\"fba9dede5f27731c9771645a39863328\""),
    );
    assert_eq!(
        parsed.contents[0].last_modified.to_rfc3339(),
        "2009-10-12T17:50:30+00:00",
    );
    assert_eq!(parsed.contents[1].key, "plain.txt");
    assert_eq!(parsed.contents[1].e_tag, None);
    let prefixes: Vec<_> = parsed
        .common_prefixes
        .iter()
        .map(|p| p.prefix.as_str())
        .collect();
    assert_eq!(prefixes, ["photos/", "videos/"]);
}

#[test]
fn list_bucket_result_empty() {
    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <KeyCount>0</KeyCount>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>"#;

    let parsed: xml::ListBucketResult = xml::parse(body.as_bytes()).unwrap();
    assert!(parsed.contents.is_empty());
    assert!(parsed.common_prefixes.is_empty());
    assert_eq!(parsed.next_continuation_token, None);
}

#[test]
fn initiate_multipart_upload_result() {
    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>bucket</Bucket>
  <Key>large.bin</Key>
  <UploadId>VXBsb2FkIElE</UploadId>
</InitiateMultipartUploadResult>"#;

    let parsed: xml::InitiateMultipartUploadResult = xml::parse(body.as_bytes()).unwrap();
    assert_eq!(parsed.upload_id, "VXBsb2FkIElE");
}

#[test]
fn complete_multipart_upload_result() {
    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>http://bucket.s3.amazonaws.com/large.bin</Location>
  <Bucket>bucket</Bucket>
  <Key>large.bin</Key>
  <ETag>"3858f62230ac3c915f300c664312c11f-2"</ETag>
</CompleteMultipartUploadResult>"#;

    let parsed: xml::CompleteMultipartUploadResult = xml::parse(body.as_bytes()).unwrap();
    assert_eq!(parsed.e_tag, "\"3858f62230ac3c915f300c664312c11f-2\"");
}

#[test]
fn complete_multipart_upload_body() {
    let request = xml::CompleteMultipartUpload {
        part: vec![
            xml::CompletedPart {
                e_tag: "\"etag-1\"".to_string(),
                part_number: 1,
            },
            xml::CompletedPart {
                e_tag: "\"etag-2\"".to_string(),
                part_number: 2,
            },
        ],
    };

    assert_eq!(
        xml::serialize(&request).unwrap(),
        "<CompleteMultipartUpload>\
            <Part><ETag>\"etag-1\"</ETag><PartNumber>1</PartNumber></Part>\
            <Part><ETag>\"etag-2\"</ETag><PartNumber>2</PartNumber></Part>\
         </CompleteMultipartUpload>",
    );
}
