// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! Runs the `kermit` binary end to end.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const SAMPLE: &[u8] =
    b"GET /index.html HTTP/1.1\nHost: example.com\nContent-Length: 42\n\n{\"a\": [1, 2]}\n";

fn kermit() -> Command {
    let path = fs::canonicalize(std::env::var_os("KERMIT").expect("Buck supplies KERMIT"))
        .expect("the kermit binary exists");
    let mut command = Command::new(path);
    command.stdin(Stdio::null());
    command
}

fn run(command: &mut Command) -> Output {
    let output = command.output().expect("kermit runs");
    assert!(
        output.status.success(),
        "kermit failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn fails(command: &mut Command) -> String {
    let output = command.output().expect("kermit runs");
    assert!(!output.status.success(), "kermit succeeded");
    String::from_utf8(output.stderr).unwrap()
}

fn sample(dir: &Path, name: &str, data: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, data).unwrap();
    path
}

/// The files of `dir`, by name.
fn outputs(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (name, fs::read(&path).unwrap())
        })
        .collect();
    out.sort();
    out
}

#[test]
fn a_seed_repeats_a_run() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in.txt", SAMPLE);
    let make = |seed: &str, name: &str| {
        let out = dir.path().join(name);
        fs::create_dir(&out).unwrap();
        run(kermit()
            .args(["-s", seed, "-n", "20", "-o"])
            .arg(out.join("%n.%s"))
            .arg(&input));
        outputs(&out)
    };
    let first = make("7", "first");
    assert_eq!(first.len(), 20);
    assert_eq!(first[0].0, "1.txt");
    assert_eq!(make("7", "again"), first);
    assert_ne!(make("8", "other"), first);
    // The uniqueness filter is on, so no two outputs match.
    let mut data: Vec<_> = first.iter().map(|(_, data)| data).collect();
    data.sort();
    data.dedup();
    assert_eq!(data.len(), 20);
}

#[test]
fn seeking_writes_only_later_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in", SAMPLE);
    let (all, later) = (dir.path().join("all"), dir.path().join("later"));
    fs::create_dir(&all).unwrap();
    fs::create_dir(&later).unwrap();
    run(kermit()
        .args(["-s", "3", "-n", "4", "-o"])
        .arg(all.join("%02n"))
        .arg(&input));
    run(kermit()
        .args(["-s", "3", "-S", "3", "-n", "2", "-o"])
        .arg(later.join("%02n"))
        .arg(&input));
    assert_eq!(outputs(&later), outputs(&all)[2..]);
}

#[test]
fn one_file_takes_one_output() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in", SAMPLE);
    let error = fails(
        kermit()
            .args(["-n", "2", "-o"])
            .arg(dir.path().join("out"))
            .arg(&input),
    );
    assert!(error.contains("Add %n, %0Nn or %h"), "{error}");
    // Named by checksum, each output still gets its own file.
    let out = dir.path().join("hashed");
    fs::create_dir(&out).unwrap();
    run(kermit()
        .args(["-n", "3", "-H", "sha256", "-o"])
        .arg(out.join("%h"))
        .arg(&input));
    assert_eq!(outputs(&out).len(), 3);
}

#[test]
fn metadata_describes_each_output() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in.json", SAMPLE);
    let meta = dir.path().join("meta.jsonl");
    let out = dir.path().join("out");
    fs::create_dir(&out).unwrap();
    run(kermit()
        .args(["-s", "5", "-n", "3", "-g", "file", "-M"])
        .arg(&meta)
        .arg("-o")
        .arg(out.join("%n"))
        .arg(&input));
    let lines: Vec<serde_json::Value> = fs::read_to_string(&meta)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0], serde_json::json!({ "seed": 5 }));
    for (record, nth) in lines[1..].iter().zip(1..) {
        let path = out.join(nth.to_string());
        let data = fs::read(&path).unwrap();
        assert_eq!(record["nth"], nth);
        assert_eq!(record["generator"], "file");
        assert_eq!(record["source"], input.display().to_string());
        assert_eq!(record["path"], path.display().to_string());
        assert_eq!(record["length"], data.len());
        assert_eq!(record["checksum"], blake3::hash(&data).to_hex().as_str());
        let mutations = record["mutations"].as_array().unwrap();
        assert!(!mutations.is_empty());
        for name in mutations {
            assert!(kermit::Mutator::from_name(name.as_str().unwrap()).is_some());
        }
    }
}

#[test]
fn templates_wrap_and_truncation_cuts() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in", SAMPLE);
    let wrapped = run(kermit()
        .args(["--output-template", "<a>%f</a>"])
        .arg(&input))
    .stdout;
    assert!(wrapped.starts_with(b"<a>") && wrapped.ends_with(b"</a>"));
    let cut = run(kermit()
        .args(["--output-template", "<a>%f</a>", "-T", "3"])
        .arg(&input))
    .stdout;
    assert_eq!(cut, b"<a>");
}

#[test]
fn standard_input_and_random_data_need_no_files() {
    let mut child = kermit()
        .args(["-n", "3", "-s", "1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(SAMPLE).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(!output.stdout.is_empty());

    let dir = tempfile::tempdir().unwrap();
    run(kermit()
        .args(["-g", "random", "-n", "3", "-o"])
        .arg(dir.path().join("%n")));
    assert_eq!(outputs(dir.path()).len(), 3);
}

#[test]
fn directories_need_recursion() {
    let dir = tempfile::tempdir().unwrap();
    let samples = dir.path().join("samples");
    fs::create_dir_all(samples.join("nested")).unwrap();
    sample(&samples, "a.txt", SAMPLE);
    sample(&samples.join("nested"), "b.txt", b"second sample 1234\n");
    let error = fails(kermit().arg(&samples));
    assert!(error.contains("is a directory. Use -r"), "{error}");
    let meta = dir.path().join("meta");
    run(kermit()
        .args(["-r", "-n", "20", "-g", "file", "-M"])
        .arg(&meta)
        .arg(&samples));
    let text = fs::read_to_string(&meta).unwrap();
    assert!(text.contains("a.txt") && text.contains("b.txt"));
}

#[test]
fn jumps_splice_two_files() {
    let dir = tempfile::tempdir().unwrap();
    let a = sample(dir.path(), "a", &SAMPLE.repeat(100));
    let b = sample(dir.path(), "b", &b"other lines\n".repeat(400));
    let meta = dir.path().join("meta");
    run(kermit()
        .args(["-g", "jump", "-n", "5", "-M"])
        .arg(&meta)
        .args([&a, &b]));
    let text = fs::read_to_string(&meta).unwrap();
    assert_eq!(text.matches("\"generator\":\"jump\"").count(), 5);
    assert!(text.contains("\"head\""));
}

#[test]
fn dictionary_tokens_appear() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in", SAMPLE);
    let dictionary = sample(dir.path(), "dict", b"# tokens\nmagic=\"ZQXJ\\x01\"\n");
    let output = run(kermit()
        .args(["-m", "di", "-p", "od", "-D"])
        .arg(&dictionary)
        .arg(&input))
    .stdout;
    assert!(output.windows(5).any(|window| window == b"ZQXJ\x01"));
    let bad = sample(dir.path(), "bad", b"magic=ZQXJ\n");
    let error = fails(kermit().arg("-D").arg(&bad).arg(&input));
    assert!(
        error.contains("line 1: expected a token in double quotes"),
        "{error}"
    );
}

#[test]
fn the_filter_gives_up_on_endless_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in", b"x");
    let error = fails(
        kermit()
            .args(["-m", "nop", "-g", "file", "-n", "2"])
            .arg(&input),
    );
    assert!(error.contains("duplicate outputs in a row"), "{error}");
    let output = run(kermit()
        .args(["-m", "nop", "-g", "file", "-n", "2", "-C", "0"])
        .arg(&input))
    .stdout;
    assert_eq!(output, b"xx");
}

#[test]
fn sends_to_tcp_and_udp_servers() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in", SAMPLE);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let mut child = kermit()
        .args(["-n", "2", "-o", &address])
        .arg(&input)
        .spawn()
        .unwrap();
    for _ in 0..2 {
        let (mut stream, _) = listener.accept().unwrap();
        let mut data = Vec::new();
        stream.read_to_end(&mut data).unwrap();
        assert!(!data.is_empty());
    }
    assert!(child.wait().unwrap().success());

    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let address = format!("{}/udp", socket.local_addr().unwrap());
    run(kermit().args(["-n", "2", "-o", &address]).arg(&input));
    let mut buffer = [0; 65_536];
    for _ in 0..2 {
        assert!(socket.recv(&mut buffer).unwrap() > 0);
    }
}

#[test]
fn serves_tcp_clients() {
    let dir = tempfile::tempdir().unwrap();
    let input = sample(dir.path(), "in", SAMPLE);
    // Find a free port, then let kermit take it. Another process could
    // take it first, but only in a narrow window.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = kermit()
        .args(["-n", "2", "-o", &format!(":{port}")])
        .arg(&input)
        .spawn()
        .unwrap();
    for _ in 0..2 {
        let mut stream = (0..500)
            .find_map(|_| {
                let stream = TcpStream::connect(("127.0.0.1", port)).ok();
                if stream.is_none() {
                    thread::sleep(Duration::from_millis(20));
                }
                stream
            })
            .expect("kermit listens within ten seconds");
        let mut data = Vec::new();
        stream.read_to_end(&mut data).unwrap();
        assert!(!data.is_empty());
    }
    assert!(child.wait().unwrap().success());
}

#[test]
fn lists_and_explains_itself() {
    let list = String::from_utf8(run(kermit().arg("-l")).stdout).unwrap();
    for mutator in kermit::Mutator::ALL {
        assert!(list.contains(&format!("  {}: ", mutator.name())), "{list}");
    }
    let about = String::from_utf8(run(kermit().arg("-a")).stdout).unwrap();
    assert!(about.contains("Aki Helin"));
}
