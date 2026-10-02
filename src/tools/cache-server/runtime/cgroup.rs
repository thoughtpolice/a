// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Cgroup v1/v2 resource limit detection.
//!
//! All reads are best-effort: missing or unparseable files yield `None`
//! for that dimension. This module never panics on I/O failure.

use std::fs;
use std::path::{Path, PathBuf};

/// Where the cgroup v2 hierarchy is mounted.
const CGROUP_V2_ROOT: &str = "/sys/fs/cgroup";

/// Raw limits and diagnostic info read from the cgroup filesystem.
pub(crate) struct CgroupLimits {
    /// Effective CPU count derived from the cgroup CPU quota, e.g. 2.5
    /// means the container is allowed 2.5 CPUs worth of time.
    pub cpu_quota_cpus: Option<f64>,

    /// Hard memory limit in bytes, if one is set.
    pub memory_limit_bytes: Option<u64>,

    /// The cgroup whose `memory.max` is `memory_limit_bytes`: this
    /// process's own, or one above it (cgroup v2 only).
    pub memory_limit_dir: Option<PathBuf>,

    /// Diagnostic info about the detection process.
    pub diag: CgroupDiag,
}

/// Diagnostic details about cgroup detection, for startup logging.
pub(crate) struct CgroupDiag {
    /// Resolved cgroup v2 directory (from `/proc/self/cgroup`), if any.
    pub cgroup_dir: Option<String>,
    /// Raw contents of `cpu.max` (v2) or quota/period (v1).
    pub raw_cpu: Option<String>,
    /// Raw contents of `memory.max` (v2) or `memory.limit_in_bytes` (v1).
    pub raw_memory: Option<String>,
    /// Which version was used: "v2", "v1", or "none".
    pub version: &'static str,
}

/// Detect cgroup CPU and memory limits.
///
/// Tries cgroup v2 paths first, then falls back to v1. Always
/// populates diagnostic info regardless of whether limits are found.
pub(crate) fn detect() -> CgroupLimits {
    // Try v2 first.
    if let Some(dir) = self_cgroup_v2_dir() {
        let dir_str = dir.to_string_lossy().into_owned();

        let raw_cpu = fs::read_to_string(dir.join("cpu.max")).ok();
        let raw_memory = fs::read_to_string(dir.join("memory.max")).ok();

        let root = Path::new(CGROUP_V2_ROOT);
        let cpu = tightest_limit(&dir, root, "cpu.max", parse_cpu_max_contents);
        let mem = tightest_limit(&dir, root, "memory.max", parse_memory_max_contents);

        return CgroupLimits {
            cpu_quota_cpus: cpu.map(|(cpus, _)| cpus),
            memory_limit_bytes: mem.as_ref().map(|&(bytes, _)| bytes),
            memory_limit_dir: mem.map(|(_, dir)| dir),
            diag: CgroupDiag {
                cgroup_dir: Some(dir_str),
                raw_cpu: raw_cpu.map(|s| s.trim().to_owned()),
                raw_memory: raw_memory.map(|s| s.trim().to_owned()),
                version: "v2",
            },
        };
    }

    // Fall back to v1.
    let raw_quota = fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").ok();
    let raw_period = fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us").ok();
    let raw_mem = fs::read_to_string("/sys/fs/cgroup/memory/memory.limit_in_bytes").ok();

    let cpu = detect_cpu_v1();
    let mem = detect_memory_v1();

    let has_v1 = raw_quota.is_some() || raw_mem.is_some();
    let raw_cpu_str = match (&raw_quota, &raw_period) {
        (Some(q), Some(p)) => Some(format!("quota={} period={}", q.trim(), p.trim())),
        (Some(q), None) => Some(format!("quota={}", q.trim())),
        _ => None,
    };

    CgroupLimits {
        cpu_quota_cpus: cpu,
        memory_limit_bytes: mem,
        memory_limit_dir: None,
        diag: CgroupDiag {
            cgroup_dir: None,
            raw_cpu: raw_cpu_str,
            raw_memory: raw_mem.map(|s| s.trim().to_owned()),
            version: if has_v1 { "v1" } else { "none" },
        },
    }
}

// -- cgroup v2 ---------------------------------------------------------------

/// Resolve the cgroup v2 directory for the current process.
///
/// Reads `/proc/self/cgroup` which on a v2-only system contains a
/// single line `0::<path>`. The cgroup directory is then
/// `/sys/fs/cgroup/<path>`.
fn self_cgroup_v2_dir() -> Option<std::path::PathBuf> {
    let contents = fs::read_to_string("/proc/self/cgroup").ok()?;
    parse_cgroup_v2_path(&contents)
}

/// Extract the cgroup v2 filesystem path from `/proc/self/cgroup`
/// contents.
fn parse_cgroup_v2_path(contents: &str) -> Option<std::path::PathBuf> {
    for line in contents.lines() {
        // cgroup v2 lines look like "0::/user.slice/..."
        if let Some(path) = line.strip_prefix("0::") {
            let trimmed = path.trim_start_matches('/');
            return Some(std::path::Path::new("/sys/fs/cgroup").join(trimmed));
        }
    }
    None
}

/// The tightest limit `parse` reads from `file` in the cgroup `dir` or in
/// any above it up to `root`, and the cgroup that sets it. A limit on an
/// ancestor binds every cgroup below it: a service's `MemoryMax=` is set on
/// its unit or slice, and a container's process may sit in a cgroup of its
/// own beneath the one carrying the container's limits.
fn tightest_limit<T: PartialOrd>(
    dir: &Path,
    root: &Path,
    file: &str,
    parse: fn(&str) -> Option<T>,
) -> Option<(T, PathBuf)> {
    dir.ancestors()
        .take_while(|cgroup| cgroup.starts_with(root))
        .filter_map(|cgroup| {
            let limit = parse(&fs::read_to_string(cgroup.join(file)).ok()?)?;
            Some((limit, cgroup.to_path_buf()))
        })
        .reduce(|tightest, next| if next.0 < tightest.0 { next } else { tightest })
}

/// Parse `cpu.max` → `"$quota $period"` from the process's cgroup.
///
/// `"max 100000"` means no limit.
fn detect_cpu_v2() -> Option<f64> {
    let dir = self_cgroup_v2_dir()?;
    let contents = fs::read_to_string(dir.join("cpu.max")).ok()?;
    parse_cpu_max_contents(&contents)
}

/// Parse `memory.max` from the process's cgroup.
///
/// `"max"` means no limit.
fn detect_memory_v2() -> Option<u64> {
    let dir = self_cgroup_v2_dir()?;
    let contents = fs::read_to_string(dir.join("memory.max")).ok()?;
    parse_memory_max_contents(&contents)
}

fn parse_cpu_max_contents(contents: &str) -> Option<f64> {
    let mut parts = contents.trim().split_whitespace();
    let quota_str = parts.next()?;
    if quota_str == "max" {
        return None;
    }
    let quota: f64 = quota_str.parse().ok()?;
    let period: f64 = parts.next()?.parse().ok()?;
    if period <= 0.0 {
        return None;
    }
    Some(quota / period)
}

fn parse_memory_max_contents(contents: &str) -> Option<u64> {
    let trimmed = contents.trim();
    if trimmed == "max" {
        return None;
    }
    trimmed.parse().ok()
}

// -- cgroup v1 ---------------------------------------------------------------

/// Quota from `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` and
/// `/sys/fs/cgroup/cpu/cpu.cfs_period_us`. A quota of `-1` means no
/// limit.
fn detect_cpu_v1() -> Option<f64> {
    let quota: i64 = read_i64("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")?;
    if quota < 0 {
        return None;
    }
    let period: i64 = read_i64("/sys/fs/cgroup/cpu/cpu.cfs_period_us")?;
    if period <= 0 {
        return None;
    }
    Some(quota as f64 / period as f64)
}

/// Memory limit from `/sys/fs/cgroup/memory/memory.limit_in_bytes`.
///
/// Values near `i64::MAX` (the kernel sentinel for "no limit") are
/// treated as unlimited.
fn detect_memory_v1() -> Option<u64> {
    let limit = read_u64("/sys/fs/cgroup/memory/memory.limit_in_bytes")?;
    // The kernel writes a large sentinel (typically PAGE_ALIGN(LONG_MAX))
    // when there is no real limit. Anything above 2^62 is effectively
    // unlimited.
    if limit > (1u64 << 62) {
        return None;
    }
    Some(limit)
}

// -- helpers -----------------------------------------------------------------

fn read_i64(path: &str) -> Option<i64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

fn read_u64(path: &str) -> Option<u64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

// -- tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Unit tests exercise the parsing logic via the internal functions.
    // The actual cgroup paths may not exist in the test environment,
    // so we test parsing indirectly through the public detect() entry
    // point (which just returns None for missing files) and through
    // direct string-parsing helpers.

    #[test]
    fn detect_returns_without_panic() {
        // On a non-cgroup host both fields will be None; that's fine.
        let limits = detect();
        if let Some(cpus) = limits.cpu_quota_cpus {
            assert!(cpus > 0.0, "CPU quota should be positive");
        }
        if let Some(mem) = limits.memory_limit_bytes {
            assert!(mem > 0, "memory limit should be positive");
        }
    }

    // -- CPU v2 parsing -------------------------------------------------------

    // -- CPU v2 parsing (uses extracted parse_cpu_max_contents) -----------------

    #[test]
    fn parse_cpu_v2_max_means_no_limit() {
        assert!(parse_cpu_max_contents("max 100000").is_none());
    }

    #[test]
    fn parse_cpu_v2_quota_and_period() {
        let cpus = parse_cpu_max_contents("200000 100000").unwrap();
        assert!((cpus - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_cpu_v2_fractional() {
        let cpus = parse_cpu_max_contents("50000 100000").unwrap();
        assert!((cpus - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_cpu_v2_trailing_newline() {
        let cpus = parse_cpu_max_contents("100000 100000\n").unwrap();
        assert!((cpus - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_cpu_v2_garbage() {
        assert!(parse_cpu_max_contents("not a number").is_none());
        assert!(parse_cpu_max_contents("").is_none());
    }

    // -- Memory v2 parsing (uses extracted parse_memory_max_contents) ----------

    #[test]
    fn parse_memory_v2_max_means_no_limit() {
        assert!(parse_memory_max_contents("max").is_none());
        assert!(parse_memory_max_contents("max\n").is_none());
    }

    #[test]
    fn parse_memory_v2_value() {
        let limit = parse_memory_max_contents("536870912\n").unwrap();
        assert_eq!(limit, 512 * 1024 * 1024);
    }

    #[test]
    fn parse_memory_v2_garbage() {
        assert!(parse_memory_max_contents("nope").is_none());
    }

    // -- CPU v1 parsing -------------------------------------------------------

    #[test]
    fn parse_cpu_v1_no_limit() {
        assert!(parse_cpu_v1_pair("-1", "100000").is_none());
    }

    #[test]
    fn parse_cpu_v1_two_cpus() {
        let cpus = parse_cpu_v1_pair("200000", "100000").unwrap();
        assert!((cpus - 2.0).abs() < f64::EPSILON);
    }

    // -- Memory v1 parsing ----------------------------------------------------

    #[test]
    fn parse_memory_v1_sentinel_means_no_limit() {
        assert!(parse_memory_v1_value(1u64 << 63).is_none());
    }

    #[test]
    fn parse_memory_v1_real_limit() {
        let limit = parse_memory_v1_value(1024 * 1024 * 1024).unwrap();
        assert_eq!(limit, 1024 * 1024 * 1024);
    }

    // -- tightest_limit -------------------------------------------------------

    /// A cgroup tree under a temporary root: each `(path, file, contents)`
    /// written in place.
    fn cgroups(files: &[(&str, &str, &str)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for (dir, file, contents) in files {
            let dir = root.path().join(dir);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(file), contents).unwrap();
        }
        root
    }

    #[test]
    fn an_ancestors_memory_limit_binds() {
        let root = cgroups(&[
            ("", "memory.max", "max\n"),
            ("system.slice", "memory.max", "1073741824\n"),
            ("system.slice/cache.service", "memory.max", "max\n"),
        ]);
        let dir = root.path().join("system.slice/cache.service");
        let (limit, set_by) =
            tightest_limit(&dir, root.path(), "memory.max", parse_memory_max_contents).unwrap();
        assert_eq!(limit, 1 << 30);
        assert_eq!(set_by, root.path().join("system.slice"));
    }

    #[test]
    fn the_tightest_limit_binds_wherever_it_is_set() {
        let root = cgroups(&[
            ("a", "memory.max", "1073741824"),
            ("a/b", "memory.max", "536870912"),
            ("a/b/c", "memory.max", "2147483648"),
            ("a", "cpu.max", "200000 100000"),
            ("a/b/c", "cpu.max", "max 100000"),
        ]);
        let dir = root.path().join("a/b/c");
        let memory = tightest_limit(&dir, root.path(), "memory.max", parse_memory_max_contents);
        assert_eq!(memory, Some((512 << 20, root.path().join("a/b"))));
        let cpu = tightest_limit(&dir, root.path(), "cpu.max", parse_cpu_max_contents);
        assert_eq!(cpu, Some((2.0, root.path().join("a"))));
    }

    #[test]
    fn no_limit_anywhere_is_none() {
        let root = cgroups(&[("a/b", "memory.max", "max")]);
        let dir = root.path().join("a/b");
        assert_eq!(
            tightest_limit(&dir, root.path(), "memory.max", parse_memory_max_contents),
            None
        );
    }

    #[test]
    fn nothing_above_the_root_is_read() {
        let outside = cgroups(&[("", "memory.max", "1024"), ("root/a", "memory.max", "max")]);
        let root = outside.path().join("root");
        assert_eq!(
            tightest_limit(
                &root.join("a"),
                &root,
                "memory.max",
                parse_memory_max_contents
            ),
            None
        );
    }

    // -- parse_cgroup_v2_path -------------------------------------------------

    #[test]
    fn cgroup_v2_path_typical_session() {
        let path = parse_cgroup_v2_path("0::/user.slice/user-1000.slice/session-2.scope\n");
        assert_eq!(
            path.unwrap().to_str().unwrap(),
            "/sys/fs/cgroup/user.slice/user-1000.slice/session-2.scope"
        );
    }

    #[test]
    fn cgroup_v2_path_docker_container() {
        let path = parse_cgroup_v2_path("0::/docker/abc123def456\n");
        assert_eq!(
            path.unwrap().to_str().unwrap(),
            "/sys/fs/cgroup/docker/abc123def456"
        );
    }

    #[test]
    fn cgroup_v2_path_root_cgroup() {
        let path = parse_cgroup_v2_path("0::/\n").unwrap();
        // After trim_start_matches('/'), the remainder is "", so
        // Path::join("") produces a trailing slash. Both forms refer
        // to the same directory.
        assert!(
            path.starts_with("/sys/fs/cgroup"),
            "should be under /sys/fs/cgroup, got {:?}",
            path
        );
    }

    #[test]
    fn cgroup_v2_path_empty_contents() {
        assert!(parse_cgroup_v2_path("").is_none());
    }

    #[test]
    fn cgroup_v2_path_v1_only_system() {
        // A cgroup v1-only system has no "0::" line.
        let contents = "12:cpuset:/\n11:cpu,cpuacct:/docker/abc\n";
        assert!(parse_cgroup_v2_path(contents).is_none());
    }

    #[test]
    fn cgroup_v2_path_hybrid_system() {
        // Hybrid systems have both v1 controllers and a v2 line.
        let contents = "11:cpu,cpuacct:/docker/abc\n0::/system.slice/foo.service\n";
        assert_eq!(
            parse_cgroup_v2_path(contents).unwrap().to_str().unwrap(),
            "/sys/fs/cgroup/system.slice/foo.service"
        );
    }

    #[test]
    fn self_cgroup_dir_resolves_on_this_host() {
        if std::fs::read_to_string("/proc/self/cgroup").is_ok() {
            let dir = self_cgroup_v2_dir();
            assert!(dir.is_some(), "should resolve cgroup v2 dir");
            assert!(dir.unwrap().exists(), "resolved dir should exist");
        }
    }

    // -- Additional edge cases ------------------------------------------------

    #[test]
    fn parse_cpu_v2_zero_period() {
        assert!(parse_cpu_max_contents("100000 0").is_none());
    }

    #[test]
    fn parse_cpu_v2_negative_period() {
        assert!(parse_cpu_max_contents("100000 -1").is_none());
    }

    #[test]
    fn parse_cpu_v2_single_value() {
        assert!(parse_cpu_max_contents("100000").is_none());
    }

    #[test]
    fn parse_memory_v2_zero() {
        assert_eq!(parse_memory_max_contents("0\n"), Some(0));
    }

    // -- Test helpers for v1 parsing (operate on values, not files) -----------

    fn parse_cpu_v1_pair(quota_str: &str, period_str: &str) -> Option<f64> {
        let quota: i64 = quota_str.trim().parse().ok()?;
        if quota < 0 {
            return None;
        }
        let period: i64 = period_str.trim().parse().ok()?;
        if period <= 0 {
            return None;
        }
        Some(quota as f64 / period as f64)
    }

    fn parse_memory_v1_value(limit: u64) -> Option<u64> {
        if limit > (1u64 << 62) {
            return None;
        }
        Some(limit)
    }
}
