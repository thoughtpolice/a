// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Polling of the registry, the status files, and the finding metadata
//! into snapshots for the model. Problems belong to one campaign and travel
//! in its snapshot; a directory without a status file is simply not a
//! campaign.

use super::model::{FindingEntry, Snapshot};
use crate::status::{self, Status, registry};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Poller {
    explicit: Vec<PathBuf>,
    use_registry: bool,
    findings: HashMap<PathBuf, FindingsCache>,
    note: String,
    parses: usize,
}

/// The artifact listing a set of entries was parsed from; the metadata
/// files are re-read only when a name, size, or modification time changes.
struct FindingsCache {
    listing: Vec<(PathBuf, SystemTime, u64)>,
    entries: Vec<FindingEntry>,
}

impl Poller {
    pub fn new(workdirs: Vec<PathBuf>, use_registry: bool) -> Self {
        Self {
            explicit: workdirs,
            use_registry,
            findings: HashMap::new(),
            note: String::new(),
            parses: 0,
        }
    }

    /// Where campaigns come from, for the screen.
    pub fn note(&self) -> &str {
        &self.note
    }

    /// How many times finding metadata has been parsed.
    #[cfg(test)]
    pub fn parses(&self) -> usize {
        self.parses
    }

    pub fn poll(&mut self) -> Vec<Snapshot> {
        let mut sources: BTreeMap<PathBuf, Option<u32>> = BTreeMap::new();
        if self.use_registry {
            match registry::dir() {
                Ok(dir) => match registry::list(&dir) {
                    Ok(entries) => {
                        self.note = format!("registry {}", dir.display());
                        for entry in entries {
                            sources
                                .entry(canonical(&entry.workdir))
                                .or_insert(Some(entry.pid));
                        }
                    }
                    Err(error) => self.note = format!("registry {}: {error:#}", dir.display()),
                },
                Err(error) => self.note = format!("{error:#}"),
            }
        } else {
            self.note = "registry disabled".into();
        }
        for workdir in &self.explicit {
            sources.entry(canonical(workdir)).or_insert(None);
        }

        let mut snapshots = Vec::new();
        for (workdir, registered_pid) in sources {
            if !Status::path(&workdir).exists() {
                continue;
            }
            let (status, read_error, pid_alive) = match Status::read(&workdir) {
                Ok(status) => {
                    let alive = pid_alive(status.pid);
                    (Some(status), None, alive)
                }
                Err(error) => (
                    None,
                    Some(format!("{error:#}")),
                    registered_pid.is_some_and(pid_alive),
                ),
            };
            let findings = self.findings_for(&workdir);
            snapshots.push(Snapshot {
                key: workdir,
                status,
                read_error,
                pid_alive,
                findings,
            });
        }
        self.findings
            .retain(|key, _| snapshots.iter().any(|snapshot| &snapshot.key == key));
        snapshots
    }

    fn findings_for(&mut self, workdir: &Path) -> Vec<FindingEntry> {
        let listing = artifact_listing(workdir);
        if let Some(cache) = self.findings.get(workdir) {
            if cache.listing == listing {
                return cache.entries.clone();
            }
        }
        let modified: HashMap<&Path, SystemTime> = listing
            .iter()
            .map(|(path, modified, _)| (path.as_path(), *modified))
            .collect();
        self.parses += 1;
        let entries: Vec<FindingEntry> = status::read_findings(workdir)
            .into_iter()
            .map(|(path, record)| {
                let modified_ms = modified
                    .get(path.as_path())
                    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |since| since.as_millis() as u64);
                FindingEntry {
                    path,
                    modified_ms,
                    record,
                }
            })
            .collect();
        self.findings.insert(
            workdir.to_path_buf(),
            FindingsCache {
                listing,
                entries: entries.clone(),
            },
        );
        entries
    }
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The published metadata files of a campaign with their sizes and
/// modification times, sorted by name; staging files never carry the
/// suffixes and so never appear.
fn artifact_listing(workdir: &Path) -> Vec<(PathBuf, SystemTime, u64)> {
    let Ok(entries) = fs::read_dir(workdir.join("artifacts")) else {
        return Vec::new();
    };
    let mut listing = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let published = path.file_name().is_some_and(|name| {
            let name = name.to_string_lossy();
            name.ends_with(".pending.json") || name.ends_with(".confirmed.json")
        });
        if !published {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        listing.push((path, modified, metadata.len()));
    }
    listing.sort();
    listing
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: signal 0 delivers nothing; kill only checks that the process
    // exists and may be signalled, and a pid never names this process's
    // own group here because zero was excluded above.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::ArtifactSink;
    use crate::executor::{ExecutorConfig, Finding, FindingFingerprint, FindingKind};
    use crate::status::{Outcome, Phase};
    use std::os::unix::fs::symlink;
    use std::time::Duration;

    fn write_status(workdir: &Path, pid: u32) -> Status {
        fs::create_dir_all(workdir).unwrap();
        let status = Status {
            version: status::STATUS_VERSION,
            pid,
            workdir: workdir.to_path_buf(),
            target: PathBuf::from("/opt/demo-target"),
            target_label: Some("//demo:fuzz".into()),
            sanitizer: "none".into(),
            seed: 7,
            jobs: 1,
            timeout_ms: 1000,
            max_input: 65_536,
            started_at_ms: 1_000_000,
            updated_at_ms: 1_001_000,
            phase: Phase::Finished {
                outcome: Outcome::Budget,
            },
            elapsed_ms: 1_000,
            executions: 10,
            verification_executions: 0,
            corpus_size: 1,
            features: 1,
            edges: 1,
            counters: 0,
            interesting_inputs: 0,
            last_interesting_ms: None,
            last_finding_ms: None,
            worker_restarts: 0,
            unstable_seeds: 0,
            truncated_observations: 0,
            flaky_findings: 0,
            dictionary_entries: 0,
            workers: Vec::new(),
            mutators: Vec::new(),
            finding: None,
            infrastructure_error: None,
            interrupted_signal: None,
        };
        status.write(workdir).unwrap();
        status
    }

    fn sink(workdir: &Path) -> ArtifactSink {
        let target = workdir.join("target");
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
        ArtifactSink::new(workdir, &config, None, 7, "none".into()).unwrap()
    }

    fn crash(code: i32) -> Finding {
        Finding {
            kind: FindingKind::Crash,
            fingerprint: FindingFingerprint {
                kind: FindingKind::Crash,
                code: Some(code),
                sanitizer: None,
            },
            detail: format!("signal {code}"),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn findings_are_reparsed_only_when_the_listing_changes() {
        let directory = tempfile::tempdir().unwrap();
        let workdir = directory.path().join("campaign");
        write_status(&workdir, std::process::id());
        let sink = sink(&workdir);
        sink.record(b"one", &crash(6), false, 1).unwrap();
        let mut poller = Poller::new(vec![workdir.clone()], false);

        let snapshots = poller.poll();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].findings.len(), 1);
        assert!(snapshots[0].pid_alive);
        assert_eq!(poller.parses(), 1);
        poller.poll();
        assert_eq!(poller.parses(), 1);

        let second = sink.record(b"two", &crash(11), true, 2).unwrap();
        fs::write(workdir.join("artifacts/.tmpstaging"), b"{").unwrap();
        let snapshots = poller.poll();
        assert_eq!(snapshots[0].findings.len(), 2);
        assert_eq!(poller.parses(), 2);
        assert!(snapshots[0].findings[0].modified_ms > 0);

        // A rewritten record with a different size is read again; a broken
        // one is then no longer a finding.
        fs::write(&second.metadata_path, b"{}").unwrap();
        let snapshots = poller.poll();
        assert_eq!(snapshots[0].findings.len(), 1);
        assert_eq!(poller.parses(), 3);
        assert_eq!(poller.note(), "registry disabled");
    }

    #[test]
    fn a_missing_status_file_drops_the_campaign() {
        let directory = tempfile::tempdir().unwrap();
        let workdir = directory.path().join("campaign");
        write_status(&workdir, std::process::id());
        let mut poller = Poller::new(vec![workdir.clone()], false);
        assert_eq!(poller.poll().len(), 1);
        fs::remove_file(Status::path(&workdir)).unwrap();
        assert!(poller.poll().is_empty());
        assert!(poller.findings.is_empty());

        fs::write(Status::path(&workdir), b"{\"version\": 1").unwrap();
        let snapshots = poller.poll();
        assert_eq!(snapshots.len(), 1);
        assert!(snapshots[0].status.is_none());
        assert!(
            snapshots[0]
                .read_error
                .as_deref()
                .unwrap()
                .contains("parsing")
        );
        assert!(!snapshots[0].pid_alive);
    }

    #[test]
    fn explicit_and_registered_workdirs_dedupe_by_canonical_path() {
        let directory = tempfile::tempdir().unwrap();
        let workdir = directory.path().join("campaign");
        let status = write_status(&workdir, 0);
        let link = directory.path().join("link");
        symlink(&workdir, &link).unwrap();
        let state = directory.path().join("state");
        registry::register(
            &state,
            &registry::Registration {
                workdir: link.clone(),
                pid: status.pid,
                started_at_ms: status.started_at_ms,
            },
        )
        .unwrap();
        let mut poller = Poller::new(vec![link, workdir.clone()], false);
        let snapshots = poller.poll();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].key, fs::canonicalize(&workdir).unwrap());
        assert!(!snapshots[0].pid_alive);
    }

    #[test]
    fn pid_liveness_reports_this_process_and_a_reaped_child() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
        let child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait_with_output().unwrap();
        assert!(!pid_alive(pid));
    }
}
