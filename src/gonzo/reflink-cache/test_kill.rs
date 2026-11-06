// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A real process, killed with SIGKILL in the middle of its work, leaves a
//! cache the next one opens with everything acknowledged in it, whole.
//!
//! The test runs its own binary again as the child, which takes files in
//! and marks some clean, saying on stdout what was acknowledged, until it
//! is killed. A kill leaves the page cache, so this tests what opening
//! does after an unclean stop, not where the syncs are: the simulated
//! filesystem's tests do that.

use std::collections::BTreeMap;
use std::io::{BufRead as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use reapi_cas::Digest;

use crate::test_support::SHA256;
use crate::{FileCache, Held, Ingested};

/// Set in the child to the directory it works in.
const CHILD: &str = "REFLINK_CACHE_KILLED_CHILD";

fn data(n: u64) -> Vec<u8> {
    format!("blob {n} ")
        .repeat(1 + (n % 50) as usize)
        .into_bytes()
}

/// The child's work: take files in, upload some, and mark some clean,
/// forever. Without the environment variable this is no child, and
/// returns at once.
#[test]
fn killed_child() {
    let Some(dir) = std::env::var_os(CHILD) else {
        return;
    };
    let dir = PathBuf::from(dir);
    let start: u64 = std::env::var("REFLINK_CACHE_KILLED_START")
        .unwrap()
        .parse()
        .unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .build()
        .unwrap();
    let cache = FileCache::open(&dir.join("store"), 1 << 30).unwrap();
    let mut out = std::io::stdout().lock();
    for n in start.. {
        let blob = data(n);
        let digest = SHA256.digest(&blob);
        let ingested = if n % 3 == 0 {
            runtime.block_on(async {
                let Some(mut upload) = cache.upload(SHA256, &digest).await.unwrap() else {
                    return Ingested::Already(Held::Dirty);
                };
                for piece in blob.chunks(100) {
                    upload.write(piece).unwrap();
                }
                upload.finish().await.unwrap()
            })
        } else {
            let path = dir.join("builds").join(n.to_string());
            std::fs::write(&path, &blob).unwrap();
            runtime
                .block_on(cache.ingest(SHA256, &digest, &path))
                .unwrap()
        };
        assert_eq!(ingested, Ingested::Added);
        writeln!(out, "acked {n}").unwrap();
        if n % 5 == 4 {
            let marked = SHA256.digest(&data(n - 2));
            runtime
                .block_on(cache.mark_clean(SHA256, &[marked]))
                .unwrap();
            writeln!(out, "marked {}", n - 2).unwrap();
        }
        out.flush().unwrap();
    }
}

/// What a child said was done, by blob number: marked clean or not.
fn run_child(dir: &Path, start: u64, acks: usize, said: &mut BTreeMap<u64, bool>) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "test_kill::killed_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, dir)
        .env("REFLINK_CACHE_KILLED_START", start.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    // Read only what is needed, but keep the pipe open until the kill,
    // so that the child is writing still, not failing to.
    let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut acked = 0;
    for line in lines.by_ref() {
        let line = line.unwrap();
        if let Some(n) = line.strip_prefix("acked ") {
            said.insert(n.parse().unwrap(), false);
            acked += 1;
        } else if let Some(n) = line.strip_prefix("marked ") {
            said.insert(n.parse().unwrap(), true);
        }
        if acked >= acks || Instant::now() > deadline {
            break;
        }
    }
    assert!(acked >= acks, "the child acknowledged only {acked}");
    // In the middle of the next file, most likely.
    std::thread::sleep(Duration::from_micros(300));
    child.kill().unwrap();
    let status = child.wait().unwrap();
    use std::os::unix::process::ExitStatusExt as _;
    assert_eq!(
        status.signal(),
        Some(libc::SIGKILL),
        "the child died of itself"
    );
    drop(lines);
}

#[test]
fn a_killed_process_leaves_everything_it_acknowledged() {
    let scratch = tempfile::tempdir().unwrap();
    std::fs::create_dir(scratch.path().join("builds")).unwrap();
    let mut said = BTreeMap::new();
    for round in 0..3u64 {
        run_child(scratch.path(), round * 1000, 30, &mut said);
        let cache = FileCache::open(&scratch.path().join("store"), 1 << 30).unwrap();
        assert!(cache.recovery().unclean, "round {round}");
        assert_eq!(cache.recovery().dropped, [], "round {round}");
        for (n, marked) in &said {
            let digest: Digest = SHA256.digest(&data(*n));
            let held = cache.has(SHA256, &digest);
            // A mark may have been done but not yet said when the child
            // was killed.
            if *marked || n % 5 == 2 {
                assert!(held.is_some(), "round {round}: {n} was lost");
            } else {
                assert_eq!(held, Some(Held::Dirty), "round {round}: {n} is not dirty");
            }
            let copy = scratch.path().join(format!("copy-{round}-{n}"));
            cache.copy_to(SHA256, &digest, false, &copy, || ()).unwrap();
            assert_eq!(
                std::fs::read(&copy).unwrap(),
                data(*n),
                "round {round}: {n}"
            );
        }
        let partial = std::fs::read_dir(scratch.path().join("store/partial")).unwrap();
        assert_eq!(partial.count(), 0, "round {round}");
    }
}
