// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The monitor's state: campaigns as last seen on disk, their sampled
//! throughput, and the selection the keys move. Nothing here touches the
//! clock or the filesystem, so tests drive it with synthetic snapshots.

use crate::status::{FindingRecord, Outcome, Phase, Status};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

pub const SAMPLE_WINDOW: usize = 120;
/// The engine rewrites its status about once a second; a fast refresh must
/// not flag every campaign as stalled.
pub const MIN_STALE_MS: u64 = 3_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Running,
    Stalled,
    Dead,
    Finished(Outcome),
}

impl State {
    pub fn rank(self) -> u8 {
        match self {
            Self::Running => 0,
            Self::Stalled => 1,
            Self::Dead => 2,
            Self::Finished(_) => 3,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stalled => "stalled",
            Self::Dead => "dead",
            Self::Finished(Outcome::Budget) => "finished:budget",
            Self::Finished(Outcome::Finding) => "finished:finding",
            Self::Finished(Outcome::Interrupted) => "finished:interrupted",
            Self::Finished(Outcome::Error) => "finished:error",
        }
    }

    pub fn is_running(self) -> bool {
        matches!(self, Self::Running | Self::Stalled)
    }
}

pub fn stale_after_ms(refresh_ms: u64) -> u64 {
    refresh_ms.saturating_mul(3).max(MIN_STALE_MS)
}

pub fn classify(status: &Status, pid_alive: bool, now_ms: u64, stale_after_ms: u64) -> State {
    if let Phase::Finished { outcome } = status.phase {
        return State::Finished(outcome);
    }
    if !pid_alive {
        return State::Dead;
    }
    if now_ms.saturating_sub(status.updated_at_ms) > stale_after_ms {
        State::Stalled
    } else {
        State::Running
    }
}

#[derive(Clone, Debug)]
pub struct FindingEntry {
    pub path: PathBuf,
    pub modified_ms: u64,
    pub record: FindingRecord,
}

/// What the poller hands over for one campaign directory each tick.
pub struct Snapshot {
    pub key: PathBuf,
    pub status: Option<Status>,
    pub read_error: Option<String>,
    pub pid_alive: bool,
    pub findings: Vec<FindingEntry>,
}

pub struct Campaign {
    pub key: PathBuf,
    pub name: String,
    pub status: Status,
    pub state: State,
    pub read_error: Option<String>,
    pub findings: Vec<FindingEntry>,
    samples: VecDeque<(u64, u64)>,
    rates: VecDeque<u64>,
}

impl Campaign {
    fn new(key: PathBuf, status: Status) -> Self {
        let name = status.target_label.clone().unwrap_or_else(|| {
            key.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| key.display().to_string())
        });
        let mut campaign = Self {
            key,
            name,
            status,
            state: State::Running,
            read_error: None,
            findings: Vec::new(),
            samples: VecDeque::new(),
            rates: VecDeque::new(),
        };
        campaign.push_sample();
        campaign
    }

    fn update(&mut self, status: Status) {
        // A rerun in the same directory starts its counters over.
        let restarted = status.started_at_ms != self.status.started_at_ms
            || status.executions < self.status.executions;
        if restarted {
            self.samples.clear();
            self.rates.clear();
        }
        let advanced = self
            .samples
            .back()
            .is_none_or(|(elapsed, _)| status.elapsed_ms > *elapsed);
        self.status = status;
        if restarted || advanced {
            self.push_sample();
        }
    }

    /// Samples pair the campaign's own monotonic clock with its execution
    /// count, so rates never depend on when this process happened to read
    /// the file.
    fn push_sample(&mut self) {
        let sample = (self.status.elapsed_ms, self.status.executions);
        if let Some(&(elapsed, executions)) = self.samples.back() {
            let delta_ms = sample.0.saturating_sub(elapsed);
            if delta_ms > 0 {
                let rate = sample.1.saturating_sub(executions).saturating_mul(1000) / delta_ms;
                self.rates.push_back(rate);
                if self.rates.len() > SAMPLE_WINDOW {
                    self.rates.pop_front();
                }
            }
        }
        self.samples.push_back(sample);
        if self.samples.len() > SAMPLE_WINDOW {
            self.samples.pop_front();
        }
    }

    pub fn current_rate(&self) -> Option<f64> {
        let count = self.samples.len();
        if count < 2 {
            return None;
        }
        let (earlier, before) = self.samples[count - 2];
        let (later, after) = self.samples[count - 1];
        let delta_ms = later.saturating_sub(earlier);
        (delta_ms > 0).then(|| after.saturating_sub(before) as f64 * 1000.0 / delta_ms as f64)
    }

    pub fn average_rate(&self) -> f64 {
        if self.status.elapsed_ms == 0 {
            0.0
        } else {
            self.status.executions as f64 * 1000.0 / self.status.elapsed_ms as f64
        }
    }

    /// The latest interval while running, the average once done.
    pub fn display_rate(&self) -> f64 {
        if self.state.is_running() {
            self.current_rate().unwrap_or_else(|| self.average_rate())
        } else {
            self.average_rate()
        }
    }

    pub fn rates(&self) -> impl Iterator<Item = u64> + '_ {
        self.rates.iter().copied()
    }

    pub fn map_density(&self) -> Option<f64> {
        (self.status.counters > 0).then(|| self.status.edges as f64 / self.status.counters as f64)
    }

    /// Confirmed and flaky findings on disk.
    pub fn finding_counts(&self) -> (usize, usize) {
        let confirmed = self
            .findings
            .iter()
            .filter(|entry| entry.record.confirmed)
            .count();
        (confirmed, self.findings.len() - confirmed)
    }

    /// How long the campaign had been running when it last reported, plus
    /// the time since that report while it is still going.
    pub fn uptime_ms(&self, now_ms: u64) -> u64 {
        if self.state.is_running() {
            self.status.elapsed_ms + self.staleness_ms(now_ms)
        } else {
            self.status.elapsed_ms
        }
    }

    pub fn last_new_path_age_ms(&self, now_ms: u64) -> Option<u64> {
        self.age_of(self.status.last_interesting_ms, now_ms)
    }

    pub fn last_finding_age_ms(&self, now_ms: u64) -> Option<u64> {
        self.age_of(self.status.last_finding_ms, now_ms)
    }

    /// A campaign-relative marker becomes an age by adding how long before
    /// the last report it happened and how old that report is.
    fn age_of(&self, marker_ms: Option<u64>, now_ms: u64) -> Option<u64> {
        marker_ms.map(|at| self.status.elapsed_ms.saturating_sub(at) + self.staleness_ms(now_ms))
    }

    fn staleness_ms(&self, now_ms: u64) -> u64 {
        now_ms.saturating_sub(self.status.updated_at_ms)
    }
}

/// A confirmed finding is on disk twice, as the pending record written
/// before verification and the confirmed one after it; only the confirmed
/// one is listed. The file stem names the input and fingerprint.
fn dedupe_findings(entries: Vec<FindingEntry>) -> Vec<FindingEntry> {
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut findings: Vec<FindingEntry> = Vec::new();
    for entry in entries {
        let stem = stem_of(&entry.path);
        match positions.get(&stem) {
            Some(&position) => {
                if entry.record.confirmed && !findings[position].record.confirmed {
                    findings[position] = entry;
                }
            }
            None => {
                positions.insert(stem, findings.len());
                findings.push(entry);
            }
        }
    }
    findings
}

fn stem_of(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.trim_end_matches(".pending.json")
        .trim_end_matches(".confirmed.json")
        .to_owned()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Focus {
    Campaigns,
    Findings,
    Detail,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Quit,
    Back,
    Next,
    Previous,
    PageDown,
    PageUp,
    First,
    Last,
    FocusNext,
    FocusPrevious,
    Activate,
    Refresh,
    ToggleHelp,
}

pub struct Model {
    pub campaigns: Vec<Campaign>,
    /// The selected campaign's key rather than its row, so re-sorting never
    /// moves the selection.
    pub selected: Option<PathBuf>,
    pub selected_finding: usize,
    pub finding_open: bool,
    pub focus: Focus,
    pub detail_scroll: u16,
    pub help: bool,
    pub now_ms: u64,
    pub load_average: Option<f64>,
    pub refresh_ms: u64,
    pub registry_note: String,
    pub quit: bool,
    pub refresh_requested: bool,
}

impl Model {
    pub fn new(refresh_ms: u64) -> Self {
        Self {
            campaigns: Vec::new(),
            selected: None,
            selected_finding: 0,
            finding_open: false,
            focus: Focus::Campaigns,
            detail_scroll: 0,
            help: false,
            now_ms: 0,
            load_average: None,
            refresh_ms,
            registry_note: String::new(),
            quit: false,
            refresh_requested: false,
        }
    }

    pub fn apply(&mut self, snapshots: Vec<Snapshot>, now_ms: u64) {
        self.now_ms = now_ms;
        let stale_after = stale_after_ms(self.refresh_ms);
        let mut previous: HashMap<PathBuf, Campaign> = std::mem::take(&mut self.campaigns)
            .into_iter()
            .map(|campaign| (campaign.key.clone(), campaign))
            .collect();
        for snapshot in snapshots {
            let mut campaign = match (snapshot.status, previous.remove(&snapshot.key)) {
                (Some(status), Some(mut campaign)) => {
                    campaign.update(status);
                    campaign
                }
                (Some(status), None) => Campaign::new(snapshot.key, status),
                // An unreadable file keeps the last good status on screen.
                (None, Some(campaign)) => campaign,
                (None, None) => continue,
            };
            campaign.read_error = snapshot.read_error;
            campaign.state = classify(&campaign.status, snapshot.pid_alive, now_ms, stale_after);
            campaign.findings = dedupe_findings(snapshot.findings);
            self.campaigns.push(campaign);
        }
        self.campaigns.sort_by(|a, b| {
            a.state
                .rank()
                .cmp(&b.state.rank())
                .then(a.status.started_at_ms.cmp(&b.status.started_at_ms))
                .then_with(|| a.key.cmp(&b.key))
        });
        if self
            .selected
            .as_ref()
            .is_none_or(|key| !self.campaigns.iter().any(|campaign| &campaign.key == key))
        {
            self.selected = self.campaigns.first().map(|campaign| campaign.key.clone());
        }
        self.clamp_finding();
    }

    fn clamp_finding(&mut self) {
        let findings = self
            .selected_campaign()
            .map_or(0, |campaign| campaign.findings.len());
        if findings == 0 {
            self.selected_finding = 0;
            self.finding_open = false;
            self.focus = Focus::Campaigns;
        } else if self.selected_finding >= findings {
            self.selected_finding = findings - 1;
        }
    }

    pub fn selected_index(&self) -> Option<usize> {
        let key = self.selected.as_ref()?;
        self.campaigns
            .iter()
            .position(|campaign| &campaign.key == key)
    }

    pub fn selected_campaign(&self) -> Option<&Campaign> {
        self.selected_index().map(|index| &self.campaigns[index])
    }

    pub fn selected_finding(&self) -> Option<&FindingEntry> {
        self.selected_campaign()?
            .findings
            .get(self.selected_finding)
    }

    /// Campaigns still going (stalled ones included) and the rest.
    pub fn counts(&self) -> (usize, usize) {
        let running = self
            .campaigns
            .iter()
            .filter(|campaign| campaign.state.is_running())
            .count();
        (running, self.campaigns.len() - running)
    }

    pub fn handle(&mut self, action: Action) {
        match action {
            Action::Quit => self.quit = true,
            Action::Refresh => self.refresh_requested = true,
            Action::ToggleHelp => self.help = !self.help,
            Action::Back => {
                if self.help {
                    self.help = false;
                } else if self.finding_open {
                    self.finding_open = false;
                    self.focus = Focus::Findings;
                } else if self.focus != Focus::Campaigns {
                    self.focus = Focus::Campaigns;
                } else {
                    self.quit = true;
                }
            }
            Action::Next => self.step(1, true),
            Action::Previous => self.step(-1, true),
            Action::PageDown => self.step(self.page(), false),
            Action::PageUp => self.step(-self.page(), false),
            Action::First => self.step(isize::MIN / 2, false),
            Action::Last => self.step(isize::MAX / 2, false),
            Action::FocusNext => self.cycle_focus(true),
            Action::FocusPrevious => self.cycle_focus(false),
            Action::Activate => match self.focus {
                Focus::Campaigns => {
                    if self
                        .selected_campaign()
                        .is_some_and(|campaign| !campaign.findings.is_empty())
                    {
                        self.focus = Focus::Findings;
                        self.finding_open = true;
                        self.detail_scroll = 0;
                    }
                }
                Focus::Findings => {
                    self.finding_open = !self.finding_open;
                    if self.finding_open {
                        self.focus = Focus::Detail;
                        self.detail_scroll = 0;
                    }
                }
                Focus::Detail => {
                    self.finding_open = false;
                    self.focus = Focus::Findings;
                }
            },
        }
    }

    fn page(&self) -> isize {
        match self.focus {
            Focus::Campaigns => 10,
            Focus::Findings | Focus::Detail => 5,
        }
    }

    fn step(&mut self, delta: isize, wrap: bool) {
        match self.focus {
            Focus::Campaigns => {
                let count = self.campaigns.len();
                let Some(index) = self.selected_index() else {
                    return;
                };
                let next = moved(index, count, delta, wrap);
                if next != index {
                    self.selected = Some(self.campaigns[next].key.clone());
                    self.selected_finding = 0;
                    self.detail_scroll = 0;
                    self.clamp_finding();
                }
            }
            Focus::Findings => {
                let count = self
                    .selected_campaign()
                    .map_or(0, |campaign| campaign.findings.len());
                if count != 0 {
                    self.selected_finding = moved(self.selected_finding, count, delta, wrap);
                    self.detail_scroll = 0;
                }
            }
            Focus::Detail => {
                self.detail_scroll = if delta < 0 {
                    self.detail_scroll
                        .saturating_sub(delta.unsigned_abs().min(u16::MAX as usize) as u16)
                } else {
                    self.detail_scroll
                        .saturating_add(delta.unsigned_abs().min(u16::MAX as usize) as u16)
                };
            }
        }
    }

    fn cycle_focus(&mut self, forward: bool) {
        let has_findings = self
            .selected_campaign()
            .is_some_and(|campaign| !campaign.findings.is_empty());
        let mut order = vec![Focus::Campaigns];
        if has_findings {
            order.push(Focus::Findings);
            if self.finding_open {
                order.push(Focus::Detail);
            }
        }
        let position = order
            .iter()
            .position(|focus| *focus == self.focus)
            .unwrap_or(0);
        let next = if forward {
            (position + 1) % order.len()
        } else {
            (position + order.len() - 1) % order.len()
        };
        self.focus = order[next];
    }
}

fn moved(index: usize, count: usize, delta: isize, wrap: bool) -> usize {
    if count == 0 {
        return 0;
    }
    let target = index as isize + delta;
    if wrap {
        target.rem_euclid(count as isize) as usize
    } else {
        target.clamp(0, count as isize - 1) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::{FindingFingerprint, FindingKind};

    pub fn status(pid: u32, phase: Phase, elapsed_ms: u64, executions: u64) -> Status {
        Status {
            version: crate::status::STATUS_VERSION,
            pid,
            workdir: PathBuf::from("/var/tmp/demo"),
            target: PathBuf::from("/opt/demo-target"),
            target_label: Some("//demo:fuzz".into()),
            sanitizer: "none".into(),
            seed: 7,
            jobs: 2,
            timeout_ms: 1000,
            max_input: 65_536,
            started_at_ms: 1_000_000,
            updated_at_ms: 1_000_000 + elapsed_ms,
            phase,
            elapsed_ms,
            executions,
            verification_executions: 0,
            corpus_size: 12,
            features: 300,
            edges: 40,
            counters: 5000,
            interesting_inputs: 11,
            last_interesting_ms: Some(elapsed_ms.saturating_sub(2_000)),
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
        }
    }

    pub fn finding(name: &str, confirmed: bool) -> FindingEntry {
        FindingEntry {
            path: PathBuf::from(format!(
                "/var/tmp/demo/artifacts/{name}.{}.json",
                if confirmed { "confirmed" } else { "pending" }
            )),
            modified_ms: 1_000_000,
            record: FindingRecord {
                kind: FindingKind::Crash,
                fingerprint: FindingFingerprint {
                    kind: FindingKind::Crash,
                    code: Some(6),
                    sanitizer: None,
                },
                confirmed,
                detail: "signal 6".into(),
                input_digest: name.into(),
                input_size: 3,
                execution: 1,
                target_label: None,
                sanitizer: "none".into(),
                repro: "buck2 run ...".into(),
                minimize: String::new(),
                stderr: String::new(),
            },
        }
    }

    fn snapshot(key: &str, status: Status, findings: Vec<FindingEntry>) -> Snapshot {
        Snapshot {
            key: PathBuf::from(key),
            status: Some(status),
            read_error: None,
            pid_alive: true,
            findings,
        }
    }

    fn running(key: &str, elapsed_ms: u64, executions: u64) -> Snapshot {
        snapshot(
            key,
            status(1, Phase::Fuzzing, elapsed_ms, executions),
            Vec::new(),
        )
    }

    #[test]
    fn rates_come_from_the_campaign_clock() {
        let mut model = Model::new(1000);
        model.apply(vec![running("/a", 10_000, 5_000)], 1_010_000);
        assert_eq!(model.campaigns[0].current_rate(), None);
        assert_eq!(model.campaigns[0].average_rate(), 500.0);
        // The same report seen twice adds no sample.
        model.apply(vec![running("/a", 10_000, 5_000)], 1_010_500);
        assert_eq!(model.campaigns[0].current_rate(), None);
        model.apply(vec![running("/a", 11_000, 9_100)], 1_011_000);
        assert_eq!(model.campaigns[0].current_rate(), Some(4_100.0));
        assert_eq!(model.campaigns[0].display_rate(), 4_100.0);
        assert_eq!(model.campaigns[0].rates().collect::<Vec<_>>(), [4_100]);
        for tick in 2..200 {
            model.apply(
                vec![running("/a", 10_000 + tick * 1_000, 5_000 + tick * 100)],
                1_010_000 + tick * 1_000,
            );
        }
        assert_eq!(model.campaigns[0].rates().count(), SAMPLE_WINDOW);
    }

    #[test]
    fn a_rerun_resets_the_samples() {
        let mut model = Model::new(1000);
        model.apply(vec![running("/a", 10_000, 5_000)], 1_010_000);
        model.apply(vec![running("/a", 11_000, 6_000)], 1_011_000);
        assert!(model.campaigns[0].current_rate().is_some());
        model.apply(vec![running("/a", 500, 10)], 1_012_000);
        assert_eq!(model.campaigns[0].current_rate(), None);
        let mut restarted = status(1, Phase::Fuzzing, 1_000, 20);
        restarted.started_at_ms += 5;
        model.apply(vec![snapshot("/a", restarted, Vec::new())], 1_013_000);
        assert_eq!(model.campaigns[0].current_rate(), None);
    }

    #[test]
    fn classification_follows_phase_pid_and_staleness() {
        let live = status(1, Phase::Fuzzing, 1_000, 1);
        assert_eq!(classify(&live, true, 1_001_000, 3_000), State::Running);
        assert_eq!(classify(&live, true, 1_004_001, 3_000), State::Stalled);
        assert_eq!(classify(&live, false, 1_001_000, 3_000), State::Dead);
        let done = status(
            1,
            Phase::Finished {
                outcome: Outcome::Budget,
            },
            1_000,
            1,
        );
        assert_eq!(
            classify(&done, false, 1_001_000, 3_000),
            State::Finished(Outcome::Budget)
        );
        assert_eq!(stale_after_ms(200), 3_000);
        assert_eq!(stale_after_ms(2_000), 6_000);
        assert_eq!(
            State::Finished(Outcome::Finding).label(),
            "finished:finding"
        );
        assert!(State::Stalled.is_running());
    }

    #[test]
    fn ages_add_the_report_age_to_the_marker() {
        let mut model = Model::new(1000);
        model.apply(vec![running("/a", 10_000, 5_000)], 1_012_500);
        let campaign = &model.campaigns[0];
        assert_eq!(campaign.last_new_path_age_ms(1_012_500), Some(4_500));
        assert_eq!(campaign.last_finding_age_ms(1_012_500), None);
        assert_eq!(campaign.uptime_ms(1_012_500), 12_500);
        assert_eq!(campaign.map_density(), Some(40.0 / 5000.0));
    }

    #[test]
    fn sorts_running_first_and_keeps_the_selection_by_key() {
        let mut model = Model::new(1000);
        let mut done = status(
            2,
            Phase::Finished {
                outcome: Outcome::Budget,
            },
            5_000,
            9,
        );
        done.started_at_ms = 900_000;
        model.apply(
            vec![
                snapshot("/done", done.clone(), Vec::new()),
                running("/live", 1_000, 1),
            ],
            1_001_000,
        );
        assert_eq!(model.campaigns[0].key, Path::new("/live"));
        assert_eq!(model.selected_index(), Some(0));
        model.handle(Action::Next);
        assert_eq!(model.selected_index(), Some(1));
        model.handle(Action::Next);
        assert_eq!(model.selected_index(), Some(0));
        model.handle(Action::Previous);
        assert_eq!(model.selected_index(), Some(1));
        assert_eq!(model.selected_campaign().unwrap().key, Path::new("/done"));
        // The live campaign finishes and sorts after the older finished one.
        let mut finished = status(
            1,
            Phase::Finished {
                outcome: Outcome::Finding,
            },
            2_000,
            2,
        );
        finished.started_at_ms = 1_000_000;
        model.apply(
            vec![
                snapshot("/done", done, Vec::new()),
                snapshot("/live", finished, Vec::new()),
            ],
            1_002_000,
        );
        assert_eq!(model.campaigns[0].key, Path::new("/done"));
        assert_eq!(model.selected_campaign().unwrap().key, Path::new("/done"));
        assert_eq!(model.counts(), (0, 2));
        model.handle(Action::Last);
        assert_eq!(model.selected_index(), Some(1));
        model.handle(Action::First);
        assert_eq!(model.selected_index(), Some(0));
        model.handle(Action::PageDown);
        assert_eq!(model.selected_index(), Some(1));
    }

    #[test]
    fn a_dropped_campaign_falls_back_to_the_first_row() {
        let mut model = Model::new(1000);
        model.apply(
            vec![running("/a", 1_000, 1), running("/b", 1_000, 1)],
            1_001_000,
        );
        model.handle(Action::Next);
        assert_eq!(model.selected_campaign().unwrap().key, Path::new("/b"));
        model.apply(vec![running("/a", 2_000, 2)], 1_002_000);
        assert_eq!(model.selected_campaign().unwrap().key, Path::new("/a"));
        model.apply(Vec::new(), 1_003_000);
        assert_eq!(model.selected, None);
        assert_eq!(model.counts(), (0, 0));
    }

    #[test]
    fn an_unreadable_status_keeps_the_last_good_one() {
        let mut model = Model::new(1000);
        model.apply(vec![running("/a", 1_000, 1)], 1_001_000);
        let broken = Snapshot {
            key: PathBuf::from("/a"),
            status: None,
            read_error: Some("parsing status.json".into()),
            pid_alive: false,
            findings: Vec::new(),
        };
        model.apply(vec![broken], 1_002_000);
        assert_eq!(model.campaigns.len(), 1);
        assert_eq!(model.campaigns[0].status.executions, 1);
        assert_eq!(model.campaigns[0].state, State::Dead);
        assert_eq!(
            model.campaigns[0].read_error.as_deref(),
            Some("parsing status.json")
        );
        let unknown = Snapshot {
            key: PathBuf::from("/b"),
            status: None,
            read_error: Some("parsing".into()),
            pid_alive: true,
            findings: Vec::new(),
        };
        model.apply(vec![unknown], 1_003_000);
        assert!(model.campaigns.is_empty());
    }

    #[test]
    fn findings_dedupe_a_confirmed_record_against_its_pending_twin() {
        let mut model = Model::new(1000);
        let entries = vec![
            finding("crash-aaa-0000", true),
            finding("crash-aaa-0000", false),
            finding("hang-bbb-0000", false),
        ];
        model.apply(
            vec![snapshot("/a", status(1, Phase::Fuzzing, 1_000, 1), entries)],
            1_001_000,
        );
        let campaign = &model.campaigns[0];
        assert_eq!(campaign.findings.len(), 2);
        assert!(campaign.findings[0].record.confirmed);
        assert_eq!(campaign.finding_counts(), (1, 1));
    }

    #[test]
    fn enter_opens_findings_and_tab_cycles_panes() {
        let mut model = Model::new(1000);
        model.apply(vec![running("/a", 1_000, 1)], 1_001_000);
        model.handle(Action::Activate);
        assert_eq!(model.focus, Focus::Campaigns);
        assert!(!model.finding_open);
        model.handle(Action::FocusNext);
        assert_eq!(model.focus, Focus::Campaigns);

        let entries = vec![
            finding("crash-aaa-0000", true),
            finding("hang-bbb-0000", false),
        ];
        model.apply(
            vec![snapshot("/a", status(1, Phase::Fuzzing, 2_000, 2), entries)],
            1_002_000,
        );
        model.handle(Action::FocusNext);
        assert_eq!(model.focus, Focus::Findings);
        model.handle(Action::FocusNext);
        assert_eq!(model.focus, Focus::Campaigns);
        model.handle(Action::Activate);
        assert_eq!(model.focus, Focus::Findings);
        assert!(model.finding_open);
        model.handle(Action::Next);
        assert_eq!(model.selected_finding, 1);
        model.handle(Action::Next);
        assert_eq!(model.selected_finding, 0);
        model.handle(Action::FocusNext);
        assert_eq!(model.focus, Focus::Detail);
        model.handle(Action::PageDown);
        assert_eq!(model.detail_scroll, 5);
        model.handle(Action::Previous);
        assert_eq!(model.detail_scroll, 4);
        model.handle(Action::FocusPrevious);
        assert_eq!(model.focus, Focus::Findings);
        model.handle(Action::Activate);
        assert!(!model.finding_open);
        model.handle(Action::Activate);
        assert!(model.finding_open);
        assert_eq!(model.focus, Focus::Detail);

        // Findings vanish: the panes close and focus returns to the table.
        model.apply(
            vec![snapshot(
                "/a",
                status(1, Phase::Fuzzing, 3_000, 3),
                Vec::new(),
            )],
            1_003_000,
        );
        assert_eq!(model.focus, Focus::Campaigns);
        assert!(!model.finding_open);
        assert_eq!(model.selected_finding, 0);
    }

    #[test]
    fn escape_closes_help_then_detail_then_quits() {
        let mut model = Model::new(1000);
        model.apply(
            vec![snapshot(
                "/a",
                status(1, Phase::Fuzzing, 1_000, 1),
                vec![finding("crash-aaa-0000", true)],
            )],
            1_001_000,
        );
        model.handle(Action::Activate);
        model.handle(Action::ToggleHelp);
        assert!(model.help);
        model.handle(Action::Back);
        assert!(!model.help);
        assert!(model.finding_open);
        model.handle(Action::Back);
        assert!(!model.finding_open);
        assert_eq!(model.focus, Focus::Findings);
        model.handle(Action::Back);
        assert_eq!(model.focus, Focus::Campaigns);
        assert!(!model.quit);
        model.handle(Action::Back);
        assert!(model.quit);
        model.handle(Action::Refresh);
        assert!(model.refresh_requested);
    }
}
