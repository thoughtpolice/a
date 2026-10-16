// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The REAPI Execution and Operations services, over the [`Scheduler`].

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use prost::Message as _;
use tonic::{Request, Response, Status};

use protos::build::bazel::remote::execution::v2::{
    Action, ActionResult, Command, Digest, ExecuteOperationMetadata, ExecuteRequest,
    ExecuteResponse, WaitExecutionRequest, execution_server, execution_stage,
};
use protos::google::longrunning::{
    CancelOperationRequest, DeleteOperationRequest, GetOperationRequest, ListOperationsRequest,
    ListOperationsResponse, Operation, WaitOperationRequest, operation, operations_server,
};
use storage::{CacheStore, ContentDigest, DigestFn};

use crate::platform::Requirements;
use crate::scheduler::{Job, Scheduler, Stage, Subscription};

/// How often an operation's stream repeats its stage when nothing has
/// changed, so that a long execution never looks like an idle stream.
const KEEPALIVE: Duration = Duration::from_secs(30);

type OperationStream = Pin<Box<dyn Stream<Item = Result<Operation, Status>> + Send>>;

/// `build.bazel.remote.execution.v2.Execution`.
#[derive(Clone, Debug)]
pub struct ExecutionService {
    scheduler: Scheduler,
    store: Arc<CacheStore>,
}

impl ExecutionService {
    pub fn new(scheduler: Scheduler, store: Arc<CacheStore>) -> Self {
        Self { scheduler, store }
    }
}

#[tonic::async_trait]
impl execution_server::Execution for ExecutionService {
    type ExecuteStream = OperationStream;

    #[tracing::instrument(skip(self, request))]
    async fn execute(
        &self,
        request: Request<ExecuteRequest>,
    ) -> Result<Response<OperationStream>, Status> {
        let (scheduler, store) = (self.scheduler.clone(), self.store.clone());
        api::instrumented_rpc("execution.execute", async move {
            let request = request.into_inner();
            let digest_fn = api::resolve_digest_function(request.digest_function)?;
            let action_cd = api::parse_and_validate_digest(&request.action_digest, digest_fn)?;
            let action_digest = request.action_digest.expect("validated above");

            if !request.skip_cache_lookup
                && let Some(result) = cached(&store, digest_fn, &action_cd).await?
            {
                let name = format!("operations/{}", uuid::Uuid::new_v4());
                let response = ExecuteResponse {
                    result: Some(result),
                    cached_result: true,
                    status: Some(Default::default()),
                    ..Default::default()
                };
                let stage = Stage::Completed(Arc::new(response));
                let op = operation(&name, digest_fn.to_proto_i32(), &action_digest, &stage);
                let stream: OperationStream = Box::pin(futures::stream::iter([Ok(op)]));
                return Ok(Response::new(stream));
            }

            let action: Action = read(&store, digest_fn, &action_digest, "action").await?;
            let command_digest = action
                .command_digest
                .clone()
                .ok_or_else(|| Status::invalid_argument("the action names no command"))?;
            let command: Command = read(&store, digest_fn, &command_digest, "command").await?;
            let input_root = action
                .input_root_digest
                .as_ref()
                .ok_or_else(|| Status::invalid_argument("the action names no input root"))?;
            let input_root_cd = api::parse_and_validate_digest_ref(input_root, digest_fn)?;
            if !store
                .cas_blob_exists(&input_root_cd)
                .await
                .map_err(api::store_error_to_status)?
            {
                return Err(missing("input root", input_root));
            }

            // Command.platform is deprecated in favour of Action.platform,
            // but older clients only set the one.
            #[allow(deprecated)]
            let platform = action.platform.as_ref().or(command.platform.as_ref());
            let requirements = Requirements::new(platform);
            let subscription = scheduler.submit(Job {
                digest_function: digest_fn.to_proto_i32(),
                action_digest,
                action,
                command,
                requirements,
            });
            tracing::debug!(operation = %subscription.name, "queued");
            Ok(Response::new(stream(subscription)))
        })
        .await
    }

    type WaitExecutionStream = OperationStream;

    #[tracing::instrument(skip(self, request))]
    async fn wait_execution(
        &self,
        request: Request<WaitExecutionRequest>,
    ) -> Result<Response<OperationStream>, Status> {
        let name = request.into_inner().name;
        match self.scheduler.subscribe(&name) {
            Some(subscription) => Ok(Response::new(stream(subscription))),
            None => Err(Status::not_found(format!("no operation {name}"))),
        }
    }
}

/// The action's cached result, if it has one whose outputs are all still
/// stored.
async fn cached(
    store: &CacheStore,
    digest_fn: DigestFn,
    action: &ContentDigest,
) -> Result<Option<ActionResult>, Status> {
    let Some(data) = store
        .ac_get(action)
        .await
        .map_err(api::store_error_to_status)?
    else {
        return Ok(None);
    };
    let Ok(result) = ActionResult::decode(data.as_ref()) else {
        return Ok(None);
    };
    Ok(api::outputs_stored(store, digest_fn, &result)
        .await?
        .then_some(result))
}

/// Read and decode the `what` a digest names.
async fn read<M: prost::Message + Default>(
    store: &CacheStore,
    digest_fn: DigestFn,
    digest: &Digest,
    what: &str,
) -> Result<M, Status> {
    let cd = api::parse_and_validate_digest_ref(digest, digest_fn)?;
    let data = store
        .cas_get_blob(&cd)
        .await
        .map_err(api::store_error_to_status)?
        .ok_or_else(|| missing(what, digest))?;
    M::decode(data.as_ref())
        .map_err(|e| Status::invalid_argument(format!("the {what} does not decode: {e}")))
}

/// What Execute answers when a blob it needs is not in the CAS.
fn missing(what: &str, digest: &Digest) -> Status {
    Status::failed_precondition(format!(
        "the {what} blobs/{}/{} is not in the CAS",
        digest.hash, digest.size_bytes
    ))
}

/// An operation's stages, as a client sees them: the current one at once,
/// then each change, and the current one again at least every
/// [`KEEPALIVE`], until it completes. Dropping the stream drops the
/// subscription, which cancels an operation nobody else is waiting for.
fn stream(subscription: Subscription) -> OperationStream {
    Box::pin(futures::stream::unfold(
        Some((subscription, true)),
        |state| async move {
            let (mut subscription, first) = state?;
            if !first {
                tokio::select! {
                    changed = subscription.stages.changed() => {
                        if changed.is_err() {
                            let gone = Status::unavailable("the scheduler stopped");
                            return Some((Err(gone), None));
                        }
                    }
                    () = tokio::time::sleep(KEEPALIVE) => {}
                }
            }
            let stage = subscription.stages.borrow_and_update().clone();
            let job = &subscription.job;
            let op = operation(
                &subscription.name,
                job.digest_function,
                &job.action_digest,
                &stage,
            );
            let next = (!stage.is_completed()).then_some((subscription, false));
            Some((Ok(op), next))
        },
    ))
}

/// An operation as REAPI describes one.
fn operation(name: &str, digest_function: i32, action_digest: &Digest, stage: &Stage) -> Operation {
    use execution_stage::Value;
    let (value, result) = match stage {
        Stage::Queued => (Value::Queued, None),
        Stage::Executing => (Value::Executing, None),
        Stage::Completed(response) => (
            Value::Completed,
            Some(operation::Result::Response(any(
                "ExecuteResponse",
                response.as_ref(),
            ))),
        ),
    };
    let metadata = ExecuteOperationMetadata {
        stage: value as i32,
        action_digest: Some(action_digest.clone()),
        digest_function,
        ..Default::default()
    };
    Operation {
        name: name.to_string(),
        metadata: Some(any("ExecuteOperationMetadata", &metadata)),
        done: result.is_some(),
        result,
    }
}

fn any(message: &str, value: &impl prost::Message) -> prost_types::Any {
    prost_types::Any {
        type_url: format!("type.googleapis.com/build.bazel.remote.execution.v2.{message}"),
        value: value.encode_to_vec(),
    }
}

/// `google.longrunning.Operations`, for looking up and cancelling
/// executions by name.
#[derive(Clone, Debug)]
pub struct OperationsService {
    scheduler: Scheduler,
}

impl OperationsService {
    pub fn new(scheduler: Scheduler) -> Self {
        Self { scheduler }
    }
}

#[tonic::async_trait]
impl operations_server::Operations for OperationsService {
    async fn list_operations(
        &self,
        _request: Request<ListOperationsRequest>,
    ) -> Result<Response<ListOperationsResponse>, Status> {
        Err(Status::unimplemented("list_operations is not implemented"))
    }

    async fn get_operation(
        &self,
        request: Request<GetOperationRequest>,
    ) -> Result<Response<Operation>, Status> {
        let name = request.into_inner().name;
        let (job, stage) = self
            .scheduler
            .peek(&name)
            .ok_or_else(|| Status::not_found(format!("no operation {name}")))?;
        Ok(Response::new(operation(
            &name,
            job.digest_function,
            &job.action_digest,
            &stage,
        )))
    }

    async fn delete_operation(
        &self,
        _request: Request<DeleteOperationRequest>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented("delete_operation is not implemented"))
    }

    async fn cancel_operation(
        &self,
        request: Request<CancelOperationRequest>,
    ) -> Result<Response<()>, Status> {
        let name = request.into_inner().name;
        if self.scheduler.cancel(&name) {
            Ok(Response::new(()))
        } else {
            Err(Status::not_found(format!("no operation {name}")))
        }
    }

    async fn wait_operation(
        &self,
        _request: Request<WaitOperationRequest>,
    ) -> Result<Response<Operation>, Status> {
        Err(Status::unimplemented(
            "wait_operation is not implemented; use WaitExecution",
        ))
    }
}
