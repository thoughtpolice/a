// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::ffi::{CString, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
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
    let mut command = Command::new(executable("FOZZIE_TEST_ENGINE"));
    // Campaigns register themselves for `fozzie tui`. Without a state
    // directory they warn and carry on, so no test writes into the
    // developer's real registry unless it sets FOZZIE_STATE_DIR itself.
    command
        .env_remove("FOZZIE_STATE_DIR")
        .env_remove("XDG_STATE_HOME")
        .env_remove("HOME");
    command
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
    assert_eq!(result["verification_executions"], 1);
    assert_eq!(result["finding"]["confirmed"], true);
    assert_eq!(result["finding"]["fingerprint"]["code"], 17);
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
fn minimizes_a_bare_relative_filename() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("input"), b"NONZERO").unwrap();
    let output = run(engine()
        .args(["minimize", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .args(["--input", "input"])
        .current_dir(directory.path()));
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        fs::read(directory.path().join("input.minimized")).unwrap(),
        b"NONZERO"
    );
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

fn status(workdir: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(workdir.join("status.json")).unwrap()).unwrap()
}

fn registrations(state: &Path) -> Vec<serde_json::Value> {
    let Ok(entries) = fs::read_dir(state.join("campaigns")) else {
        return Vec::new();
    };
    entries
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
        // SAFETY: signal 0 performs only the existence and permission checks.
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        assert!(!alive, "target {pid} survived campaign shutdown");
    }
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
fn simultaneous_candidates_are_preserved_before_verifier_arbitration() {
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path().join("campaign");
    let output = run(fixture("findings", &work)
        .arg("--target-arg")
        .arg(directory.path())
        .args(["--jobs", "2", "--runs", "66"]));
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let records = metadata(&work);
    let mut codes = records
        .iter()
        .filter(|record| record["confirmed"] == false)
        .map(|record| record["fingerprint"]["code"].as_i64().unwrap())
        .collect::<Vec<_>>();
    codes.sort_unstable();
    assert_eq!(codes, [17, 18]);
    assert_eq!(
        records
            .iter()
            .filter(|record| record["confirmed"] == true)
            .count(),
        1
    );
    assert_targets_reaped(directory.path());
}

#[test]
fn signals_stop_active_workers_and_preserve_a_summary_and_corpus() {
    for signal in [libc::SIGINT, libc::SIGTERM] {
        let directory = tempfile::tempdir().unwrap();
        let mut child = Running::start(
            engine()
                .args(["fuzz", "--target"])
                .arg(executable("FOZZIE_REGRESSION_TARGET"))
                .args(["--target-arg", "interrupt", "--target-arg"])
                .arg(directory.path())
                .args(["--duration", "0", "--jobs", "2", "--timeout-ms", "60000"])
                .env("TMPDIR", directory.path()),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        for worker in 0..2 {
            let marker = directory.path().join(format!("worker-{worker}.pid"));
            while fs::read_to_string(&marker)
                .ok()
                .is_none_or(|text| text.trim().parse::<u32>().is_err())
            {
                assert!(
                    child.child.try_wait().unwrap().is_none(),
                    "Fozzie exited before workers were ready"
                );
                assert!(Instant::now() < deadline, "workers did not rendezvous");
                thread::sleep(Duration::from_millis(5));
            }
        }
        let campaign = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("fozzie-"))
            })
            .expect("the campaign directory");
        let live = run(engine()
            .args(["tui", "--once", "--no-registry", "--workdir"])
            .arg(&campaign)
            .args(["--width", "120", "--height", "40"]));
        assert!(live.status.success(), "{live:?}");
        let screen = String::from_utf8_lossy(&live.stdout);
        assert!(screen.contains("1 running"), "{screen}");
        assert!(screen.contains("phase         fuzzing"), "{screen}");
        // SAFETY: this is the live child owned by the test, not its process
        // group or any unrelated process.
        assert_eq!(
            unsafe { libc::kill(child.child.id() as libc::pid_t, signal) },
            0
        );
        let output = child.finish(Duration::from_secs(3));
        assert_eq!(output.status.code(), Some(128 + signal), "{output:?}");
        let result = summary(&output);
        assert_eq!(result["interrupted_signal"], signal);
        assert_eq!(result["workdir_persisted"], true);
        assert!(result["finding"].is_null());
        assert!(result["infrastructure_error"].is_null());
        let workdir = Path::new(result["workdir"].as_str().unwrap());
        assert!(
            fs::read_dir(workdir.join("corpus"))
                .unwrap()
                .next()
                .is_some()
        );
        let live = status(workdir);
        assert_eq!(live["phase"]["outcome"], "interrupted");
        assert_eq!(live["interrupted_signal"], signal);
        assert_targets_reaped(directory.path());
    }
}

#[test]
fn status_file_and_registry_describe_a_durable_campaign() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let work = directory.path().join("campaign");
    let seed = directory.path().join("seed");
    fs::write(&seed, b"ordinary seed").unwrap();
    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .arg("--workdir")
        .arg(&work)
        .arg("--corpus")
        .arg(&seed)
        .args([
            "--runs",
            "64",
            "--duration",
            "0",
            "--jobs",
            "2",
            "--seed",
            "1234",
        ])
        .env("FOZZIE_STATE_DIR", &state));
    assert!(output.status.success(), "{output:?}");
    let result = summary(&output);
    let status = status(&work);
    assert_eq!(status["version"], 1);
    assert_eq!(status["phase"]["name"], "finished");
    assert_eq!(status["phase"]["outcome"], "budget");
    assert_eq!(status["executions"], result["executions"]);
    assert_eq!(status["executions"], 64);
    assert!(status["pid"].as_u64().unwrap() > 0);
    let workers = status["workers"].as_array().unwrap();
    assert_eq!(workers.len(), 2);
    // Calibration runs the lone seed twice on the main thread; every other
    // execution belongs to a worker.
    let worker_executions: u64 = workers
        .iter()
        .map(|worker| worker["executions"].as_u64().unwrap())
        .sum();
    assert_eq!(worker_executions, 62);
    let mutators = status["mutators"].as_array().unwrap();
    assert_eq!(mutators.len(), 8);
    let applied: u64 = mutators
        .iter()
        .map(|mutator| mutator["applied"].as_u64().unwrap())
        .sum();
    assert!(applied > 0);
    assert!(status["counters"].as_u64().unwrap() > 0);
    let edges = status["edges"].as_u64().unwrap();
    assert!(edges > 0 && edges <= status["features"].as_u64().unwrap());
    assert!(status["last_interesting_ms"].is_number());
    assert!(status["finding"].is_null());
    let entries = registrations(&state);
    assert_eq!(entries.len(), 1);
    assert_eq!(
        Path::new(entries[0]["workdir"].as_str().unwrap()),
        fs::canonicalize(&work).unwrap()
    );
}

#[test]
fn temporary_campaigns_leave_no_registry_entry() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .args(["--runs", "4", "--duration", "0", "--jobs", "1"])
        .env("FOZZIE_STATE_DIR", &state)
        .env("TMPDIR", directory.path()));
    assert!(output.status.success(), "{output:?}");
    assert_eq!(summary(&output)["workdir_persisted"], false);
    assert!(registrations(&state).is_empty());
}

#[test]
fn a_finding_is_published_in_status_and_keeps_the_registry_entry() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let seed = directory.path().join("seed");
    fs::write(&seed, b"B").unwrap();
    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .arg("--corpus")
        .arg(&seed)
        .args(["--runs", "8", "--duration", "0", "--jobs", "1"])
        .env("FOZZIE_STATE_DIR", &state)
        .env("TMPDIR", directory.path()));
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let result = summary(&output);
    assert_eq!(result["workdir_persisted"], true);
    let workdir = Path::new(result["workdir"].as_str().unwrap());
    let status = status(workdir);
    assert_eq!(status["phase"]["outcome"], "finding");
    assert_eq!(status["finding"]["confirmed"], true);
    assert_eq!(status["finding"]["kind"], "crash");
    assert_eq!(status["finding"]["fingerprint"]["code"], 6);
    assert!(status["last_finding_ms"].is_number());
    let entries = registrations(&state);
    assert_eq!(entries.len(), 1);
    assert_eq!(
        Path::new(entries[0]["workdir"].as_str().unwrap()),
        fs::canonicalize(workdir).unwrap()
    );
}

fn tui_once(state: Option<&Path>, workdir: Option<&Path>) -> String {
    let mut command = engine();
    command.args(["tui", "--once", "--width", "120", "--height", "40"]);
    match state {
        Some(state) => {
            command.env("FOZZIE_STATE_DIR", state);
        }
        None => {
            command.arg("--no-registry");
        }
    }
    if let Some(workdir) = workdir {
        command.arg("--workdir").arg(workdir);
    }
    let output = run(&mut command);
    assert!(output.status.success(), "{output:?}");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn tui_once_lists_a_finished_campaign_from_workdir_and_registry() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let work = directory.path().join("campaign");
    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .arg("--workdir")
        .arg(&work)
        .args(["--runs", "4", "--duration", "0", "--jobs", "1"])
        .args(["--target-label", "//demo:tui"])
        .env("FOZZIE_STATE_DIR", &state));
    assert!(output.status.success(), "{output:?}");

    for screen in [tui_once(None, Some(&work)), tui_once(Some(&state), None)] {
        assert!(
            screen.starts_with("fozzie tui  1 campaign (0 running, 1 finished)"),
            "{screen}"
        );
        assert!(screen.contains("> //demo:tui"), "{screen}");
        assert!(screen.contains("finished:budget"), "{screen}");
        assert!(screen.contains("phase         finished:budget"), "{screen}");
        assert!(screen.contains("findings (0)"), "{screen}");
    }
}

#[test]
fn tui_once_shows_a_confirmed_finding() {
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path().join("campaign");
    let seed = directory.path().join("seed");
    fs::write(&seed, b"B").unwrap();
    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .arg("--workdir")
        .arg(&work)
        .arg("--corpus")
        .arg(&seed)
        .args(["--runs", "8", "--duration", "0", "--test-mode"]));
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let screen = tui_once(None, Some(&work));
    assert!(screen.contains("finished:finding"), "{screen}");
    assert!(screen.contains("findings (1)"), "{screen}");
    assert!(screen.contains("> crash   confirmed signal 6"), "{screen}");
}

#[test]
fn tui_once_with_an_empty_registry_prints_no_campaigns() {
    let directory = tempfile::tempdir().unwrap();
    let screen = tui_once(Some(directory.path()), None);
    assert!(screen.contains("no campaigns"), "{screen}");
    assert!(
        screen.contains(&format!("registry {}", directory.path().display())),
        "{screen}"
    );
}

#[test]
fn tui_without_a_terminal_exits_2() {
    let output = run(engine().args(["tui", "--no-registry"]));
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("fozzie: tui needs a terminal; use --once"),
        "{output:?}"
    );
}

/// A child that is killed and reaped if the test leaves it behind.
struct Reaped(Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[test]
fn tui_runs_interactively_on_a_pty_and_quits_on_q() {
    let directory = tempfile::tempdir().unwrap();
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    // SAFETY: winsize is plain data, and openpty writes the two descriptors
    // it opened while reading only the size; the name and termios pointers
    // may be null.
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    size.ws_col = 100;
    size.ws_row = 30;
    let opened = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    assert_eq!(opened, 0, "openpty: {}", io::Error::last_os_error());
    // SAFETY: both descriptors were just returned by openpty and nothing
    // else owns them.
    let mut master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    // SAFETY: the master is owned by this test; O_NONBLOCK lets the reader
    // below poll it against a deadline.
    unsafe {
        let flags = libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(&master), libc::F_GETFL);
        assert!(flags >= 0);
        assert_eq!(
            libc::fcntl(
                std::os::fd::AsRawFd::as_raw_fd(&master),
                libc::F_SETFL,
                flags | libc::O_NONBLOCK
            ),
            0
        );
    }

    let mut command = engine();
    command
        .args(["tui", "--no-registry", "--refresh-ms", "100", "--workdir"])
        .arg(directory.path())
        .stdin(Stdio::from(slave.try_clone().unwrap()))
        .stdout(Stdio::from(slave.try_clone().unwrap()))
        .stderr(Stdio::from(slave));
    // SAFETY: only async-signal-safe calls run between fork and exec, and
    // the new session and controlling terminal belong to the child alone.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = Reaped(command.spawn().unwrap());
    // The command keeps its copies of the slave open until it is dropped;
    // only the child's copies should hold the terminal up.
    drop(command);

    // Everything the screen has written so far; false once the terminal
    // has closed.
    fn drain(master: &mut File, seen: &mut Vec<u8>) -> bool {
        let mut chunk = [0u8; 4096];
        loop {
            match master.read(&mut chunk) {
                Ok(0) => return false,
                Ok(count) => seen.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => return true,
                Err(error) if error.raw_os_error() == Some(libc::EIO) => return false,
                Err(error) => panic!("reading the terminal: {error}"),
            }
        }
    }
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !String::from_utf8_lossy(&seen).contains("no campaigns") {
        assert!(drain(&mut master, &mut seen), "the terminal closed early");
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "fozzie tui exited before drawing: {}",
            String::from_utf8_lossy(&seen)
        );
        assert!(
            Instant::now() < deadline,
            "fozzie tui never drew: {}",
            String::from_utf8_lossy(&seen)
        );
        thread::sleep(Duration::from_millis(10));
    }
    let screen = String::from_utf8_lossy(&seen).into_owned();
    assert!(screen.contains("fozzie tui"), "{screen}");
    assert!(
        screen.contains("\x1b[?1049h"),
        "no alternate screen: {screen:?}"
    );

    master.write_all(b"q").unwrap();
    let status = loop {
        drain(&mut master, &mut seen);
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "fozzie tui did not quit on q");
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(status.code(), Some(0), "{status:?}");
    drain(&mut master, &mut seen);
    let tail = String::from_utf8_lossy(&seen).into_owned();
    assert!(
        tail.contains("\x1b[?1049l"),
        "alternate screen not left: {tail:?}"
    );
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

#[test]
fn a_full_dictionary_stops_comparison_feedback() {
    let directory = tempfile::tempdir().unwrap();
    let seed = directory.path().join("seed");
    fs::write(&seed, b"ordinary seed").unwrap();
    let dictionary = directory.path().join("full.dict");
    let entries: String = (0..8192)
        .map(|index| format!("\"tok{index:04}\"\n"))
        .collect();
    fs::write(&dictionary, entries).unwrap();

    let truncated = |dictionary: Option<&Path>| {
        let mut command = engine();
        command
            .args(["fuzz", "--target"])
            .arg(executable("FOZZIE_TEST_TARGET"))
            .arg("--corpus")
            .arg(&seed)
            .args([
                "--cmp-capacity",
                "1",
                "--duration",
                "0",
                "--runs",
                "8",
                "--seed",
                "1234",
                "--test-mode",
            ]);
        if let Some(dictionary) = dictionary {
            command.arg("--dictionary").arg(dictionary);
        }
        let output = run(&mut command);
        assert!(output.status.success(), "{output:?}");
        let result = summary(&output);
        assert_eq!(result["executions"], 8);
        result["truncated_observations"].as_u64().unwrap()
    };

    // The target compares the input length several times per run, so one
    // entry of capacity always truncates while the operands are wanted.
    assert!(truncated(None) > 0);
    assert_eq!(truncated(Some(&dictionary)), 0);
}

#[test]
fn resources_reach_the_target_by_absolute_path() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input");
    fs::write(&input, b"RESOURCE").unwrap();
    fs::write(directory.path().join("good.txt"), b"ok\n").unwrap();
    fs::write(directory.path().join("bad.txt"), b"no\n").unwrap();

    let replay = |resource: &str, expected: &[&str]| {
        let mut command = engine();
        command
            .current_dir(directory.path())
            .args(["replay", "--target"])
            .arg(executable("FOZZIE_TEST_TARGET"))
            .arg("--input")
            .arg(&input)
            .arg("--resource")
            .arg(resource)
            .args(expected);
        run(&mut command)
    };

    // The engine resolves the relative path against its own directory, so
    // the target, which does not share it, still opens the file.
    let good = replay("oracle=good.txt", &[]);
    assert!(good.status.success(), "{good:?}");

    let bad = replay(
        "oracle=bad.txt",
        &[
            "--expect-finding",
            "--expect-kind",
            "nonzero_harness",
            "--expect-code",
            "21",
        ],
    );
    assert!(bad.status.success(), "{bad:?}");

    let missing = replay("oracle=missing.txt", &[]);
    assert!(!missing.status.success(), "{missing:?}");
    assert!(
        String::from_utf8_lossy(&missing.stderr).contains("resolving resource oracle"),
        "{missing:?}"
    );

    let unnamed = replay("good.txt", &[]);
    assert!(!unnamed.status.success(), "{unnamed:?}");
}

#[test]
fn repeated_options_take_their_last_value() {
    let directory = tempfile::tempdir().unwrap();
    let seed = directory.path().join("seed");
    fs::write(&seed, b"ordinary seed").unwrap();
    let output = run(engine()
        .args(["fuzz", "--target"])
        .arg(executable("FOZZIE_TEST_TARGET"))
        .arg("--corpus")
        .arg(seed)
        .args([
            "--duration",
            "0",
            "--runs",
            "0",
            "--jobs",
            "1",
            "--timeout-ms",
            "1000",
            "--runs",
            "3",
            "--duration",
            "0",
            "--jobs",
            "2",
            "--timeout-ms",
            "5000",
            "--seed",
            "1",
            "--seed",
            "2",
        ]));
    assert!(output.status.success(), "{output:?}");
    assert_eq!(summary(&output)["executions"], 3);
    let banner = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(banner.contains("seed=2 jobs=2 "), "{banner}");
}
