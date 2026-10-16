// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A small S3 REST client.
//!
//! Requests go through reqwest, with TLS from native-tls, which this
//! repository backs with BoringSSL. They are signed with an in-crate AWS
//! Signature Version 4 implementation on the RustCrypto stack, so nothing
//! here links ring or aws-lc-rs.
//!
//! [`Client`] covers the object API that storage engines and coordination
//! code need. It reads objects with ranges and conditions, writes them
//! with `If-None-Match: *` or `If-Match` preconditions, and also deletes,
//! copies, lists, and runs multipart uploads. It retries transient failures,
//! reconciles writes whose retry finds the earlier attempt already applied,
//! and resumes response bodies that break off.
//!
//! Conditional writes have worked on AWS S3 since late 2024, and MinIO, R2
//! and Tigris support them as well. They are what makes compare-and-set on
//! a single object possible:
//!
//! ```no_run
//! # async fn example() -> s3_client::Result<()> {
//! use s3_client::{ClientBuilder, ErrorKind, GetObject, PutObject, WriteCondition};
//!
//! let client = ClientBuilder::from_env().with_bucket("my-bucket").build()?;
//! let current = client.get_object("state.json", &GetObject::default()).await?;
//! let e_tag = current.info.e_tag.clone().expect("S3 reports ETags");
//! let options = PutObject {
//!     condition: WriteCondition::Matches(e_tag),
//!     ..Default::default()
//! };
//! match client.put_object("state.json", "{}".into(), &options).await {
//!     Ok(_) => println!("swapped"),
//!     Err(e) if e.kind() == ErrorKind::PreconditionFailed => println!("lost the race"),
//!     Err(e) => return Err(e),
//! }
//! # Ok(())
//! # }
//! ```
//!
//! [`sigv4`] signs requests to other AWS-style services too.

mod body;
mod builder;
mod client;
mod error;
pub mod sigv4;
mod types;
mod xml;

pub use crate::builder::ClientBuilder;
pub use crate::client::Client;
pub use crate::error::{Error, ErrorKind, Result};
pub use crate::sigv4::Credentials;
pub use crate::types::{
    ByteRange, ByteStream, GetObject, GetObjectOutput, ListObjects, ListPage, ObjectAttributes,
    ObjectInfo, PutObject, PutObjectOutput, WriteCondition,
};

#[cfg(test)]
mod test_sigv4;

#[cfg(test)]
mod test_xml;

#[cfg(test_module_chaos3)]
mod test_chaos3;
