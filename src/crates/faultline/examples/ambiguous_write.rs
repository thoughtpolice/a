// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Pausing an async write after it commits, and failing its response.
//!
//! A point placed after the store is modified (and after its lock is released)
//! lets a test hold a writer at a known moment, observe the committed state
//! through another request, and then decide what the writer's caller sees.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use faultline::{Action, Injector, Point};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Fault {
    InternalError,
}

#[derive(Clone)]
struct Store {
    objects: Arc<Mutex<HashMap<String, String>>>,
    after_commit: Point<Fault>,
}

impl Store {
    fn new(faults: &Injector<Fault>) -> Self {
        Self {
            objects: Arc::default(),
            after_commit: faults.point("store.put.after_commit"),
        }
    }

    async fn put(&self, key: &str, value: &str) -> Result<(), Fault> {
        self.objects
            .lock()
            .unwrap()
            .insert(key.to_owned(), value.to_owned());
        // The lock guard is gone before this await, so readers can proceed.
        faultline::fail_point_async!(self.after_commit, |fault| Err(fault));
        Ok(())
    }

    async fn get(&self, key: &str) -> Option<String> {
        self.objects.lock().unwrap().get(key).cloned()
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    const DEADLINE: Duration = Duration::from_secs(10);
    let faults = Injector::new();
    let store = Store::new(&faults);

    // 1. Hold a writer between commit and response.
    let guard = store.after_commit.scoped(Action::Pause)?;
    let writer = tokio::spawn({
        let store = store.clone();
        async move { store.put("manifest", "v1").await }
    });
    let seen = tokio::time::timeout(DEADLINE, guard.wait_for_pauses(1)).await?;
    println!("writer paused after commit: {seen:?}");
    assert!(!writer.is_finished());
    let visible = store.get("manifest").await;
    println!("a concurrent reader sees {visible:?}");
    assert_eq!(visible.as_deref(), Some("v1"));
    drop(guard);
    let result = tokio::time::timeout(DEADLINE, writer).await??;
    println!("released writer returned {result:?}");
    assert_eq!(result, Ok(()));

    // 2. Commit, then fail the response: the caller cannot trust the error.
    let _guard = store
        .after_commit
        .scoped(Action::Return(Fault::InternalError).times(1))?;
    let result = store.put("manifest", "v2").await;
    let actual = store.get("manifest").await;
    println!("put returned {result:?}, but the store holds {actual:?}");
    assert_eq!(result, Err(Fault::InternalError));
    assert_eq!(actual.as_deref(), Some("v2"));
    Ok(())
}
