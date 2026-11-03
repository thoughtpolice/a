// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Bytes shared by threads, taken before they are used and given back
//! after.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// A wait for budget ended because its stop flag was set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("stopped while waiting for budget")]
pub struct Stopped;

/// A number of bytes shared by threads (decoded data not yet stored, say):
/// each takes some before it holds that much, and gives them back by
/// dropping what it took. Waits are blocking: for threads, not async
/// tasks.
pub struct ByteBudget {
    available: Mutex<usize>,
    freed: Condvar,
    total: usize,
}

/// Budget held, given back when dropped.
pub struct Held {
    budget: Arc<ByteBudget>,
    bytes: usize,
}

/// How often a wait looks at its stop flag.
const STOP_POLL: Duration = Duration::from_millis(50);

impl ByteBudget {
    /// A budget of `total` bytes.
    pub fn new(total: usize) -> Arc<Self> {
        Arc::new(Self {
            available: Mutex::new(total),
            freed: Condvar::new(),
            total,
        })
    }

    /// The whole budget.
    pub fn total(&self) -> usize {
        self.total
    }

    /// Nothing held, to add takings to (see [`Held::absorb`]).
    pub fn nothing(self: &Arc<Self>) -> Held {
        Held {
            budget: Arc::clone(self),
            bytes: 0,
        }
    }

    /// Take `bytes` (the whole budget, for anything larger: a single use
    /// larger than the budget must still go ahead) if that much is free
    /// now.
    pub fn try_take(self: &Arc<Self>, bytes: usize) -> Option<Held> {
        let want = bytes.min(self.total);
        let mut available = self.available.lock().expect("budget lock never poisoned");
        if *available < want {
            return None;
        }
        *available -= want;
        Some(Held {
            budget: Arc::clone(self),
            bytes: want,
        })
    }

    /// Wait until `bytes` (the whole budget, for anything larger) are free
    /// and take them, unless `stop` is set first.
    ///
    /// A thread that holds budget itself should give it back (or hand it
    /// on) before it waits, or threads holding budget can all wait on each
    /// other.
    pub fn take(self: &Arc<Self>, bytes: usize, stop: &AtomicBool) -> Result<Held, Stopped> {
        let want = bytes.min(self.total);
        let mut available = self.available.lock().expect("budget lock never poisoned");
        while *available < want {
            if stop.load(Ordering::Relaxed) {
                return Err(Stopped);
            }
            available = self
                .freed
                .wait_timeout(available, STOP_POLL)
                .expect("budget lock never poisoned")
                .0;
        }
        *available -= want;
        Ok(Held {
            budget: Arc::clone(self),
            bytes: want,
        })
    }
}

impl Held {
    /// Bytes held.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Hold `other`'s bytes too, given back with these. Both must come
    /// from the same budget.
    pub fn absorb(&mut self, mut other: Held) {
        assert!(
            Arc::ptr_eq(&self.budget, &other.budget),
            "budget held from another budget"
        );
        self.bytes += std::mem::take(&mut other.bytes);
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if self.bytes > 0 {
            *self
                .budget
                .available
                .lock()
                .expect("budget lock never poisoned") += self.bytes;
            self.budget.freed.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_is_taken_and_given_back() {
        let budget = ByteBudget::new(100);
        let stop = AtomicBool::new(false);
        let held = budget.try_take(60).expect("free");
        assert_eq!(held.bytes(), 60);
        assert!(budget.try_take(60).is_none());
        drop(held);
        // More than the whole budget takes the whole budget.
        let all = budget.take(1000, &stop).unwrap();
        assert_eq!(all.bytes(), 100);
        assert!(budget.try_take(1).is_none());
    }

    #[test]
    fn takings_add_up_and_go_back_together() {
        let budget = ByteBudget::new(10);
        let mut held = budget.nothing();
        held.absorb(budget.try_take(4).unwrap());
        held.absorb(budget.try_take(6).unwrap());
        assert_eq!(held.bytes(), 10);
        assert!(budget.try_take(1).is_none());
        drop(held);
        assert!(budget.try_take(10).is_some());
    }

    #[test]
    fn waits_end_when_stopped() {
        let budget = ByteBudget::new(10);
        let _all = budget.try_take(10).unwrap();
        let stop = AtomicBool::new(true);
        assert_eq!(budget.take(1, &stop).err(), Some(Stopped));
    }

    #[test]
    fn a_wait_ends_when_budget_comes_back() {
        let budget = ByteBudget::new(10);
        let all = budget.try_take(10).unwrap();
        let waiter = {
            let budget = budget.clone();
            std::thread::spawn(move || budget.take(5, &AtomicBool::new(false)).map(|h| h.bytes()))
        };
        std::thread::sleep(Duration::from_millis(20));
        drop(all);
        assert_eq!(waiter.join().unwrap(), Ok(5));
    }
}
