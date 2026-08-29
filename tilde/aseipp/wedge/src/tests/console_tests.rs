// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The packages wlink links, run whole under the reference interpreter on
//! the console HAL host and held to the native wasm2c hosts of
//! `tilde//aseipp/wlink/demo`: the prototype game must make the same HAL
//! calls in the same order.

use std::path::PathBuf;
use std::process::Command;

use wedge::Compiler;
use wedge::interp::{Config, Instance, Value};
use wedge::ir::Program;
use wedge_testing::console::{ConsoleHost, KeyEvent};

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
