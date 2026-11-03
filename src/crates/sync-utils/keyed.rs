// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A lock per key, made on demand and dropped once nobody holds or waits
//! for it.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, Weak};

/// One holder per key at a time.
///
/// Requests for an expensive thing (a fetch from an origin, say) that is
/// cached once done can hold the thing's key while doing it: concurrent
/// requests for it wait, then find it cached, instead of each doing it.
pub struct KeyedLock<K> {
    locks: Mutex<HashMap<K, Weak<tokio::sync::Mutex<()>>>>,
}

impl<K> Default for KeyedLock<K> {
    fn default() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash> KeyedLock<K> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait until nobody else holds `key`, then hold it until the guard is
    /// dropped. Waiters are served in the order they came.
    pub async fn lock(&self, key: K) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().expect("keyed lock map never poisoned");
            locks.retain(|_, held| held.strong_count() > 0);
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    locks.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    /// Keys held or waited for, as of the last [`lock`](Self::lock), which
    /// sweeps out the rest.
    pub fn len(&self) -> usize {
        self.locks
            .lock()
            .expect("keyed lock map never poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn one_holder_per_key() {
        let locks = Arc::new(KeyedLock::new());
        let held = locks.lock("a").await;
        // Another key is free.
        drop(locks.lock("b").await);

        let waiter = {
            let locks = locks.clone();
            tokio::spawn(async move { drop(locks.lock("a").await) })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished(), "a second holder of the same key");
        drop(held);
        waiter.await.unwrap();
    }

    #[tokio::test]
    async fn released_keys_are_swept() {
        let locks = KeyedLock::new();
        for key in 0..100 {
            drop(locks.lock(key).await);
        }
        let _held = locks.lock(100).await;
        assert_eq!(locks.len(), 1);
    }
}
