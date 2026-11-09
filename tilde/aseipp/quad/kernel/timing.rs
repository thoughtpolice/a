// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! How long starting up takes: with `QUAD_TIMING=1` in the environment,
//! each step marked here (and from Scheme, with `timing-mark`) is written
//! to standard error with the time since the process started, so that a
//! slow start can be pinned on a step.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// When timing began, and how long the process had run by then.
fn origin() -> Option<&'static (Instant, Duration)> {
    static ORIGIN: OnceLock<Option<(Instant, Duration)>> = OnceLock::new();
    ORIGIN
        .get_or_init(|| {
            std::env::var_os("QUAD_TIMING")
                .is_some_and(|v| v == "1")
                .then(|| (Instant::now(), process_age().unwrap_or_default()))
        })
        .as_ref()
}

/// How long ago the process started, from /proc: to clock ticks (10 ms).
#[cfg(target_os = "linux")]
fn process_age() -> Option<Duration> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // The fields after the command's closing parenthesis; the start time
    // is the 22nd field, the 20th of these.
    let after = &stat[stat.rfind(')')? + 2..];
    let started: f64 = after.split(' ').nth(19)?.parse().ok()?;
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split(' ')
        .next()?
        .parse()
        .ok()?;
    // Clock ticks are USER_HZ, 100 a second on every Linux.
    Some(Duration::from_secs_f64((uptime - started / 100.0).max(0.0)))
}

/// How long ago the process started, from the kernel's record of it: to
/// the microsecond.
#[cfg(target_os = "macos")]
fn process_age() -> Option<Duration> {
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: plain C data, for which all zeroes is a value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    // SAFETY: room for the one record asked for, this process's.
    let got = unsafe {
        libc::proc_pidinfo(
            std::process::id() as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if got != size {
        return None;
    }
    let started = std::time::UNIX_EPOCH
        + Duration::from_secs(info.pbi_start_tvsec)
        + Duration::from_micros(info.pbi_start_tvusec);
    std::time::SystemTime::now().duration_since(started).ok()
}

/// Notes that `step` is done, when timing.
pub fn mark(step: &str) {
    if let Some((at, age)) = origin() {
        let ms = (at.elapsed() + *age).as_secs_f64() * 1000.0;
        eprintln!("quad: {ms:8.1} ms  {step}");
    }
}
