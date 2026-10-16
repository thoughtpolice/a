// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Commands in an empty root see their inputs and nothing else.
//!
//! An empty root has no dynamic loader and no libc, so the program run in
//! it here is [`probe`], a static x86_64 executable small enough to write
//! out by hand.

use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::time::Duration;

use crate::runner::{self, Outcome, SpawnError, Spec};
use crate::sandbox::{self, EmptyRoot};

/// A static x86_64 Linux executable that asks `access(argv[1], F_OK)` and
/// exits with the errno it gets, or 0 if the path exists.
pub fn probe() -> Vec<u8> {
    #[rustfmt::skip]
    let code: &[u8] = &[
        0x48, 0x8b, 0x7c, 0x24, 0x10, // mov rdi, [rsp + 16]  ; argv[1]
        0x31, 0xf6,                   // xor esi, esi         ; F_OK
        0xb8, 0x15, 0x00, 0x00, 0x00, // mov eax, 21          ; access
        0x0f, 0x05,                   // syscall
        0xf7, 0xd8,                   // neg eax              ; the errno, or 0
        0x89, 0xc7,                   // mov edi, eax
        0xb8, 0x3c, 0x00, 0x00, 0x00, // mov eax, 60          ; exit
        0x0f, 0x05,                   // syscall
    ];
    const BASE: u64 = 0x40_0000;
    const HEADERS: u64 = 64 + 56;
    let size = HEADERS + code.len() as u64;
    let mut elf = Vec::new();
    // The ELF header: 64-bit, little-endian, an x86_64 executable with
    // one program header and no sections.
    elf.extend(b"\x7fELF\x02\x01\x01\x00");
    elf.extend([0; 8]);
    elf.extend(2u16.to_le_bytes());
    elf.extend(0x3eu16.to_le_bytes());
    elf.extend(1u32.to_le_bytes());
    elf.extend((BASE + HEADERS).to_le_bytes());
    elf.extend(64u64.to_le_bytes());
    elf.extend(0u64.to_le_bytes());
    elf.extend(0u32.to_le_bytes());
    elf.extend(64u16.to_le_bytes());
    elf.extend(56u16.to_le_bytes());
    elf.extend(1u16.to_le_bytes());
    elf.extend([0; 6]);
    // One loadable, readable and executable segment: the whole file.
    elf.extend(1u32.to_le_bytes());
    elf.extend(5u32.to_le_bytes());
    elf.extend(0u64.to_le_bytes());
    elf.extend(BASE.to_le_bytes());
    elf.extend(BASE.to_le_bytes());
    elf.extend(size.to_le_bytes());
    elf.extend(size.to_le_bytes());
    elf.extend(0x1000u64.to_le_bytes());
    elf.extend(code);
    elf
}

/// Whether these tests can run here: on x86_64, where the kernel lets this
/// process make an empty root.
pub fn can_test() -> bool {
    if !cfg!(target_arch = "x86_64") || !sandbox::supported() {
        eprintln!("skipping: no empty roots here");
        return false;
    }
    true
}

/// A root holding the probe, and somewhere for its output.
struct Scratch {
    dir: tempfile::TempDir,
}

impl Scratch {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("probe"), probe()).unwrap();
        std::fs::set_permissions(root.join("probe"), std::fs::Permissions::from_mode(0o555))
            .unwrap();
        Self { dir }
    }

    fn root(&self) -> std::path::PathBuf {
        self.dir.path().join("root")
    }

    /// Run `argv` in `working_directory` (under the root), in an empty
    /// root or on the host.
    async fn run(
        &self,
        argv: &[&str],
        working_directory: &str,
        empty: bool,
    ) -> anyhow::Result<Outcome> {
        let arguments: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
        let root = EmptyRoot::new(&self.root(), Path::new(working_directory)).unwrap();
        for name in ["stdout", "stderr"] {
            let _ = std::fs::remove_file(self.dir.path().join(name));
        }
        runner::run(
            &Spec {
                arguments: &arguments,
                environment: &[],
                working_directory: &self.root().join(working_directory),
                stdout: &self.dir.path().join("stdout"),
                stderr: &self.dir.path().join("stderr"),
                timeout: Duration::from_secs(60),
                cgroup: None,
                empty_root: empty.then_some(&root),
            },
            std::future::pending(),
        )
        .await
    }
}

const ENOENT: i32 = libc::ENOENT;

#[tokio::test]
async fn the_probe_tells_what_exists() {
    if !can_test() {
        return;
    }
    let scratch = Scratch::new();
    // On the host, the host's files are there.
    assert_eq!(
        scratch
            .run(&["./probe", "/etc/passwd"], "", false)
            .await
            .unwrap(),
        Outcome::Exited(0)
    );
    assert_eq!(
        scratch
            .run(&["./probe", "/no/such/file"], "", false)
            .await
            .unwrap(),
        Outcome::Exited(ENOENT)
    );
}

#[tokio::test]
async fn an_empty_root_holds_the_inputs_and_nothing_else() {
    if !can_test() {
        return;
    }
    let scratch = Scratch::new();
    for path in ["/probe", "probe", "/sub", "/"] {
        assert_eq!(
            scratch.run(&["./probe", path], "", true).await.unwrap(),
            Outcome::Exited(0),
            "{path} is an input"
        );
    }
    let host = scratch.dir.path().join("stdout");
    for path in [
        "/etc/passwd",
        "/bin/sh",
        "/proc/self",
        "/dev/null",
        "/tmp",
        &host.display().to_string(),
    ] {
        assert_eq!(
            scratch.run(&["./probe", path], "", true).await.unwrap(),
            Outcome::Exited(ENOENT),
            "{path} is not"
        );
    }
}

#[tokio::test]
async fn the_working_directory_is_under_the_new_root() {
    if !can_test() {
        return;
    }
    let scratch = Scratch::new();
    assert_eq!(
        scratch
            .run(&["../probe", "../probe"], "sub", true)
            .await
            .unwrap(),
        Outcome::Exited(0)
    );
}

#[tokio::test]
async fn nothing_is_found_on_a_path() {
    if !can_test() {
        return;
    }
    let scratch = Scratch::new();
    let err = scratch
        .run(&["sh", "-c", "true"], "", true)
        .await
        .expect_err("no shell");
    assert!(err.downcast_ref::<SpawnError>().is_some(), "{err:#}");
}
