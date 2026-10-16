// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The services end to end, over real HTTP/2: clients executing actions,
//! and fake workers taking them.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use prost::Message as _;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tonic::Streaming;
use tonic::transport::{Channel, Endpoint};

use gonzo_protos::worker::v1::{
    Finished, Hello, SchedulerMessage, WorkerMessage, scheduler_client::SchedulerClient,
    scheduler_message, scheduler_server::SchedulerServer, worker_message,
};
use protos::build::bazel::remote::execution::v2::{
    Action, ActionResult, Command, Digest, Directory, ExecuteRequest, ExecuteResponse, Platform,
    WaitExecutionRequest, execution_client::ExecutionClient, execution_server::ExecutionServer,
    platform::Property,
};
use protos::google::longrunning::{Operation, operation, operations_server::OperationsServer};
use protos::google::rpc::Code;
use storage::{CacheStore, CacheStoreSettings, Compression, ContentDigest, DigestFn, StoreBackend};

use crate::{Config, ExecutionService, OperationsService, Scheduler, WorkerSessions};

/// Long enough for anything here to happen.
const PATIENCE: Duration = Duration::from_secs(10);

struct Server {
    channel: Channel,
    store: Arc<CacheStore>,
    _stop: oneshot::Sender<()>,
}

async fn start() -> Server {
    let store = Arc::new(
        CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
            .await
            .expect("open store"),
    );
    let scheduler = Scheduler::new(Config::default());
    let routes = tonic::service::Routes::new(ExecutionServer::new(ExecutionService::new(
        scheduler.clone(),
        store.clone(),
    )))
    .add_service(OperationsServer::new(OperationsService::new(
        scheduler.clone(),
    )))
    .add_service(SchedulerServer::new(WorkerSessions::new(
        scheduler,
        store.clone(),
    )))
    .prepare();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("address");
    let (stop, stopped) = oneshot::channel::<()>();
    tokio::spawn(dial9_tonic::serve_traced(
        listener,
        routes,
        dial9::Dial9TokioHandle::disabled(),
        async move {
            let _ = stopped.await;
        },
    ));
    let channel = Endpoint::from_shared(format!("http://{addr}"))
        .expect("endpoint")
        .connect()
        .await
        .expect("connect");
    Server {
        channel,
        store,
        _stop: stop,
    }
}

async fn put(store: &CacheStore, data: impl Into<Bytes>) -> Digest {
    let data = data.into();
    let cd = ContentDigest::compute(DigestFn::Sha256, &data);
    let digest = Digest {
        hash: hex::encode(cd.hash),
        size_bytes: data.len() as i64,
    };
    store
        .cas_put_blob(&cd, data, Compression::Identity)
        .await
        .expect("put");
    digest
}

/// Store an action running `argv` on `arch`, and return its digest.
async fn action(store: &CacheStore, argv: &[&str], arch: &str) -> Digest {
    let command = Command {
        arguments: argv.iter().map(|a| a.to_string()).collect(),
        ..Default::default()
    };
    let action = Action {
        command_digest: Some(put(store, command.encode_to_vec()).await),
        input_root_digest: Some(put(store, Directory::default().encode_to_vec()).await),
        platform: Some(Platform {
            properties: vec![Property {
                name: "Arch".into(),
                value: arch.into(),
            }],
        }),
        ..Default::default()
    };
    put(store, action.encode_to_vec()).await
}

async fn execute(channel: &Channel, action: &Digest) -> Streaming<Operation> {
    ExecutionClient::new(channel.clone())
        .execute(ExecuteRequest {
            action_digest: Some(action.clone()),
            digest_function: 1,
            ..Default::default()
        })
        .await
        .expect("execute")
        .into_inner()
}

/// Read operations until one is done, and return its response.
async fn completion(stream: &mut Streaming<Operation>) -> (String, ExecuteResponse) {
    loop {
        let op = tokio::time::timeout(PATIENCE, stream.message())
            .await
            .expect("in time")
            .expect("a message")
            .expect("not the end yet");
        if !op.done {
            continue;
        }
        let Some(operation::Result::Response(any)) = op.result else {
            panic!("a response");
        };
        return (
            op.name,
            ExecuteResponse::decode(any.value.as_slice()).expect("decode"),
        );
    }
}

struct FakeWorker {
    to_scheduler: mpsc::Sender<WorkerMessage>,
    from_scheduler: Streaming<SchedulerMessage>,
}

impl FakeWorker {
    async fn connect(channel: &Channel, arch: &str) -> Self {
        let (to_scheduler, rx) = mpsc::channel(16);
        to_scheduler
            .send(WorkerMessage {
                message: Some(worker_message::Message::Hello(Hello {
                    name: format!("fake-{arch}"),
                    properties: vec![Property {
                        name: "Arch".into(),
                        value: arch.into(),
                    }],
                    slots: 1,
                    version: "test".into(),
                })),
            })
            .await
            .expect("hello");
        let from_scheduler = SchedulerClient::new(channel.clone())
            .session(ReceiverStream::new(rx))
            .await
            .expect("session")
            .into_inner();
        Self {
            to_scheduler,
            from_scheduler,
        }
    }

    async fn next(&mut self) -> scheduler_message::Message {
        tokio::time::timeout(PATIENCE, self.from_scheduler.message())
            .await
            .expect("in time")
            .expect("a message")
            .expect("not the end")
            .message
            .expect("a message")
    }

    async fn finish(&self, operation: &str, response: ExecuteResponse) {
        self.to_scheduler
            .send(WorkerMessage {
                message: Some(worker_message::Message::Finished(Finished {
                    operation: operation.to_string(),
                    response: Some(response),
                })),
            })
            .await
            .expect("finished");
    }
}

fn exited(code: i32, stdout: Option<Digest>) -> ExecuteResponse {
    ExecuteResponse {
        result: Some(ActionResult {
            exit_code: code,
            stdout_digest: stdout,
            ..Default::default()
        }),
        status: Some(Default::default()),
        ..Default::default()
    }
}

#[tokio::test]
async fn an_action_runs_on_a_worker_and_its_result_is_cached() {
    let server = start().await;
    let mut worker = FakeWorker::connect(&server.channel, "amd64").await;
    let digest = action(&server.store, &["echo", "hi"], "amd64").await;
    let mut client = execute(&server.channel, &digest).await;

    let scheduler_message::Message::Assign(assign) = worker.next().await else {
        panic!("an assignment");
    };
    assert_eq!(assign.action_digest.as_ref(), Some(&digest));
    assert_eq!(assign.command.unwrap().arguments, ["echo", "hi"]);
    // The worker uploads its outputs before reporting.
    let stdout = put(&server.store, "hi\n").await;
    worker
        .finish(&assign.operation, exited(0, Some(stdout.clone())))
        .await;

    let (name, response) = completion(&mut client).await;
    assert_eq!(name, assign.operation);
    assert!(!response.cached_result);
    assert_eq!(response.result.unwrap().stdout_digest, Some(stdout.clone()));

    // The result is cached now.
    let (_, response) = completion(&mut execute(&server.channel, &digest).await).await;
    assert!(response.cached_result);
    assert_eq!(response.result.unwrap().stdout_digest, Some(stdout));
}

#[tokio::test]
async fn failures_are_not_cached() {
    let server = start().await;
    let mut worker = FakeWorker::connect(&server.channel, "amd64").await;
    let digest = action(&server.store, &["false"], "amd64").await;
    for _ in 0..2 {
        let mut client = execute(&server.channel, &digest).await;
        let scheduler_message::Message::Assign(assign) = worker.next().await else {
            panic!("an assignment, both times");
        };
        worker.finish(&assign.operation, exited(1, None)).await;
        let (_, response) = completion(&mut client).await;
        assert_eq!(response.result.unwrap().exit_code, 1);
    }
}

#[tokio::test]
async fn an_action_missing_from_the_cas_is_a_failed_precondition() {
    let server = start().await;
    let status = ExecutionClient::new(server.channel.clone())
        .execute(ExecuteRequest {
            action_digest: Some(Digest {
                hash: "0".repeat(64),
                size_bytes: 1,
            }),
            digest_function: 1,
            ..Default::default()
        })
        .await
        .expect_err("refused");
    assert_eq!(status.code(), tonic::Code::FailedPrecondition, "{status}");
}

#[tokio::test]
async fn a_client_that_goes_away_cancels_its_action() {
    let server = start().await;
    let mut worker = FakeWorker::connect(&server.channel, "amd64").await;
    let digest = action(&server.store, &["sleep", "1000"], "amd64").await;
    let client = execute(&server.channel, &digest).await;
    let scheduler_message::Message::Assign(assign) = worker.next().await else {
        panic!("an assignment");
    };

    drop(client);
    let scheduler_message::Message::Cancel(cancel) = worker.next().await else {
        panic!("a cancellation");
    };
    assert_eq!(cancel.operation, assign.operation);
}

#[tokio::test]
async fn wait_execution_follows_an_operation() {
    let server = start().await;
    let mut worker = FakeWorker::connect(&server.channel, "amd64").await;
    let digest = action(&server.store, &["true"], "amd64").await;
    let mut client = execute(&server.channel, &digest).await;
    let first = client.message().await.expect("ok").expect("a message");

    let mut waiter = ExecutionClient::new(server.channel.clone())
        .wait_execution(WaitExecutionRequest {
            name: first.name.clone(),
        })
        .await
        .expect("wait")
        .into_inner();
    let scheduler_message::Message::Assign(assign) = worker.next().await else {
        panic!("an assignment");
    };
    worker.finish(&assign.operation, exited(0, None)).await;
    assert_eq!(completion(&mut waiter).await.0, first.name);
    assert_eq!(completion(&mut client).await.0, first.name);
}

#[tokio::test]
async fn a_worker_that_goes_away_hands_its_action_to_another() {
    let server = start().await;
    let mut first = FakeWorker::connect(&server.channel, "amd64").await;
    let digest = action(&server.store, &["true"], "amd64").await;
    let mut client = execute(&server.channel, &digest).await;
    let scheduler_message::Message::Assign(assign) = first.next().await else {
        panic!("an assignment");
    };
    drop(first);

    let mut second = FakeWorker::connect(&server.channel, "amd64").await;
    let scheduler_message::Message::Assign(again) = second.next().await else {
        panic!("the same assignment");
    };
    assert_eq!(again.operation, assign.operation);
    second.finish(&again.operation, exited(0, None)).await;
    let (_, response) = completion(&mut client).await;
    assert_eq!(
        response.status.map(|s| s.code),
        Some(Code::Ok as i32),
        "completed normally"
    );
}
