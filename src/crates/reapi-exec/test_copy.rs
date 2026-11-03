// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use reapi_cas::DigestFn;
use reflink_cache::FileCache;

const SHA256: DigestFn = DigestFn::Sha256;

/// A command forked while a copy is open for writing holds it open
/// until it execs, and an action's exec of the copy meanwhile fails
/// with ETXTBSY. Here the copy waits on a FIFO and the command waits to
/// exec, so that, were they not kept apart, they would overlap.
#[tokio::test(flavor = "multi_thread")]
async fn no_command_forks_while_a_copy_is_open_for_writing() {
    use std::io::Write as _;
    use std::os::unix::ffi::OsStrExt as _;
    use std::time::Duration;

    let scratch = tempfile::tempdir().unwrap();
    let cache = Arc::new(FileCache::open(&scratch.path().join("files"), u64::MAX).unwrap());
    let digest = SHA256.digest(b"a slow tool");
    let source = cache.path(SHA256, &digest);
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    let fifo = std::ffi::CString::new(source.as_os_str().as_bytes()).unwrap();
    // SAFETY: mkfifo(3) reads a NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    // The FIFO's only writer is another process, so the copy ends when
    // it exits, whatever a child of this one holds.
    let mut writer = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            r#"exec 3>"$0"; read go; printf '#!/bin/sh\nexit 0\n' >&3"#,
        ])
        .arg(&source)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    let tool = scratch.path().join("tool");
    let copying = tokio::task::spawn_blocking({
        let (cache, tool) = (cache.clone(), tool.clone());
        move || crate::inputs::copy_input(&cache, SHA256, &digest, true, &tool)
    });
    while !tool.exists() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    let mut release = [0; 2];
    // SAFETY: pipe(2) fills the two descriptors.
    assert_eq!(unsafe { libc::pipe(release.as_mut_ptr()) }, 0);
    let [held, unblock] = release;
    let mut command = tokio::process::Command::new("/bin/sh");
    command.args(["-c", ":"]);
    // SAFETY: read(2) is async-signal-safe.
    unsafe {
        command.pre_exec(move || {
            let mut byte = 0u8;
            libc::read(held, (&raw mut byte).cast(), 1);
            Ok(())
        });
    }
    let spawning = tokio::task::spawn_blocking(move || hermetic_run::spawn(&mut command).unwrap());
    // Time for the command to fork, if it may while the copy is open.
    tokio::time::sleep(Duration::from_millis(200)).await;

    writer.stdin.take().unwrap().write_all(b"\n").unwrap();
    assert!(writer.wait().unwrap().success());
    copying.await.unwrap().unwrap();
    let ran = std::process::Command::new(&tool).status();

    // SAFETY: write(2) reads the one byte given.
    assert_eq!(unsafe { libc::write(unblock, b"\n".as_ptr().cast(), 1) }, 1);
    assert!(spawning.await.unwrap().wait().await.unwrap().success());
    // SAFETY: both descriptors are this test's own.
    unsafe {
        libc::close(held);
        libc::close(unblock);
    }
    assert!(ran.unwrap().success());
}
