// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A worker's session with the scheduler, and each action it runs.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use anyhow::{Context as _, Result, bail};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;

use gonzo_protos::worker::v1::{
    Assign, Finished, Hello, SchedulerMessage, WorkerMessage, scheduler_client::SchedulerClient,
    scheduler_message, worker_message,
};
use protos::build::bazel::remote::execution::v2::{
    ActionResult, ExecuteResponse, ExecutedActionMetadata, platform::Property,
};
use protos::google::rpc::{Code, Status};

use crate::cache::FileCache;
use crate::cas::{Cas, Missing};
use crate::digest::DigestFunction;
use crate::inputs::Inputs;
use crate::outputs;
use crate::runner::{self, Outcome, SpawnError};

/// How a worker presents itself and runs actions.
#[derive(Clone, Debug)]
pub struct Config {
    /// How it appears in logs and in each result's metadata.
    pub name: String,
    /// What it offers; see [`host_properties`].
    pub properties: Vec<Property>,
    /// How many actions it runs at once.
    pub slots: usize,
    /// Where it keeps its file cache (`files/`) and lays out actions
    /// (`builds/`).
    pub dir: PathBuf,
    /// The timeout of an action that sets none.
    pub default_timeout: Duration,
    /// The longest timeout an action may set.
    pub max_timeout: Duration,
}

/// The properties of this machine as Buck names them (see
/// `buck/platforms/defs.bzl`): `OSFamily` as Bazel spells it, `Arch` as Go
/// and OCI do, and `container-image=host`, since actions run on the machine
/// as it is rather than in an image.
pub fn host_properties() -> Vec<Property> {
    let os = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "Darwin",
        "windows" => "Windows",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    [
        ("OSFamily", os),
        ("Arch", arch),
        ("container-image", "host"),
    ]
    .into_iter()
    .map(|(name, value)| Property {
        name: name.to_string(),
        value: value.to_string(),
    })
    .collect()
}

/// See the module documentation.
pub struct Worker {
    config: Config,
    scheduler: SchedulerClient<Channel>,
    cas: Cas,
    inputs: Inputs,
    builds: PathBuf,
    next_build: AtomicU64,
    /// Held for the worker's life, so two workers never share a directory.
    _lock: std::fs::File,
}

impl Worker {
    /// A worker reaching the daemon over `channel`. Claims `config.dir`,
    /// clearing out anything an earlier worker left mid-action.
    pub fn new(channel: Channel, config: Config) -> Result<Self> {
        std::fs::create_dir_all(&config.dir)
            .with_context(|| format!("creating {}", config.dir.display()))?;
        let lock = std::fs::File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(config.dir.join("worker.lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                bail!("another worker is using {}", config.dir.display())
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
        }
        let builds = config.dir.join("builds");
        if builds.exists() {
            remove_tree(&builds).with_context(|| format!("clearing {}", builds.display()))?;
        }
        std::fs::create_dir_all(&builds)?;
        let files = Arc::new(FileCache::open(&config.dir.join("files"))?);
        let cas = Cas::new(channel.clone(), "");
        Ok(Self {
            scheduler: SchedulerClient::new(channel),
            inputs: Inputs::new(cas.clone(), files),
            cas,
            builds,
            next_build: AtomicU64::new(0),
            config,
            _lock: lock,
        })
    }

    /// Take actions from the scheduler until the session ends or `shutdown`
    /// resolves. Actions still running then are stopped.
    pub async fn serve(self: &Arc<Self>, shutdown: impl Future<Output = ()>) -> Result<()> {
        let (to_scheduler, rx) = mpsc::channel(64);
        to_scheduler
            .send(message(worker_message::Message::Hello(Hello {
                name: self.config.name.clone(),
                properties: self.config.properties.clone(),
                slots: self.config.slots as u32,
                version: option_env!("depot_VERSION").unwrap_or("dev").to_string(),
            })))
            .await?;
        let mut from_scheduler = self
            .scheduler
            .clone()
            .session(ReceiverStream::new(rx))
            .await
            .context("starting a session with the scheduler")?
            .into_inner();
        tracing::info!(worker = %self.config.name, slots = self.config.slots, "serving the scheduler");

        // Dropping an action's sender cancels it.
        let mut running: HashMap<String, oneshot::Sender<()>> = HashMap::new();
        let mut tasks = tokio::task::JoinSet::new();
        let (done_tx, mut done) = mpsc::unbounded_channel::<(String, ExecuteResponse)>();
        tokio::pin!(shutdown);
        let ended = loop {
            tokio::select! {
                message = from_scheduler.message() => match message {
                    Ok(Some(SchedulerMessage { message: Some(scheduler_message::Message::Assign(assign)) })) => {
                        let (cancel, cancelled) = oneshot::channel();
                        running.insert(assign.operation.clone(), cancel);
                        let (worker, done_tx) = (self.clone(), done_tx.clone());
                        tasks.spawn(async move {
                            let operation = assign.operation.clone();
                            let response = worker.execute(assign, async { let _ = cancelled.await; }).await;
                            let _ = done_tx.send((operation, response));
                        });
                    }
                    Ok(Some(SchedulerMessage { message: Some(scheduler_message::Message::Cancel(cancel)) })) => {
                        if let Some(cancel) = running.remove(&cancel.operation) {
                            let _ = cancel.send(());
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => break Ok(()),
                    Err(status) => break Err(anyhow::Error::from(status).context("the session with the scheduler failed")),
                },
                Some((operation, response)) = done.recv() => {
                    running.remove(&operation);
                    let finished = worker_message::Message::Finished(Finished {
                        operation,
                        response: Some(response),
                    });
                    if to_scheduler.send(message(finished)).await.is_err() {
                        break Ok(());
                    }
                }
                () = &mut shutdown => break Ok(()),
            }
        };
        drop(running);
        while tasks.join_next().await.is_some() {}
        ended
    }

    /// Run one action, and say how it went.
    async fn execute(
        &self,
        assign: Assign,
        cancelled: impl Future<Output = ()>,
    ) -> ExecuteResponse {
        let build = self
            .builds
            .join(self.next_build.fetch_add(1, Ordering::Relaxed).to_string());
        let response = match self.try_execute(&assign, &build, cancelled).await {
            Ok(response) => response,
            Err(e) => {
                let code = if e.downcast_ref::<Missing>().is_some() {
                    Code::FailedPrecondition
                } else if e.downcast_ref::<SpawnError>().is_some() {
                    Code::InvalidArgument
                } else {
                    Code::Internal
                };
                tracing::debug!(operation = %assign.operation, "action failed: {e:#}");
                ExecuteResponse {
                    status: Some(Status {
                        code: code as i32,
                        message: format!("{e:#}"),
                        details: Vec::new(),
                    }),
                    ..Default::default()
                }
            }
        };
        let _ = tokio::task::spawn_blocking(move || remove_tree(&build)).await;
        response
    }

    async fn try_execute(
        &self,
        assign: &Assign,
        build: &Path,
        cancelled: impl Future<Output = ()>,
    ) -> Result<ExecuteResponse> {
        let mut metadata = ExecutedActionMetadata {
            worker: self.config.name.clone(),
            queued_timestamp: assign.queued,
            worker_start_timestamp: Some(now()),
            ..Default::default()
        };
        let function = DigestFunction::from_proto(assign.digest_function)
            .with_context(|| format!("unsupported digest function {}", assign.digest_function))?;
        let action = assign
            .action
            .as_ref()
            .context("the assignment has no action")?;
        let command = assign
            .command
            .as_ref()
            .context("the assignment has no command")?;
        let input_root = action
            .input_root_digest
            .as_ref()
            .context("the action has no input root")?;

        let root = build.join("root");
        std::fs::create_dir_all(&root)?;
        metadata.input_fetch_start_timestamp = Some(now());
        self.inputs.materialize(function, input_root, &root).await?;
        metadata.input_fetch_completed_timestamp = Some(now());

        let working_directory = Path::new(&command.working_directory);
        if !working_directory
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        {
            bail!(
                "working directory {:?} is not inside the input root",
                command.working_directory
            );
        }
        let working_directory = root.join(working_directory);
        std::fs::create_dir_all(&working_directory)?;
        outputs::prepare(command, &working_directory)?;

        let timeout = action
            .timeout
            .and_then(|t| Duration::try_from(t).ok())
            .filter(|t| !t.is_zero())
            .unwrap_or(self.config.default_timeout)
            .min(self.config.max_timeout);
        let environment: Vec<(String, String)> = command
            .environment_variables
            .iter()
            .map(|v| (v.name.clone(), v.value.clone()))
            .collect();
        let (stdout, stderr) = (build.join("stdout"), build.join("stderr"));
        metadata.execution_start_timestamp = Some(now());
        let outcome = runner::run(
            &runner::Spec {
                arguments: &command.arguments,
                environment: &environment,
                working_directory: &working_directory,
                stdout: &stdout,
                stderr: &stderr,
                timeout,
            },
            cancelled,
        )
        .await?;
        metadata.execution_completed_timestamp = Some(now());

        let (exit_code, status) = match outcome {
            Outcome::Exited(code) => (code, Status::default()),
            Outcome::TimedOut => (
                128 + libc::SIGKILL,
                Status {
                    code: Code::DeadlineExceeded as i32,
                    message: format!("the action ran past its timeout of {}s", timeout.as_secs()),
                    details: Vec::new(),
                },
            ),
            Outcome::Cancelled => {
                return Ok(ExecuteResponse {
                    status: Some(Status {
                        code: Code::Cancelled as i32,
                        message: "the action was cancelled".to_string(),
                        details: Vec::new(),
                    }),
                    ..Default::default()
                });
            }
        };

        metadata.output_upload_start_timestamp = Some(now());
        // A timed-out action's outputs are not worth anything; its output
        // streams say what it was doing.
        let produced = if outcome == Outcome::TimedOut {
            outputs::Produced::default()
        } else {
            outputs::upload(&self.cas, function, command, &working_directory).await?
        };
        let stdout_digest = outputs::upload_file(&self.cas, function, &stdout).await?;
        let stderr_digest = outputs::upload_file(&self.cas, function, &stderr).await?;
        metadata.output_upload_completed_timestamp = Some(now());
        metadata.worker_completed_timestamp = Some(now());

        Ok(ExecuteResponse {
            result: Some(ActionResult {
                output_files: produced.files,
                output_directories: produced.directories,
                output_symlinks: produced.symlinks,
                exit_code,
                stdout_digest: Some(stdout_digest),
                stderr_digest: Some(stderr_digest),
                execution_metadata: Some(metadata),
                ..Default::default()
            }),
            status: Some(status),
            ..Default::default()
        })
    }
}

fn message(message: worker_message::Message) -> WorkerMessage {
    WorkerMessage {
        message: Some(message),
    }
}

fn now() -> prost_types::Timestamp {
    SystemTime::now().into()
}

/// Remove `path` and everything under it, even directories an action made
/// read-only.
fn remove_tree(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => {
            make_writable(path);
            std::fs::remove_dir_all(path)
        }
    }
}

fn make_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.is_dir() {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                make_writable(&entry.path());
            }
        }
    }
}
