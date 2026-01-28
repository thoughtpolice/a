// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HTTP interaction test framework for smols3.
//!
//! This module provides a test harness for exercising the S3 API through
//! request/response flows without spinning up an actual TCP server.
//!
//! # Architecture
//!
//! The framework uses tower's Service trait to call S3Service directly:
//!
//! ```text
//! TestHarness<Store>
//!     └── S3Service (s3s)
//!          └── SmolS3
//!               └── Store (MemoryStore / FjallStore)
//! ```
//!
//! # Example
//!
//! ```ignore
//! use smols3_testing::{TestHarness, S3Request};
//! use store::MemoryStore;
//!
//! #[tokio::test]
//! async fn test_put_get() {
//!     let harness = TestHarness::new(MemoryStore::new());
//!
//!     // Create bucket
//!     let resp = harness.call(S3Request::create_bucket("test-bucket").build()).await;
//!     assert_eq!(resp.status(), 200);
//!
//!     // Put and get object
//!     harness.call(S3Request::put_object("test-bucket", "key").with_body(b"hello").build()).await;
//!     let resp = harness.call(S3Request::get_object("test-bucket", "key").build()).await;
//!     assert_eq!(resp.status(), 200);
//! }
//! ```

mod harness;
mod request;
mod response;

pub use harness::TestHarness;
pub use request::S3Request;
pub use response::{collect_body, Expect};
