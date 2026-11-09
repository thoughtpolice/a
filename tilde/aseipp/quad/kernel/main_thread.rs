// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The process's main thread, on macOS: AppKit's, which every window must
//! run on. There kernel.c gives the main thread to
//! [`quad_main_thread_run`], which starts Scheme on a thread of its own and
//! then runs what is sent to the main thread ([`run`]): the windows' event
//! loop, once the first window opens (gui/windows.rs). When Scheme is done,
//! the process exits from the main thread too: through the windows' event
//! loop, where that has it.
//!
//! Elsewhere the main thread is Scheme's, and windows have a thread of
//! their own.

use std::ffi::c_int;
use std::sync::{Mutex, mpsc};

type Job = Box<dyn FnOnce() + Send>;

/// Where what the main thread is to run goes, once it runs it.
static JOBS: Mutex<Option<mpsc::Sender<Job>>> = Mutex::new(None);

/// Runs `job` on the main thread, as soon as it is done with what it runs
/// now: an error where the main thread runs nothing sent to it (a process
/// that kernel.c did not start, such as the Rust half's tests).
pub fn run(job: impl FnOnce() + Send + 'static) -> Result<(), String> {
    JOBS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .ok_or("windows need the main thread, which this process keeps for itself")?
        .send(Box::new(job))
        .map_err(|_| "the main thread stopped".to_string())
}

/// kernel.c's `main`, on macOS: runs `scheme` (kernel.c's Scheme, which
/// returns its exit status) on a thread with a stack of `stack` bytes, then
/// what is sent to the main thread, until the process exits with Scheme's
/// status.
#[unsafe(no_mangle)]
pub extern "C" fn quad_main_thread_run(scheme: extern "C" fn() -> c_int, stack: usize) -> ! {
    let (sender, jobs) = mpsc::channel::<Job>();
    *JOBS.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
    let started = std::thread::Builder::new()
        .name("quad-scheme".into())
        .stack_size(stack)
        .spawn(move || exit(scheme()));
    if let Err(error) = started {
        eprintln!("quad: fatal: cannot start Scheme's thread: {error}");
        std::process::exit(70);
    }
    for job in jobs {
        job();
    }
    unreachable!("JOBS keeps a sender to the main thread")
}

/// Ends the process with `status`, from the main thread: through the
/// windows' event loop if it runs there, else as the next job.
fn exit(status: c_int) {
    if !crate::gui::exit_from_windows(status) {
        // The main thread serves jobs, so this cannot fail.
        let _ = run(move || std::process::exit(status));
    }
}
