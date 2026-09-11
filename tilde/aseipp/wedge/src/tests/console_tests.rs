// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The packages wlink links, run whole under the reference interpreter on
//! the console HAL host and held to the native wasm2c hosts of
//! `tilde//aseipp/wlink/demo`: the prototype game must make the same HAL
//! calls in the same order, and PureDOOM must render the same frames.

use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

use wedge::Compiler;
use wedge::interp::{Config, Fault, Instance, Value};
use wedge::ir::Program;
use wedge_testing::console::{Console, ConsoleHost, KeyEvent, parse_script};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn resource(name: &str) -> PathBuf {
    buck_resources::get(format!("aseipp/wedge/{name}"))
        .unwrap_or_else(|error| panic!("locate {name}: {error}"))
}

fn linked(name: &str) -> Program {
    let path = resource(&format!("wlink-{name}.wasm"));
    let wasm = std::fs::read(&path).unwrap_or_else(|error| panic!("read {name}: {error}"));
    let program = Compiler::new()
        .compile(&wasm)
        .unwrap_or_else(|error| panic!("compile wlink's linked {name} module: {error}"));
    program
        .verify()
        .unwrap_or_else(|errors| panic!("{name} does not verify:\n{errors}"));
    program
}

/// A whole program's fuel: the instance counts every instruction and
/// terminator it executes.
const UNLIMITED: Config = Config {
    fuel: u64::MAX,
    max_call_depth: 1000,
    max_memory_bytes: 1 << 30,
    max_table_elements: 1 << 24,
    max_array_elements: 1 << 26,
};

fn native_output(binary: &str, arguments: &[String]) -> String {
    let output = Command::new(resource(binary))
        .args(arguments)
        .output()
        .unwrap_or_else(|error| panic!("run {binary}: {error}"));
    assert!(
        output.status.success(),
        "{binary} failed with {}:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("the host prints UTF-8")
}

/// The demo's stdio host holds the right arrow through two frames, then
/// presses start, and calls `frame` with a 16 ms step and `end-frame` after
/// it until the game stops or a hundred frames pass. The interpreter must
/// produce its transcript, byte for byte.
#[test]
fn the_console_game_makes_the_same_hal_calls_as_its_stdio_host() {
    const ENTER: u32 = 1;
    const RIGHT: u32 = 8;
    let program = linked("console");
    let mut host = ConsoleHost::new();
    let mut instance =
        Instance::instantiate(&program, &mut host, UNLIMITED).expect("the package instantiates");
    instance
        .invoke_export(&mut host, "init", &[])
        .expect("init runs");
    let mut frames = 1;
    loop {
        if frames == 1 {
            host.events.push(KeyEvent {
                key: RIGHT,
                pressed: true,
            });
        }
        if frames == 3 {
            host.events.push(KeyEvent {
                key: RIGHT,
                pressed: false,
            });
            host.events.push(KeyEvent {
                key: ENTER,
                pressed: true,
            });
        }
        let more = match instance
            .invoke_export(&mut host, "frame", &[Value::I32(16)])
            .expect("frame runs")
            .as_slice()
        {
            [Value::I32(more)] => *more != 0,
            other => panic!("frame returned {other:?}"),
        };
        instance
            .invoke_export(&mut host, "end-frame", &[])
            .expect("end-frame runs");
        if !more || frames >= 100 {
            break;
        }
        frames += 1;
    }
    let mut transcript = host.trace.join("\n");
    transcript.push_str(&format!("\ngame over after {frames} frames\n"));
    assert_eq!(transcript, native_output("console-host", &[]));
    assert_eq!(frames, 3);
    assert!(host.logs.iter().any(|(_, message)| message == "game: init"));
}

/// PureDOOM on the same package, paced and scripted like the SDK's
/// headless host: after every frame the interpreter must have the frame
/// hash and memory sizes `--trace` prints. Doom's initialization alone is
/// two hundred million instructions, five seconds in an optimized build
/// and a minute in an unoptimized one, so an unoptimized build runs the
/// comparison only when `WEDGE_DOOM_FRAMES` asks for it; the variable
/// also chooses how many frames to compare. Doom's renderer recurses
/// through its BSP tree, and an unoptimized interpreter frame is large, so
/// the test needs the stack the Rust test runner gives every test thread.
#[test]
fn doom_renders_the_same_frames_as_wasm2c() {
    let requested: Option<u64> = std::env::var("WEDGE_DOOM_FRAMES")
        .ok()
        .and_then(|frames| frames.parse().ok());
    if requested.is_none() && cfg!(debug_assertions) {
        eprintln!("skipped: an unoptimized build compares Doom only when WEDGE_DOOM_FRAMES is set");
        return;
    }
    let frames = requested.unwrap_or(3);
    let script_text = "1 escape down\n2 escape up\n";
    let game_arguments = ["-warp", "1", "-skill", "3", "-nomonsters"];

    let script_path = std::env::temp_dir().join(format!("wedge-doom-{}.txt", std::process::id()));
    std::fs::write(&script_path, script_text).expect("write the script");
    let mut arguments: Vec<String> = [
        "--iwad".to_owned(),
        resource("freedoom2.wad").display().to_string(),
        "--headless".to_owned(),
        "--frames".to_owned(),
        frames.to_string(),
        "--script".to_owned(),
        script_path.display().to_string(),
        "--trace".to_owned(),
        "--".to_owned(),
    ]
    .to_vec();
    arguments.extend(game_arguments.iter().map(|argument| (*argument).to_owned()));
    let native = native_output("doom-host", &arguments);
    let _ = std::fs::remove_file(&script_path);
    let expected: Vec<&str> = native
        .lines()
        .filter(|line| line.starts_with("frame="))
        .collect();
    assert_eq!(expected.len() as u64, frames, "{native}");

    let program = linked("doom");
    let mut host = ConsoleHost::new();
    host.mount_readonly(
        "doom2.wad",
        std::fs::read(resource("freedoom2.wad")).expect("read the IWAD"),
    )
    .expect("mount the IWAD");
    host.args = std::iter::once("doom")
        .chain(game_arguments)
        .map(str::to_owned)
        .collect();
    let started = Instant::now();
    let mut console = Console::start(
        &program,
        host,
        UNLIMITED,
        35,
        parse_script(script_text).expect("the script parses"),
    )
    .unwrap_or_else(|fault| panic!("Doom does not initialize: {fault}"));
    eprintln!(
        "init: {} instructions in {:.2?}",
        u64::MAX - console.instance.fuel(),
        started.elapsed()
    );
    let mut traces = Vec::new();
    for _ in 0..frames {
        let started = Instant::now();
        let more = match console.frame() {
            Ok(more) => more,
            Err(Fault::Trap(_)) if console.host.exit.is_some() => false,
            Err(fault) => panic!(
                "frame {} faulted: {fault}\n{}",
                console.frames() + 1,
                console
                    .host
                    .logs
                    .iter()
                    .map(|(_, message)| message.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        };
        let trace = console.trace();
        eprintln!(
            "{trace}: {} instructions in {:.2?}",
            u64::MAX - console.instance.fuel(),
            started.elapsed()
        );
        traces.push(trace.to_string());
        if !more {
            break;
        }
    }
    assert_eq!(traces, expected);
}

/// Quake II on the same package, paced like its runner at 60 Hz and told to
/// load the demo's first level: after every frame the interpreter must have
/// the frame hash and memory sizes `--trace` prints. Loading the level is
/// fifty million instructions and the player spawns on frame 93, after
/// which every rendered frame is another eight million, so an optimized
/// build compares a hundred frames, a few seconds, and an unoptimized one
/// only when `WEDGE_QUAKE2_FRAMES` asks for it; the variable also chooses
/// how many frames to compare.
#[test]
fn quake2_renders_the_same_frames_as_wasm2c() {
    let requested: Option<u64> = std::env::var("WEDGE_QUAKE2_FRAMES")
        .ok()
        .and_then(|frames| frames.parse().ok());
    if requested.is_none() && cfg!(debug_assertions) {
        eprintln!(
            "skipped: an unoptimized build compares Quake II only when WEDGE_QUAKE2_FRAMES is set"
        );
        return;
    }
    let frames = requested.unwrap_or(100);
    let game_arguments = ["+map", "demo1"];

    let script_path = std::env::temp_dir().join(format!("wedge-quake2-{}.txt", std::process::id()));
    std::fs::write(&script_path, "").expect("write the script");
    let mut arguments: Vec<String> = [
        "--pak".to_owned(),
        resource("pak0.pak").display().to_string(),
        "--headless".to_owned(),
        "--frames".to_owned(),
        frames.to_string(),
        "--script".to_owned(),
        script_path.display().to_string(),
        "--trace".to_owned(),
        "--".to_owned(),
    ]
    .to_vec();
    arguments.extend(game_arguments.iter().map(|argument| (*argument).to_owned()));
    let native = native_output("quake2-host", &arguments);
    let _ = std::fs::remove_file(&script_path);
    let expected: Vec<&str> = native
        .lines()
        .filter(|line| line.starts_with("frame="))
        .collect();
    assert_eq!(expected.len() as u64, frames, "{native}");

    let program = linked("quake2");
    let mut host = ConsoleHost::new();
    host.mount_readonly(
        "baseq2/pak0.pak",
        std::fs::read(resource("pak0.pak")).expect("read the pak"),
    )
    .expect("mount the pak");
    host.args = std::iter::once("quake2")
        .chain(game_arguments)
        .map(str::to_owned)
        .collect();
    let started = Instant::now();
    let mut console = Console::start(
        &program,
        host,
        UNLIMITED,
        60,
        parse_script("").expect("the empty script parses"),
    )
    .unwrap_or_else(|fault| panic!("Quake II does not initialize: {fault}"));
    eprintln!(
        "init: {} instructions in {:.2?}",
        u64::MAX - console.instance.fuel(),
        started.elapsed()
    );
    let mut traces = Vec::new();
    for _ in 0..frames {
        let started = Instant::now();
        let more = match console.frame() {
            Ok(more) => more,
            Err(Fault::Trap(_)) if console.host.exit.is_some() => false,
            Err(fault) => panic!(
                "frame {} faulted: {fault}\n{}",
                console.frames() + 1,
                console
                    .host
                    .logs
                    .iter()
                    .map(|(_, message)| message.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        };
        let trace = console.trace();
        eprintln!(
            "{trace}: {} instructions in {:.2?}",
            u64::MAX - console.instance.fuel(),
            started.elapsed()
        );
        traces.push(trace.to_string());
        if !more {
            break;
        }
    }
    assert_eq!(traces, expected);
}
