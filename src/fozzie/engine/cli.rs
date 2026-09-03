// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use clap::{Args, Parser, Subcommand};
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "fozzie", about = "Buck-native compiled-code fuzzer")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Replay the seed corpus and perform a coverage-guided fuzzing campaign.
    Fuzz(FuzzOptions),
    /// Execute one input and report whether the target fails.
    Replay(ReplayOptions),
    /// Reduce a failing input while preserving its failure class.
    Minimize(MinimizeOptions),
}

#[derive(Clone, Debug, Args)]
pub struct TargetOptions {
    /// Instrumented persistent target executable.
    #[arg(long)]
    pub target: PathBuf,

    /// Argument forwarded to the target before its persistent loop starts.
    #[arg(long = "target-arg", allow_hyphen_values = true)]
    pub target_args: Vec<OsString>,

    /// Maximum bytes in one fuzz input.
    #[arg(long, default_value_t = 65_536)]
    pub max_input: usize,

    /// Parent-enforced timeout for one harness call.
    #[arg(long, default_value_t = 1_000)]
    pub timeout_ms: u64,

    /// Maximum sparse coverage features returned by one run.
    #[arg(long, default_value_t = 65_536)]
    pub feature_capacity: usize,

    /// Maximum comparison observations returned by one run.
    #[arg(long, default_value_t = 4_096)]
    pub cmp_capacity: usize,
}

#[derive(Debug, Args)]
pub struct FuzzOptions {
    #[command(flatten)]
    pub target: TargetOptions,

    /// A seed file or directory. May be repeated.
    #[arg(long = "corpus")]
    pub corpus: Vec<PathBuf>,

    /// A libFuzzer-style dictionary file. May be repeated.
    #[arg(long = "dictionary")]
    pub dictionaries: Vec<PathBuf>,

    /// Durable campaign directory. A temporary directory is used when omitted.
    #[arg(long)]
    pub workdir: Option<PathBuf>,

    /// Campaign execution budget in seconds after setup; zero means no time limit.
    #[arg(long, default_value_t = 10)]
    pub duration: u64,

    /// Maximum target executions; zero means no execution limit.
    #[arg(long, default_value_t = 0)]
    pub runs: u64,

    /// Persistent target processes; zero selects available parallelism.
    #[arg(long, default_value_t = 0)]
    pub jobs: usize,

    /// Reproducible campaign RNG seed.
    #[arg(long, default_value_t = 0xF022_1E_u64)]
    pub seed: u64,

    /// Buck label recorded in finding metadata.
    #[arg(long)]
    pub target_label: Option<String>,

    /// Stop after the first confirmed finding and use deterministic test defaults.
    #[arg(long)]
    pub test_mode: bool,
}

#[derive(Debug, Args)]
pub struct ReplayOptions {
    #[command(flatten)]
    pub target: TargetOptions,

    /// Input file to replay.
    #[arg(long, conflicts_with = "base64")]
    pub input: Option<PathBuf>,

    /// Inline base64 input, useful when a Buck test sandbox has disappeared.
    #[arg(long, conflicts_with = "input")]
    pub base64: Option<String>,

    /// Succeed only if replay produces a finding (useful for regression tests).
    #[arg(long)]
    pub expect_finding: bool,
}

#[derive(Debug, Args)]
pub struct MinimizeOptions {
    #[command(flatten)]
    pub target: TargetOptions,

    /// Failing input to reduce.
    #[arg(long)]
    pub input: PathBuf,

    /// Destination; defaults to INPUT.minimized.
    #[arg(long)]
    pub output: Option<PathBuf>,
}
