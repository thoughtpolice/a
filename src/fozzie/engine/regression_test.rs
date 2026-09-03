// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::ffi::{CString, OsString};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const DIAGNOSTIC: &str = "fozzie test oracle returned 17\n";

fn executable(variable: &str) -> PathBuf {
    fs::canonicalize(std::env::var_os(variable).expect("Buck supplies the test executable"))
        .expect("test executable exists")
}

fn engine() -> Command {
    Command::new(executable("FOZZIE_TEST_ENGINE"))
}

fn run(command: &mut Command) -> Output {
    Running::start(command).finish(Duration::from_secs(20))
}

struct Running {
    child: Child,
    stdout: Option<thread::JoinHandle<Vec<u8>>>,
    stderr: Option<thread::JoinHandle<Vec<u8>>>,
}

impl Running {
    fn start(command: &mut Command) -> Self {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("starting Fozzie");
        fn capture(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
            thread::spawn(move || {
                let mut bytes = Vec::new();
                pipe.read_to_end(&mut bytes).unwrap();
                bytes
            })
        }
        let stdout = Some(capture(child.stdout.take().unwrap()));
        let stderr = Some(capture(child.stderr.take().unwrap()));
        Self {
            child,
            stdout,
            stderr,
        }
    }

    fn finish(mut self, timeout: Duration) -> Output {
        let deadline = Instant::now() + timeout;
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = self.child.try_wait().expect("checking Fozzie") {
                break status;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                self.child.kill().unwrap();
                break self.child.wait().unwrap();
            }
            thread::sleep(Duration::from_millis(5));
        };
        let output = Output {
            status,
            stdout: self.stdout.take().unwrap().join().unwrap(),
            stderr: self.stderr.take().unwrap().join().unwrap(),
        };
        assert!(!timed_out, "Fozzie did not finish: {output:?}");
        output
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn summary(output: &Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let encoded = stdout
        .lines()
        .find_map(|line| line.strip_prefix("FOZZIE_SUMMARY "))
        .unwrap_or_else(|| panic!("missing campaign summary: {output:?}"));
    serde_json::from_str(encoded).unwrap()
}

fn fixture(mode: &str, workdir: &Path) -> Command {
    let mut command = engine();
    command
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_REGRESSION_TARGET"))
        .args([
            "--target-arg",
            mode,
            "--duration",
            "0",
            "--timeout-ms",
            "10000",
        ])
        .arg("--workdir")
        .arg(workdir);
    command
}

fn metadata(workdir: &Path) -> Vec<serde_json::Value> {
    fs::read_dir(workdir.join("artifacts"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| serde_json::from_slice(&fs::read(path).unwrap()).unwrap())
        .collect()
}

fn assert_targets_reaped(directory: &Path) {
    let calls = fs::read_to_string(directory.join("calls")).unwrap();
    for line in calls.lines() {
        let pid: u32 = line.split_whitespace().nth(1).unwrap().parse().unwrap();
        assert!(
            !Path::new("/proc").join(pid.to_string()).exists(),
            "target {pid} survived campaign shutdown"
        );
    }
}

#[test]
fn slow_setup_does_not_skip_a_failing_seed() {
    let directory = tempfile::tempdir().unwrap();
    let seed = directory.path().join("seed");
    fs::write(&seed, b"NONZERO").unwrap();
    let dictionary = directory.path().join("dictionary");
    let path = CString::new(dictionary.as_os_str().as_bytes()).unwrap();
    // SAFETY: path is a NUL-terminated pathname inside this test's directory.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);

    // Wait for Fozzie to open the dictionary, then delay its contents beyond
    // the entire execution budget. This avoids depending on machine speed or
    // the cost of parsing a particular dictionary.
    let writer_path = dictionary.clone();
    let writer = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut file = loop {
            match OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&writer_path)
            {
                Ok(file) => break file,
                Err(error)
                    if error.raw_os_error() == Some(libc::ENXIO) && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("opening delayed dictionary: {error}"),
            }
        };
        thread::sleep(Duration::from_millis(1_100));
        file.write_all(b"\"token\"\n").unwrap();
    });

    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .arg("--workdir")
        .arg(directory.path().join("campaign"))
        .arg("--corpus")
        .arg(seed)
        .arg("--dictionary")
        .arg(dictionary)
        .args(["--duration", "1", "--runs", "1", "--test-mode"]));
    writer.join().unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let result = summary(&output);
    assert_eq!(result["executions"], 1);
    assert_eq!(result["finding"]["confirmed"], true);
}

#[test]
fn nonzero_diagnostics_reach_replay_and_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let seed = directory.path().join("seed");
    fs::write(&seed, b"NONZERO").unwrap();
    let target = executable("FOZZIE_TEST_TARGET");
    for _ in 0..8 {
        let output = run(engine()
            .args(["replay", "--target"])
            .arg(&target)
            .arg("--input")
            .arg(&seed));
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(DIAGNOSTIC),
            "{output:?}"
        );
    }

    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(target)
        .arg("--workdir")
        .arg(directory.path().join("campaign"))
        .arg("--corpus")
        .arg(seed)
        .args(["--duration", "0", "--runs", "1", "--test-mode"]));
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let result = summary(&output);
    assert_eq!(result["finding"]["confirmed"], true);
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(result["finding"]["metadata_path"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(metadata["stderr"], DIAGNOSTIC);
}

#[test]
fn supports_long_campaign_and_temporary_paths() {
    let directory = tempfile::tempdir().unwrap();
    let campaign = directory.path().join("long-campaign-".repeat(10));
    fs::create_dir(&campaign).unwrap();
    let seed = directory.path().join("seed");
    fs::write(&seed, b"ordinary seed").unwrap();
    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .arg("--workdir")
        .arg(&campaign)
        .arg("--corpus")
        .arg(seed)
        .args([
            "--duration",
            "0",
            "--runs",
            "4",
            "--seed",
            "1234",
            "--test-mode",
        ])
        .env("TMPDIR", &campaign));
    assert!(output.status.success(), "{output:?}");
    assert_eq!(summary(&output)["executions"], 4);
}
#[test]
fn two_workers_share_the_exact_execution_budget_and_exit() {
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path().join("campaign");
    let output = run(fixture("parallel", &work)
        .arg("--target-arg")
        .arg(directory.path())
        .args(["--jobs", "2", "--runs", "66"]));
    assert!(output.status.success(), "{output:?}");
    assert_eq!(summary(&output)["executions"], 66);
    let calls = fs::read_to_string(directory.path().join("calls")).unwrap();
    assert_eq!(calls.lines().count(), 66);
    assert!(calls.lines().any(|line| line.starts_with("0 ")));
    assert!(calls.lines().any(|line| line.starts_with("1 ")));
    assert_targets_reaped(directory.path());
}

#[test]
fn stderr_from_a_successful_run_does_not_reach_the_next_finding() {
    let directory = tempfile::tempdir().unwrap();
    for trial in 0..8 {
        let work = directory.path().join(trial.to_string());
        let output = run(fixture("stderr", &work).args(["--runs", "2", "--test-mode"]));
        assert!(output.status.success(), "{output:?}");
        let records = metadata(&work);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["stderr"], "current failed run\n");
    }
}

#[test]
fn successful_workdir_retention_matches_the_summary() {
    let directory = tempfile::tempdir().unwrap();
    for durable in [false, true] {
        let mut command = engine();
        command
            .args(["fuzz", "--target"])
            .arg(executable("FOZZIE_TEST_TARGET"))
            .args(["--duration", "0", "--runs", "1", "--test-mode"]);
        if durable {
            command
                .arg("--workdir")
                .arg(directory.path().join("campaign"));
        }
        let output = run(&mut command);
        assert!(output.status.success(), "{output:?}");
        let result = summary(&output);
        assert_eq!(result["workdir_persisted"], durable);
        assert_eq!(
            Path::new(result["workdir"].as_str().unwrap()).exists(),
            durable
        );
    }
}

#[test]
fn artifact_replay_preserves_non_utf8_and_empty_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let output = run(fixture("arguments", directory.path())
        .arg("--target-arg")
        .arg(OsString::from_vec(vec![b'-', 0xff, b'\'', b'\n']))
        .args(["--target-arg", "", "--runs", "1", "--test-mode"]));
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let result = summary(&output);
    assert!(
        result["finding"]["repro"]
            .as_str()
            .unwrap()
            .contains("replay-artifact")
    );
    let replay = run(engine()
        .arg("replay-artifact")
        .arg(result["finding"]["metadata_path"].as_str().unwrap()));
    assert_eq!(replay.status.code(), Some(1), "{replay:?}");
    assert!(String::from_utf8_lossy(&replay.stderr).contains("lossless arguments"));
}

#[test]
fn large_inputs_replay_from_metadata_without_a_large_command_line() {
    let directory = tempfile::tempdir().unwrap();
    let seed = directory.path().join("seed");
    fs::write(&seed, vec![b'x'; 200000]).unwrap();
    let output = run(fixture("large-input", directory.path())
        .arg("--corpus")
        .arg(seed)
        .args(["--max-input", "200000", "--runs", "1", "--test-mode"]));
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let result = summary(&output);
    let command = result["finding"]["repro"].as_str().unwrap();
    assert!(command.contains("replay-artifact"));
    assert!(command.len() < 4096);
    let replay = run(engine()
        .arg("replay-artifact")
        .arg(result["finding"]["metadata_path"].as_str().unwrap()));
    assert_eq!(replay.status.code(), Some(1), "{replay:?}");
}
