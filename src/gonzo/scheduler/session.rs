// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! `gonzo.worker.v1.Scheduler`: worker sessions, and recording what workers
//! report in the action cache.

use std::pin::Pin;
use std::sync::Arc;

use futures::{Stream, StreamExt as _};
use prost::Message as _;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use gonzo_protos::worker::v1::{
    SchedulerMessage, WorkerMessage, scheduler_server, worker_message::Message,
};
use protos::build::bazel::remote::execution::v2::ExecuteResponse;
use protos::google::rpc::Code;
use storage::CacheStore;

use crate::scheduler::{Job, Scheduler, failure};

/// Serves worker sessions for a [`Scheduler`].
#[derive(Clone, Debug)]
pub struct WorkerSessions {
    scheduler: Scheduler,
    store: Arc<CacheStore>,
}

impl WorkerSessions {
    pub fn new(scheduler: Scheduler, store: Arc<CacheStore>) -> Self {
        Self { scheduler, store }
    }
}

type SessionStream = Pin<Box<dyn Stream<Item = Result<SchedulerMessage, Status>> + Send>>;

#[tonic::async_trait]
impl scheduler_server::Scheduler for WorkerSessions {
    type SessionStream = SessionStream;

    async fn session(
        &self,
        request: Request<Streaming<WorkerMessage>>,
    ) -> Result<Response<SessionStream>, Status> {
        let mut from_worker = request.into_inner();
        let hello = match from_worker.message().await? {
            Some(WorkerMessage {
                message: Some(Message::Hello(hello)),
            }) => hello,
            _ => {
                return Err(Status::invalid_argument(
                    "a worker session starts with Hello",
                ));
            }
        };
        let (id, to_worker) = self.scheduler.connect(&hello);

        let (scheduler, store) = (self.scheduler.clone(), self.store.clone());
        tokio::spawn(async move {
            loop {
                match from_worker.message().await {
                    Ok(Some(WorkerMessage {
                        message: Some(Message::Finished(finished)),
                    })) => {
                        let response = finished.response.unwrap_or_else(|| {
                            failure(Code::Internal, "the worker reported no response")
                        });
                        if let Some(job) = scheduler.assigned(id, &finished.operation) {
                            record(&store, &job, &response).await;
                        }
                        scheduler.finished(id, &finished.operation, response);
                    }
                    Ok(Some(_)) => {
                        tracing::warn!(worker = %hello.name, "ignoring an unexpected message");
                    }
                    Ok(None) => break,
                    Err(status) => {
                        tracing::debug!(worker = %hello.name, %status, "worker session failed");
                        break;
                    }
                }
            }
            // Which also ends the stream to the worker, by dropping its
            // sender.
            scheduler.disconnect(id);
        });

        Ok(Response::new(Box::pin(
            UnboundedReceiverStream::new(to_worker).map(Ok),
        )))
    }
}

/// Record `response` as the action's result in the action cache, if it
/// succeeded, may be cached, and its outputs are all stored.
///
/// Only the scheduler writes results that workers report, and only for the
/// actions it gave them.
async fn record(store: &CacheStore, job: &Job, response: &ExecuteResponse) {
    let Some(result) = &response.result else {
        return;
    };
    let ok = response.status.as_ref().is_none_or(|s| s.code == 0);
    if !ok || result.exit_code != 0 || !job.cacheable() {
        return;
    }
    let Ok(digest_fn) = api::resolve_digest_function(job.digest_function) else {
        return;
    };
    let Ok(action) = api::parse_and_validate_digest_ref(&job.action_digest, digest_fn) else {
        return;
    };
    let hash = &job.action_digest.hash;
    match api::outputs_stored(store, digest_fn, result).await {
        Ok(true) => {
            if let Err(e) = store.ac_put(&action, result.encode_to_vec().into()).await {
                tracing::warn!(action = %hash, "failed to record the action's result: {e}");
            }
        }
        Ok(false) => {
            tracing::warn!(action = %hash, "not caching a result whose outputs are not all stored");
        }
        Err(status) => {
            tracing::warn!(action = %hash, "failed to check the result's outputs: {status}");
        }
    }
}
