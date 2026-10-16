// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gonzo's worker: it takes actions from the scheduler, lays out their
//! inputs, runs them, and uploads what they produce. The daemon runs one
//! for its own machine, and `gonzo-worker` runs one anywhere else; either
//! way it speaks gRPC to the daemon. See `src/gonzo/notes/execution.md`.

pub mod cache;
pub mod cas;
pub mod cgroup;
pub mod digest;
pub mod inputs;
pub mod outputs;
pub mod runner;
pub mod sandbox;
mod worker;

pub use worker::{Config, Worker, host_environment, host_properties, offered_properties};

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod test_inputs;
#[cfg(test)]
mod test_outputs;
#[cfg(test)]
mod test_sandbox;
#[cfg(test)]
mod test_worker;
