// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::os::unix::fs::PermissionsExt as _;
use std::sync::Arc;

use protos::build::bazel::remote::execution::v2::{
    Digest, Directory, DirectoryNode, FileNode, SymlinkNode,
};

use crate::cache::FileCache;
use crate::cas::Missing;
use crate::digest::DigestFunction;
use crate::inputs::Inputs;
use crate::test_support::Daemon;

fn file(name: &str, digest: &Digest, executable: bool) -> FileNode {
    FileNode {
        name: name.into(),
        digest: Some(digest.clone()),
        is_executable: executable,
        node_properties: None,
    }
}

fn subdir(name: &str, digest: &Digest) -> DirectoryNode {
    DirectoryNode {
        name: name.into(),
        digest: Some(digest.clone()),
    }
}

fn mode(path: &std::path::Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn lays_out_files_directories_and_symlinks() {
    let daemon = Daemon::start().await;
    let text = daemon.put("some text\n").await;
    let script = daemon.put("#!/bin/sh\necho hi\n").await;
    // Big enough to be streamed rather than batched.
    let big: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let big_digest = daemon.put(big.clone()).await;

    let empty = daemon.put_dir(&Directory::default()).await;
    let sub = daemon
        .put_dir(&Directory {
            files: vec![
                file("big.bin", &big_digest, false),
                file("same.txt", &text, false),
            ],
            ..Default::default()
        })
        .await;
    let root = daemon
        .put_dir(&Directory {
            files: vec![
                file("run.sh", &script, true),
                file("text.txt", &text, false),
            ],
            directories: vec![subdir("empty", &empty), subdir("sub", &sub)],
            symlinks: vec![SymlinkNode {
                name: "link".into(),
                target: "sub/same.txt".into(),
                node_properties: None,
            }],
            ..Default::default()
        })
        .await;

    let scratch = tempfile::tempdir().unwrap();
    let files = Arc::new(FileCache::open(&scratch.path().join("files"), u64::MAX).unwrap());
    let (inputs, cas) = (Inputs::new(files), daemon.cas());
    for attempt in ["first", "second"] {
        // The second time, everything comes from the caches.
        let dest = scratch.path().join(attempt);
        std::fs::create_dir(&dest).unwrap();
        inputs
            .materialize(&cas, DigestFunction::Sha256, &root, &dest)
            .await
            .expect("materialize");

        assert_eq!(
            std::fs::read_to_string(dest.join("text.txt")).unwrap(),
            "some text\n"
        );
        assert_eq!(mode(&dest.join("text.txt")), 0o444);
        assert_eq!(mode(&dest.join("run.sh")), 0o555);
        assert_eq!(std::fs::read(dest.join("sub/big.bin")).unwrap(), big);
        assert_eq!(
            std::fs::read_link(dest.join("link")).unwrap().to_str(),
            Some("sub/same.txt")
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("link")).unwrap(),
            "some text\n"
        );
        assert!(
            std::fs::read_dir(dest.join("empty"))
                .unwrap()
                .next()
                .is_none()
        );
    }
}

#[tokio::test]
async fn missing_inputs_are_named() {
    let daemon = Daemon::start().await;
    let absent = DigestFunction::Sha256.of(b"never uploaded");
    let root = daemon
        .put_dir(&Directory {
            files: vec![file("absent", &absent, false)],
            ..Default::default()
        })
        .await;

    let scratch = tempfile::tempdir().unwrap();
    let files = Arc::new(FileCache::open(&scratch.path().join("files"), u64::MAX).unwrap());
    let (inputs, cas) = (Inputs::new(files), daemon.cas());
    let err = inputs
        .materialize(&cas, DigestFunction::Sha256, &root, scratch.path())
        .await
        .expect_err("an input is missing");
    let missing = err.downcast_ref::<Missing>().expect("a Missing error");
    assert_eq!(missing.0, [absent]);
}

#[tokio::test]
async fn entries_must_be_file_names() {
    let daemon = Daemon::start().await;
    let text = daemon.put("x").await;
    let scratch = tempfile::tempdir().unwrap();
    let files = Arc::new(FileCache::open(&scratch.path().join("files"), u64::MAX).unwrap());
    let (inputs, cas) = (Inputs::new(files), daemon.cas());
    for name in ["..", "a/b", ""] {
        let root = daemon
            .put_dir(&Directory {
                files: vec![file(name, &text, false)],
                ..Default::default()
            })
            .await;
        let err = inputs
            .materialize(&cas, DigestFunction::Sha256, &root, scratch.path())
            .await
            .expect_err("refused");
        assert!(
            format!("{err:#}").contains("is not a single path component"),
            "{err:#}"
        );
    }
    let root = daemon
        .put_dir(&Directory {
            files: vec![file("a", &text, false), file("a", &text, true)],
            ..Default::default()
        })
        .await;
    let err = inputs
        .materialize(&cas, DigestFunction::Sha256, &root, scratch.path())
        .await
        .expect_err("refused");
    assert!(
        format!("{err:#}").contains("appears more than once"),
        "{err:#}"
    );
}

/// A directory too large for a batch streams, as any large blob does.
#[tokio::test]
async fn a_directory_too_large_for_a_batch_is_streamed() {
    let daemon = Daemon::start().await;
    let target = "t".repeat(200);
    let symlinks = (0..25_000)
        .map(|i| SymlinkNode {
            name: format!("link{i:05}"),
            target: target.clone(),
            node_properties: None,
        })
        .collect();
    let root = daemon
        .put_dir(&Directory {
            symlinks,
            ..Default::default()
        })
        .await;
    assert!(root.size_bytes > 4_000_000, "the daemon's batch limit");
    let scratch = tempfile::tempdir().unwrap();
    let files = Arc::new(FileCache::open(&scratch.path().join("files"), u64::MAX).unwrap());
    let dest = scratch.path().join("root");
    std::fs::create_dir(&dest).unwrap();
    Inputs::new(files)
        .materialize(&daemon.cas(), DigestFunction::Sha256, &root, &dest)
        .await
        .expect("laid out");
    let link = std::fs::read_link(dest.join("link24999")).unwrap();
    assert_eq!(link.to_str(), Some(target.as_str()));
}
