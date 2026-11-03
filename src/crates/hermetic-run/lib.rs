// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Running a command hermetically, as a remote execution worker runs an
//! action: exactly the environment it names, its own process group (and
//! cgroup), stdin empty and output to files, a timeout, cancellation, and
//! nothing left behind once it ends. Optionally it sees one directory and
//! nothing else ([`EmptyRoot`]).
//!
//! - [`run`]: run a [`Spec`] to its [`Outcome`].
//! - [`Cgroups`]: a cgroup v2 per command, under this process's own, so
//!   everything a command starts can be killed with it.
//! - [`EmptyRoot`]: user, mount, network, IPC and UTS namespaces, and a
//!   `pivot_root` into a directory, prepared before the fork.
//! - [`writing_input`] and [`spawn`]: the lock that keeps a command's exec
//!   from failing with `ETXTBSY` while this process writes an executable.

pub mod cgroup;
pub mod empty_root;
mod run;

pub use cgroup::{Cgroup, Cgroups};
pub use empty_root::EmptyRoot;
pub use run::{Outcome, SpawnError, Spec, run, spawn, writing_input};

#[cfg(test)]
mod test_empty_root;
