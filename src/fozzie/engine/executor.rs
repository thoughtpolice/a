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
use std::fs::{self, File};
use std::io::ErrorKind;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(100);
const PR_SET_PDEATHSIG: i32 = 1;
const SIGKILL: i32 = 9;

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
    fn prctl(option: i32, ...) -> i32;
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    Crash,
    Hang,
    NonzeroHarness,
    Exit,
}

#[derive(Clone, Debug)]
pub struct Finding {
    pub kind: FindingKind,
    pub detail: String,
    pub stderr: Vec<u8>,
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
            .shm
            .write_input(input)
            .context("publishing target input")?;

        if let Err(error) = (RunFrame {
            run_id,
            input_size: input.len() as u64,
        })
        .write_to(&mut session.socket)
        {
            return self.failed_run(false, Error::new(error));
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
            done.feature_count <= session.shm.feature_capacity(),
            "target overflowed feature region"
        );
        ensure!(
            done.cmp_count <= session.shm.cmp_capacity(),
            "target overflowed comparison region"
        );

        if done.status == DONE_HARNESS_NONZERO {
            return Ok(Execution::Finding(Finding {
                kind: FindingKind::NonzeroHarness,
                detail: format!("LLVMFuzzerTestOneInput returned {}", done.harness_return),
                stderr: session.read_stderr(),
            }));
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
            return Ok(Execution::Finding(Finding {
                kind: FindingKind::Hang,
                detail: format!("target exceeded {} ms", self.config.timeout.as_millis()),
                stderr,
            }));
        }

        let status = session.wait_after_disconnect();
        let stderr = session.read_stderr();
        match status {
            Ok(status) if status.signal().is_some() => Ok(Execution::Finding(Finding {
                kind: FindingKind::Crash,
                detail: format!("target terminated by signal {}", status.signal().unwrap()),
                stderr,
            })),
            Ok(status) if matches!(status.code(), Some(70..=74)) => {
                bail!("target runtime failed with {status}: {error:#}")
            }
            Ok(status) if !status.success() => Ok(Execution::Finding(Finding {
                kind: FindingKind::Exit,
                detail: format!("target exited with {status}"),
                stderr,
            })),
            Ok(status) => bail!("target disconnected with {status}: {error:#}"),
            Err(wait_error) => Err(wait_error).context(format!("target disconnected: {error:#}")),
        }
    }
}

struct Session {
    _directory: TempDir,
    _socket_directory: TempDir,
    shm: SharedMemory,
    socket: UnixStream,
    child: Option<Child>,
    stderr_path: PathBuf,
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
        let stderr_path = directory.path().join("target.stderr");
        let feature_capacity = u32::try_from(config.feature_capacity)
            .context("feature capacity exceeds protocol limit")?;
        let cmp_capacity = u32::try_from(config.cmp_capacity)
            .context("comparison capacity exceeds protocol limit")?;
        let shm = SharedMemory::create(&shm_path, config.max_input, feature_capacity, cmp_capacity)
            .context("creating target shared memory")?;

        let listener = UnixListener::bind(&socket_path)
            .with_context(|| format!("binding {}", socket_path.display()))?;
        listener.set_nonblocking(true)?;
        let stderr_file = File::create(&stderr_path)
            .with_context(|| format!("creating {}", stderr_path.display()))?;

        let mut command = Command::new(&config.target);
        command
            .args(&config.target_args)
            .env("FOZZIE_SHM_PATH", &shm_path)
            .env("FOZZIE_SOCKET_PATH", &socket_path)
            .env("RUST_BACKTRACE", "1")
            .env(
                "ASAN_OPTIONS",
                "abort_on_error=1:disable_coredump=0:symbolize=1",
            )
            .env("UBSAN_OPTIONS", "abort_on_error=1:print_stacktrace=1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_file))
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
        let mut child = command
            .spawn()
            .with_context(|| format!("starting target {}", config.target.display()))?;

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    if let Some(status) = child.try_wait().context("checking target startup")? {
                        let stderr = fs::read(&stderr_path).unwrap_or_default();
                        bail!(
                            "target exited during startup with {status}: {}",
                            String::from_utf8_lossy(&stderr)
                        );
                    }
                    if Instant::now() >= deadline {
                        kill_process_group(&mut child);
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
        socket.set_read_timeout(Some(config.timeout))?;
        socket.set_write_timeout(Some(config.timeout))?;
        let hello = HelloFrame::read_from(&mut socket)?;
        ensure!(
            hello.capabilities & CAP_INLINE_8BIT_COUNTERS != 0,
            "target runtime has no counter support"
        );
        ensure!(
            hello.counter_count > 0,
            "target has no SanitizerCoverage counters; check the Buck fuzz transition"
        );

        Ok(Self {
            _directory: directory,
            _socket_directory: socket_directory,
            shm,
            socket,
            child: Some(child),
            stderr_path,
        })
    }

    fn read_stderr(&self) -> Vec<u8> {
        fs::read(&self.stderr_path).unwrap_or_default()
    }

    fn terminate(&mut self) -> Vec<u8> {
        if let Some(child) = &mut self.child {
            kill_process_group(child);
        }
        self.child.take();
        self.read_stderr()
    }

    fn wait_after_disconnect(&mut self) -> std::io::Result<ExitStatus> {
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        let child = self.child.as_mut().expect("live session has child");
        loop {
            if let Some(status) = child.try_wait()? {
                self.child.take();
                return Ok(status);
            }
            if Instant::now() >= deadline {
                kill_process_group(child);
                return child.wait().inspect(|_| {
                    self.child.take();
                });
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let _ = StopFrame::default().write_to(&mut self.socket);
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
                _ => {
                    kill_process_group(child);
                    break;
                }
            }
        }
        let _ = child.wait();
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
