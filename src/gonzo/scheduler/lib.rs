// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gonzo's scheduler: it queues the actions clients ask to execute, hands
//! each to a worker whose platform suits it, and records what the worker
//! reports in the action cache. See `src/gonzo/notes/execution.md`.

mod execution;
pub mod platform;
mod scheduler;
mod session;

#[cfg(test)]
mod test_services;

pub use execution::{ExecutionService, OperationsService};
pub use session::WorkerSessions;

pub use scheduler::{Config, Job, Scheduler, Stage, Subscription, WorkerId, failure};
