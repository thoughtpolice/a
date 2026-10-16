// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Running an action's command.
//!
//! The command runs with exactly the environment it names, in its own
//! process group, with stdin empty and stdout and stderr in files. When it
//! exits, runs out of time or is cancelled, whatever else is left in its
//! group is killed too. Nothing more is isolated yet: the command sees the
//! machine as the worker does.

use std::future::Future;
use std::os::unix::process::ExitStatusExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};

/// What to run.
#[derive(Debug)]
pub struct Spec<'a> {
    /// The program and its arguments. A program named with a `/` but not
    /// absolute is relative to the working directory; one without a `/`
    /// is looked up in the command's own `PATH`.
    pub arguments: &'a [String],
    pub environment: &'a [(String, String)],
    pub working_directory: &'a Path,
    pub stdout: &'a Path,
    pub stderr: &'a Path,
    pub timeout: Duration,
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
    let program = if program.contains('/') {
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
    let mut child = command.spawn().map_err(|source| SpawnError {
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
    let _ = child.wait().await;
    Ok(outcome)
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
}
