// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Campaign state for external observers such as `fozzie tui`: the live
//! `status.json` in a work directory, the machine-wide campaign registry,
//! and a read-only view of the finding metadata a campaign publishes.

use crate::artifact::RecordedFinding;
use crate::corpus::{persist_replace, persist_replace_unsynced};
use crate::executor::{FindingFingerprint, FindingKind};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Bumped when a field changes meaning or disappears; added fields need no
/// bump because readers ignore unknown keys.
pub const STATUS_VERSION: u32 = 1;
pub const STATUS_FILE: &str = "status.json";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub version: u32,
    pub pid: u32,
    pub workdir: PathBuf,
    pub target: PathBuf,
    pub target_label: Option<String>,
    pub sanitizer: String,
    pub seed: u64,
    pub jobs: usize,
    pub timeout_ms: u64,
    pub max_input: usize,
    /// Wall clock, for display and liveness only.
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub phase: Phase,
    /// Monotonic, since the campaign started, setup included like the
    /// summary's `elapsed_ms`. Rates come from deltas of this and
    /// `executions`, never from wall-clock differences.
    pub elapsed_ms: u64,
    pub executions: u64,
    pub verification_executions: u64,
    pub corpus_size: usize,
    pub features: usize,
    /// Distinct counters behind the features (`feature >> 3`); with
    /// `counters` this gives the covered share of the target's map.
    pub edges: usize,
    /// Counters the target declared when it connected; 0 until one has,
    /// which stays the case when the first seed already crashes.
    pub counters: u64,
    pub interesting_inputs: u64,
    /// `elapsed_ms` at the last coverage growth and at the last finding
    /// candidate, flaky ones included.
    pub last_interesting_ms: Option<u64>,
    pub last_finding_ms: Option<u64>,
    pub worker_restarts: u64,
    pub unstable_seeds: u64,
    pub truncated_observations: u64,
    pub flaky_findings: u64,
    pub dictionary_entries: usize,
    pub workers: Vec<WorkerStatus>,
    pub mutators: Vec<MutatorYield>,
    pub finding: Option<RecordedFinding>,
    pub infrastructure_error: Option<String>,
    pub interrupted_signal: Option<i32>,
}

/// Serialized as `{"name": "fuzzing"}` or `{"name": "finished", "outcome":
/// "budget"}`, so a reader finds the phase under one key whatever the
/// variant's shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "snake_case")]
pub enum Phase {
    Setup,
    Calibrating,
    Fuzzing,
    Finished { outcome: Outcome },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Budget,
    Finding,
    Interrupted,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkerStatus {
    pub id: usize,
    pub executions: u64,
    pub restarts: u64,
    pub last_input_len: usize,
}

/// A mutator is credited as `useful` for every input that grew coverage
/// among those it touched, so with stacked rounds the ratio is an upper
/// bound per mutator, as in AFL++'s per-stage accounting.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MutatorYield {
    pub name: String,
    pub applied: u64,
    pub useful: u64,
}

impl Status {
    pub fn path(workdir: &Path) -> PathBuf {
        workdir.join(STATUS_FILE)
    }

    pub fn write(&self, workdir: &Path) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(self).context("encoding campaign status")?;
        bytes.push(b'\n');
        persist_replace_unsynced(&Self::path(workdir), &bytes)
    }

    pub fn read(workdir: &Path) -> Result<Self> {
        let path = Self::path(workdir);
        let bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        // Probe the version first so a format change reports itself rather
        // than surfacing as a missing field.
        #[derive(Deserialize)]
        struct Probe {
            version: u32,
        }
        let probe: Probe = serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing {}", path.display()))?;
        ensure!(
            probe.version == STATUS_VERSION,
            "{} has status format {}; this fozzie reads {STATUS_VERSION}",
            path.display(),
            probe.version
        );
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))
    }
}

pub fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// The part of a finding's metadata a monitor shows. Identity fields are
/// required; the rest default so older files still list. The file stem
/// calls a nonzero harness result `nonzero` while the JSON `kind` says
/// `nonzero_harness`: only the JSON is consulted, the path is for display.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FindingRecord {
    pub kind: FindingKind,
    pub fingerprint: FindingFingerprint,
    pub confirmed: bool,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub input_digest: String,
    #[serde(default)]
    pub input_size: usize,
    #[serde(default)]
    pub execution: u64,
    #[serde(default)]
    pub target_label: Option<String>,
    #[serde(default)]
    pub sanitizer: String,
    #[serde(default)]
    pub repro: String,
    #[serde(default)]
    pub minimize: String,
    #[serde(default)]
    pub stderr: String,
}

/// Every `*.json` under `<workdir>/artifacts`, newest first by modification
/// time, then by execution, then by path. Staging files carry no `.json`
/// suffix and a file that does not parse is not a finding, so both are
/// skipped rather than failing the listing.
pub fn read_findings(workdir: &Path) -> Vec<(PathBuf, FindingRecord)> {
    let Ok(entries) = fs::read_dir(workdir.join("artifacts")) else {
        return Vec::new();
    };
    let mut findings = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<FindingRecord>(&bytes) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        findings.push((modified, path, record));
    }
    findings.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.2.execution.cmp(&a.2.execution))
            .then_with(|| a.1.cmp(&b.1))
    });
    findings
        .into_iter()
        .map(|(_, path, record)| (path, record))
        .collect()
}

pub mod registry {
    use super::*;
    use std::ffi::OsString;
    use std::io::ErrorKind;
    use std::os::unix::ffi::OsStrExt;

    #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
    pub struct Registration {
        pub workdir: PathBuf,
        pub pid: u32,
        pub started_at_ms: u64,
    }

    /// A written entry. Removal is explicit because most campaigns keep
    /// theirs: a finished campaign stays visible until its directory goes.
    pub struct Registered {
        path: PathBuf,
    }

    impl Registered {
        pub fn remove(self) -> Result<()> {
            match fs::remove_file(&self.path) {
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                result => result.with_context(|| format!("removing {}", self.path.display())),
            }
        }
    }

    pub fn dir() -> Result<PathBuf> {
        resolve_dir(
            std::env::var_os("FOZZIE_STATE_DIR"),
            std::env::var_os("XDG_STATE_HOME"),
            std::env::var_os("HOME"),
        )
        .context("no campaign registry directory: set FOZZIE_STATE_DIR, XDG_STATE_HOME, or HOME")
    }

    /// XDG treats empty and relative values as unset; the override follows
    /// the same rule so a registry never lands relative to a working
    /// directory.
    pub(super) fn resolve_dir(
        explicit: Option<OsString>,
        xdg: Option<OsString>,
        home: Option<OsString>,
    ) -> Option<PathBuf> {
        let absolute =
            |value: Option<OsString>| value.map(PathBuf::from).filter(|path| path.is_absolute());
        if let Some(dir) = absolute(explicit) {
            return Some(dir);
        }
        if let Some(dir) = absolute(xdg) {
            return Some(dir.join("fozzie"));
        }
        absolute(home).map(|home| home.join(".local/state/fozzie"))
    }

    /// One entry per work directory: the id is a prefix of the BLAKE3 hash
    /// of the path bytes, so a rerun replaces the previous entry.
    pub fn id(workdir: &Path) -> String {
        blake3::hash(workdir.as_os_str().as_bytes()).to_hex()[..16].to_owned()
    }

    pub fn entry_path(dir: &Path, workdir: &Path) -> PathBuf {
        dir.join("campaigns").join(format!("{}.json", id(workdir)))
    }

    pub fn register(dir: &Path, registration: &Registration) -> Result<Registered> {
        let campaigns = dir.join("campaigns");
        fs::create_dir_all(&campaigns)
            .with_context(|| format!("creating {}", campaigns.display()))?;
        let path = entry_path(dir, &registration.workdir);
        let mut bytes =
            serde_json::to_vec_pretty(registration).context("encoding campaign registration")?;
        bytes.push(b'\n');
        persist_replace(&path, &bytes)?;
        Ok(Registered { path })
    }

    /// Newest first. A missing directory is an empty registry; an entry
    /// that does not parse is not a campaign (a foreign file, or one a
    /// crash truncated) and is skipped rather than failing the listing.
    pub fn list(dir: &Path) -> Result<Vec<Registration>> {
        let campaigns = dir.join("campaigns");
        let entries = match fs::read_dir(&campaigns) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(error).with_context(|| format!("reading {}", campaigns.display()));
            }
        };
        let mut registrations = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            if let Ok(registration) = serde_json::from_slice::<Registration>(&bytes) {
                registrations.push(registration);
            }
        }
        registrations.sort_by(|a, b| {
            b.started_at_ms
                .cmp(&a.started_at_ms)
                .then_with(|| a.workdir.cmp(&b.workdir))
        });
        Ok(registrations)
    }
}

#[cfg(test)]
mod tests {
    use super::registry::{self, Registration};
    use super::*;
    use crate::artifact::ArtifactSink;
    use crate::executor::{ExecutorConfig, Finding};
    use std::ffi::OsString;
    use std::time::Duration;

    fn sample_status() -> Status {
        Status {
            version: STATUS_VERSION,
            pid: 4242,
            workdir: PathBuf::from("/var/tmp/demo"),
            target: PathBuf::from("/opt/demo-target"),
            target_label: Some("//demo:fuzz".into()),
            sanitizer: "none".into(),
            seed: 7,
            jobs: 2,
            timeout_ms: 1000,
            max_input: 65_536,
            started_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_005_000,
            phase: Phase::Finished {
                outcome: Outcome::Finding,
            },
            elapsed_ms: 5_000,
            executions: 1234,
            verification_executions: 1,
            corpus_size: 12,
            features: 300,
            edges: 40,
            counters: 5000,
            interesting_inputs: 11,
            last_interesting_ms: Some(4_900),
            last_finding_ms: Some(4_990),
            worker_restarts: 0,
            unstable_seeds: 1,
            truncated_observations: 2,
            flaky_findings: 0,
            dictionary_entries: 33,
            workers: (0..2)
                .map(|id| WorkerStatus {
                    id,
                    executions: 600 + id as u64,
                    restarts: 0,
                    last_input_len: 17,
                })
                .collect(),
            mutators: crate::mutate::MUTATOR_NAMES
                .iter()
                .map(|name| MutatorYield {
                    name: (*name).to_owned(),
                    applied: 100,
                    useful: 1,
                })
                .collect(),
            finding: Some(RecordedFinding {
                kind: FindingKind::NonzeroHarness,
                fingerprint: FindingFingerprint {
                    kind: FindingKind::NonzeroHarness,
                    code: Some(17),
                    sanitizer: None,
                },
                confirmed: true,
                input_digest: "abc".into(),
                input_path: PathBuf::from("/var/tmp/demo/artifacts/nonzero-abc-0123"),
                metadata_path: PathBuf::from(
                    "/var/tmp/demo/artifacts/nonzero-abc-0123.confirmed.json",
                ),
                detail: "LLVMFuzzerTestOneInput returned 17".into(),
                repro: "buck2 run ...".into(),
                minimize: "buck2 run ... minimize".into(),
            }),
            infrastructure_error: None,
            interrupted_signal: None,
        }
    }

    #[test]
    fn status_round_trips_through_json() {
        let status = sample_status();
        let encoded = serde_json::to_vec(&status).unwrap();
        assert_eq!(serde_json::from_slice::<Status>(&encoded).unwrap(), status);

        let directory = tempfile::tempdir().unwrap();
        status.write(directory.path()).unwrap();
        assert_eq!(Status::read(directory.path()).unwrap(), status);

        let mut document: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        document["version"] = serde_json::json!(99);
        fs::write(
            Status::path(directory.path()),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let error = Status::read(directory.path()).unwrap_err().to_string();
        assert!(error.contains("status format 99"), "{error}");
    }

    #[test]
    fn phase_has_a_stable_json_shape() {
        assert_eq!(
            serde_json::to_value(Phase::Fuzzing).unwrap(),
            serde_json::json!({"name": "fuzzing"})
        );
        assert_eq!(
            serde_json::to_value(Phase::Finished {
                outcome: Outcome::Budget
            })
            .unwrap(),
            serde_json::json!({"name": "finished", "outcome": "budget"})
        );
    }

    #[test]
    fn registry_ids_are_stable_path_hashes() {
        let a = registry::id(Path::new("/var/tmp/a"));
        assert_eq!(a, registry::id(Path::new("/var/tmp/a")));
        assert_ne!(a, registry::id(Path::new("/var/tmp/b")));
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(
            registry::entry_path(Path::new("/state"), Path::new("/var/tmp/a"))
                .ends_with(format!("campaigns/{a}.json"))
        );
    }

    #[test]
    fn registry_resolves_directories_in_precedence_order() {
        let resolve = |explicit: Option<&str>, xdg: Option<&str>, home: Option<&str>| {
            registry::resolve_dir(
                explicit.map(OsString::from),
                xdg.map(OsString::from),
                home.map(OsString::from),
            )
        };
        assert_eq!(
            resolve(Some("/explicit"), Some("/xdg"), Some("/home/me")),
            Some(PathBuf::from("/explicit"))
        );
        assert_eq!(
            resolve(None, Some("/xdg"), Some("/home/me")),
            Some(PathBuf::from("/xdg/fozzie"))
        );
        assert_eq!(
            resolve(None, None, Some("/home/me")),
            Some(PathBuf::from("/home/me/.local/state/fozzie"))
        );
        assert_eq!(
            resolve(Some(""), Some("relative"), Some("/home/me")),
            Some(PathBuf::from("/home/me/.local/state/fozzie"))
        );
        assert_eq!(resolve(None, None, None), None);
    }

    #[test]
    fn registry_lists_entries_and_ignores_malformed_ones() {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path();
        let first = Registration {
            workdir: PathBuf::from("/var/tmp/first"),
            pid: 10,
            started_at_ms: 100,
        };
        let second = Registration {
            workdir: PathBuf::from("/var/tmp/second"),
            pid: 20,
            started_at_ms: 200,
        };
        let registered = registry::register(state, &first).unwrap();
        registry::register(state, &second).unwrap();
        let campaigns = state.join("campaigns");
        fs::write(campaigns.join("garbage.json"), b"{").unwrap();
        fs::write(campaigns.join(".tmpabc"), b"{}").unwrap();
        fs::write(campaigns.join("notes.txt"), b"hello").unwrap();
        assert_eq!(
            registry::list(state).unwrap(),
            vec![second.clone(), first.clone()]
        );

        let rerun = Registration {
            pid: 11,
            ..first.clone()
        };
        registry::register(state, &rerun).unwrap();
        assert_eq!(registry::list(state).unwrap(), vec![second.clone(), rerun]);

        registered.remove().unwrap();
        assert_eq!(registry::list(state).unwrap(), vec![second]);
        assert!(registry::list(&state.join("missing")).unwrap().is_empty());
        let again = registry::register(state, &first).unwrap();
        fs::remove_file(registry::entry_path(state, &first.workdir)).unwrap();
        again.remove().unwrap();
    }

    #[test]
    fn read_findings_parses_artifact_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        fs::write(&target, b"binary").unwrap();
        let config = ExecutorConfig {
            target,
            target_args: Vec::new(),
            resources: Vec::new(),
            max_input: 4096,
            timeout: Duration::from_millis(77),
            feature_capacity: 123,
            cmp_capacity: 45,
            sanitizer: "none".to_owned(),
        };
        let sink = ArtifactSink::new(
            directory.path(),
            &config,
            Some("//demo:fuzz".into()),
            7,
            "none".into(),
        )
        .unwrap();
        let crash = Finding {
            kind: FindingKind::Crash,
            fingerprint: FindingFingerprint {
                kind: FindingKind::Crash,
                code: Some(6),
                sanitizer: None,
            },
            detail: "signal 6".into(),
            stderr: b"backtrace".to_vec(),
        };
        let nonzero = Finding {
            kind: FindingKind::NonzeroHarness,
            fingerprint: FindingFingerprint {
                kind: FindingKind::NonzeroHarness,
                code: Some(17),
                sanitizer: None,
            },
            detail: "LLVMFuzzerTestOneInput returned 17".into(),
            stderr: Vec::new(),
        };
        sink.record(b"bad", &crash, false, 9).unwrap();
        sink.record(b"bad", &crash, true, 10).unwrap();
        let recorded = sink.record(b"worse", &nonzero, false, 11).unwrap();
        fs::write(directory.path().join("artifacts/broken.json"), b"{").unwrap();

        let findings = read_findings(directory.path());
        assert_eq!(
            findings
                .iter()
                .map(|(_, record)| record.execution)
                .collect::<Vec<_>>(),
            [11, 10, 9]
        );
        let (path, record) = &findings[0];
        assert_eq!(path, &recorded.metadata_path);
        assert!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("nonzero-")
        );
        assert_eq!(record.kind, FindingKind::NonzeroHarness);
        assert_eq!(record.fingerprint.code, Some(17));
        assert!(!record.confirmed);
        assert_eq!(record.input_size, 5);
        assert_eq!(record.target_label.as_deref(), Some("//demo:fuzz"));
        assert!(record.repro.starts_with("buck2 run "));
        assert!(findings[1].1.confirmed);
        assert_eq!(findings[1].1.stderr, "backtrace");
        assert!(read_findings(&directory.path().join("missing")).is_empty());
    }
}
