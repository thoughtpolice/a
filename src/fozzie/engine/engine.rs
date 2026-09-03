// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use crate::artifact::{ArtifactSink, RecordedFinding};
use crate::cli::{Cli, Command, FuzzOptions, MinimizeOptions, ReplayOptions};
use crate::corpus::{Corpus, persist_replace, read_bounded};
use crate::executor::{Execution, ExecutorConfig, Finding, FindingFingerprint, PersistentExecutor};
use crate::interrupt;
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
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

pub fn run(cli: Cli) -> Result<ExitCode> {
    match cli.command {
        Command::Fuzz(options) => fuzz(options),
        Command::Replay(options) => replay(options),
        Command::ReplayArtifact { metadata } => replay(crate::artifact::replay_options(&metadata)?),
        Command::Minimize(options) => minimize(options),
    }
}

fn fuzz(options: FuzzOptions) -> Result<ExitCode> {
    let started = Instant::now();
    let executor_config = ExecutorConfig::from_options(&options.target)?;
    let mut work = WorkRoot::new(options.workdir.as_deref())?;
    let corpus_path = work.path().join("corpus");
    let corpus = Corpus::load(&options.corpus, corpus_path, executor_config.max_input)?;
    let dictionary_entries = load_dictionaries(&options.dictionaries, executor_config.max_input)?;
    let artifact_sink = ArtifactSink::new(
        work.path(),
        &executor_config,
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
        dictionary: RwLock::new(DynamicDictionary::new(dictionary_entries)),
        artifacts: artifact_sink,
        executions: AtomicU64::new(0),
        interesting: AtomicU64::new(0),
        restarts: AtomicU64::new(0),
        unstable_seeds: AtomicU64::new(0),
        truncated_observations: AtomicU64::new(0),
        flaky_findings: AtomicU64::new(0),
        verification_executions: AtomicU64::new(0),
        verifier: Mutex::new(()),
        stop: AtomicBool::new(false),
        finding: Mutex::new(None),
        infrastructure_error: Mutex::new(None),
    });

    let _interrupt_handler =
        interrupt::Handler::install().context("installing campaign signal handlers")?;

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

    if let Err(error) = calibrate(
        &shared,
        &executor_config,
        work.path(),
        options.runs,
        deadline,
    ) {
        if interrupt::signal().is_none() {
            shared.set_infrastructure_error(format!("calibration: {error:#}"));
        }
    }

    if !shared.should_stop() && budget_available(&shared, options.runs, deadline) {
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
                        if interrupt::signal().is_none() {
                            shared
                                .set_infrastructure_error(format!("worker {worker_id}: {error:#}"));
                        }
                    }
                });
            }
        });
    }

    let interrupted_signal = interrupt::signal();
    if shared.executions.load(Ordering::Relaxed) == 0 && interrupted_signal.is_none() {
        shared.set_infrastructure_error("campaign ended without executing the target".into());
    }

    let elapsed = started.elapsed();
    let finding = shared.finding.lock().unwrap().clone();
    let infrastructure_error = shared.infrastructure_error.lock().unwrap().clone();
    let flaky_findings = shared.flaky_findings.load(Ordering::Relaxed);
    let verification_executions = shared.verification_executions.load(Ordering::Relaxed);
    let primary_executions = shared.executions.load(Ordering::Relaxed);
    if finding.is_some()
        || infrastructure_error.is_some()
        || flaky_findings != 0
        || interrupted_signal.is_some()
    {
        work.preserve();
    }
    let workdir_persisted = work.temporary.is_none();
    let summary = Summary {
        seed: options.seed,
        workdir: work.path().to_path_buf(),
        workdir_persisted,
        interrupted_signal,
        elapsed_ms: elapsed.as_millis() as u64,
        executions: primary_executions,
        verification_executions,
        total_executions: primary_executions.saturating_add(verification_executions),
        executions_per_second: if elapsed.is_zero() {
            0.0
        } else {
            primary_executions as f64 / elapsed.as_secs_f64()
        },
        corpus_size: shared.corpus.lock().unwrap().len(),
        features: shared.features.lock().unwrap().len(),
        interesting_inputs: shared.interesting.load(Ordering::Relaxed),
        worker_restarts: shared.restarts.load(Ordering::Relaxed),
        unstable_seeds: shared.unstable_seeds.load(Ordering::Relaxed),
        truncated_observations: shared.truncated_observations.load(Ordering::Relaxed),
        flaky_findings,
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
    if let Some(signal) = interrupted_signal {
        eprintln!(
            "fozzie: interrupted by signal {signal}; campaign saved at {}",
            work.path().display()
        );
        return Ok(ExitCode::from((128 + signal) as u8));
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
        if shared.should_stop() || !budget_available(shared, run_limit, deadline) {
            break;
        }
        let Some(execution_id) = claim_execution(shared, run_limit, deadline) else {
            break;
        };
        let first = executor.run(&seed)?;
        match first {
            Execution::Finding(finding) => {
                if handle_finding(shared, &mut executor, &seed, finding, execution_id)? {
                    break;
                }
            }
            Execution::Ok(first) => {
                let first_features = first.features.iter().copied().collect::<HashSet<_>>();
                if let Some(second_id) = claim_execution(shared, run_limit, deadline) {
                    let second = executor.run(&seed)?;
                    match second {
                        Execution::Finding(finding) => {
                            if handle_finding(shared, &mut executor, &seed, finding, second_id)? {
                                break;
                            }
                        }
                        Execution::Ok(second) => {
                            let second_features =
                                second.features.iter().copied().collect::<HashSet<_>>();
                            if first_features != second_features {
                                shared.unstable_seeds.fetch_add(1, Ordering::Relaxed);
                                let mut stable = first;
                                stable
                                    .features
                                    .retain(|feature| second_features.contains(feature));
                                absorb_observation(shared, &seed, stable, false)?;
                            } else {
                                absorb_observation(shared, &seed, first, false)?;
                            }
                        }
                    }
                } else {
                    absorb_observation(shared, &seed, first, false)?;
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

    while !shared.should_stop() {
        let Some(execution_id) = claim_execution(&shared, run_limit, deadline) else {
            break;
        };
        let (base, splice) = {
            let corpus = shared.corpus.lock().unwrap();
            corpus.snapshot_pair(rng.below(corpus.len()), rng.below(corpus.len()))
        };
        let input = {
            let dictionary = shared.dictionary.read().unwrap();
            mutate(
                &base,
                &splice,
                dictionary.entries(),
                config.max_input,
                &mut rng,
            )
        };

        match executor.run(&input) {
            Ok(Execution::Ok(observation)) => {
                consecutive_errors = 0;
                absorb_observation(&shared, &input, observation, true)?;
            }
            Ok(Execution::Finding(finding)) => {
                consecutive_errors = 0;
                let _ = handle_finding(&shared, &mut executor, &input, finding, execution_id)?;
            }
            Err(error) => {
                if interrupt::signal().is_some() {
                    break;
                }
                consecutive_errors += 1;
                shared.restarts.fetch_add(1, Ordering::Relaxed);
                executor.restart();
                if consecutive_errors >= 3 {
                    return Err(error).context("three consecutive target runtime failures");
                }
            }
        }
    }
    if consecutive_errors != 0 && !shared.should_stop() {
        bail!(
            "campaign budget ended after {consecutive_errors} unresolved target runtime error(s)"
        );
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

    if observation.comparisons.is_empty() {
        return Ok(());
    }
    let mut dictionary = shared.dictionary.write().unwrap();
    for comparison in observation.comparisons {
        if comparison.arg1 == comparison.arg2 {
            continue;
        }
        for token in comparison_tokens(comparison.arg1, comparison.arg2, comparison.width) {
            if dictionary.len() >= MAX_DICTIONARY_ENTRIES {
                break;
            }
            dictionary.insert(token);
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
) -> Result<bool> {
    // Publish every candidate before arbitration. Another worker may own the
    // verifier, but it must never make this exact input disappear.
    let mut recorded = shared.artifacts.record(input, &finding, false, execution)?;
    let _verifier = shared.verifier.lock().unwrap();
    if shared.should_stop() {
        return Ok(true);
    }

    executor.restart();
    shared
        .verification_executions
        .fetch_add(1, Ordering::Relaxed);
    let confirmed = match executor
        .run(input)
        .context("confirming finding in a fresh target")?
    {
        Execution::Finding(candidate) => candidate.fingerprint == finding.fingerprint,
        Execution::Ok(_) => false,
    };
    if confirmed {
        recorded = shared.artifacts.record(input, &finding, true, execution)?;
        *shared.finding.lock().unwrap() = Some(recorded);
        shared.stop.store(true, Ordering::Release);
    } else {
        shared.flaky_findings.fetch_add(1, Ordering::Relaxed);
        eprintln!(
            "fozzie: flaky {:?} preserved at {}",
            finding.kind,
            recorded.input_path.display()
        );
    }
    Ok(confirmed)
}

fn replay(options: ReplayOptions) -> Result<ExitCode> {
    let config = ExecutorConfig::from_options(&options.target)?;
    let input = read_replay_input(
        options.input.as_deref(),
        options.base64.as_deref(),
        config.max_input,
    )?;
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
            let expected = options
                .expect_kind
                .as_deref()
                .is_none_or(|kind| finding_kind_name(finding.kind) == kind)
                && options
                    .expect_code
                    .is_none_or(|code| finding.fingerprint.code == Some(code))
                && options.expect_sanitizer.as_deref().is_none_or(|sanitizer| {
                    finding
                        .fingerprint
                        .sanitizer
                        .as_deref()
                        .is_some_and(|actual| actual.starts_with(&format!("{sanitizer}:")))
                });
            if options.expect_finding && !expected {
                eprintln!(
                    "fozzie: finding did not match expected kind/code (actual fingerprint: {:?})",
                    finding.fingerprint
                );
            }
            Ok(if options.expect_finding && expected {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
    }
}

fn finding_kind_name(kind: crate::executor::FindingKind) -> &'static str {
    match kind {
        crate::executor::FindingKind::Crash => "crash",
        crate::executor::FindingKind::Hang => "hang",
        crate::executor::FindingKind::NonzeroHarness => "nonzero_harness",
        crate::executor::FindingKind::Exit => "exit",
    }
}

fn minimize(options: MinimizeOptions) -> Result<ExitCode> {
    let config = ExecutorConfig::from_options(&options.target)?;
    let mut input = read_bounded(&options.input, config.max_input)
        .with_context(|| format!("reading failing input {}", options.input.display()))?;
    let directory = tempfile::tempdir().context("creating minimization directory")?;
    let mut executor = PersistentExecutor::new(config, directory.path().to_path_buf())?;
    let expected = match executor.run(&input)? {
        Execution::Finding(finding) => finding.fingerprint,
        Execution::Ok(_) => bail!("input does not fail in the target"),
    };

    let mut granularity = 2_usize;
    while !input.is_empty() {
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

    executor.restart();
    if !preserves(&mut executor, &input, &expected)? {
        bail!("minimized input did not preserve its finding in a fresh target");
    }
    let output = options.output.unwrap_or_else(|| {
        let mut name = options.input.as_os_str().to_os_string();
        name.push(".minimized");
        PathBuf::from(name)
    });
    persist_replace(&output, &input)?;
    println!(
        "fozzie: minimized {:?} to {} bytes at {}",
        expected.kind,
        input.len(),
        output.display()
    );
    Ok(ExitCode::SUCCESS)
}

fn preserves(
    executor: &mut PersistentExecutor,
    input: &[u8],
    expected: &FindingFingerprint,
) -> Result<bool> {
    Ok(matches!(
        executor.run(input)?,
        Execution::Finding(Finding { fingerprint, .. }) if &fingerprint == expected
    ))
}

fn read_replay_input(
    path: Option<&Path>,
    encoded: Option<&str>,
    max_input: usize,
) -> Result<Vec<u8>> {
    let input = match (path, encoded) {
        (Some(path), None) => read_bounded(path, max_input),
        (None, Some(encoded)) => STANDARD.decode(encoded).context("decoding --base64 input"),
        _ => bail!("exactly one of --input or --base64 is required"),
    }?;
    if input.len() > max_input {
        bail!("replay input is larger than --max-input {max_input}");
    }
    Ok(input)
}

fn claim_execution(shared: &Shared, limit: u64, deadline: Option<Instant>) -> Option<u64> {
    if shared.should_stop() {
        return None;
    }
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
        return 1;
    }
    if requested != 0 {
        return requested;
    }
    thread::available_parallelism().map_or(1, usize::from)
}

struct Shared {
    corpus: Mutex<Corpus>,
    features: Mutex<HashSet<u64>>,
    dictionary: RwLock<DynamicDictionary>,
    artifacts: ArtifactSink,
    executions: AtomicU64,
    interesting: AtomicU64,
    restarts: AtomicU64,
    unstable_seeds: AtomicU64,
    truncated_observations: AtomicU64,
    flaky_findings: AtomicU64,
    verification_executions: AtomicU64,
    verifier: Mutex<()>,
    stop: AtomicBool,
    finding: Mutex<Option<RecordedFinding>>,
    infrastructure_error: Mutex<Option<String>>,
}

struct DynamicDictionary {
    entries: Vec<Vec<u8>>,
    known: HashSet<Vec<u8>>,
}

impl DynamicDictionary {
    fn new(mut entries: Vec<Vec<u8>>) -> Self {
        entries.truncate(MAX_DICTIONARY_ENTRIES);
        let known = entries.iter().cloned().collect();
        Self { entries, known }
    }

    fn entries(&self) -> &[Vec<u8>] {
        &self.entries
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn insert(&mut self, token: Vec<u8>) -> bool {
        if token.is_empty()
            || self.entries.len() >= MAX_DICTIONARY_ENTRIES
            || !self.known.insert(token.clone())
        {
            return false;
        }
        self.entries.push(token);
        true
    }
}

impl Shared {
    fn should_stop(&self) -> bool {
        self.stop.load(Ordering::Acquire) || interrupt::signal().is_some()
    }

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
    temporary: Option<TempDir>,
}

impl WorkRoot {
    fn new(path: Option<&Path>) -> Result<Self> {
        match path {
            Some(path) => {
                fs::create_dir_all(path)
                    .with_context(|| format!("creating work directory {}", path.display()))?;
                Ok(Self {
                    path: fs::canonicalize(path)?,
                    temporary: None,
                })
            }
            None => {
                let directory = tempfile::Builder::new().prefix("fozzie-").tempdir()?;
                Ok(Self {
                    path: directory.path().to_path_buf(),
                    temporary: Some(directory),
                })
            }
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn preserve(&mut self) {
        if let Some(directory) = self.temporary.take() {
            let path = directory.keep();
            debug_assert_eq!(path, self.path);
        }
    }
}

#[derive(Serialize)]
struct Summary {
    seed: u64,
    workdir: PathBuf,
    workdir_persisted: bool,
    interrupted_signal: Option<i32>,
    elapsed_ms: u64,
    executions: u64,
    verification_executions: u64,
    total_executions: u64,
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
        assert!(read_replay_input(None, None, 3).is_err());
        assert!(read_replay_input(None, Some("YWJj"), 3).is_ok_and(|bytes| bytes == b"abc"));
        assert!(read_replay_input(None, Some("YWJjZA=="), 3).is_err());
    }

    #[test]
    fn test_mode_defaults_to_one_worker() {
        assert_eq!(effective_jobs(0, true), 1);
        assert_eq!(effective_jobs(4, true), 1);
        assert_eq!(effective_jobs(4, false), 4);
    }

    #[test]
    fn preserves_a_temporary_work_root_on_demand() {
        let mut work = WorkRoot::new(None).unwrap();
        let path = work.path().to_path_buf();
        work.preserve();
        drop(work);
        assert!(path.is_dir());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn dynamic_dictionary_deduplicates_and_bounds_entries() {
        let initial = (0..=MAX_DICTIONARY_ENTRIES)
            .map(|value| value.to_le_bytes().to_vec())
            .collect();
        let mut dictionary = DynamicDictionary::new(initial);
        assert_eq!(dictionary.len(), MAX_DICTIONARY_ENTRIES);
        assert!(!dictionary.insert(b"overflow".to_vec()));

        let mut dictionary = DynamicDictionary::new(vec![b"known".to_vec()]);
        assert!(!dictionary.insert(b"known".to_vec()));
        assert!(dictionary.insert(b"new".to_vec()));
        assert_eq!(dictionary.entries(), &[b"known".to_vec(), b"new".to_vec()]);
    }
}
