// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! # Flake Aware Culprit Finding (FACF)
//!
//! A Bayesian algorithm for finding bug-introducing commits even when tests are
//! flaky (non-deterministic). Based on the Google research paper "Flake Aware
//! Culprit Finding" by Henderson et al.
//!
//! ## The Problem
//!
//! Traditional binary search (git bisect) assumes tests are deterministic: they
//! always pass before the bug-introducing commit and always fail after. But real
//! tests are often flaky - they can fail non-deterministically due to timing
//! issues, resource exhaustion, network problems, etc.
//!
//! ## The Solution
//!
//! FACF uses Bayesian inference to maintain a probability distribution over
//! "which commit is the culprit?" Each test result (PASS or FAIL) is evidence
//! that updates the distribution via Bayes' rule. The key insight is an
//! asymmetry in the noise model:
//!
//! - **PASS is reliable**: A test cannot pass if there's a real bug at or before
//!   that commit (we assume bugs are deterministic once introduced)
//! - **FAIL is unreliable**: A test can fail due to flakiness even when the code
//!   is fine
//!
//! This means a PASS provides strong evidence (eliminates suspects), while a
//! FAIL provides weaker evidence (could be a flake).
//!
//! ## Usage
//!
//! ```rust
//! use facf::{Facf, FacfConfig, TestResult};
//!
//! // 10 suspects (commits) to search through
//! let mut facf = Facf::new(10, FacfConfig::default());
//!
//! while facf.result().is_none() {
//!     // Get the next position(s) to test
//!     let positions = facf.next_runs(1);
//!     if positions.is_empty() {
//!         break;
//!     }
//!
//!     for pos in positions {
//!         // Run your test at this commit (caller-provided)
//!         let result = run_test_at_commit(pos);
//!         facf.record_result(pos, result);
//!     }
//! }
//!
//! match facf.result() {
//!     Some(FacfResult::Culprit { position, confidence }) => {
//!         println!("Culprit at position {} ({:.1}%)", position, confidence * 100.0);
//!     }
//!     Some(FacfResult::NoCulprit { confidence }) => {
//!         println!("Flake ({:.1}%)", confidence * 100.0);
//!     }
//!     None => println!("Could not determine culprit"),
//! }
//! ```

pub mod distribution;
pub mod search;
#[cfg(test)]
pub mod tests;
