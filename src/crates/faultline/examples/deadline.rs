// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Injecting latency to exercise a client-side deadline.
//!
//! `hit_async` sleeps on the Tokio timer, so a slow request never blocks the
//! executor. The runtime starts with a paused clock: the injected delays cost
//! no wall-clock time, and the ordering of timeouts is exact.

use std::time::Duration;

use faultline::{Action, Injector, Point};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Clone, Debug)]
struct Backend {
    before_reply: Point<()>,
}

impl Backend {
    async fn fetch(&self) -> &'static str {
        faultline::fail_point_async!(self.before_reply);
        "fresh"
    }
}

/// Serves a cached value if the backend misses the deadline.
async fn fetch_or_cached(backend: &Backend, deadline: Duration) -> &'static str {
    tokio::time::timeout(deadline, backend.fetch())
        .await
        .unwrap_or("cached")
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    runtime.block_on(async {
        let faults = Injector::new();
        let backend = Backend {
            before_reply: faults.point("backend.reply.before"),
        };
        let deadline = Duration::from_millis(100);

        // Alternate slow and fast replies; `or_else` falls through to `off`
        // once the slow rule's budget is spent.
        let plan = Action::Sleep(Duration::from_secs(1))
            .times(2)
            .or_else(Action::Off);
        let _guard = backend.before_reply.scoped(plan).unwrap();

        let started = tokio::time::Instant::now();
        let mut replies = Vec::new();
        for request in 1..=3 {
            let reply = fetch_or_cached(&backend, deadline).await;
            println!("request {request}: {reply} at {:?}", started.elapsed());
            replies.push(reply);
        }
        assert_eq!(replies, ["cached", "cached", "fresh"]);
        assert_eq!(backend.before_reply.snapshot().triggered, 3);
    });
}
