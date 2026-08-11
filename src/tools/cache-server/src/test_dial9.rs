// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The dial9 recorder wiring that `main` sets up before the tokio runtime.
//!
//! The rest of the suite runs against inert handles, so without these the
//! enabled path — writer, sources, attach, drain — is only ever exercised by
//! actually running the server.

use std::{fs, path::Path, time::Duration};

use clap::Parser as _;
use dial9::{Dial9TokioHandle, RecorderTokioExt as _};

use crate::{Cli, build_recorder};

/// Parse a `Cli` the way the binary would, with only the flags a test cares
/// about set, so the defaults stay wired through clap rather than duplicated.
fn cli(args: &[&str]) -> Cli {
    let mut argv = vec!["buck2-cache-server"];
    argv.extend_from_slice(args);
    Cli::try_parse_from(&argv).expect("parse test CLI")
}

/// Sealed segment files in `dir`.
///
/// dial9 writes into `trace.<n>.bin.active` and only seals that segment when it
/// holds real events, so a sealed file is proof that events actually flowed —
/// the active file exists from the moment the writer is constructed.
fn sealed_segments(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read trace dir")
        .map(|e| e.expect("dir entry").file_name().to_string_lossy().into())
        .filter(|n: &String| n.starts_with("trace.") && !n.ends_with(".active"))
        .collect();
    names.sort();
    names
}

#[test]
fn disabled_recorder_attaches_a_working_runtime() {
    let (recorder, trace_dir, caps) = build_recorder(&cli(&["--disable-dial9"])).expect("recorder");
    assert!(trace_dir.is_none(), "nothing to trace into when disabled");
    assert!(
        caps.is_none(),
        "perf capabilities are not probed when disabled"
    );

    let (recorder, runtime) = recorder
        .attach_tokio_runtime(|b| {
            b.worker_threads(2);
        })
        .expect("attach runtime");

    // The point of a disabled recorder: handles stay inert and `spawn` falls
    // through to `tokio::spawn`, so no caller has to branch on it.
    let handle = Dial9TokioHandle::current();
    let answer = runtime.block_on(async move { handle.spawn(async { 42 }).await.unwrap() });
    assert_eq!(answer, 42);

    drop(runtime);
    recorder.graceful_shutdown(Duration::from_secs(5));
}

#[test]
fn enabled_recorder_writes_trace_segments() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trace_dir = dir.path().join("traces");

    // A stale trace directory must not survive startup, or the disk caps would
    // be enforced against a previous run's segments.
    fs::create_dir_all(&trace_dir).expect("pre-create trace dir");
    fs::write(trace_dir.join("trace.99.bin.gz"), b"stale").expect("stale segment");

    let (recorder, reported_dir, caps) = build_recorder(&cli(&[
        "--trace-dir",
        trace_dir.to_str().expect("utf-8 temp path"),
    ]))
    .expect("recorder");

    assert_eq!(reported_dir.as_deref(), Some(trace_dir.as_path()));
    assert!(caps.is_some(), "perf capabilities are probed when enabled");
    assert!(
        !trace_dir.join("trace.99.bin.gz").exists(),
        "startup must wipe the previous run's segments"
    );

    let (recorder, runtime) = recorder
        .attach_tokio_runtime(|b| {
            b.worker_threads(2);
        })
        .expect("attach runtime");

    // Attaching claims this thread, so the spawn handle resolves here — the
    // same order `main` relies on. Capturing the handle before attaching would
    // silently yield an inert one: spawning would still work, but every task
    // would lose its wake tracking.
    assert!(
        dial9::Dial9Handle::current().is_enabled(),
        "attach must claim the calling thread for handles captured here to be traced"
    );
    let handle = Dial9TokioHandle::current();

    runtime.block_on(async move {
        let mut tasks = Vec::new();
        for _ in 0..16 {
            tasks.push(handle.spawn(async {
                for _ in 0..64 {
                    tokio::task::yield_now().await;
                }
            }));
        }
        for task in tasks {
            task.await.expect("traced task");
        }
    });

    // Drop the runtime first so workers flush their thread-local buffers, then
    // let the recorder drain and seal.
    drop(runtime);
    recorder.graceful_shutdown(Duration::from_secs(30));

    let segments = sealed_segments(&trace_dir);
    assert!(
        !segments.is_empty(),
        "poll events from 16 traced tasks should have sealed a segment; trace dir holds {:?}",
        fs::read_dir(&trace_dir)
            .expect("read trace dir")
            .map(|e| e.expect("dir entry").file_name())
            .collect::<Vec<_>>()
    );
    for name in &segments {
        let len = fs::metadata(trace_dir.join(name))
            .expect("segment metadata")
            .len();
        assert!(len > 0, "sealed segment {name} is empty");
    }

    // `attach` installs the recorder handle on this thread and nothing removes
    // it; leave the libtest worker clean for whatever runs on it next.
    dial9::core::clear_tl_handle();
}
