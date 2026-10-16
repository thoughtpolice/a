// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Where the queue file lives.
//!
//! The queue needs exactly two things from storage. It reads the file with
//! its version, and replaces it only if it is still at a given version. S3 does
//! both with `GetObject` and a conditional `PutObject`.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use s3_client::{ErrorKind, GetObject, PutObject, WriteCondition};

use crate::state::QueueState;

/// The queue file at some version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Versioned {
    pub state: QueueState,
    /// The version, which a write must name to replace it.
    pub e_tag: String,
}

/// A failed read or write of the queue file.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The file is not at the version the write named.
    #[error("the queue file changed since it was read")]
    Conflict,
    #[error("the queue file is not valid: {0}")]
    Corrupt(#[from] serde_json::Error),
    #[error(transparent)]
    Storage(Box<dyn std::error::Error + Send + Sync>),
}

/// The result of [`Store::load_if_changed`].
#[derive(Debug)]
pub enum Changed {
    Unchanged,
    /// The file changed, and is now this, or gone.
    Changed(Option<Versioned>),
}

/// Storage for one queue file.
#[async_trait]
pub trait Store: Send + Sync + 'static {
    /// The file, or `None` if there is none yet.
    async fn load(&self) -> Result<Option<Versioned>, StoreError>;

    /// The file, if it is no longer at version `e_tag`. Implementations
    /// can answer this more cheaply than [`load`](Self::load).
    async fn load_if_changed(&self, e_tag: &str) -> Result<Changed, StoreError> {
        Ok(match self.load().await? {
            Some(current) if current.e_tag == e_tag => Changed::Unchanged,
            other => Changed::Changed(other),
        })
    }

    /// Replace the file with `state` if it is at version `expected`, or
    /// create it if `expected` is `None` and there is no file. Returns the
    /// new version.
    async fn swap(&self, expected: Option<&str>, state: &QueueState) -> Result<String, StoreError>;
}

/// A queue file in an S3 bucket.
#[derive(Debug, Clone)]
pub struct S3QueueStore {
    client: s3_client::Client,
    key: String,
}

impl S3QueueStore {
    pub fn new(client: s3_client::Client, key: impl Into<String>) -> Self {
        Self {
            client,
            key: key.into(),
        }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    async fn get(&self, options: &GetObject) -> Result<Option<Versioned>, s3_client::Error> {
        let output = match self.client.get_object(&self.key, options).await {
            Ok(output) => output,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let e_tag = output
            .info
            .e_tag
            .clone()
            .ok_or_else(|| missing_e_tag(&self.key))?;
        let bytes = output.bytes().await?;
        Ok(Some(Versioned {
            state: QueueState::from_json(&bytes).map_err(|e| corrupt(&self.key, e))?,
            e_tag,
        }))
    }
}

fn storage(error: s3_client::Error) -> StoreError {
    StoreError::Storage(Box::new(error))
}

fn missing_e_tag(key: &str) -> s3_client::Error {
    s3_client::Error::Invalid {
        message: format!("the response for {key} had no ETag"),
        source: None,
    }
}

fn corrupt(key: &str, error: serde_json::Error) -> s3_client::Error {
    s3_client::Error::Invalid {
        message: format!("{key} is not a valid queue file"),
        source: Some(Box::new(error)),
    }
}

#[async_trait]
impl Store for S3QueueStore {
    async fn load(&self) -> Result<Option<Versioned>, StoreError> {
        self.get(&GetObject::default()).await.map_err(storage)
    }

    async fn load_if_changed(&self, e_tag: &str) -> Result<Changed, StoreError> {
        let options = GetObject {
            if_none_match: Some(e_tag.to_string()),
            ..Default::default()
        };
        match self.get(&options).await {
            Ok(current) => Ok(Changed::Changed(current)),
            Err(e) if e.kind() == ErrorKind::NotModified => Ok(Changed::Unchanged),
            Err(e) => Err(storage(e)),
        }
    }

    async fn swap(&self, expected: Option<&str>, state: &QueueState) -> Result<String, StoreError> {
        let condition = match expected {
            Some(e_tag) => WriteCondition::Matches(e_tag.to_string()),
            None => WriteCondition::Absent,
        };
        let options = PutObject {
            condition,
            attributes: s3_client::ObjectAttributes {
                content_type: Some("application/json".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        match self
            .client
            .put_object(&self.key, state.to_json().into(), &options)
            .await
        {
            Ok(output) => output
                .e_tag
                .ok_or_else(|| storage(missing_e_tag(&self.key))),
            Err(e) if e.kind() == ErrorKind::PreconditionFailed => Err(StoreError::Conflict),
            Err(e) => Err(storage(e)),
        }
    }
}

/// A queue file in memory, for tests and examples. Share one between
/// brokers and clients through an `Arc`.
#[derive(Debug, Default)]
pub struct MemoryStore {
    file: Mutex<Option<(Vec<u8>, u64)>>,
    next_version: AtomicU64,
    writes: AtomicU64,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// How many writes have succeeded.
    pub fn writes(&self) -> u64 {
        self.writes.load(Ordering::Relaxed)
    }
}

#[async_trait]
impl Store for MemoryStore {
    async fn load(&self) -> Result<Option<Versioned>, StoreError> {
        let file = self.file.lock().expect("memory store lock").clone();
        file.map(|(bytes, version)| {
            Ok(Versioned {
                state: QueueState::from_json(&bytes)?,
                e_tag: version.to_string(),
            })
        })
        .transpose()
    }

    async fn swap(&self, expected: Option<&str>, state: &QueueState) -> Result<String, StoreError> {
        let mut file = self.file.lock().expect("memory store lock");
        let current = file.as_ref().map(|(_, version)| version.to_string());
        if current.as_deref() != expected {
            return Err(StoreError::Conflict);
        }
        let version = self.next_version.fetch_add(1, Ordering::Relaxed) + 1;
        *file = Some((state.to_json(), version));
        self.writes.fetch_add(1, Ordering::Relaxed);
        Ok(version.to_string())
    }
}
