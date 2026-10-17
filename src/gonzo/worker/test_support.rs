// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A daemon for the worker to talk to, in process: its CAS and its
//! scheduler.

use gonzo_protos::worker::v1::scheduler_server::SchedulerServer;
use protos::build::bazel::remote::execution::v2::execution_server::ExecutionServer;

use crate::cas::Cas;

pub struct Daemon(gonzo_testing::Daemon);

impl Daemon {
    pub async fn start() -> Self {
        Self(
            gonzo_testing::Daemon::start(|routes, store| {
                let scheduler = scheduler::Scheduler::new(scheduler::Config::default());
                routes
                    .add_service(ExecutionServer::new(scheduler::ExecutionService::new(
                        scheduler.clone(),
                        store.clone(),
                    )))
                    .add_service(SchedulerServer::new(scheduler::WorkerSessions::new(
                        scheduler,
                        store.clone(),
                    )))
            })
            .await,
        )
    }

    pub fn cas(&self) -> Cas {
        Cas::new(self.channel.clone())
    }
}

impl std::ops::Deref for Daemon {
    type Target = gonzo_testing::Daemon;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
