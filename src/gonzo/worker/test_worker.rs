// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A worker serving a scheduler, end to end: actions go in through
//! Execute, run for real, and their results come back.

use std::sync::Arc;
use std::time::Duration;

use prost::Message as _;
use tokio::sync::oneshot;
use tonic::Streaming;

use protos::build::bazel::remote::execution::v2::{
    Action, Command, Digest, Directory, ExecuteRequest, ExecuteResponse, FileNode, Platform,
    command::EnvironmentVariable, execution_client::ExecutionClient,
};
use protos::google::longrunning::{Operation, operation};
use protos::google::rpc::Code;

use crate::digest::DigestFunction;
use crate::test_support::Daemon;
use crate::{Config, Worker, host_properties};

const PATIENCE: Duration = Duration::from_secs(30);

/// A daemon and a worker serving it, for as long as this is kept.
struct Setup {
    daemon: Daemon,
    scratch: tempfile::TempDir,
    _stop: oneshot::Sender<()>,
}

async fn setup() -> Setup {
    let daemon = Daemon::start().await;
    let scratch = tempfile::tempdir().unwrap();
    let worker = Arc::new(
        Worker::new(
            daemon.channel.clone(),
            Config {
                name: "test-worker".into(),
                properties: host_properties(),
                slots: 2,
                dir: scratch.path().join("worker"),
                cache_bytes: u64::MAX,
                base_environment: vec![
                    ("PATH".into(), "/usr/bin:/bin".into()),
                    ("FROM_THE_IMAGE".into(), "yes".into()),
                ],
                default_timeout: Duration::from_secs(60),
                max_timeout: Duration::from_secs(600),
            },
        )
        .expect("worker"),
    );
    let (stop, stopped) = oneshot::channel::<()>();
    tokio::spawn(async move {
        worker
            .serve(async {
                let _ = stopped.await;
            })
            .await
    });
    Setup {
        daemon,
        scratch,
        _stop: stop,
    }
}

/// Store an action running `script` with `sh`, over `inputs`.
async fn action(
    daemon: &Daemon,
    script: &str,
    outputs: &[&str],
    inputs: &Directory,
    timeout: Option<Duration>,
) -> Digest {
    let command = Command {
        arguments: vec!["sh".into(), "-c".into(), script.into()],
        environment_variables: vec![EnvironmentVariable {
            name: "PATH".into(),
            value: "/usr/bin:/bin".into(),
        }],
        output_paths: outputs.iter().map(|p| p.to_string()).collect(),
        ..Default::default()
    };
    let action = Action {
        command_digest: Some(daemon.put(command.encode_to_vec()).await),
        input_root_digest: Some(daemon.put_dir(inputs).await),
        timeout: timeout.map(|t| t.try_into().unwrap()),
        platform: Some(Platform {
            properties: host_properties(),
        }),
        ..Default::default()
    };
    daemon.put(action.encode_to_vec()).await
}

async fn execute(daemon: &Daemon, digest: &Digest) -> Streaming<Operation> {
    ExecutionClient::new(daemon.channel.clone())
        .execute(ExecuteRequest {
            action_digest: Some(digest.clone()),
            digest_function: 1,
            ..Default::default()
        })
        .await
        .expect("execute")
        .into_inner()
}

async fn completion(stream: &mut Streaming<Operation>) -> ExecuteResponse {
    loop {
        let op = tokio::time::timeout(PATIENCE, stream.message())
            .await
            .expect("in time")
            .expect("a message")
            .expect("not the end yet");
        if let Some(operation::Result::Response(any)) = op.result {
            return ExecuteResponse::decode(any.value.as_slice()).expect("decode");
        }
    }
}

fn code(response: &ExecuteResponse) -> i32 {
    response.status.as_ref().map_or(0, |s| s.code)
}

#[tokio::test]
async fn an_action_runs_and_its_outputs_come_back() {
    let setup = setup().await;
    let daemon = &setup.daemon;
    let input = daemon.put("world").await;
    let inputs = Directory {
        files: vec![FileNode {
            name: "input.txt".into(),
            digest: Some(input),
            is_executable: false,
            node_properties: None,
        }],
        ..Default::default()
    };
    let digest = action(
        daemon,
        "echo hello $(cat input.txt) > out/greeting && echo done",
        &["out/greeting"],
        &inputs,
        None,
    )
    .await;

    let response = completion(&mut execute(daemon, &digest).await).await;
    assert_eq!(code(&response), 0, "{:?}", response.status);
    assert!(!response.cached_result);
    let result = response.result.expect("a result");
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.output_files.len(), 1);
    assert_eq!(result.output_files[0].path, "out/greeting");
    let greeting = result.output_files[0].digest.as_ref().unwrap();
    assert_eq!(daemon.get(greeting).await.as_ref(), b"hello world\n");
    assert_eq!(
        daemon
            .get(result.stdout_digest.as_ref().unwrap())
            .await
            .as_ref(),
        b"done\n"
    );
    let metadata = result.execution_metadata.expect("metadata");
    assert_eq!(metadata.worker, "test-worker");
    assert!(metadata.execution_completed_timestamp.is_some());

    // Recorded in the action cache, so the next time is a hit.
    let again = completion(&mut execute(daemon, &digest).await).await;
    assert!(again.cached_result);
}

#[tokio::test]
async fn a_failing_action_reports_its_exit_code_and_stderr() {
    let setup = setup().await;
    let daemon = &setup.daemon;
    let digest = action(
        daemon,
        "echo oops >&2; exit 2",
        &[],
        &Directory::default(),
        None,
    )
    .await;
    let response = completion(&mut execute(daemon, &digest).await).await;
    assert_eq!(code(&response), 0, "the action ran; it just failed");
    let result = response.result.unwrap();
    assert_eq!(result.exit_code, 2);
    assert_eq!(
        daemon
            .get(result.stderr_digest.as_ref().unwrap())
            .await
            .as_ref(),
        b"oops\n"
    );
}

#[tokio::test]
async fn a_missing_input_fails_the_precondition() {
    let setup = setup().await;
    let daemon = &setup.daemon;
    let inputs = Directory {
        files: vec![FileNode {
            name: "absent".into(),
            digest: Some(DigestFunction::Sha256.of(b"never uploaded")),
            is_executable: false,
            node_properties: None,
        }],
        ..Default::default()
    };
    let digest = action(daemon, "cat absent", &[], &inputs, None).await;
    let response = completion(&mut execute(daemon, &digest).await).await;
    assert_eq!(
        code(&response),
        Code::FailedPrecondition as i32,
        "{:?}",
        response.status
    );
}

#[tokio::test]
async fn an_action_past_its_timeout_is_stopped() {
    let setup = setup().await;
    let daemon = &setup.daemon;
    let digest = action(
        daemon,
        "echo started; sleep 60",
        &[],
        &Directory::default(),
        Some(Duration::from_secs(1)),
    )
    .await;
    let response = completion(&mut execute(daemon, &digest).await).await;
    assert_eq!(
        code(&response),
        Code::DeadlineExceeded as i32,
        "{:?}",
        response.status
    );
    let result = response.result.expect("what it printed");
    assert_eq!(
        daemon
            .get(result.stdout_digest.as_ref().unwrap())
            .await
            .as_ref(),
        b"started\n"
    );
}

#[tokio::test]
async fn an_action_nobody_waits_for_is_killed() {
    let setup = setup().await;
    let daemon = &setup.daemon;
    let pid_file = setup.scratch.path().join("pid");
    let script = format!("echo $$ > {}; exec sleep 60", pid_file.display());
    let digest = action(daemon, &script, &[], &Directory::default(), None).await;
    let stream = execute(daemon, &digest).await;

    let deadline = tokio::time::Instant::now() + PATIENCE;
    let pid = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| s.trim().parse::<i32>().ok())
        {
            break pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the action never started"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    drop(stream);
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while std::path::Path::new(&format!("/proc/{pid}")).exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the action outlived its client"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn actions_start_from_the_base_environment() {
    let setup = setup().await;
    let daemon = &setup.daemon;
    // The command sets PATH itself (see `action`), and not FROM_THE_IMAGE.
    let digest = action(daemon, "env | sort", &[], &Directory::default(), None).await;
    let response = completion(&mut execute(daemon, &digest).await).await;
    let result = response.result.expect("a result");
    let stdout = daemon.get(result.stdout_digest.as_ref().unwrap()).await;
    let stdout = String::from_utf8_lossy(&stdout);
    assert!(stdout.contains("FROM_THE_IMAGE=yes\n"), "{stdout}");
    assert_eq!(stdout.matches("PATH=").count(), 1, "{stdout}");
}
