// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use crate::cli::TargetOptions;
use crate::protocol::{
    CAP_INLINE_8BIT_COUNTERS, DONE_COMPARISONS_TRUNCATED, DONE_FEATURES_TRUNCATED,
    DONE_HARNESS_NONZERO, DONE_OK, DoneFrame, HelloFrame, RunFrame, StopFrame,
};
use crate::shm::{CmpObservation, SharedMemory};
use anyhow::{Context, Error, Result, bail, ensure};
use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{ErrorKind, Read};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(100);
const STDERR_CAPACITY: usize = 1024 * 1024;
const PR_SET_PDEATHSIG: i32 = 1;
const SIGKILL: i32 = 9;
const F_GETFL: i32 = 3;
const F_SETFL: i32 = 4;
const O_NONBLOCK: i32 = 0o4000;

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
    fn prctl(option: i32, ...) -> i32;
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}

#[derive(Clone, Debug)]
pub struct ExecutorConfig {
    pub target: PathBuf,
    pub target_args: Vec<std::ffi::OsString>,
    pub max_input: usize,
    pub timeout: Duration,
    pub feature_capacity: usize,
    pub cmp_capacity: usize,
}

impl ExecutorConfig {
    pub fn from_options(options: &TargetOptions) -> Result<Self> {
        ensure!(options.max_input > 0, "--max-input must be nonzero");
        ensure!(options.timeout_ms > 0, "--timeout-ms must be nonzero");
        ensure!(
            options.feature_capacity > 0,
            "--feature-capacity must be nonzero"
        );
        let target = fs::canonicalize(&options.target)
            .with_context(|| format!("resolving target {}", options.target.display()))?;
        Ok(Self {
            target,
            target_args: options.target_args.clone(),
            max_input: options.max_input,
            timeout: Duration::from_millis(options.timeout_ms),
            feature_capacity: options.feature_capacity,
            cmp_capacity: options.cmp_capacity,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub features: Vec<u64>,
    pub comparisons: Vec<CmpObservation>,
    pub features_truncated: bool,
    pub comparisons_truncated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    Crash,
    Hang,
    NonzeroHarness,
    Exit,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FindingFingerprint {
    pub kind: FindingKind,
    pub code: Option<i32>,
    pub sanitizer: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Finding {
    pub kind: FindingKind,
    pub fingerprint: FindingFingerprint,
    pub detail: String,
    pub stderr: Vec<u8>,
}

impl Finding {
    fn new(kind: FindingKind, code: Option<i32>, detail: String, stderr: Vec<u8>) -> Self {
        let fingerprint = FindingFingerprint {
            kind,
            code,
            sanitizer: sanitizer_signature(&stderr),
        };
        Self {
            kind,
            fingerprint,
            detail,
            stderr,
        }
    }
}

#[derive(Debug)]
pub enum Execution {
    Ok(Observation),
    Finding(Finding),
}

pub struct PersistentExecutor {
    config: ExecutorConfig,
    worker_root: PathBuf,
    session: Option<Session>,
    next_run_id: u64,
}

impl PersistentExecutor {
    pub fn new(config: ExecutorConfig, worker_root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&worker_root)
            .with_context(|| format!("creating worker directory {}", worker_root.display()))?;
        Ok(Self {
            config,
            worker_root,
            session: None,
            next_run_id: 1,
        })
    }

    pub fn target(&self) -> &Path {
        &self.config.target
    }

    pub fn restart(&mut self) {
        self.session.take();
    }

    pub fn run(&mut self, input: &[u8]) -> Result<Execution> {
        ensure!(
            input.len() <= self.config.max_input,
            "input has {} bytes, above executor limit {}",
            input.len(),
            self.config.max_input
        );
        if self.session.is_none() {
            self.session = Some(Session::spawn(&self.config, &self.worker_root)?);
        }

        let run_id = self.next_run_id;
        self.next_run_id = self.next_run_id.wrapping_add(1).max(1);
        let session = self.session.as_mut().expect("session initialized above");
        session
            .stderr
            .clear()
            .context("resetting target stderr between runs")?;
        session
            .shm
            .write_input(input)
            .context("publishing target input")?;

        if let Err(error) = (RunFrame {
            run_id,
            input_size: input.len() as u64,
        })
        .write_to(&mut session.socket)
        {
            let timed_out = matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock);
            return self.failed_run(timed_out, Error::new(error));
        }
        let done = match DoneFrame::read_from(&mut session.socket) {
            Ok(done) => done,
            Err(error) => {
                let timed_out = matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock);
                return self.failed_run(timed_out, error.into());
            }
        };
        ensure!(
            done.run_id == run_id,
            "target replied to run {} with run {}",
            run_id,
            done.run_id
        );
        ensure!(
            done.status == DONE_OK || done.status == DONE_HARNESS_NONZERO,
            "target returned unknown Done status {}",
            done.status
        );
        ensure!(
            done.done_flags & !(DONE_FEATURES_TRUNCATED | DONE_COMPARISONS_TRUNCATED) == 0,
            "target returned unknown Done flags {:#x}",
            done.done_flags
        );
        ensure!(
            (done.status == DONE_OK && done.harness_return == 0)
                || (done.status == DONE_HARNESS_NONZERO && done.harness_return != 0),
            "target returned inconsistent status {} and harness result {}",
            done.status,
            done.harness_return
        );
        ensure!(
            done.feature_count <= session.shm.feature_capacity(),
            "target overflowed feature region"
        );
        ensure!(
            done.cmp_count <= session.shm.cmp_capacity(),
            "target overflowed comparison region"
        );

        if done.status == DONE_HARNESS_NONZERO {
            // The target has sent Done, but the stderr reader may still have
            // bytes in flight. End the failed session and drain its pipe before
            // taking the diagnostic snapshot used by artifacts and replay.
            let mut session = self.session.take().expect("completed run has a session");
            let stderr = session.terminate();
            return Ok(Execution::Finding(Finding::new(
                FindingKind::NonzeroHarness,
                Some(done.harness_return),
                format!("LLVMFuzzerTestOneInput returned {}", done.harness_return),
                stderr,
            )));
        }

        let features = session.shm.read_features(done.feature_count)?;
        let comparisons = session.shm.read_cmp(done.cmp_count)?;
        Ok(Execution::Ok(Observation {
            features,
            comparisons,
            features_truncated: done.done_flags & DONE_FEATURES_TRUNCATED != 0,
            comparisons_truncated: done.done_flags & DONE_COMPARISONS_TRUNCATED != 0,
        }))
    }

    fn failed_run(&mut self, timed_out: bool, error: Error) -> Result<Execution> {
        let mut session = self.session.take().expect("failed run has a session");
        if timed_out {
            let stderr = session.terminate();
            return Ok(Execution::Finding(Finding::new(
                FindingKind::Hang,
                None,
                format!("target exceeded {} ms", self.config.timeout.as_millis()),
                stderr,
            )));
        }

        let outcome = session.wait_after_disconnect();
        let stderr = session.read_stderr();
        match outcome {
            Ok(DisconnectOutcome::Exited(status)) if status.signal().is_some() => {
                let signal = status.signal().unwrap();
                Ok(Execution::Finding(Finding::new(
                    FindingKind::Crash,
                    Some(signal),
                    format!("target terminated by signal {signal}"),
                    stderr,
                )))
            }
            Ok(DisconnectOutcome::Exited(status)) => Ok(Execution::Finding(Finding::new(
                FindingKind::Exit,
                status.code(),
                format!("target exited with {status}"),
                stderr,
            ))),
            Ok(DisconnectOutcome::Forced(status)) => bail!(
                "target disconnected but remained alive for {} ms; Fozzie killed it ({status}): {error:#}",
                SHUTDOWN_GRACE.as_millis()
            ),
            Err(wait_error) => Err(wait_error).context(format!("target disconnected: {error:#}")),
        }
    }
}

fn sanitizer_signature(stderr: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stderr);
    for (name, marker) in [
        ("address", "SUMMARY: AddressSanitizer: "),
        ("memory", "SUMMARY: MemorySanitizer: "),
        ("thread", "SUMMARY: ThreadSanitizer: "),
        (
            "undefined-behavior",
            "SUMMARY: UndefinedBehaviorSanitizer: ",
        ),
    ] {
        if let Some(summary) = text.lines().find_map(|line| line.strip_prefix(marker)) {
            return Some(format!("{name}:{}", summary.trim()));
        }
    }
    for (name, marker) in [
        ("address", "ERROR: AddressSanitizer: "),
        ("memory", "WARNING: MemorySanitizer: "),
        ("thread", "WARNING: ThreadSanitizer: "),
    ] {
        if let Some(rest) = text.split_once(marker).map(|(_, rest)| rest) {
            let class = rest.split_whitespace().next().unwrap_or("unknown");
            return Some(format!("{name}:{class}"));
        }
    }
    text.contains("runtime error:")
        .then(|| "undefined-behavior:runtime-error".to_owned())
}

fn runtime_options(existing: Option<&OsStr>, required: &str) -> OsString {
    let mut options = existing.unwrap_or_default().to_os_string();
    if !options.is_empty() {
        options.push(":");
    }
    options.push(required);
    options
}

struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn get_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("armed child guard")
    }

    fn disarm(mut self) -> Child {
        self.child.take().expect("armed child guard")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            kill_process_group(child);
        }
    }
}

#[derive(Default)]
struct StderrBuffer {
    bytes: VecDeque<u8>,
    truncated: bool,
}

impl StderrBuffer {
    fn append(&mut self, bytes: &[u8]) {
        if bytes.len() >= STDERR_CAPACITY {
            self.bytes.clear();
            self.bytes
                .extend(bytes[bytes.len() - STDERR_CAPACITY..].iter().copied());
            self.truncated = true;
            return;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(STDERR_CAPACITY);
        if overflow != 0 {
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
        self.bytes.extend(bytes.iter().copied());
    }

    fn clear(&mut self) {
        self.bytes.clear();
        self.truncated = false;
    }

    fn snapshot(&self) -> Vec<u8> {
        let mut result = Vec::with_capacity(self.bytes.len() + 64);
        if self.truncated {
            result.extend_from_slice(b"[fozzie: target stderr truncated to newest 1 MiB]\n");
        }
        result.extend(self.bytes.iter().copied());
        result
    }
}

struct StderrCapture {
    state: Arc<Mutex<StderrState>>,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

struct StderrState {
    pipe: ChildStderr,
    buffer: StderrBuffer,
}

impl Drop for StderrCapture {
    fn drop(&mut self) {
        self.finish();
    }
}

impl StderrCapture {
    fn spawn(stderr: ChildStderr) -> Result<Self> {
        let descriptor = stderr.as_raw_fd();
        // SAFETY: fcntl only changes the status flags for this owned pipe.
        let flags = unsafe { fcntl(descriptor, F_GETFL) };
        if flags < 0 || unsafe { fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error())
                .context("making target stderr nonblocking");
        }
        let state = Arc::new(Mutex::new(StderrState {
            pipe: stderr,
            buffer: StderrBuffer::default(),
        }));
        let reader_state = Arc::clone(&state);
        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        let reader = thread::spawn(move || {
            let mut chunk = [0_u8; 8192];
            let mut drained_after_stop = 0_usize;
            loop {
                // Reading and appending share the reset lock, so a chunk
                // cannot be read before reset and appended after it.
                let result = {
                    let mut state = reader_state.lock().unwrap();
                    let result = state.pipe.read(&mut chunk);
                    if let Ok(amount) = result {
                        state.buffer.append(&chunk[..amount]);
                    }
                    result
                };
                match result {
                    Ok(0) => break,
                    Ok(amount) => {
                        if reader_stop.load(Ordering::Acquire) {
                            drained_after_stop = drained_after_stop.saturating_add(amount);
                            if drained_after_stop >= STDERR_CAPACITY {
                                break;
                            }
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        if reader_stop.load(Ordering::Acquire) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            state,
            stop,
            reader: Some(reader),
        })
    }

    fn clear(&self) -> std::io::Result<()> {
        let mut state = self.state.lock().unwrap();
        let mut chunk = [0_u8; 8192];
        let mut drained = 0;
        // Done precedes this call, and the next Run has not been sent. Drain
        // all writes from the completed harness call before resetting its
        // buffer. Bound the work if the harness keeps writing after return.
        loop {
            match state.pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(amount) => {
                    drained += amount;
                    if drained >= STDERR_CAPACITY {
                        return Err(std::io::Error::other(
                            "target stderr did not quiesce between runs",
                        ));
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
        state.buffer.clear();
        Ok(())
    }

    fn snapshot(&self) -> Vec<u8> {
        self.state.lock().unwrap().buffer.snapshot()
    }

    fn finish(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

struct Session {
    _directory: TempDir,
    _socket_directory: TempDir,
    shm: SharedMemory,
    socket: UnixStream,
    child: Option<Child>,
    stderr: StderrCapture,
}

impl Session {
    fn spawn(config: &ExecutorConfig, worker_root: &Path) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("target-")
            .tempdir_in(worker_root)
            .context("creating target session directory")?;
        let shm_path = directory.path().join("shared-memory");
        // Linux limits Unix socket pathnames independently of filesystem
        // paths. Keep this private directory short even when the campaign
        // directory or TMPDIR is deeply nested.
        let socket_directory = tempfile::Builder::new()
            .prefix("fozzie-socket-")
            .tempdir_in("/tmp")
            .context("creating target control socket directory")?;
        let socket_path = socket_directory.path().join("control.sock");
        let feature_capacity = u32::try_from(config.feature_capacity)
            .context("feature capacity exceeds protocol limit")?;
        let cmp_capacity = u32::try_from(config.cmp_capacity)
            .context("comparison capacity exceeds protocol limit")?;
        let shm = SharedMemory::create(&shm_path, config.max_input, feature_capacity, cmp_capacity)
            .context("creating target shared memory")?;

        let listener = UnixListener::bind(&socket_path)
            .with_context(|| format!("binding {}", socket_path.display()))?;
        listener.set_nonblocking(true)?;

        let mut command = Command::new(&config.target);
        let asan_options = std::env::var_os("ASAN_OPTIONS");
        let ubsan_options = std::env::var_os("UBSAN_OPTIONS");
        command
            .args(&config.target_args)
            .env("FOZZIE_SHM_PATH", &shm_path)
            .env("FOZZIE_SOCKET_PATH", &socket_path)
            .env("RUST_BACKTRACE", "1")
            .env(
                "ASAN_OPTIONS",
                runtime_options(
                    asan_options.as_deref(),
                    "abort_on_error=1:disable_coredump=0:symbolize=1:allow_addr2line=1:detect_leaks=0",
                ),
            )
            .env(
                "UBSAN_OPTIONS",
                runtime_options(
                    ubsan_options.as_deref(),
                    "abort_on_error=1:print_stacktrace=1",
                ),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .process_group(0);
        // SAFETY: prctl is async-signal-safe on Linux and this closure neither
        // allocates nor touches shared synchronization state after fork.
        unsafe {
            command.pre_exec(|| {
                if prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command
            .spawn()
            .with_context(|| format!("starting target {}", config.target.display()))?;
        let mut child = ChildGuard::new(child);
        let child_stderr = child
            .get_mut()
            .stderr
            .take()
            .context("target stderr pipe was not created")?;
        let mut stderr = StderrCapture::spawn(child_stderr)?;

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    if let Some(status) = child
                        .get_mut()
                        .try_wait()
                        .context("checking target startup")?
                    {
                        stderr.finish();
                        let output = stderr.snapshot();
                        bail!(
                            "target exited during startup with {status}: {}",
                            String::from_utf8_lossy(&output)
                        );
                    }
                    if Instant::now() >= deadline {
                        kill_process_group(child.get_mut());
                        stderr.finish();
                        bail!(
                            "target did not connect within {} seconds",
                            STARTUP_TIMEOUT.as_secs()
                        );
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => return Err(error).context("accepting target control connection"),
            }
        };
        let mut session = Self {
            _directory: directory,
            _socket_directory: socket_directory,
            shm,
            socket,
            child: Some(child.disarm()),
            stderr,
        };
        session.socket.set_read_timeout(Some(STARTUP_TIMEOUT))?;
        let hello = HelloFrame::read_from(&mut session.socket)?;
        ensure!(
            hello.capabilities & CAP_INLINE_8BIT_COUNTERS != 0,
            "target runtime has no counter support"
        );
        ensure!(
            hello.counter_count > 0,
            "target has no SanitizerCoverage counters; check the Buck fuzz transition"
        );
        session.socket.set_read_timeout(Some(config.timeout))?;
        session.socket.set_write_timeout(Some(config.timeout))?;

        Ok(session)
    }

    fn read_stderr(&self) -> Vec<u8> {
        self.stderr.snapshot()
    }

    fn terminate(&mut self) -> Vec<u8> {
        if let Some(child) = &mut self.child {
            kill_process_group(child);
        }
        self.child.take();
        self.stderr.finish();
        self.read_stderr()
    }

    fn wait_after_disconnect(&mut self) -> std::io::Result<DisconnectOutcome> {
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        let child = self.child.as_mut().expect("live session has child");
        loop {
            if let Some(status) = child.try_wait()? {
                self.child.take();
                self.stderr.finish();
                return Ok(DisconnectOutcome::Exited(status));
            }
            if Instant::now() >= deadline {
                kill_process_group(child);
                let status = child.wait()?;
                self.child.take();
                self.stderr.finish();
                return Ok(DisconnectOutcome::Forced(status));
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}

enum DisconnectOutcome {
    Exited(ExitStatus),
    Forced(ExitStatus),
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = StopFrame::default().write_to(&mut self.socket);
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    _ => {
                        kill_process_group(child);
                        break;
                    }
                }
            }
            let _ = child.wait();
            self.child.take();
        }
        self.stderr.finish();
    }
}

fn kill_process_group(child: &mut Child) {
    // SAFETY: the child was placed in a fresh process group whose ID is its
    // PID. A negative PID targets that group and cannot include the controller.
    unsafe {
        kill(-(child.id() as i32), SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_buffer_keeps_a_bounded_tail_and_can_reset() {
        let mut buffer = StderrBuffer::default();
        buffer.append(&vec![b'a'; STDERR_CAPACITY - 2]);
        buffer.append(b"bcdef");
        let snapshot = buffer.snapshot();
        assert!(snapshot.starts_with(b"[fozzie: target stderr truncated"));
        assert!(snapshot.ends_with(b"aabcdef"));
        assert!(snapshot.len() <= STDERR_CAPACITY + 64);

        buffer.clear();
        buffer.append(b"current run");
        assert_eq!(buffer.snapshot(), b"current run");
    }

    #[test]
    fn fingerprints_preserve_exit_and_sanitizer_identity() {
        let address = Finding::new(
            FindingKind::Crash,
            Some(6),
            "abort".to_owned(),
            b"noise\nSUMMARY: AddressSanitizer: heap-buffer-overflow parser.cc:7 in parse\n"
                .to_vec(),
        );
        let another_signal = Finding::new(
            FindingKind::Crash,
            Some(11),
            "segmentation fault".to_owned(),
            Vec::new(),
        );
        let another_site = Finding::new(
            FindingKind::Crash,
            Some(6),
            "abort".to_owned(),
            b"SUMMARY: AddressSanitizer: heap-buffer-overflow parser.cc:8 in parse\n".to_vec(),
        );

        assert_eq!(
            address.fingerprint.sanitizer.as_deref(),
            Some("address:heap-buffer-overflow parser.cc:7 in parse")
        );
        assert_ne!(address.fingerprint, another_signal.fingerprint);
        assert_ne!(address.fingerprint, another_site.fingerprint);
    }

    #[test]
    fn appends_required_sanitizer_options_after_user_options() {
        assert_eq!(
            runtime_options(
                Some(OsStr::new("verbosity=1:abort_on_error=0")),
                "abort_on_error=1"
            ),
            OsString::from("verbosity=1:abort_on_error=0:abort_on_error=1")
        );
        assert_eq!(
            runtime_options(None, "symbolize=1:allow_addr2line=1"),
            OsString::from("symbolize=1:allow_addr2line=1")
        );
    }
}
