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
    Action, ActionResult, Command, ExecuteResponse, ExecutedActionMetadata, platform::Property,
};
use protos::google::rpc::{Code, Status};

use crate::cache::FileCache;
use crate::cas::{Cas, Missing};
use crate::cgroup::Cgroups;
use crate::digest::DigestFunction;
use crate::inputs::Inputs;
use crate::outputs;
use crate::runner::{self, Outcome, SpawnError};
use crate::sandbox::EmptyRoot;

/// How a worker presents itself and runs actions.
#[derive(Clone, Debug)]
pub struct Config {
    /// How it appears in logs and in each result's metadata.
    pub name: String,
    /// What it offers; see [`offered_properties`].
    pub properties: Vec<Property>,
    /// How many actions it runs at once.
    pub slots: usize,
    /// Where it keeps its file cache (`files/`) and lays out actions
    /// (`builds/`).
    pub dir: PathBuf,
    /// Most bytes of input files to keep in the file cache.
    pub cache_bytes: u64,
    /// The environment of the "image" actions run in: variables each action
    /// gets unless its command sets them. See [`host_environment`].
    pub base_environment: Vec<(String, String)>,
    /// The timeout of an action that sets none.
    pub default_timeout: Duration,
    /// The longest timeout an action may set.
    pub max_timeout: Duration,
}

/// The environment an action on this machine starts from, as a container
/// image's would: the worker's own `PATH`, so that a command named without
/// a path (Buck's system toolchains name `rustc`, say) is found where the
/// worker would find it, as it is when Buck runs the action locally. That
/// is what `container-image=host` promises; an action that should not
/// depend on the machine's tools sets its own `PATH`.
pub fn host_environment() -> Vec<(String, String)> {
    std::env::var("PATH")
        .map(|path| vec![("PATH".to_string(), path)])
        .unwrap_or_default()
}

/// This machine's host name, if the kernel says.
pub fn host_name() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|name| name.trim().to_string())
}

/// What a worker on this machine offers: its [`host_properties`], and
/// `container-image=empty` too where it can run actions in an empty root
/// (see [`sandbox`](crate::sandbox)).
pub fn offered_properties() -> Vec<Property> {
    let mut properties = host_properties();
    if crate::sandbox::supported() {
        properties.push(Property {
            name: "container-image".to_string(),
            value: crate::sandbox::EMPTY.to_string(),
        });
    }
    properties
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
    inputs: Inputs,
    builds: PathBuf,
    next_build: AtomicU64,
    /// Where actions' cgroups go, if the worker can make them.
    cgroups: Option<Cgroups>,
    /// Held for the worker's life, so two workers never share a directory.
    _lock: std::fs::File,
}

impl Worker {
    /// A worker as `config` says. Claims `config.dir`, clearing out
    /// anything an earlier worker left mid-action.
    pub fn new(config: Config) -> Result<Self> {
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
        let files = Arc::new(FileCache::open(
            &config.dir.join("files"),
            config.cache_bytes,
        )?);
        let cgroups = Cgroups::new();
        match &cgroups {
            Some(cgroups) => tracing::info!(
                cgroups = %cgroups.dir().display(),
                "actions run in cgroups of their own"
            ),
            None => {
                tracing::info!("actions run in process groups; this process cannot make cgroups")
            }
        }
        Ok(Self {
            inputs: Inputs::new(files),
            builds,
            next_build: AtomicU64::new(0),
            cgroups,
            config,
            _lock: lock,
        })
    }

    /// Take actions from the scheduler at the other end of `channel` until
    /// the session ends or `shutdown` resolves. Actions still running then
    /// are stopped. A worker may serve one session after another, keeping
    /// its caches.
    pub async fn serve(
        self: &Arc<Self>,
        channel: Channel,
        shutdown: impl Future<Output = ()>,
    ) -> Result<()> {
        let cas = Cas::new(channel.clone());
        let (to_scheduler, rx) = mpsc::channel(64);
        to_scheduler
            .send(message(worker_message::Message::Hello(Hello {
                name: self.config.name.clone(),
                properties: self.config.properties.clone(),
                slots: self.config.slots as u32,
                version: option_env!("depot_VERSION").unwrap_or("dev").to_string(),
            })))
            .await?;
        let mut from_scheduler = SchedulerClient::new(channel)
            .session(ReceiverStream::new(rx))
            .await
            .context("starting a session with the scheduler")?
            .into_inner();
        tracing::info!(worker = %self.config.name, slots = self.config.slots, "serving the scheduler");

        // Dropping an action's sender cancels it.
        let mut running: HashMap<String, oneshot::Sender<()>> = HashMap::new();
        let mut tasks = tokio::task::JoinSet::new();
        tokio::pin!(shutdown);
        let ended = loop {
            tokio::select! {
                message = from_scheduler.message() => match message {
                    Ok(Some(SchedulerMessage { message: Some(scheduler_message::Message::Assign(assign)) })) => {
                        let (cancel, cancelled) = oneshot::channel();
                        running.insert(assign.operation.clone(), cancel);
                        let (worker, cas) = (self.clone(), cas.clone());
                        tasks.spawn(async move {
                            let operation = assign.operation.clone();
                            let response = worker.execute(&cas, assign, async { let _ = cancelled.await; }).await;
                            (operation, response)
                        });
                    }
                    Ok(Some(SchedulerMessage { message: Some(scheduler_message::Message::Cancel(cancel)) })) => {
                        running.remove(&cancel.operation);
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => break Ok(()),
                    Err(status) => break Err(anyhow::Error::from(status).context("the session with the scheduler failed")),
                },
                Some(joined) = tasks.join_next() => {
                    let (operation, response) = match joined {
                        Ok(done) => done,
                        Err(e) => {
                            tracing::error!("an action's task failed: {e}");
                            continue;
                        }
                    };
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
        cas: &Cas,
        assign: Assign,
        cancelled: impl Future<Output = ()>,
    ) -> ExecuteResponse {
        let number = self.next_build.fetch_add(1, Ordering::Relaxed).to_string();
        let build = self.builds.join(&number);
        let response = match self
            .try_execute(cas, &assign, &build, &number, cancelled)
            .await
        {
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
                    status: Some(status(code, format!("{e:#}"))),
                    ..Default::default()
                }
            }
        };
        let _ = tokio::task::spawn_blocking(move || remove_tree(&build)).await;
        response
    }

    async fn try_execute(
        &self,
        cas: &Cas,
        assign: &Assign,
        build: &Path,
        number: &str,
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
        self.inputs
            .materialize(cas, function, input_root, &root)
            .await?;
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
        // An empty root has nothing of the host, its PATH included.
        let (empty_root, base_environment) = match container_image(action, command) {
            "host" => (None, &self.config.base_environment[..]),
            crate::sandbox::EMPTY => (
                Some(
                    EmptyRoot::new(&root, Path::new(&command.working_directory))
                        .context("preparing the action's empty root")?,
                ),
                &[][..],
            ),
            other => bail!("this worker cannot run actions in container-image={other}"),
        };
        let mut environment: Vec<(String, String)> = base_environment
            .iter()
            .filter(|(name, _)| {
                !command
                    .environment_variables
                    .iter()
                    .any(|v| v.name == *name)
            })
            .cloned()
            .collect();
        environment.extend(
            command
                .environment_variables
                .iter()
                .map(|v| (v.name.clone(), v.value.clone())),
        );
        let (stdout, stderr) = (build.join("stdout"), build.join("stderr"));
        let cgroup = match &self.cgroups {
            Some(cgroups) => Some(
                cgroups
                    .create(number)
                    .context("making the action's cgroup")?,
            ),
            None => None,
        };
        metadata.execution_start_timestamp = Some(now());
        let outcome = runner::run(
            &runner::Spec {
                arguments: &command.arguments,
                environment: &environment,
                working_directory: &working_directory,
                stdout: &stdout,
                stderr: &stderr,
                timeout,
                cgroup: cgroup.as_ref(),
                empty_root: empty_root.as_ref(),
            },
            cancelled,
        )
        .await?;
        drop(cgroup);
        metadata.execution_completed_timestamp = Some(now());

        let (exit_code, status) = match outcome {
            Outcome::Exited(code) => (code, Status::default()),
            Outcome::TimedOut => (
                128 + libc::SIGKILL,
                status(
                    Code::DeadlineExceeded,
                    format!("the action ran past its timeout of {}s", timeout.as_secs()),
                ),
            ),
            Outcome::Cancelled => {
                return Ok(ExecuteResponse {
                    status: Some(status(Code::Cancelled, "the action was cancelled")),
                    ..Default::default()
                });
            }
        };

        metadata.output_upload_start_timestamp = Some(now());
        // A timed-out action's outputs are not worth anything; its output
        // streams say what it was doing.
        let expected = if outcome == Outcome::TimedOut {
            Vec::new()
        } else {
            outputs::expected(command)?
        };
        let (produced, [stdout_digest, stderr_digest]) = outputs::upload(
            cas,
            function,
            expected,
            &working_directory,
            [stdout, stderr],
        )
        .await?;
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

/// The image the action asks to run in: the value of its platform's
/// `container-image`, or `host` if it names none.
fn container_image<'a>(action: &'a Action, command: &'a Command) -> &'a str {
    // Command.platform is deprecated in favour of Action.platform, but
    // older clients only set the one.
    #[allow(deprecated)]
    let platform = action.platform.as_ref().or(command.platform.as_ref());
    platform
        .and_then(|p| p.properties.iter().find(|p| p.name == "container-image"))
        .map_or("host", |p| p.value.as_str())
}

fn message(message: worker_message::Message) -> WorkerMessage {
    WorkerMessage {
        message: Some(message),
    }
}

fn status(code: Code, message: impl Into<String>) -> Status {
    Status {
        code: code as i32,
        message: message.into(),
        details: Vec::new(),
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
