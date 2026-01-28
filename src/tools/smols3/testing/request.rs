// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! S3 HTTP request builder.

use bytes::Bytes;
use http::{Method, Request, Uri};

/// Builder for S3 HTTP requests.
///
/// Provides a fluent API for constructing S3-compatible HTTP requests
/// for use with the test harness.
pub struct S3Request {
    method: Method,
    uri: String,
    body: Option<Bytes>,
    headers: Vec<(String, String)>,
}

impl S3Request {
    // =========================================================================
    // Bucket operations
    // =========================================================================

    /// Create a request to create a bucket.
    pub fn create_bucket(bucket: &str) -> Self {
        Self {
            method: Method::PUT,
            uri: format!("/{bucket}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to delete a bucket.
    pub fn delete_bucket(bucket: &str) -> Self {
        Self {
            method: Method::DELETE,
            uri: format!("/{bucket}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to check if a bucket exists (HEAD bucket).
    pub fn head_bucket(bucket: &str) -> Self {
        Self {
            method: Method::HEAD,
            uri: format!("/{bucket}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to list all buckets.
    pub fn list_buckets() -> Self {
        Self {
            method: Method::GET,
            uri: "/".to_string(),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to get bucket location.
    pub fn get_bucket_location(bucket: &str) -> Self {
        Self {
            method: Method::GET,
            uri: format!("/{bucket}?location"),
            body: None,
            headers: vec![],
        }
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    /// Create a request to put an object.
    pub fn put_object(bucket: &str, key: &str) -> Self {
        Self {
            method: Method::PUT,
            uri: format!("/{bucket}/{key}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to get an object.
    pub fn get_object(bucket: &str, key: &str) -> Self {
        Self {
            method: Method::GET,
            uri: format!("/{bucket}/{key}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to check if an object exists (HEAD object).
    pub fn head_object(bucket: &str, key: &str) -> Self {
        Self {
            method: Method::HEAD,
            uri: format!("/{bucket}/{key}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to delete an object.
    pub fn delete_object(bucket: &str, key: &str) -> Self {
        Self {
            method: Method::DELETE,
            uri: format!("/{bucket}/{key}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to copy an object.
    pub fn copy_object(bucket: &str, key: &str, source_bucket: &str, source_key: &str) -> Self {
        Self {
            method: Method::PUT,
            uri: format!("/{bucket}/{key}"),
            body: None,
            headers: vec![(
                "x-amz-copy-source".to_string(),
                format!("/{source_bucket}/{source_key}"),
            )],
        }
    }

    // =========================================================================
    // List operations
    // =========================================================================

    /// Create a request to list objects (v1).
    pub fn list_objects(bucket: &str) -> Self {
        Self {
            method: Method::GET,
            uri: format!("/{bucket}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to list objects (v2).
    pub fn list_objects_v2(bucket: &str) -> Self {
        Self {
            method: Method::GET,
            uri: format!("/{bucket}?list-type=2"),
            body: None,
            headers: vec![],
        }
    }

    // =========================================================================
    // Multipart operations
    // =========================================================================

    /// Create a request to initiate a multipart upload.
    pub fn create_multipart_upload(bucket: &str, key: &str) -> Self {
        Self {
            method: Method::POST,
            uri: format!("/{bucket}/{key}?uploads"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to upload a part.
    pub fn upload_part(bucket: &str, key: &str, upload_id: &str, part_number: i32) -> Self {
        Self {
            method: Method::PUT,
            uri: format!("/{bucket}/{key}?partNumber={part_number}&uploadId={upload_id}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to complete a multipart upload.
    pub fn complete_multipart_upload(bucket: &str, key: &str, upload_id: &str) -> Self {
        Self {
            method: Method::POST,
            uri: format!("/{bucket}/{key}?uploadId={upload_id}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to abort a multipart upload.
    pub fn abort_multipart_upload(bucket: &str, key: &str, upload_id: &str) -> Self {
        Self {
            method: Method::DELETE,
            uri: format!("/{bucket}/{key}?uploadId={upload_id}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to list parts of a multipart upload.
    pub fn list_parts(bucket: &str, key: &str, upload_id: &str) -> Self {
        Self {
            method: Method::GET,
            uri: format!("/{bucket}/{key}?uploadId={upload_id}"),
            body: None,
            headers: vec![],
        }
    }

    /// Create a request to list in-progress multipart uploads.
    pub fn list_multipart_uploads(bucket: &str) -> Self {
        Self {
            method: Method::GET,
            uri: format!("/{bucket}?uploads"),
            body: None,
            headers: vec![],
        }
    }

    // =========================================================================
    // Builder methods
    // =========================================================================

    /// Set the request body.
    pub fn with_body(mut self, body: impl AsRef<[u8]>) -> Self {
        self.body = Some(Bytes::copy_from_slice(body.as_ref()));
        self
    }

    /// Set the Content-Type header.
    pub fn with_content_type(mut self, content_type: &str) -> Self {
        self.headers
            .push(("content-type".to_string(), content_type.to_string()));
        self
    }

    /// Set a byte range for the request (Range header).
    pub fn with_range(mut self, start: u64, end: u64) -> Self {
        self.headers
            .push(("range".to_string(), format!("bytes={start}-{end}")));
        self
    }

    /// Add a query parameter to the URI.
    pub fn with_query(mut self, key: &str, value: &str) -> Self {
        if self.uri.contains('?') {
            self.uri.push('&');
        } else {
            self.uri.push('?');
        }
        self.uri.push_str(key);
        self.uri.push('=');
        self.uri.push_str(value);
        self
    }

    /// Add prefix parameter for list operations.
    pub fn with_prefix(self, prefix: &str) -> Self {
        self.with_query("prefix", prefix)
    }

    /// Add delimiter parameter for list operations.
    pub fn with_delimiter(self, delimiter: &str) -> Self {
        self.with_query("delimiter", delimiter)
    }

    /// Add max-keys parameter for list operations.
    pub fn with_max_keys(self, max_keys: u32) -> Self {
        self.with_query("max-keys", &max_keys.to_string())
    }

    /// Add a custom header.
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    /// Add If-None-Match header for conditional writes.
    ///
    /// When set to "*", the request only succeeds if the object doesn't exist.
    pub fn with_if_none_match(self, value: &str) -> Self {
        self.with_header("if-none-match", value)
    }

    /// Add If-Match header for conditional writes.
    ///
    /// The request only succeeds if the object's ETag matches.
    pub fn with_if_match(self, etag: &str) -> Self {
        self.with_header("if-match", etag)
    }

    /// Build the HTTP request.
    pub fn build(self) -> Request<s3s::Body> {
        let uri: Uri = self.uri.parse().expect("invalid URI");

        let body = match self.body {
            Some(bytes) => s3s::Body::from(bytes),
            None => s3s::Body::empty(),
        };

        let mut builder = Request::builder().method(self.method).uri(uri);

        for (name, value) in self.headers {
            builder = builder.header(name, value);
        }

        builder.body(body).expect("failed to build request")
    }
}
