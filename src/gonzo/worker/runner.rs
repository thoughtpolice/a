// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Running an action's command.
//!
//! The command runs with exactly the environment it names, in its own
//! process group (and cgroup, if it has one), with stdin empty and stdout
//! and stderr in files. When it exits, runs out of time or is cancelled,
//! whatever else is left in its group and cgroup is killed too. It sees
//! the machine as the worker does, or, given an [`EmptyRoot`], nothing but
//! its inputs.

use std::future::Future;
use std::os::unix::process::ExitStatusExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{PoisonError, RwLock, RwLockReadGuard};
use std::time::Duration;

use anyhow::{Context as _, Result, bail};

use crate::cgroup::ActionCgroup;
use crate::sandbox::EmptyRoot;

/// What to run.
#[derive(Debug)]
pub struct Spec<'a> {
    /// The program and its arguments. A program named with a `/` but not
    /// absolute is relative to the working directory; one without a `/`
    /// is looked up in the command's own `PATH`, in the empty root if it
    /// has one.
    pub arguments: &'a [String],
    pub environment: &'a [(String, String)],
    pub working_directory: &'a Path,
    pub stdout: &'a Path,
    pub stderr: &'a Path,
    pub timeout: Duration,
    /// A cgroup for the command and everything it starts.
    pub cgroup: Option<&'a ActionCgroup>,
    /// Run the command with its input root as its whole filesystem.
    pub empty_root: Option<&'a EmptyRoot>,
}

/// How a command ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It exited, with this code; a signal `n` reads as `128 + n`, as a
    /// shell would say.
    Exited(i32),
    TimedOut,
    Cancelled,
}

/// The command could not be started at all.
#[derive(Debug, thiserror::Error)]
#[error("could not run {program:?}: {source}")]
pub struct SpawnError {
    pub program: PathBuf,
    pub source: std::io::Error,
}

/// Run `spec` until it exits, its timeout passes, or `cancelled` resolves.
pub async fn run(spec: &Spec<'_>, cancelled: impl Future<Output = ()>) -> Result<Outcome> {
    let Some((program, arguments)) = spec.arguments.split_first() else {
        bail!("the command has no arguments");
    };
    // In an empty root the working directory is the current one when the
    // command execs, under another name than the worker's.
    let program = if program.contains('/') && spec.empty_root.is_none() {
        spec.working_directory.join(program)
    } else {
        PathBuf::from(program)
    };
    let stdout = std::fs::File::create_new(spec.stdout)
        .with_context(|| format!("creating {}", spec.stdout.display()))?;
    let stderr = std::fs::File::create_new(spec.stderr)
        .with_context(|| format!("creating {}", spec.stderr.display()))?;

    let mut command = tokio::process::Command::new(&program);
    command
        .args(arguments)
        .env_clear()
        .envs(spec.environment.iter().map(|(k, v)| (k, v)))
        .current_dir(spec.working_directory)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .process_group(0)
        .kill_on_drop(true);
    if let Some(cgroup) = spec.cgroup {
        let procs = cgroup.procs_fd();
        // SAFETY: joining makes one async-signal-safe write(2).
        unsafe {
            command.pre_exec(move || crate::cgroup::join(procs));
        }
    }
    if let Some(root) = spec.empty_root.cloned() {
        // SAFETY: entering makes system calls only. It runs after the
        // cgroup join, which needs the worker's view of /sys/fs/cgroup.
        unsafe {
            command.pre_exec(move || root.enter());
        }
    }
    let mut child = spawn(&mut command).map_err(|source| SpawnError {
        program: program.clone(),
        source,
    })?;
    let group = Group(child.id().expect("a running child has an id"));

    let outcome = tokio::select! {
        status = child.wait() => {
            let status = status.context("waiting for the command")?;
            match (status.code(), status.signal()) {
                (Some(code), _) => Outcome::Exited(code),
                (None, Some(signal)) => Outcome::Exited(128 + signal),
                (None, None) => bail!("the command ended with {status}, neither exiting nor signalled"),
            }
        }
        () = tokio::time::sleep(spec.timeout) => Outcome::TimedOut,
        () = cancelled => Outcome::Cancelled,
    };
    // Whatever the command left behind goes with it. The group is killed
    // before the child is reaped, so its id cannot have been reused.
    drop(group);
    if let Some(cgroup) = spec.cgroup {
        cgroup.kill().await;
    }
    let _ = child.wait().await;
    Ok(outcome)
}

/// Held to read while the worker has open for writing a file an action may
/// execute, and to write while a command is spawned.
///
/// A child forked from the multithreaded worker holds every descriptor the
/// worker had open until it execs, after joining its cgroup and entering
/// its empty root. An exec of a file still open for writing fails with
/// ETXTBSY ("text file busy"), and not only the worker's exec: one in
/// another action, such as a compiler driver's of its compiler proper,
/// fails the action. Spawning returns once the child has exec'd, or failed
/// to, so no child is between fork and exec while an input is written.
static SPAWNING: RwLock<()> = RwLock::new(());

/// Hold while writing a file that an action may execute; see [`SPAWNING`].
pub(crate) fn writing_input() -> RwLockReadGuard<'static, ()> {
    SPAWNING.read().unwrap_or_else(PoisonError::into_inner)
}

/// Spawn `command` while no input is open for writing; see [`SPAWNING`].
pub(crate) fn spawn(
    command: &mut tokio::process::Command,
) -> std::io::Result<tokio::process::Child> {
    let _spawning = SPAWNING.write().unwrap_or_else(PoisonError::into_inner);
    command.spawn()
}

/// A process group, killed when this is dropped.
struct Group(u32);

impl Drop for Group {
    fn drop(&mut self) {
        // SAFETY: kill(2) with a negative pid signals the group; it touches
        // no memory.
        unsafe {
            libc::kill(-(self.0 as libc::pid_t), libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch {
        dir: tempfile::TempDir,
    }

    impl Scratch {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join("root")).unwrap();
            Self { dir }
        }

        fn root(&self) -> PathBuf {
            self.dir.path().join("root")
        }

        async fn run(
            &self,
            argv: &[&str],
            timeout: Duration,
            cancelled: impl Future<Output = ()>,
        ) -> Result<Outcome> {
            let arguments: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
            let environment = [("PATH".to_string(), "/usr/bin:/bin".to_string())];
            let (stdout, stderr) = (
                self.dir.path().join("stdout"),
                self.dir.path().join("stderr"),
            );
            let _ = std::fs::remove_file(&stdout);
            let _ = std::fs::remove_file(&stderr);
            run(
                &Spec {
                    arguments: &arguments,
                    environment: &environment,
                    working_directory: &self.root(),
                    stdout: &stdout,
                    stderr: &stderr,
                    timeout,
                    cgroup: None,
                    empty_root: None,
                },
                cancelled,
            )
            .await
        }

        fn stdout(&self) -> String {
            std::fs::read_to_string(self.dir.path().join("stdout")).unwrap()
        }

        fn stderr(&self) -> String {
            std::fs::read_to_string(self.dir.path().join("stderr")).unwrap()
        }
    }

    const LONG: Duration = Duration::from_secs(60);

    #[tokio::test]
    async fn captures_output_and_the_exit_code() {
        let scratch = Scratch::new();
        let outcome = scratch
            .run(
                &["sh", "-c", "echo out; echo err >&2; exit 3"],
                LONG,
                std::future::pending(),
            )
            .await
            .unwrap();
        assert_eq!(outcome, Outcome::Exited(3));
        assert_eq!(scratch.stdout(), "out\n");
        assert_eq!(scratch.stderr(), "err\n");
    }

    #[tokio::test]
    async fn the_environment_is_exactly_the_one_given() {
        let scratch = Scratch::new();
        scratch
            .run(&["env"], LONG, std::future::pending())
            .await
            .unwrap();
        assert_eq!(scratch.stdout(), "PATH=/usr/bin:/bin\n");
    }

    #[tokio::test]
    async fn programs_with_a_slash_are_relative_to_the_working_directory() {
        let scratch = Scratch::new();
        let tool = scratch.root().join("tools");
        std::fs::create_dir(&tool).unwrap();
        std::fs::write(tool.join("hello"), "#!/bin/sh\necho hello from $(pwd)\n").unwrap();
        std::fs::set_permissions(
            tool.join("hello"),
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let outcome = scratch
            .run(&["tools/hello"], LONG, std::future::pending())
            .await
            .unwrap();
        assert_eq!(outcome, Outcome::Exited(0));
        assert_eq!(
            scratch.stdout(),
            format!("hello from {}\n", scratch.root().display())
        );
    }

    #[tokio::test]
    async fn a_missing_program_cannot_be_spawned() {
        let scratch = Scratch::new();
        let err = scratch
            .run(&["no-such-program-anywhere"], LONG, std::future::pending())
            .await
            .expect_err("nothing to run");
        assert!(err.downcast_ref::<SpawnError>().is_some(), "{err:#}");
    }

    #[tokio::test]
    async fn a_signal_reads_as_128_plus_its_number() {
        let scratch = Scratch::new();
        let outcome = scratch
            .run(&["sh", "-c", "kill -9 $$"], LONG, std::future::pending())
            .await
            .unwrap();
        assert_eq!(outcome, Outcome::Exited(128 + 9));
    }

    /// Whether the process `pid` is gone (or a zombie no one has reaped).
    fn gone(pid: i32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit(')')
                .next()
                .is_some_and(|rest| rest.trim_start().starts_with('Z')),
        }
    }

    #[tokio::test]
    async fn a_timeout_kills_the_whole_group() {
        let scratch = Scratch::new();
        let outcome = scratch
            .run(
                &["sh", "-c", "sleep 100 & echo $! > ../background; wait"],
                Duration::from_millis(500),
                std::future::pending(),
            )
            .await
            .unwrap();
        assert_eq!(outcome, Outcome::TimedOut);
        let pid: i32 = std::fs::read_to_string(scratch.dir.path().join("background"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        for _ in 0..100 {
            if gone(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the background process {pid} outlived its action");
    }

    #[tokio::test]
    async fn cancelling_stops_the_command() {
        let scratch = Scratch::new();
        let started = std::time::Instant::now();
        let outcome = scratch
            .run(
                &["sleep", "100"],
                LONG,
                tokio::time::sleep(Duration::from_millis(200)),
            )
            .await
            .unwrap();
        assert_eq!(outcome, Outcome::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn processes_that_leave_the_group_die_with_the_cgroup() {
        let Some(cgroups) = crate::cgroup::Cgroups::new() else {
            eprintln!("skipping: this process cannot make cgroups");
            return;
        };
        let scratch = Scratch::new();
        let cgroup = cgroups.create("escape").expect("a cgroup");
        let arguments: Vec<String> = [
            "sh",
            "-c",
            "setsid sleep 100 < /dev/null > /dev/null 2>&1 & echo $! > ../escaped",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        let environment = [("PATH".to_string(), "/usr/bin:/bin".to_string())];
        let outcome = run(
            &Spec {
                arguments: &arguments,
                environment: &environment,
                working_directory: &scratch.root(),
                stdout: &scratch.dir.path().join("stdout"),
                stderr: &scratch.dir.path().join("stderr"),
                timeout: LONG,
                cgroup: Some(&cgroup),
                empty_root: None,
            },
            std::future::pending(),
        )
        .await
        .unwrap();
        assert_eq!(outcome, Outcome::Exited(0));
        let pid: i32 = std::fs::read_to_string(scratch.dir.path().join("escaped"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        for _ in 0..100 {
            if gone(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // SAFETY: kill(2) touches no memory.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        panic!("{pid} left its process group and outlived its action");
    }
}
