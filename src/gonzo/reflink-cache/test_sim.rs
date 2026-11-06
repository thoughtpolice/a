// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The simulated filesystem keeps what was made durable and may lose the
//! rest, as ext4 and XFS do.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use hegel::TestCase;
use hegel::generators as gs;

use crate::fs::{File as _, Fs as _};
use crate::sim::SimFs;

fn p(path: &str) -> PathBuf {
    PathBuf::from(path)
}

/// Keep every pending change, and every file as it is now.
fn keep_all(n: u64) -> u64 {
    n - 1
}

/// Keep only what is durable.
fn keep_none(_: u64) -> u64 {
    0
}

fn create(fs: &SimFs, path: &str, data: &[u8]) {
    let mut file = fs.create_new(&p(path)).unwrap();
    file.write_all(data).unwrap();
}

fn sync_data(fs: &SimFs, path: &str) {
    fs.open(&p(path)).unwrap().sync_data().unwrap();
}

fn names(fs: &SimFs, dir: &str) -> Vec<String> {
    let mut names: Vec<String> = fs
        .read_dir(&p(dir))
        .unwrap()
        .into_iter()
        .map(|e| e.name.into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// A filesystem with directories `/a` and `/b`, durable.
fn two_dirs() -> SimFs {
    let fs = SimFs::new();
    fs.create_dir(&p("/a")).unwrap();
    fs.create_dir(&p("/b")).unwrap();
    fs.sync_dir(&p("/")).unwrap();
    fs
}

#[test]
fn synced_data_and_names_survive_a_crash() {
    let fs = two_dirs();
    create(&fs, "/a/x", b"hello");
    sync_data(&fs, "/a/x");
    fs.sync_dir(&p("/a")).unwrap();
    fs.crash(&mut keep_none);
    assert_eq!(fs.read(&p("/a/x")).unwrap(), b"hello");
}

#[test]
fn an_unsynced_name_is_lost_when_the_crash_drops_it() {
    let fs = two_dirs();
    create(&fs, "/a/x", b"hello");
    sync_data(&fs, "/a/x");
    fs.crash(&mut keep_none);
    assert!(fs.read(&p("/a/x")).is_err());
}

#[test]
fn a_synced_name_without_synced_data_may_come_back_empty_cut_or_zeroed() {
    let seen: BTreeSet<Vec<u8>> = (0..4)
        .flat_map(|version| (0..=5).map(move |len| (version, len)))
        .map(|(version, len)| {
            let fs = two_dirs();
            create(&fs, "/a/x", b"hello");
            fs.sync_dir(&p("/a")).unwrap();
            let mut answers = [version, len].into_iter();
            fs.crash(&mut |_| answers.next().unwrap());
            fs.read(&p("/a/x")).unwrap()
        })
        .collect();
    for expected in [&b""[..], b"hel", b"hello", b"he\0\0\0", b"\0\0\0\0\0"] {
        assert!(seen.contains(expected), "{expected:?} is never seen");
    }
}

#[test]
fn a_rename_is_one_change_to_both_directories() {
    for (keep, at) in [(keep_all as fn(u64) -> u64, "/b/y"), (keep_none, "/a/x")] {
        let fs = two_dirs();
        create(&fs, "/a/x", b"data");
        sync_data(&fs, "/a/x");
        fs.sync_dir(&p("/a")).unwrap();
        fs.rename(&p("/a/x"), &p("/b/y")).unwrap();
        fs.crash(&mut { keep });
        let found: Vec<&str> = ["/a/x", "/b/y"]
            .into_iter()
            .filter(|path| fs.read(&p(path)).is_ok())
            .collect();
        assert_eq!(found, [at]);
    }
}

#[test]
fn syncing_either_directory_makes_a_rename_durable() {
    for synced in ["/a", "/b"] {
        let fs = two_dirs();
        create(&fs, "/a/x", b"data");
        sync_data(&fs, "/a/x");
        fs.sync_dir(&p("/a")).unwrap();
        fs.rename(&p("/a/x"), &p("/b/y")).unwrap();
        fs.sync_dir(&p(synced)).unwrap();
        fs.crash(&mut keep_none);
        assert_eq!(names(&fs, "/a"), Vec::<String>::new());
        assert_eq!(names(&fs, "/b"), ["y"]);
    }
}

#[test]
fn a_crash_point_fails_every_later_call_until_restart() {
    let fs = two_dirs();
    let before = fs.calls();
    fs.crash_after(2);
    create(&fs, "/a/x", b"one");
    let err = fs.create_new(&p("/a/y")).unwrap_err();
    assert!(SimFs::is_crash(&err), "{err}");
    assert!(fs.crashed());
    assert!(SimFs::is_crash(&fs.sync_fs(&p("/")).unwrap_err()));
    // The create and the write succeeded; the third call did not.
    assert_eq!(fs.calls() - before, 3);
    fs.crash(&mut keep_all);
    assert!(!fs.crashed());
    assert_eq!(fs.read(&p("/a/x")).unwrap(), b"one");
}

#[test]
fn files_opened_before_a_crash_fail_after_it() {
    let fs = two_dirs();
    create(&fs, "/a/x", b"data");
    fs.sync_fs(&p("/")).unwrap();
    let mut file = fs.open(&p("/a/x")).unwrap();
    fs.crash(&mut keep_all);
    assert!(file.read(&mut [0; 4]).is_err());
    let mut again = fs.open(&p("/a/x")).unwrap();
    let mut data = Vec::new();
    again.read_to_end(&mut data).unwrap();
    assert_eq!(data, b"data");
}

#[test]
fn renames_between_devices_fail_and_reflinks_are_not_made() {
    let fs = two_dirs();
    fs.add_device(&p("/other")).unwrap();
    create(&fs, "/other/x", b"data");
    let err = fs.rename(&p("/other/x"), &p("/a/x")).unwrap_err();
    assert_eq!(err.raw_os_error(), Some(libc::EXDEV));
    let from = fs.open(&p("/other/x")).unwrap();
    let to = fs.create_new(&p("/a/x")).unwrap();
    assert!(!fs.reflink(&from, &to));
    let near = fs.create_new(&p("/other/y")).unwrap();
    assert!(fs.reflink(&from, &near));
    assert_eq!(fs.read(&p("/other/y")).unwrap(), b"data");
}

#[test]
fn sync_fs_makes_everything_durable() {
    let fs = two_dirs();
    create(&fs, "/a/x", b"one");
    create(&fs, "/b/y", b"two");
    fs.rename(&p("/a/x"), &p("/b/z")).unwrap();
    assert!(fs.unsynced());
    fs.sync_fs(&p("/")).unwrap();
    assert!(!fs.unsynced());
    fs.crash(&mut keep_none);
    assert_eq!(names(&fs, "/b"), ["y", "z"]);
    assert_eq!(fs.read(&p("/b/z")).unwrap(), b"one");
}

/// What a test knows of a file it made.
#[derive(Clone, Debug)]
struct Known {
    data: Vec<u8>,
    data_synced: bool,
    /// The directories whose sync would make the file's name durable,
    /// or none once it is.
    name_unsynced_in: BTreeSet<&'static str>,
}

const DIRS: [&str; 2] = ["/a", "/b"];
const NAMES: [&str; 3] = ["x", "y", "z"];

fn draw_path(tc: &TestCase) -> (&'static str, PathBuf) {
    let dir = tc.draw(gs::sampled_from(&DIRS[..]));
    let name = tc.draw(gs::sampled_from(&NAMES[..]));
    (dir, Path::new(dir).join(name))
}

/// Random calls, then a crash: every file whose data and name were both
/// made durable since they last changed is there whole; keeping
/// everything keeps the live state; keeping nothing keeps exactly the
/// files that were wholly durable.
#[hegel::test(test_cases = 300, database = None)]
fn durable_files_survive_any_crash(tc: TestCase) {
    let fs = two_dirs();
    let mut known: BTreeMap<PathBuf, Known> = BTreeMap::new();
    let steps = tc.draw(gs::integers::<usize>().max_value(30));
    for _ in 0..steps {
        match tc.draw(gs::integers::<u8>().max_value(5)) {
            0 => {
                let (dir, path) = draw_path(&tc);
                let data: Vec<u8> = tc.draw(gs::binary().max_size(16));
                if let Ok(mut file) = fs.create_new(&path) {
                    file.write_all(&data).unwrap();
                    known.insert(
                        path,
                        Known {
                            data,
                            data_synced: false,
                            name_unsynced_in: [dir].into(),
                        },
                    );
                }
            }
            1 => {
                let (_, path) = draw_path(&tc);
                if let Some(k) = known.get_mut(&path) {
                    fs.open(&path).unwrap().sync_data().unwrap();
                    k.data_synced = true;
                }
            }
            2 => {
                let dir = tc.draw(gs::sampled_from(&DIRS[..]));
                fs.sync_dir(Path::new(dir)).unwrap();
                for k in known.values_mut() {
                    if k.name_unsynced_in.contains(dir) {
                        k.name_unsynced_in.clear();
                    }
                }
            }
            3 => {
                let (from_dir, from) = draw_path(&tc);
                let (to_dir, to) = draw_path(&tc);
                if from != to
                    && let Some(mut k) = known.remove(&from)
                {
                    fs.rename(&from, &to).unwrap();
                    k.name_unsynced_in = [from_dir, to_dir].into();
                    known.insert(to, k);
                }
            }
            4 => {
                let (_, path) = draw_path(&tc);
                if known.remove(&path).is_some() {
                    fs.remove_file(&path).unwrap();
                }
            }
            _ => {
                fs.sync_fs(Path::new("/")).unwrap();
                for k in known.values_mut() {
                    k.data_synced = true;
                    k.name_unsynced_in.clear();
                }
            }
        }
    }
    let live: BTreeMap<PathBuf, Vec<u8>> = known
        .keys()
        .map(|path| (path.clone(), fs.read(path).unwrap()))
        .collect();
    let durable = |k: &Known| k.data_synced && k.name_unsynced_in.is_empty();

    let choice = tc.draw(gs::integers::<u8>().max_value(2));
    match choice {
        0 => fs.crash(&mut keep_all),
        1 => fs.crash(&mut keep_none),
        _ => fs.crash(&mut |n| tc.draw(gs::integers::<u64>().max_value(n - 1))),
    }
    for (path, k) in &known {
        if durable(k) {
            assert_eq!(
                fs.read(path).unwrap(),
                k.data,
                "{} is durable",
                path.display()
            );
        }
    }
    let after: BTreeMap<PathBuf, Vec<u8>> = DIRS
        .iter()
        .flat_map(|dir| NAMES.iter().map(move |name| Path::new(dir).join(name)))
        .filter_map(|path| Some((path.clone(), fs.read(&path).ok()?)))
        .collect();
    match choice {
        0 => assert_eq!(after, live),
        1 => {
            // Files removed or renamed away unsyncedly may come back, but
            // every file that was wholly durable is there.
            for (path, k) in &known {
                if durable(k) {
                    assert_eq!(after.get(path), Some(&k.data));
                }
            }
        }
        _ => {}
    }
}
