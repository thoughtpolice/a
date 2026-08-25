// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

const LIFECYCLE_DIR: &str = "BURROW_LIFECYCLE_TEST_DIR";

/// A hermetic long-running child for the process-group test.  The parent
/// test invokes this same test binary with only this ignored case enabled.
#[test]
#[ignore]
fn child_waits_for_signal() {
    std::thread::sleep(Duration::from_secs(60));
}

/// Proves registration happens in `ShutdownSignals::new`, rather than on
/// the first poll of `recv`. This must run in a subprocess because failure
/// would terminate the process with SIGTERM.
#[tokio::test]
#[ignore]
async fn signal_registered_before_recv_is_polled() {
    let mut signals = ShutdownSignals::new().expect("registering signals");
    let pid = c_int::try_from(std::process::id()).unwrap();
    // SAFETY: `kill` has no pointer arguments; `pid` names this process
    // and the fixed POSIX signal is valid.
    assert_eq!(unsafe { kill(pid, ShutdownSignal::Terminate.number()) }, 0);
    let received = tokio::time::timeout(Duration::from_secs(1), signals.recv())
        .await
        .expect("the pre-poll signal was lost");
    assert_eq!(received, ShutdownSignal::Terminate);
}

/// A descendant used by the process-group ownership test. It records the
/// forwarded signal so the outer test checks delivery, not just timing.
#[tokio::test]
#[ignore]
async fn descendant_records_forwarded_signal() {
    let directory = PathBuf::from(std::env::var_os(LIFECYCLE_DIR).unwrap());
    let mut signals = ShutdownSignals::new().expect("registering descendant signals");
    std::fs::write(directory.join("ready"), b"").expect("reporting descendant readiness");
    let signal = signals.recv().await;
    std::fs::write(directory.join("signal"), signal.number().to_string())
        .expect("recording the forwarded signal");
}

/// Starts the descendant in the process group inherited from this test
/// process and then exits cleanly, modeling a shell with background work.
#[test]
#[ignore]
fn leader_exits_after_spawning_descendant() {
    let directory = PathBuf::from(std::env::var_os(LIFECYCLE_DIR).unwrap());
    let descendant = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "process_lifecycle_tests::descendant_records_forwarded_signal",
        ])
        .env(LIFECYCLE_DIR, &directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("starting the descendant test process");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !directory.join("ready").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        directory.join("ready").exists(),
        "descendant never became ready"
    );
    // Dropping std::process::Child deliberately detaches it. The outer
    // Burrow process owns it through the inherited private process group.
    drop(descendant);
}

#[tokio::test]
async fn signal_handlers_are_installed_before_the_first_recv_poll() {
    let status = ProcessCommand::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "process_lifecycle_tests::signal_registered_before_recv_is_polled",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .expect("running the signal registration helper");
    assert!(status.success(), "signal helper exited as {status}");
}

#[tokio::test]
async fn group_shutdown_preserves_the_child_signal_status() {
    let mut command = ProcessCommand::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "process_lifecycle_tests::child_waits_for_signal",
        ])
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn().expect("starting the test child");
    let process_group = c_int::try_from(child.id().unwrap()).unwrap();

    let code = stop_child_group(
        &mut child,
        process_group,
        None,
        ShutdownSignal::Terminate,
        async {},
    )
    .await
    .expect("stopping the test child");

    assert_eq!(code, ShutdownSignal::Terminate.exit_code());
}

#[tokio::test]
async fn group_shutdown_stops_descendants_after_the_leader_exits() {
    let directory = tempfile::tempdir().expect("a lifecycle scratch directory");
    let mut command = ProcessCommand::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "process_lifecycle_tests::leader_exits_after_spawning_descendant",
        ])
        .env(LIFECYCLE_DIR, directory.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut leader = command.spawn().expect("starting the group leader helper");
    let process_group = c_int::try_from(leader.id().unwrap()).unwrap();
    let status = tokio::time::timeout(Duration::from_secs(8), leader.wait())
        .await
        .expect("the group leader did not exit")
        .expect("waiting for the group leader");
    assert!(status.success(), "group leader failed: {status}");

    let code = stop_child_group(
        &mut leader,
        process_group,
        Some(status),
        ShutdownSignal::Terminate,
        async {},
    )
    .await
    .expect("stopping descendants after their leader exited");
    assert_eq!(code, 0, "the leader's status must be preserved");
    assert_eq!(
        std::fs::read_to_string(directory.path().join("signal"))
            .expect("the descendant did not record a signal"),
        ShutdownSignal::Terminate.number().to_string(),
    );
}
