// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The Rust half of quad's kernel: components written in Rust, for Scheme.
//!
//! Each `#[chez::procedure]` is a Scheme procedure in the library
//! `(quad native)`, which the build generates from [`native`] (BUILD's
//! chez.rust_library); arguments and results convert by their Rust types, and
//! errors and panics become Scheme errors. The kernel registers them at boot
//! by calling [`quad_native_register`].
//!
//! Components that run threads of their own -- the network, later -- hand
//! Scheme an object holding a [`Mailbox`], whose file descriptor the editor's
//! event loop polls; the ticker below is the smallest such component.
//! Subprocesses ([`Process`]) need no thread: Scheme polls and reads their
//! output's descriptor, and writes to their input's, directly.
//!
//! Allocation: there is no `#[global_allocator]`. The executable links
//! mimalloc's malloc override, so Rust's system allocator already allocates
//! from mimalloc, as Chez Scheme and the C kernel do.

use std::fs::File;
use std::os::fd::AsRawFd;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use chez::{ByteVec, Bytes, Mailbox, Object, Ref, RefMut};

/// The BLAKE3 hash of a bytevector: a 32-byte bytevector.
#[chez::procedure]
fn blake3(data: Bytes) -> ByteVec {
    ByteVec(blake3::hash(&data).as_bytes().to_vec())
}

/// What the Rust half is: "quad-kernel VERSION (rust)".
#[chez::procedure(name = "kernel-rust-version")]
fn version() -> &'static str {
    concat!("quad-kernel ", env!("DEPOT_PACKAGE_VERSION"), " (rust)")
}

/// Ticks from a thread of its own: every interval, the tick's number.
pub struct Ticker {
    ticks: Mailbox<u64>,
}

/// A ticker that ticks `count` times, `interval-ms` apart, then stops. The
/// ticks arrive in Scheme through ticker-take!, once ticker-fd is readable.
#[chez::procedure]
fn make_ticker(interval_ms: u64, count: u64) -> Result<Object<Ticker>, String> {
    let (tx, ticks) = Mailbox::new().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        for i in 1..=count {
            std::thread::sleep(Duration::from_millis(interval_ms));
            if tx.send(i).is_err() {
                // Dropped: nobody is listening.
                return;
            }
        }
    });
    Ok(Object(Ticker { ticks }))
}

/// The descriptor that is readable while ticks wait.
#[chez::procedure]
fn ticker_fd(t: Ref<Ticker>) -> i32 {
    t.ticks.fd()
}

/// The ticks waiting, oldest first.
#[chez::procedure(name = "ticker-take!")]
fn ticker_take(t: Ref<Ticker>) -> Vec<u64> {
    t.ticks.take()
}

/// A subprocess, with pipes to its standard input and from its standard
/// output: what the editor talks to programs through (an agent's server, a
/// language server). Its standard error goes to a file, or nowhere, so that
/// nothing waits on a pipe nobody reads.
pub struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl Process {
    /// Close its input, which asks a well-behaved server to exit; give it a
    /// moment to, then kill it. Either way it is reaped.
    fn stop(&mut self, grace: Duration) {
        self.stdin = None;
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            self.stop(Duration::from_millis(500));
        }
    }
}

/// Run `argv` (the program, then its arguments, searched for in PATH) in
/// directory `cwd` (#f: the editor's), its standard error appended to the
/// file `stderr` (#f: discarded).
#[chez::procedure(name = "spawn-process")]
fn spawn_process(
    argv: Vec<String>,
    cwd: Option<String>,
    stderr: Option<String>,
) -> Result<Object<Process>, String> {
    let (program, args) = argv
        .split_first()
        .ok_or("spawn-process: an empty command")?;
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stderr(match stderr {
        Some(path) => File::options()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("{path}: {e}"))?
            .into(),
        None => Stdio::null(),
    });
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout is piped");
    Ok(Object(Process {
        child,
        stdin,
        stdout,
    }))
}

#[chez::procedure]
fn process_pid(p: Ref<Process>) -> u32 {
    p.child.id()
}

/// The descriptor to write the process's input to, or -1 once closed.
#[chez::procedure]
fn process_input_fd(p: Ref<Process>) -> i32 {
    p.stdin.as_ref().map_or(-1, |i| i.as_raw_fd())
}

/// The descriptor to read the process's output from, which polls readable
/// at its end, too.
#[chez::procedure]
fn process_output_fd(p: Ref<Process>) -> i32 {
    p.stdout.as_raw_fd()
}

/// Close the process's input: it reads end of file.
#[chez::procedure(name = "process-close-input!")]
fn process_close_input(mut p: RefMut<Process>) {
    p.stdin = None;
}

/// The exit status if the process has exited (a signal's number, negated,
/// if one killed it), else #f.
#[chez::procedure]
fn process_status(mut p: RefMut<Process>) -> Result<Option<i32>, String> {
    use std::os::unix::process::ExitStatusExt;
    let status = p.child.try_wait().map_err(|e| e.to_string())?;
    Ok(status.map(|s| s.code().unwrap_or_else(|| -s.signal().unwrap_or(0))))
}

/// Stop the process: close its input, wait up to `grace-ms` for it to exit,
/// then kill it.
#[chez::procedure(name = "process-stop!")]
fn process_stop(mut p: RefMut<Process>, grace_ms: u64) {
    p.stop(Duration::from_millis(grace_ms));
}

chez::library! {
    /// `(quad native)`.
    pub fn native() -> "quad native" {
        blake3, version, make_ticker, ticker_fd, ticker_take,
        spawn_process, process_pid, process_input_fd, process_output_fd,
        process_close_input, process_status, process_stop,
    }
}

/// Register `(quad native)`'s procedures with Chez Scheme: the kernel calls
/// this once the heap is built.
#[unsafe(no_mangle)]
pub extern "C" fn quad_native_register() {
    chez::quiet_panics();
    native().register();
}
