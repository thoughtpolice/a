// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Runtime environment checks for the cache server.
//!
//! Validates Linux kernel settings required for dial9 CPU profiling and
//! kernel stack traces before the traced runtime starts. Detects cgroup
//! CPU and memory limits so callers can size thread pools and configure
//! the global allocator appropriately.

mod cgroup;
mod mimalloc_config;

/// Profiling capabilities determined by Linux kernel settings.
#[derive(Debug, Clone)]
pub struct PerfCapabilities {
    /// CPU sampling via `perf_event_open` is available.
    ///
    /// Requires `kernel.perf_event_paranoid` <= 2.
    pub cpu_profiling: bool,

    /// Kernel stack traces can be collected with resolved symbols.
    ///
    /// Requires `kernel.perf_event_paranoid` <= 1 and
    /// `kernel.kptr_restrict` == 0.
    pub kernel_stacks: bool,

    paranoid: Option<i32>,
    kptr: Option<i32>,
}

impl PerfCapabilities {
    /// Log warnings for any kernel settings that prevent profiling.
    ///
    /// Call this after the tracing subscriber has been initialized so
    /// the messages are visible in normal log output.
    pub fn emit_warnings(&self) {
        if !self.cpu_profiling {
            if let Some(v) = self.paranoid {
                tracing::warn!(
                    perf_event_paranoid = v,
                    "CPU profiling disabled (need perf_event_paranoid <= 2); \
                     dial9 traces will lack CPU samples. \
                     Fix: sudo sysctl -w kernel.perf_event_paranoid=1"
                );
            }
        }

        if !self.kernel_stacks {
            if let Some(v) = self.paranoid {
                // Only warn about paranoid for kernel stacks when cpu
                // profiling is enabled — otherwise the warning above
                // already covers the root cause.
                if v > 1 && self.cpu_profiling {
                    tracing::warn!(
                        perf_event_paranoid = v,
                        "kernel stacks disabled (need perf_event_paranoid <= 1); \
                         scheduler events recorded without kernel frames. \
                         Fix: sudo sysctl -w kernel.perf_event_paranoid=1"
                    );
                }
            }
            if let Some(v) = self.kptr {
                if v != 0 {
                    tracing::warn!(
                        kptr_restrict = v,
                        "kernel stacks disabled (need kptr_restrict = 0); \
                         kernel addresses will appear as raw hex. \
                         Fix: sudo sysctl -w kernel.kptr_restrict=0"
                    );
                }
            }
        }
    }
}

/// Check Linux kernel perf settings and determine available dial9
/// profiling capabilities.
///
/// Reads `/proc/sys/kernel/perf_event_paranoid` and
/// `/proc/sys/kernel/kptr_restrict` to decide what can be enabled.
///
/// On non-Linux systems or when procfs is unreadable, all capabilities
/// default to unavailable.
///
/// Call [`PerfCapabilities::emit_warnings`] after the tracing subscriber
/// is initialized to log any issues.
pub fn check_perf_capabilities() -> PerfCapabilities {
    let paranoid = read_sysctl("/proc/sys/kernel/perf_event_paranoid");
    let kptr = read_sysctl("/proc/sys/kernel/kptr_restrict");
    let (cpu_profiling, kernel_stacks) = evaluate(paranoid, kptr);
    PerfCapabilities {
        cpu_profiling,
        kernel_stacks,
        paranoid,
        kptr,
    }
}

// --- Cgroup-aware resource detection ----------------------------------------

/// Detected runtime resource limits.
///
/// Use [`init`] to populate this at startup, before building tokio
/// runtimes or allocating large data structures. Call
/// [`emit_diagnostics`](RuntimeInfo::emit_diagnostics) after the
/// tracing subscriber is initialized to log startup info.
#[derive(Debug, Clone)]
pub struct RuntimeInfo {
    /// Effective CPU count (cgroup-aware). Use this for sizing thread
    /// pools (e.g. `tokio::runtime::Builder::worker_threads`).
    pub effective_cpus: usize,

    /// Memory limit in bytes, if a cgroup limit is set.
    pub memory_limit: Option<u64>,

    /// Whether the process is running inside a cgroup with at least one
    /// resource limit set.
    pub in_cgroup: bool,

    // Diagnostic fields for deferred logging.
    cgroup_version: &'static str,
    cgroup_dir: Option<String>,
    raw_cpu: Option<String>,
    raw_memory: Option<String>,
    cpu_quota: Option<f64>,
}

impl RuntimeInfo {
    /// Log cgroup detection results and mimalloc configuration.
    ///
    /// Call this after the tracing subscriber has been initialized so
    /// the messages are visible in normal log output. This always logs,
    /// even when no cgroup limits are detected, to aid debugging
    /// container deployments.
    pub fn emit_diagnostics(&self) {
        tracing::info!(
            cgroup_version = self.cgroup_version,
            cgroup_dir = self.cgroup_dir.as_deref().unwrap_or("n/a"),
            raw_cpu = self.raw_cpu.as_deref().unwrap_or("n/a"),
            raw_memory = self.raw_memory.as_deref().unwrap_or("n/a"),
            "cgroup detection"
        );

        tracing::info!(
            cpu_quota = self.cpu_quota.map(|c| format!("{c:.2}")),
            effective_cpus = self.effective_cpus,
            memory_limit_mib = self.memory_limit.map(|b| b / (1024 * 1024)),
            in_cgroup = self.in_cgroup,
            "runtime resource limits"
        );

        let arena_reserve_kib = mimalloc::option_get(mimalloc::MiOption::ArenaReserve);
        tracing::info!(
            arena_reserve_mib = arena_reserve_kib / 1024,
            "mimalloc configuration"
        );
    }
}

/// Detect cgroup limits and configure the runtime accordingly.
///
/// Call once at startup, before building tokio runtimes.
///
/// - Reads cgroup v2 then v1 CPU/memory limits
/// - Falls back to [`std::thread::available_parallelism`] for CPUs
/// - Configures mimalloc arena reserve when a memory limit is detected
///
/// **Note:** this runs before the tracing subscriber is active. Call
/// [`RuntimeInfo::emit_diagnostics`] later to log the results.
pub fn init() -> RuntimeInfo {
    let limits = cgroup::detect();

    let in_cgroup = limits.cpu_quota_cpus.is_some() || limits.memory_limit_bytes.is_some();

    let effective_cpus = match limits.cpu_quota_cpus {
        Some(cpus) => (cpus.ceil() as usize).max(1),
        None => std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
    };

    mimalloc_config::configure(limits.memory_limit_bytes);

    RuntimeInfo {
        effective_cpus,
        memory_limit: limits.memory_limit_bytes,
        in_cgroup,
        cgroup_version: limits.diag.version,
        cgroup_dir: limits.diag.cgroup_dir,
        raw_cpu: limits.diag.raw_cpu,
        raw_memory: limits.diag.raw_memory,
        cpu_quota: limits.cpu_quota_cpus,
    }
}

// --- Perf capability checks -------------------------------------------------

fn read_sysctl(path: &str) -> Option<i32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

fn evaluate(perf_event_paranoid: Option<i32>, kptr_restrict: Option<i32>) -> (bool, bool) {
    let (Some(paranoid), Some(kptr)) = (perf_event_paranoid, kptr_restrict) else {
        return (false, false);
    };

    let cpu_profiling = paranoid <= 2;

    // Kernel stacks require both paranoid <= 1 (so perf_event_open can
    // capture kernel frames) and kptr_restrict == 0 (so kernel addresses
    // resolve to function names instead of raw hex).
    let kernel_stacks = if !cpu_profiling {
        false
    } else {
        paranoid <= 1 && kptr == 0
    };

    (cpu_profiling, kernel_stacks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permissive_paranoid_one() {
        assert_eq!(evaluate(Some(1), Some(0)), (true, true));
    }

    #[test]
    fn permissive_paranoid_zero() {
        assert_eq!(evaluate(Some(0), Some(0)), (true, true));
    }

    #[test]
    fn negative_paranoid_is_permissive() {
        assert_eq!(evaluate(Some(-1), Some(0)), (true, true));
    }

    #[test]
    fn paranoid_two_blocks_kernel_stacks() {
        assert_eq!(evaluate(Some(2), Some(0)), (true, false));
    }

    #[test]
    fn paranoid_three_blocks_all_profiling() {
        assert_eq!(evaluate(Some(3), Some(0)), (false, false));
    }

    #[test]
    fn kptr_restrict_blocks_kernel_stacks() {
        assert_eq!(evaluate(Some(1), Some(1)), (true, false));
    }

    #[test]
    fn kptr_restrict_higher_values() {
        assert_eq!(evaluate(Some(0), Some(2)), (true, false));
    }

    #[test]
    fn both_restrictive() {
        assert_eq!(evaluate(Some(4), Some(2)), (false, false));
    }

    #[test]
    fn missing_both_values() {
        assert_eq!(evaluate(None, None), (false, false));
    }

    #[test]
    fn missing_kptr_only() {
        assert_eq!(evaluate(Some(1), None), (false, false));
    }

    #[test]
    fn missing_paranoid_only() {
        assert_eq!(evaluate(None, Some(0)), (false, false));
    }
}
