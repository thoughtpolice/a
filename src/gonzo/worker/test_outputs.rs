// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;

use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{Command, Directory, Tree};

use crate::digest::{DigestFunction, key};
use crate::outputs;
use crate::test_support::Daemon;

fn write(root: &Path, path: &str, contents: &[u8], mode: u32) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, contents).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[allow(deprecated)]
fn legacy(files: &[&str], directories: &[&str]) -> Command {
    Command {
        output_files: files.iter().map(|p| p.to_string()).collect(),
        output_directories: directories.iter().map(|p| p.to_string()).collect(),
        ..Default::default()
    }
}

#[tokio::test]
async fn prepare_creates_the_parents_of_outputs() {
    let scratch = tempfile::tempdir().unwrap();
    let command = Command {
        output_paths: vec!["out/a/file".into(), "top".into()],
        ..Default::default()
    };
    outputs::prepare(&command, scratch.path()).unwrap();
    assert!(scratch.path().join("out/a").is_dir());
    assert!(!scratch.path().join("out/a/file").exists());
    assert!(!scratch.path().join("top").exists());
}

#[test]
fn outputs_must_stay_inside_the_working_directory() {
    let scratch = tempfile::tempdir().unwrap();
    for bad in ["../escape", "/abs", "a/../../b", ""] {
        let command = Command {
            output_paths: vec![bad.into()],
            ..Default::default()
        };
        assert!(
            outputs::prepare(&command, scratch.path()).is_err(),
            "{bad:?}"
        );
    }
}

#[tokio::test]
async fn files_directories_and_symlinks_are_uploaded() {
    let daemon = Daemon::start().await;
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    write(root, "bin/tool", b"#!/bin/sh\n", 0o755);
    write(root, "gen/out/a.txt", b"a", 0o644);
    write(root, "gen/out/same/a.txt", b"a", 0o644);
    write(root, "gen/out/z.txt", b"zzz", 0o644);
    std::fs::create_dir_all(root.join("gen/out/empty")).unwrap();
    std::os::unix::fs::symlink("a.txt", root.join("gen/out/link")).unwrap();
    std::os::unix::fs::symlink("../bin/tool", root.join("gen/alias")).unwrap();
    // Declared a file but produced as a directory, as Buck's strict mode
    // declares outputs that may be either.
    write(root, "gen/either/inner", b"inner", 0o644);

    let command = legacy(
        &["bin/tool", "gen/alias", "gen/either", "never/made"],
        &["gen/out"],
    );
    let produced = outputs::upload(&daemon.cas(), DigestFunction::Sha256, &command, root)
        .await
        .expect("upload");

    assert_eq!(produced.files.len(), 1);
    let tool = &produced.files[0];
    assert_eq!(tool.path, "bin/tool");
    assert!(tool.is_executable);
    assert_eq!(
        daemon.get(tool.digest.as_ref().unwrap()).await.as_ref(),
        b"#!/bin/sh\n"
    );

    assert_eq!(produced.symlinks.len(), 1);
    assert_eq!(produced.symlinks[0].path, "gen/alias");
    assert_eq!(produced.symlinks[0].target, "../bin/tool");

    let paths: Vec<&str> = produced
        .directories
        .iter()
        .map(|d| d.path.as_str())
        .collect();
    assert_eq!(paths, ["gen/either", "gen/out"]);
    let out = &produced.directories[1];
    let tree = Tree::decode(daemon.get(out.tree_digest.as_ref().unwrap()).await).unwrap();
    let root_dir = tree.root.unwrap();
    let names = |d: &Directory| {
        (
            d.files.iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
            d.directories
                .iter()
                .map(|d| d.name.clone())
                .collect::<Vec<_>>(),
            d.symlinks
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(
        names(&root_dir),
        (
            vec!["a.txt".into(), "z.txt".into()],
            vec!["empty".into(), "same".into()],
            vec!["link".into()]
        )
    );
    // Both subdirectories are among the children, each once.
    assert_eq!(tree.children.len(), 2);
    for sub in &root_dir.directories {
        let digest = sub.digest.as_ref().unwrap();
        assert!(
            tree.children
                .iter()
                .any(|c| key(&DigestFunction::Sha256.of(&c.encode_to_vec())) == key(digest)),
            "{}",
            sub.name
        );
    }
    for file in &root_dir.files {
        assert!(
            daemon.has(file.digest.as_ref().unwrap()).await,
            "{}",
            file.name
        );
    }
}

#[tokio::test]
async fn large_outputs_are_streamed() {
    let daemon = Daemon::start().await;
    let scratch = tempfile::tempdir().unwrap();
    let big: Vec<u8> = (0..5 * 1024 * 1024 + 17).map(|i| (i % 253) as u8).collect();
    write(scratch.path(), "big.bin", &big, 0o644);
    let command = Command {
        output_paths: vec!["big.bin".into()],
        ..Default::default()
    };
    let produced = outputs::upload(
        &daemon.cas(),
        DigestFunction::Sha256,
        &command,
        scratch.path(),
    )
    .await
    .expect("upload");
    let digest = produced.files[0].digest.as_ref().unwrap();
    assert_eq!(digest.size_bytes, big.len() as i64);
    assert_eq!(daemon.get(digest).await.as_ref(), big.as_slice());
}

#[tokio::test]
async fn large_trees_are_streamed() {
    // A directory output whose tree is over the daemon's 4 MB message
    // limit, as an unpacked source archive's can be.
    let daemon = Daemon::start().await;
    let scratch = tempfile::tempdir().unwrap();
    let long = "x".repeat(200);
    for i in 0..10_000 {
        write(
            scratch.path(),
            &format!("out/{i:05}{long}/{i:05}{long}"),
            b"",
            0o644,
        );
    }
    let command = Command {
        output_paths: vec!["out".into()],
        ..Default::default()
    };
    let produced = outputs::upload(
        &daemon.cas(),
        DigestFunction::Sha256,
        &command,
        scratch.path(),
    )
    .await
    .expect("upload");
    let digest = produced.directories[0].tree_digest.as_ref().unwrap();
    assert!(digest.size_bytes > 4 * 1024 * 1024, "{}", digest.size_bytes);
    let tree = Tree::decode(daemon.get(digest).await).unwrap();
    assert_eq!(tree.children.len(), 10_000);
}
