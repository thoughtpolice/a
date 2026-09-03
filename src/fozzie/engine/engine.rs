// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use crate::artifact::{ArtifactSink, RecordedFinding};
use crate::cli::{Cli, Command, FuzzOptions, MinimizeOptions, ReplayOptions};
use crate::corpus::Corpus;
use crate::executor::{Execution, ExecutorConfig, Finding, FindingKind, PersistentExecutor};
use crate::mutate::{MAX_DICTIONARY_ENTRIES, Rng, comparison_tokens, load_dictionaries, mutate};
use anyhow::{Context, Result, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

pub fn run(cli: Cli) -> Result<ExitCode> {
    match cli.command {
        Command::Fuzz(options) => fuzz(options),
        Command::Replay(options) => replay(options),
        Command::Minimize(options) => minimize(options),
    }
}

fn fuzz(options: FuzzOptions) -> Result<ExitCode> {
    let started = Instant::now();
    let executor_config = ExecutorConfig::from_options(&options.target)?;
    let work = WorkRoot::new(options.workdir.as_deref())?;
    let corpus_path = work.path().join("corpus");
    let corpus = Corpus::load(&options.corpus, corpus_path, executor_config.max_input)?;
    let dictionary = load_dictionaries(&options.dictionaries, executor_config.max_input)?;
    let artifact_sink = ArtifactSink::new(
        work.path(),
        executor_config.target.clone(),
        options.target_label.clone(),
        options.seed,
        options.sanitizer.clone(),
    )?;
    let jobs = effective_jobs(options.jobs, options.test_mode);

    eprintln!(
        "fozzie: seed={} jobs={} corpus={} timeout={}ms workdir={}",
        options.seed,
        jobs,
        corpus.len(),
        executor_config.timeout.as_millis(),
        work.path().display()
    );

    let shared = Arc::new(Shared {
        corpus: Mutex::new(corpus),
        features: Mutex::new(HashSet::new()),
        dictionary: Mutex::new(dictionary),
        artifacts: artifact_sink,
        executions: AtomicU64::new(0),
        interesting: AtomicU64::new(0),
        restarts: AtomicU64::new(0),
        unstable_seeds: AtomicU64::new(0),
        truncated_observations: AtomicU64::new(0),
        flaky_findings: AtomicU64::new(0),
        finding_claimed: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        finding: Mutex::new(None),
        infrastructure_error: Mutex::new(None),
    });

    // Importing seeds and dictionaries and hashing the target are setup work;
    // they must not consume the budget before the first harness call.
    let deadline = if options.duration == 0 {
        None
    } else {
        Some(
            Instant::now()
                .checked_add(Duration::from_secs(options.duration))
                .context("campaign duration exceeds the monotonic clock range")?,
        )
    };

    calibrate(
        &shared,
        &executor_config,
        work.path(),
        options.runs,
        deadline,
    )?;

    if !shared.stop.load(Ordering::Acquire) && budget_available(&shared, options.runs, deadline) {
        thread::scope(|scope| {
            for worker_id in 0..jobs {
                let shared = Arc::clone(&shared);
                let config = executor_config.clone();
                let worker_root = work.path().join(format!("workers/{worker_id}"));
                scope.spawn(move || {
                    if let Err(error) = worker_loop(
                        worker_id,
                        shared.clone(),
                        config,
                        worker_root,
                        options.seed,
                        options.runs,
                        deadline,
                    ) {
                        shared.set_infrastructure_error(format!("worker {worker_id}: {error:#}"));
                    }
                });
            }
        });
    }

    if shared.executions.load(Ordering::Relaxed) == 0 {
        shared.set_infrastructure_error("campaign ended without executing the target".into());
    }

    let elapsed = started.elapsed();
    let finding = shared.finding.lock().unwrap().clone();
    let infrastructure_error = shared.infrastructure_error.lock().unwrap().clone();
    let summary = Summary {
        seed: options.seed,
        elapsed_ms: elapsed.as_millis() as u64,
        executions: shared.executions.load(Ordering::Relaxed),
        executions_per_second: if elapsed.is_zero() {
            0.0
        } else {
            shared.executions.load(Ordering::Relaxed) as f64 / elapsed.as_secs_f64()
        },
        corpus_size: shared.corpus.lock().unwrap().len(),
        features: shared.features.lock().unwrap().len(),
        interesting_inputs: shared.interesting.load(Ordering::Relaxed),
        worker_restarts: shared.restarts.load(Ordering::Relaxed),
        unstable_seeds: shared.unstable_seeds.load(Ordering::Relaxed),
        truncated_observations: shared.truncated_observations.load(Ordering::Relaxed),
        flaky_findings: shared.flaky_findings.load(Ordering::Relaxed),
        finding: finding.clone(),
        infrastructure_error: infrastructure_error.clone(),
    };
    println!("FOZZIE_SUMMARY {}", serde_json::to_string(&summary)?);

    if let Some(finding) = finding {
        eprintln!(
            "fozzie: confirmed {:?}: {}\nartifact: {}\nmetadata: {}\nreproduce: {}",
            finding.kind,
            finding.detail,
            finding.input_path.display(),
            finding.metadata_path.display(),
            finding.repro
        );
        return Ok(ExitCode::from(1));
    }
    if let Some(error) = infrastructure_error {
        bail!("fuzzing infrastructure failed: {error}");
    }
    Ok(ExitCode::SUCCESS)
}

fn calibrate(
    shared: &Arc<Shared>,
    config: &ExecutorConfig,
    workdir: &Path,
    run_limit: u64,
    deadline: Option<Instant>,
) -> Result<()> {
    let seeds = shared.corpus.lock().unwrap().all();
    let mut executor = PersistentExecutor::new(config.clone(), workdir.join("calibration"))?;
    for seed in seeds {
        if shared.stop.load(Ordering::Acquire) || !budget_available(shared, run_limit, deadline) {
            break;
        }
        let Some(execution_id) = claim_execution(shared, run_limit, deadline) else {
            break;
        };
        let first = executor.run(&seed)?;
        match first {
            Execution::Finding(finding) => {
                handle_finding(shared, &mut executor, &seed, finding, execution_id)?;
                break;
            }
            Execution::Ok(first) => {
                let first_features = first.features.iter().copied().collect::<HashSet<_>>();
                absorb_observation(shared, &seed, first, false)?;
                if let Some(second_id) = claim_execution(shared, run_limit, deadline) {
                    let second = executor.run(&seed)?;
                    match second {
                        Execution::Finding(finding) => {
                            handle_finding(shared, &mut executor, &seed, finding, second_id)?;
                            break;
                        }
                        Execution::Ok(second) => {
                            let second_features =
                                second.features.iter().copied().collect::<HashSet<_>>();
                            if first_features != second_features {
                                shared.unstable_seeds.fetch_add(1, Ordering::Relaxed);
                            }
                            absorb_observation(shared, &seed, second, false)?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn worker_loop(
    worker_id: usize,
    shared: Arc<Shared>,
    config: ExecutorConfig,
    worker_root: PathBuf,
    campaign_seed: u64,
    run_limit: u64,
    deadline: Option<Instant>,
) -> Result<()> {
    let mut rng = Rng::new(campaign_seed ^ (worker_id as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
    let mut executor = PersistentExecutor::new(config.clone(), worker_root)?;
    let mut consecutive_errors = 0_u32;

    while !shared.stop.load(Ordering::Acquire) {
        let Some(execution_id) = claim_execution(&shared, run_limit, deadline) else {
            break;
        };
        let (base, splice) = {
            let corpus = shared.corpus.lock().unwrap();
            corpus.snapshot_pair(rng.below(corpus.len()), rng.below(corpus.len()))
        };
        let dictionary = shared.dictionary.lock().unwrap().clone();
        let input = mutate(&base, &splice, &dictionary, config.max_input, &mut rng);

        match executor.run(&input) {
            Ok(Execution::Ok(observation)) => {
                consecutive_errors = 0;
                absorb_observation(&shared, &input, observation, true)?;
            }
            Ok(Execution::Finding(finding)) => {
                consecutive_errors = 0;
                handle_finding(&shared, &mut executor, &input, finding, execution_id)?;
            }
            Err(error) => {
                consecutive_errors += 1;
                shared.restarts.fetch_add(1, Ordering::Relaxed);
                executor.restart();
                if consecutive_errors >= 3 {
                    return Err(error).context("three consecutive target runtime failures");
                }
            }
        }
    }
    Ok(())
}

fn absorb_observation(
    shared: &Shared,
    input: &[u8],
    observation: crate::executor::Observation,
    persist: bool,
) -> Result<()> {
    if observation.features_truncated || observation.comparisons_truncated {
        shared
            .truncated_observations
            .fetch_add(1, Ordering::Relaxed);
    }
    let new_features = {
        let mut global = shared.features.lock().unwrap();
        observation
            .features
            .into_iter()
            .filter(|feature| global.insert(*feature))
            .count()
    };
    if new_features != 0 && persist {
        if shared
            .corpus
            .lock()
            .unwrap()
            .add_interesting(input.to_vec())?
        {
            shared.interesting.fetch_add(1, Ordering::Relaxed);
        }
    }

    let mut dictionary = shared.dictionary.lock().unwrap();
    for comparison in observation.comparisons {
        if comparison.arg1 == comparison.arg2 {
            continue;
        }
        for token in comparison_tokens(comparison.arg1, comparison.arg2, comparison.width) {
            if dictionary.len() >= MAX_DICTIONARY_ENTRIES {
                break;
            }
            if !token.is_empty() && !dictionary.contains(&token) {
                dictionary.push(token);
            }
        }
    }
    Ok(())
}

fn handle_finding(
    shared: &Shared,
    executor: &mut PersistentExecutor,
    input: &[u8],
    finding: Finding,
    execution: u64,
) -> Result<()> {
    if shared
        .finding_claimed
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }

    executor.restart();
    let confirmation = executor.run(input);
    let confirmed = matches!(
        confirmation,
        Ok(Execution::Finding(Finding { ref kind, .. })) if *kind == finding.kind
    );
    let recorded = shared
        .artifacts
        .record(input, &finding, confirmed, execution)?;
    if confirmed {
        *shared.finding.lock().unwrap() = Some(recorded);
        shared.stop.store(true, Ordering::Release);
    } else {
        shared.flaky_findings.fetch_add(1, Ordering::Relaxed);
        eprintln!(
            "fozzie: flaky {:?} preserved at {}",
            finding.kind,
            recorded.input_path.display()
        );
        shared.finding_claimed.store(false, Ordering::Release);
    }
    Ok(())
}

fn replay(options: ReplayOptions) -> Result<ExitCode> {
    let input = read_replay_input(options.input.as_deref(), options.base64.as_deref())?;
    let config = ExecutorConfig::from_options(&options.target)?;
    let directory = tempfile::tempdir().context("creating replay directory")?;
    let mut executor = PersistentExecutor::new(config, directory.path().to_path_buf())?;
    match executor.run(&input)? {
        Execution::Ok(observation) => {
            println!(
                "fozzie: input completed ({} features, {} comparisons)",
                observation.features.len(),
                observation.comparisons.len()
            );
            Ok(if options.expect_finding {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            })
        }
        Execution::Finding(finding) => {
            eprintln!("fozzie: reproduced {:?}: {}", finding.kind, finding.detail);
            if !finding.stderr.is_empty() {
                eprintln!("{}", String::from_utf8_lossy(&finding.stderr));
            }
            Ok(if options.expect_finding {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
    }
}

fn minimize(options: MinimizeOptions) -> Result<ExitCode> {
    let mut input = fs::read(&options.input)
        .with_context(|| format!("reading failing input {}", options.input.display()))?;
    let config = ExecutorConfig::from_options(&options.target)?;
    let directory = tempfile::tempdir().context("creating minimization directory")?;
    let mut executor = PersistentExecutor::new(config, directory.path().to_path_buf())?;
    let expected = match executor.run(&input)? {
        Execution::Finding(finding) => finding.kind,
        Execution::Ok(_) => bail!("input does not fail in the target"),
    };

    let mut granularity = 2_usize;
    while input.len() >= 2 {
        let chunk = input.len().div_ceil(granularity);
        let mut reduced = false;
        let mut begin = 0;
        while begin < input.len() {
            let end = (begin + chunk).min(input.len());
            let mut candidate = input.clone();
            candidate.drain(begin..end);
            executor.restart();
            if preserves(&mut executor, &candidate, &expected)? {
                input = candidate;
                granularity = granularity.saturating_sub(1).max(2);
                reduced = true;
                break;
            }
            begin = end;
        }
        if !reduced {
            if granularity >= input.len() {
                break;
            }
            granularity = (granularity * 2).min(input.len());
        }
    }

    let output = options
        .output
        .unwrap_or_else(|| PathBuf::from(format!("{}.minimized", options.input.display())));
    fs::write(&output, &input)
        .with_context(|| format!("writing minimized input {}", output.display()))?;
    println!(
        "fozzie: minimized {:?} to {} bytes at {}",
        expected,
        input.len(),
        output.display()
    );
    Ok(ExitCode::SUCCESS)
}

fn preserves(
    executor: &mut PersistentExecutor,
    input: &[u8],
    expected: &FindingKind,
) -> Result<bool> {
    Ok(matches!(
        executor.run(input)?,
        Execution::Finding(Finding { kind, .. }) if &kind == expected
    ))
}

fn read_replay_input(path: Option<&Path>, encoded: Option<&str>) -> Result<Vec<u8>> {
    match (path, encoded) {
        (Some(path), None) => fs::read(path).with_context(|| format!("reading {}", path.display())),
        (None, Some(encoded)) => STANDARD.decode(encoded).context("decoding --base64 input"),
        _ => bail!("exactly one of --input or --base64 is required"),
    }
}

fn claim_execution(shared: &Shared, limit: u64, deadline: Option<Instant>) -> Option<u64> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return None;
    }
    loop {
        let current = shared.executions.load(Ordering::Relaxed);
        if limit != 0 && current >= limit {
            return None;
        }
        if shared
            .executions
            .compare_exchange_weak(current, current + 1, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return Some(current + 1);
        }
    }
}

fn budget_available(shared: &Shared, limit: u64, deadline: Option<Instant>) -> bool {
    (limit == 0 || shared.executions.load(Ordering::Relaxed) < limit)
        && deadline.is_none_or(|deadline| Instant::now() < deadline)
}

fn effective_jobs(requested: usize, test_mode: bool) -> usize {
    if test_mode {
        return requested.max(1);
    }
    if requested != 0 {
        return requested;
    }
    thread::available_parallelism().map_or(1, usize::from)
}

struct Shared {
    corpus: Mutex<Corpus>,
    features: Mutex<HashSet<u64>>,
    dictionary: Mutex<Vec<Vec<u8>>>,
    artifacts: ArtifactSink,
    executions: AtomicU64,
    interesting: AtomicU64,
    restarts: AtomicU64,
    unstable_seeds: AtomicU64,
    truncated_observations: AtomicU64,
    flaky_findings: AtomicU64,
    finding_claimed: AtomicBool,
    stop: AtomicBool,
    finding: Mutex<Option<RecordedFinding>>,
    infrastructure_error: Mutex<Option<String>>,
}

impl Shared {
    fn set_infrastructure_error(&self, error: String) {
        let mut slot = self.infrastructure_error.lock().unwrap();
        if slot.is_none() {
            *slot = Some(error);
        }
        self.stop.store(true, Ordering::Release);
    }
}

struct WorkRoot {
    path: PathBuf,
    _temporary: Option<TempDir>,
}

impl WorkRoot {
    fn new(path: Option<&Path>) -> Result<Self> {
        match path {
            Some(path) => {
                fs::create_dir_all(path)
                    .with_context(|| format!("creating work directory {}", path.display()))?;
                Ok(Self {
                    path: fs::canonicalize(path)?,
                    _temporary: None,
                })
            }
            None => {
                let directory = tempfile::Builder::new().prefix("fozzie-").tempdir()?;
                Ok(Self {
                    path: directory.path().to_path_buf(),
                    _temporary: Some(directory),
                })
            }
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Serialize)]
struct Summary {
    seed: u64,
    elapsed_ms: u64,
    executions: u64,
    executions_per_second: f64,
    corpus_size: usize,
    features: usize,
    interesting_inputs: u64,
    worker_restarts: u64,
    unstable_seeds: u64,
    truncated_observations: u64,
    flaky_findings: u64,
    finding: Option<RecordedFinding>,
    infrastructure_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_exactly_one_replay_source() {
        assert!(read_replay_input(None, None).is_err());
        assert!(read_replay_input(None, Some("YWJj")).is_ok_and(|bytes| bytes == b"abc"));
    }

    #[test]
    fn test_mode_defaults_to_one_worker() {
        assert_eq!(effective_jobs(0, true), 1);
        assert_eq!(effective_jobs(4, true), 4);
    }
}
