// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Refusing writes a store cannot take, before they pile up or fill its
//! disk, so that reads keep working and the store recovers on its own.
//!
//! - [`Backlog`]: refuses new writes while the oldest under way has waited
//!   longer than a limit.
//! - [`DiskReserve`]: refuses new writes while the filesystem under a local
//!   store has less free space than a reserve.
//! - [`Admission`]: both, as one gate to pass before every write.

mod backlog;
mod space;

use std::sync::Arc;
use std::time::Duration;

pub use backlog::{Backlog, DEFAULT_MAX_WRITE_WAIT, Ticket};
pub use space::{DiskReserve, default_reserve, filesystem_space};

/// Why a write was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    /// The disk under the store has less free space than its reserve.
    #[error("the disk is nearly full ({free} bytes free, {reserve} reserved)")]
    DiskFull { free: u64, reserve: u64 },
    /// The oldest write under way has waited past the backlog's limit.
    #[error("the store is {} ms behind on writes", waited.as_millis())]
    Behind { waited: Duration },
}

/// The gate a write passes before it starts: a disk reserve, a backlog,
/// both, or neither.
#[derive(Default)]
pub struct Admission {
    disk: Option<Arc<DiskReserve>>,
    backlog: Option<Backlog>,
}

/// A write admitted; dropping it (done or abandoned) takes it off the
/// backlog.
pub struct Permit<'a> {
    _ticket: Option<Ticket<'a>>,
}

impl Admission {
    /// A gate refusing writes as `disk` and `backlog` say.
    pub fn new(disk: Option<Arc<DiskReserve>>, backlog: Option<Backlog>) -> Self {
        Self { disk, backlog }
    }

    /// A gate with a backlog refusing writes once the oldest has waited
    /// `max_wait`, or none for zero.
    pub fn with_max_wait(disk: Option<Arc<DiskReserve>>, max_wait: Duration) -> Self {
        let backlog = (!max_wait.is_zero()).then(|| Backlog::new(max_wait));
        Self::new(disk, backlog)
    }

    /// Admit a write, or refuse it. Hold the permit until the write is done.
    pub fn admit(&self) -> Result<Permit<'_>, Refused> {
        if let Some(disk) = &self.disk {
            disk.check()?;
        }
        let ticket = self.backlog.as_ref().map(Backlog::admit).transpose()?;
        Ok(Permit { _ticket: ticket })
    }

    /// The disk reserve, if there is one.
    pub fn disk(&self) -> Option<&DiskReserve> {
        self.disk.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_limits_admit_everything() {
        let gate = Admission::default();
        let _held: Vec<_> = (0..100).map(|_| gate.admit().unwrap()).collect();
        assert!(
            Admission::with_max_wait(None, Duration::ZERO)
                .admit()
                .is_ok()
        );
    }

    #[test]
    fn a_backlog_refuses_once_a_write_waits_too_long() {
        let gate = Admission::with_max_wait(None, Duration::from_millis(20));
        let held = gate.admit().unwrap();
        std::thread::sleep(Duration::from_millis(40));
        assert!(matches!(gate.admit(), Err(Refused::Behind { .. })));
        drop(held);
        assert!(gate.admit().is_ok());
    }

    #[tokio::test]
    async fn a_reserve_larger_than_the_disk_refuses() {
        let dir = std::env::temp_dir();
        let disk = DiskReserve::watch(dir.clone(), Some(u64::MAX)).unwrap();
        let gate = Admission::new(Some(disk), None);
        assert!(matches!(
            gate.admit(),
            Err(Refused::DiskFull {
                reserve: u64::MAX,
                ..
            })
        ));
        let disk = DiskReserve::watch(dir, Some(0)).unwrap();
        assert!(Admission::new(Some(disk), None).admit().is_ok());
    }
}
