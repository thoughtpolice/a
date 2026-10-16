// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Pressure Stall Information (PSI) reader.
//!
//! PSI exposes per-resource stall metrics in the cgroup filesystem
//! (and globally under `/proc/pressure/`). Each resource has two
//! lines:
//!
//! ```text
//! some avg10=0.00 avg60=0.00 avg300=0.00 total=12345
//! full avg10=0.00 avg60=0.00 avg300=0.00 total=6789
//! ```
//!
//! - **some**: fraction of time _at least one_ task was stalled.
//! - **full**: fraction of time _all_ non-idle tasks were stalled
//!   (severe thrashing). Not defined for CPU at the system level.
//!
//! `avg10/60/300` are rolling percentage averages over 10 s / 60 s /
//! 300 s windows. `total` is the cumulative stall time in
//! microseconds.
//!
//! Reference: <https://docs.kernel.org/accounting/psi.html>

use std::path::Path;

/// A single PSI measurement line (`some` or `full`).
#[derive(Debug, Clone, Copy, Default)]
pub struct PsiLine {
    /// Rolling average over the last 10 seconds (percentage, 0–100).
    pub avg10: f64,
    /// Rolling average over the last 60 seconds.
    pub avg60: f64,
    /// Rolling average over the last 300 seconds (5 minutes).
    pub avg300: f64,
    /// Cumulative stall time in microseconds.
    pub total_us: u64,
}

/// PSI snapshot for one resource.
#[derive(Debug, Clone, Default)]
pub struct PsiResource {
    /// At least one task was stalled.
    pub some: PsiLine,
    /// All non-idle tasks were stalled simultaneously.
    pub full: Option<PsiLine>,
}

/// Complete PSI snapshot across all resources.
#[derive(Debug, Clone, Default)]
pub struct PsiSnapshot {
    pub cpu: Option<PsiResource>,
    pub memory: Option<PsiResource>,
    pub io: Option<PsiResource>,
}

/// Read a PSI snapshot from a cgroup directory.
///
/// Reads `cpu.pressure`, `memory.pressure`, and `io.pressure`. Missing
/// or unreadable files yield `None` for that resource.
pub fn read(cgroup_dir: &Path) -> PsiSnapshot {
    PsiSnapshot {
        cpu: read_resource(&cgroup_dir.join("cpu.pressure")),
        memory: read_resource(&cgroup_dir.join("memory.pressure")),
        io: read_resource(&cgroup_dir.join("io.pressure")),
    }
}

fn read_resource(path: &Path) -> Option<PsiResource> {
    let contents = std::fs::read_to_string(path).ok()?;
    parse_resource(&contents)
}

fn parse_resource(contents: &str) -> Option<PsiResource> {
    let mut some = None;
    let mut full = None;
    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix("some ") {
            some = parse_line(rest);
        } else if let Some(rest) = line.strip_prefix("full ") {
            full = parse_line(rest);
        }
    }
    Some(PsiResource { some: some?, full })
}

/// Parse `avg10=0.00 avg60=0.00 avg300=0.00 total=12345`.
fn parse_line(s: &str) -> Option<PsiLine> {
    let mut avg10 = None;
    let mut avg60 = None;
    let mut avg300 = None;
    let mut total_us = None;

    for part in s.split_whitespace() {
        if let Some((key, val)) = part.split_once('=') {
            match key {
                "avg10" => avg10 = val.parse().ok(),
                "avg60" => avg60 = val.parse().ok(),
                "avg300" => avg300 = val.parse().ok(),
                "total" => total_us = val.parse().ok(),
                _ => {}
            }
        }
    }

    Some(PsiLine {
        avg10: avg10?,
        avg60: avg60?,
        avg300: avg300?,
        total_us: total_us?,
    })
}

// -- pressure classification -------------------------------------------------

/// Coarse pressure level derived from `avg10`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PressureLevel {
    /// avg10 < 5%  — no meaningful contention.
    None,
    /// avg10 < 15% — light contention, may be transient.
    Low,
    /// avg10 < 40% — significant contention, consider shedding load.
    Medium,
    /// avg10 >= 40% — severe stalls, active shedding recommended.
    High,
}

impl PressureLevel {
    /// Classify from a "some" avg10 value.
    pub fn from_avg10(avg10: f64) -> Self {
        if avg10 >= 40.0 {
            Self::High
        } else if avg10 >= 15.0 {
            Self::Medium
        } else if avg10 >= 5.0 {
            Self::Low
        } else {
            Self::None
        }
    }
}

impl std::fmt::Display for PressureLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => f.write_str("none"),
            Self::Low => f.write_str("low"),
            Self::Medium => f.write_str("medium"),
            Self::High => f.write_str("high"),
        }
    }
}

// -- pressure monitor --------------------------------------------------------

/// Coarse snapshot of pressure across all resources, suitable for
/// quick decision-making in request handlers.
#[derive(Debug, Clone, Copy)]
pub struct PressureState {
    pub cpu: PressureLevel,
    pub memory: PressureLevel,
    pub io: PressureLevel,
}

impl Default for PressureState {
    fn default() -> Self {
        Self {
            cpu: PressureLevel::None,
            memory: PressureLevel::None,
            io: PressureLevel::None,
        }
    }
}

impl PressureState {
    fn from_snapshot(snap: &PsiSnapshot) -> Self {
        Self {
            cpu: snap
                .cpu
                .as_ref()
                .map(|r| PressureLevel::from_avg10(r.some.avg10))
                .unwrap_or(PressureLevel::None),
            memory: snap
                .memory
                .as_ref()
                .map(|r| PressureLevel::from_avg10(r.some.avg10))
                .unwrap_or(PressureLevel::None),
            io: snap
                .io
                .as_ref()
                .map(|r| PressureLevel::from_avg10(r.some.avg10))
                .unwrap_or(PressureLevel::None),
        }
    }
}

/// Background monitor that periodically reads PSI and exposes the
/// current pressure state via a [`tokio::sync::watch`] channel.
///
/// # Usage
///
/// ```rust,ignore
/// let monitor = PressureMonitor::spawn(cgroup_dir, Duration::from_secs(2));
///
/// // In a request handler:
/// let state = monitor.current();
/// if state.memory >= PressureLevel::High {
///     return Err(Status::resource_exhausted("memory pressure"));
/// }
/// ```
///
/// The monitor task runs until the `PressureMonitor` (and all cloned
/// receivers) are dropped.
#[derive(Clone)]
pub struct PressureMonitor {
    rx: tokio::sync::watch::Receiver<PressureState>,
}

impl PressureMonitor {
    /// Spawn a background task that reads PSI from `cgroup_dir` every
    /// `interval`.
    ///
    /// Returns `None` if `cgroup_dir` is `None` (no cgroup detected).
    pub fn spawn(
        cgroup_dir: Option<std::path::PathBuf>,
        interval: std::time::Duration,
    ) -> Option<Self> {
        let cgroup_dir = cgroup_dir?;

        // Take an initial reading so the watch starts populated.
        let initial = PressureState::from_snapshot(&read(&cgroup_dir));
        let (tx, rx) = tokio::sync::watch::channel(initial);

        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let snap = read(&cgroup_dir);
                let state = PressureState::from_snapshot(&snap);

                // Only warn when pressure is severe enough to trigger
                // load shedding — Medium is noticeable but transient,
                // and logging every 2 s at that level is just noise.
                if state.memory >= PressureLevel::High
                    || state.cpu >= PressureLevel::High
                    || state.io >= PressureLevel::High
                {
                    tracing::warn!(
                        memory = %state.memory,
                        cpu = %state.cpu,
                        io = %state.io,
                        "high resource pressure"
                    );
                }

                if tx.send(state).is_err() {
                    break; // All receivers dropped.
                }
            }
        });

        Some(Self { rx })
    }

    /// Get the most recent pressure state (non-blocking).
    pub fn current(&self) -> PressureState {
        *self.rx.borrow()
    }

    /// Subscribe to pressure state changes.
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<PressureState> {
        self.rx.clone()
    }
}

// -- tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const MEMORY_PRESSURE: &str = "\
some avg10=1.23 avg60=4.56 avg300=7.89 total=123456
full avg10=0.10 avg60=0.20 avg300=0.30 total=654321
";

    const CPU_PRESSURE: &str = "\
some avg10=12.34 avg60=5.67 avg300=2.00 total=9999999
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
";

    const CPU_PRESSURE_NO_FULL: &str = "\
some avg10=0.50 avg60=0.10 avg300=0.05 total=42
";

    #[test]
    fn parse_memory_pressure() {
        let res = parse_resource(MEMORY_PRESSURE).unwrap();
        assert!((res.some.avg10 - 1.23).abs() < f64::EPSILON);
        assert!((res.some.avg60 - 4.56).abs() < f64::EPSILON);
        assert!((res.some.avg300 - 7.89).abs() < f64::EPSILON);
        assert_eq!(res.some.total_us, 123456);

        let full = res.full.unwrap();
        assert!((full.avg10 - 0.10).abs() < f64::EPSILON);
        assert_eq!(full.total_us, 654321);
    }

    #[test]
    fn parse_cpu_pressure_with_full() {
        let res = parse_resource(CPU_PRESSURE).unwrap();
        assert!((res.some.avg10 - 12.34).abs() < f64::EPSILON);
        let full = res.full.unwrap();
        assert!((full.avg10 - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_cpu_pressure_without_full() {
        let res = parse_resource(CPU_PRESSURE_NO_FULL).unwrap();
        assert!((res.some.avg10 - 0.50).abs() < f64::EPSILON);
        assert!(res.full.is_none());
    }

    #[test]
    fn parse_empty_string() {
        assert!(parse_resource("").is_none());
    }

    #[test]
    fn parse_garbage() {
        assert!(parse_resource("not valid psi data").is_none());
    }

    #[test]
    fn parse_line_missing_field() {
        // Missing total.
        assert!(parse_line("avg10=1.0 avg60=2.0 avg300=3.0").is_none());
    }

    #[test]
    fn parse_line_extra_fields_ignored() {
        let line = parse_line("avg10=1.0 avg60=2.0 avg300=3.0 total=100 foo=bar").unwrap();
        assert_eq!(line.total_us, 100);
    }

    // -- PressureLevel --------------------------------------------------------

    #[test]
    fn level_none() {
        assert_eq!(PressureLevel::from_avg10(0.0), PressureLevel::None);
        assert_eq!(PressureLevel::from_avg10(4.99), PressureLevel::None);
    }

    #[test]
    fn level_low() {
        assert_eq!(PressureLevel::from_avg10(5.0), PressureLevel::Low);
        assert_eq!(PressureLevel::from_avg10(14.99), PressureLevel::Low);
    }

    #[test]
    fn level_medium() {
        assert_eq!(PressureLevel::from_avg10(15.0), PressureLevel::Medium);
        assert_eq!(PressureLevel::from_avg10(39.99), PressureLevel::Medium);
    }

    #[test]
    fn level_high() {
        assert_eq!(PressureLevel::from_avg10(40.0), PressureLevel::High);
        assert_eq!(PressureLevel::from_avg10(100.0), PressureLevel::High);
    }

    #[test]
    fn levels_are_ordered() {
        assert!(PressureLevel::None < PressureLevel::Low);
        assert!(PressureLevel::Low < PressureLevel::Medium);
        assert!(PressureLevel::Medium < PressureLevel::High);
    }

    // -- live read (best-effort) ----------------------------------------------

    #[test]
    fn read_from_proc_pressure() {
        // /proc/pressure/ is system-wide, should exist on any Linux 4.20+.
        let snap = read(Path::new("/proc/pressure"));
        // If we got here, the files were either read or gracefully skipped.
        if let Some(cpu) = &snap.cpu {
            assert!(cpu.some.avg10 >= 0.0);
        }
    }
}
