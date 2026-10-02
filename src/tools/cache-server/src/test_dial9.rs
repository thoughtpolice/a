// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The dial9 recorder wiring the server starts with.
//!
//! Both halves of it fail quietly rather than loudly when they are wrong: a
//! `base_path` that names a file still "works", it just makes a directory of
//! that name, and a spawn handle taken before the runtime is attached still
//! spawns, it just records nothing. So assert on the trace dial9 actually
//! leaves behind.

use std::time::Duration;

use dial9::{Dial9Handle, Dial9HandleTokioExt as _, Dial9TokioHandle};

use crate::{attach_options, claim_trace_dir, start_recorder};

#[test]
fn records_a_sealed_segment() {
    let tmp = tempfile::tempdir().expect("temp dir");
    let trace_dir = tmp.path().join("traces");

    let caps = runtime::check_perf_capabilities();
    let metadata = vec![("service.name".to_string(), "test".to_string())];
    let recorder = start_recorder(&trace_dir, 1, 8, 10, metadata, &caps).expect("start recorder");
    assert!(
        recorder.handle().is_enabled(),
        "build() starts recording; a disabled recorder here means the writer failed"
    );

    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all().worker_threads(2);
    let rt = recorder
        .handle()
        .attach_tokio_runtime(builder, attach_options())
        .expect("attach runtime");

    // The attach is what tracks this thread, so both of these have to come
    // after it. Before it they are silently inert.
    let handle = Dial9TokioHandle::current();
    assert!(
        Dial9Handle::current().is_enabled(),
        "attaching should install a live handle on the attaching thread"
    );

    dial9::block_on(&rt, async move {
        let tasks: Vec<_> = (0..16u64)
            .map(|i| {
                handle.spawn(async move {
                    // Park and wake so the runtime records more than a single
                    // uninterrupted poll per task.
                    tokio::task::yield_now().await;
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    i * 2
                })
            })
            .collect();
        for (i, task) in tasks.into_iter().enumerate() {
            assert_eq!(task.await.expect("task"), i as u64 * 2);
        }
    });

    // Workers flush their thread-local buffers as they exit, so the runtime
    // goes first; then the drain seals and compresses the last segment.
    drop(rt);
    recorder.graceful_shutdown(Duration::from_secs(30));

    // Segments are files directly under `trace_dir`. A `base_path` that named
    // a file instead would leave a *directory* of that name here, so the entry
    // kind is part of what is being checked.
    let entries: Vec<(String, bool)> = std::fs::read_dir(&trace_dir)
        .expect("trace directory")
        .map(|e| {
            let e = e.expect("directory entry");
            (
                e.file_name().to_string_lossy().into_owned(),
                e.file_type().expect("entry file type").is_file(),
            )
        })
        .collect();

    // The writer creates `trace.0.bin.active` the moment it is constructed, so
    // a non-empty directory proves nothing — only a sealed segment does.
    assert!(
        entries
            .iter()
            .any(|(name, is_file)| *is_file && !name.ends_with(".active")),
        "no sealed segment file under {}: {entries:?}",
        trace_dir.display(),
    );
}

#[test]
fn a_trace_directory_has_one_writer() {
    let tmp = tempfile::tempdir().expect("temp dir");
    let (dir, lock) = claim_trace_dir(tmp.path(), "serve")
        .expect("claim")
        .expect("first claim succeeds");
    assert_eq!(dir, tmp.path().join("serve"));
    assert!(
        claim_trace_dir(tmp.path(), "serve")
            .expect("claim")
            .is_none()
    );
    // Another subcommand records alongside.
    assert!(
        claim_trace_dir(tmp.path(), "compact")
            .expect("claim")
            .is_some()
    );
    drop(lock);
    assert!(
        claim_trace_dir(tmp.path(), "serve")
            .expect("claim")
            .is_some()
    );
}

#[test]
fn raw_segments_from_an_earlier_run_are_set_aside() {
    let tmp = tempfile::tempdir().expect("temp dir");
    let dir = tmp.path().join("serve");
    std::fs::create_dir_all(&dir).expect("trace dir");
    for name in [
        "trace.3.bin",
        "trace.4.bin.gz",
        "trace.5.bin.active",
        "notes.bin",
    ] {
        std::fs::write(dir.join(name), name).expect("write");
    }
    let _claim = claim_trace_dir(tmp.path(), "serve")
        .expect("claim")
        .expect("claimed");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("read dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            ".lock",
            "notes.bin",
            "trace.3.bin.unsymbolized",
            "trace.4.bin.gz",
            "trace.5.bin.active",
        ]
    );
}
