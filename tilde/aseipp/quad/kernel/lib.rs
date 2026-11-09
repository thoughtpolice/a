// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The Rust half of quad's kernel: components written in Rust, for Scheme.
//!
//! Each `#[chez::procedure]` is a Scheme procedure in the library
//! `(quad native)`, which the build generates from [`native`] (BUILD's
//! chez.rust_library); arguments and results convert by their Rust types, and
//! errors and panics become Scheme errors. The kernel registers them at boot
//! by calling [`quad_native_register`].
//!
//! Components that run threads of their own -- iroh (mesh.rs), GUI windows
//! (gui.rs) -- hand Scheme
//! an object holding a [`Mailbox`], whose file descriptor the editor's event
//! loop polls; the ticker below is the smallest such component.
//! Subprocesses ([`Process`]) need no thread: Scheme polls and reads their
//! output's descriptor, and writes to their input's, directly.
//!
//! Allocation: there is no `#[global_allocator]`. The executable links
//! mimalloc's malloc override, so Rust's system allocator already allocates
//! from mimalloc, as Chez Scheme and the C kernel do.

use std::fs::File;
use std::os::fd::AsRawFd;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use chez::{ByteVec, Bytes, Mailbox, Object, Ref, RefMut};

mod font;
mod gui;
mod mesh;
mod render;
mod slug;

/// The BLAKE3 hash of a bytevector: a 32-byte bytevector.
#[chez::procedure]
fn blake3(data: Bytes) -> ByteVec {
    ByteVec(blake3::hash(&data).as_bytes().to_vec())
}

/// What the Rust half is: "quad-kernel VERSION (rust)".
#[chez::procedure(name = "kernel-rust-version")]
fn version() -> &'static str {
    concat!("quad-kernel ", env!("DEPOT_PACKAGE_VERSION"), " (rust)")
}

/// Ticks from a thread of its own: every interval, the tick's number.
pub struct Ticker {
    ticks: Mailbox<u64>,
}

/// A ticker that ticks `count` times, `interval-ms` apart, then stops. The
/// ticks arrive in Scheme through ticker-take!, once ticker-fd is readable.
#[chez::procedure]
fn make_ticker(interval_ms: u64, count: u64) -> Result<Object<Ticker>, String> {
    let (tx, ticks) = Mailbox::new().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        for i in 1..=count {
            std::thread::sleep(Duration::from_millis(interval_ms));
            if tx.send(i).is_err() {
                // Dropped: nobody is listening.
                return;
            }
        }
    });
    Ok(Object(Ticker { ticks }))
}

/// The descriptor that is readable while ticks wait.
#[chez::procedure]
fn ticker_fd(t: Ref<Ticker>) -> i32 {
    t.ticks.fd()
}

/// The ticks waiting, oldest first.
#[chez::procedure(name = "ticker-take!")]
fn ticker_take(t: Ref<Ticker>) -> Vec<u64> {
    t.ticks.take()
}

/// A subprocess, with pipes to its standard input and from its standard
/// output: what the editor talks to programs through (an agent's server, a
/// language server). Its standard error goes to a file, or nowhere, so that
/// nothing waits on a pipe nobody reads.
pub struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl Process {
    /// Close its input, which asks a well-behaved server to exit; give it a
    /// moment to, then kill it. Either way it is reaped.
    fn stop(&mut self, grace: Duration) {
        self.stdin = None;
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            self.stop(Duration::from_millis(500));
        }
    }
}

/// Run `argv` (the program, then its arguments, searched for in PATH) in
/// directory `cwd` (#f: the editor's), its standard error appended to the
/// file `stderr` (#f: discarded).
#[chez::procedure(name = "spawn-process")]
fn spawn_process(
    argv: Vec<String>,
    cwd: Option<String>,
    stderr: Option<String>,
) -> Result<Object<Process>, String> {
    let (program, args) = argv
        .split_first()
        .ok_or("spawn-process: an empty command")?;
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stderr(match stderr {
        Some(path) => File::options()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("{path}: {e}"))?
            .into(),
        None => Stdio::null(),
    });
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout is piped");
    Ok(Object(Process {
        child,
        stdin,
        stdout,
    }))
}

/// Run `argv` (the program, then its arguments, searched for in PATH) on
/// its own, as a desktop's launcher does: nothing is read from or written
/// to it, and a thread waits for it to exit, so that it is not left a
/// zombie.
#[chez::procedure(name = "launch-process")]
fn launch_process(argv: Vec<String>) -> Result<(), String> {
    let (program, args) = argv
        .split_first()
        .ok_or("launch-process: an empty command")?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[chez::procedure]
fn process_pid(p: Ref<Process>) -> u32 {
    p.child.id()
}

/// The descriptor to write the process's input to, or -1 once closed.
#[chez::procedure]
fn process_input_fd(p: Ref<Process>) -> i32 {
    p.stdin.as_ref().map_or(-1, |i| i.as_raw_fd())
}

/// The descriptor to read the process's output from, which polls readable
/// at its end, too.
#[chez::procedure]
fn process_output_fd(p: Ref<Process>) -> i32 {
    p.stdout.as_raw_fd()
}

/// Close the process's input: it reads end of file.
#[chez::procedure(name = "process-close-input!")]
fn process_close_input(mut p: RefMut<Process>) {
    p.stdin = None;
}

/// The exit status if the process has exited (a signal's number, negated,
/// if one killed it), else #f.
#[chez::procedure]
fn process_status(mut p: RefMut<Process>) -> Result<Option<i32>, String> {
    use std::os::unix::process::ExitStatusExt;
    let status = p.child.try_wait().map_err(|e| e.to_string())?;
    Ok(status.map(|s| s.code().unwrap_or_else(|| -s.signal().unwrap_or(0))))
}

/// Stop the process: close its input, wait up to `grace-ms` for it to exit,
/// then kill it.
#[chez::procedure(name = "process-stop!")]
fn process_stop(mut p: RefMut<Process>, grace_ms: u64) {
    p.stop(Duration::from_millis(grace_ms));
}

// ---------------------------------------------------------------------------
// Editors and clients over iroh (mesh.rs)

/// An editor accepting clients over iroh, with a new identity and join
/// key, and (with `code?`) a new join code it announces itself under, all
/// made up now and kept nowhere. `local` uses no relays or address lookup,
/// so that only the addresses a ticket carries reach it. Clients' streams
/// arrive through mesh-host-take!, once mesh-host-fd is readable.
#[chez::procedure(name = "mesh-host-start")]
fn mesh_host_start(code: bool, local: bool) -> Result<Object<mesh::Host>, String> {
    mesh::host(code, local)
        .map(Object)
        .map_err(|e| e.to_string())
}

/// Readable while client streams, or news, wait.
#[chez::procedure]
fn mesh_host_fd(h: Ref<mesh::Host>) -> i32 {
    h.streams.fd()
}

/// The descriptors of the client streams waiting; -1 for each change to
/// the editor's info.
#[chez::procedure(name = "mesh-host-take!")]
fn mesh_host_take(h: Ref<mesh::Host>) -> Vec<i32> {
    h.streams.take()
}

/// What the editor's endpoint has made known: its ID, its ticket, its join
/// code and what failed, each #f until known.
#[chez::procedure]
fn mesh_host_info(h: Ref<mesh::Host>) -> Vec<Option<String>> {
    let i = h.info.lock().unwrap();
    vec![
        i.id.clone(),
        i.ticket.clone(),
        i.code.clone(),
        i.error.clone(),
    ]
}

/// "code", "ticket" or #f: what `target` is to mesh-connect.
#[chez::procedure(name = "mesh-target-kind")]
fn mesh_target_kind(target: String) -> Option<String> {
    mesh::target_kind(&target).map(str::to_string)
}

/// A connection to the editor that `target`, a join code or ticket, names.
/// It waits until connected, or fails.
#[chez::procedure(name = "mesh-connect")]
fn mesh_connect(target: String, local: bool) -> Result<Object<mesh::Session>, String> {
    mesh::connect(&target, local).map(Object)
}

/// The descriptor of a connection's stream, to speak the protocol on.
#[chez::procedure]
fn mesh_session_fd(s: Ref<mesh::Session>) -> i32 {
    s.fd
}

/// The ID of the editor a connection reached.
#[chez::procedure]
fn mesh_session_editor(s: Ref<mesh::Session>) -> String {
    s.editor.clone()
}

// MARK: GUI windows (gui.rs, for core/gui.sls)

/// Open a window `cols` by `rows` cells in size, drawing text in the font
/// `family` (else the system's monospace font) at `points`; its events come
/// from gui-take!, once gui-fd is readable.
#[chez::procedure(name = "gui-open")]
fn gui_open(
    title: String,
    cols: u32,
    rows: u32,
    family: String,
    points: f64,
) -> Result<Object<gui::Gui>, String> {
    let font = gui::FontSpec {
        family,
        points: points as f32,
    };
    gui::Gui::open(title, cols, rows, font).map(Object)
}

#[chez::procedure]
fn gui_fd(g: Ref<gui::Gui>) -> i32 {
    g.events.fd()
}

/// What happened to the window, oldest first, as lists: ("resize" rows
/// cols), ("char" text mods kind), ("special" name mods kind), ("mouse"
/// kind button col row mods), ("focus" in?), ("clipboard" target text),
/// ("dropped" path), ("error" message), ("closed").
#[chez::procedure(name = "gui-take!")]
fn gui_take(g: Ref<gui::Gui>) -> Vec<gui::Event> {
    g.events.take()
}

/// Paint a frame: rectangles in cells (gui.slang's Rect, 32 bytes each),
/// then the cells with text (font.rs's CELL_BYTES each, their texts in
/// `text`), over a background color; text left to the terminal's color is
/// in `foreground`, and the cursor is at (`cursor_row`, `cursor_col`), or
/// hidden (-1).
#[chez::procedure(name = "gui-paint!")]
#[allow(clippy::too_many_arguments)]
fn gui_paint(
    g: Ref<gui::Gui>,
    rects: Bytes,
    cells: Bytes,
    text: Bytes,
    background: u32,
    foreground: u32,
    cursor_row: i32,
    cursor_col: i32,
) -> Result<(), String> {
    let cursor =
        (cursor_row >= 0 && cursor_col >= 0).then_some((cursor_row as u32, cursor_col as u32));
    g.paint(&rects, &cells, &text, (background, foreground), cursor)
}

/// Draw frames into images, with no window, in the font `family` (else the
/// system's monospace font) at `points`: for tests, on a GPU or a software
/// renderer (QUAD_GUI_DEVICE=llvmpipe for Mesa's lavapipe).
#[chez::procedure(name = "gui-headless")]
fn gui_headless(family: String, points: f64) -> Result<Object<gui::Snapshots>, String> {
    let font = gui::FontSpec {
        family,
        points: points as f32,
    };
    gui::Snapshots::new(font).map(Object)
}

/// A cell's width and height in pixels, and the device drawing.
#[chez::procedure(name = "gui-headless-info")]
fn gui_headless_info(h: Ref<gui::Snapshots>) -> Vec<String> {
    let [w, hh] = h.cell();
    vec![w.to_string(), hh.to_string(), h.device_name()]
}

/// A frame of `cols` by `rows` cells, as gui-paint! takes it, drawn: its
/// pixels, RGBA, top row first.
#[chez::procedure(name = "gui-headless-draw!")]
fn gui_headless_draw(
    mut h: RefMut<gui::Snapshots>,
    rects: Bytes,
    cells: Bytes,
    text: Bytes,
    background: u32,
    cols: u32,
    rows: u32,
) -> Result<ByteVec, String> {
    h.draw(&rects, &cells, &text, background, cols, rows)
        .map(ByteVec)
}

#[chez::procedure(name = "gui-set-title!")]
fn gui_set_title(g: Ref<gui::Gui>, title: String) {
    g.set_title(title);
}

/// Whether the window has the system's clipboard and primary selection.
#[chez::procedure(name = "gui-clipboard?")]
fn gui_has_clipboard(g: Ref<gui::Gui>) -> bool {
    g.has_clipboard
}

/// Put text on the clipboard (target "c") or primary selection ("p").
#[chez::procedure(name = "gui-clipboard-set!")]
fn gui_clipboard_set(g: Ref<gui::Gui>, target: String, text: String) {
    g.clipboard_set(target, text);
}

/// Ask for the clipboard's (or primary selection's) contents, which come
/// from gui-take! as ("clipboard" target text).
#[chez::procedure(name = "gui-clipboard-get!")]
fn gui_clipboard_get(g: Ref<gui::Gui>, target: String) {
    g.clipboard_get(target);
}

/// Draw the window's text in `family` (else the system's monospace font)
/// at `points`; its grid is sized again for it.
#[chez::procedure(name = "gui-set-font!")]
fn gui_set_font(g: Ref<gui::Gui>, family: String, points: f64) {
    g.set_font(family, points as f32);
}

/// Show the pointer as `shape`, a CSS cursor name ("text", "default",
/// "pointer"); an unknown one is the default arrow.
#[chez::procedure(name = "gui-set-pointer!")]
fn gui_set_pointer(g: Ref<gui::Gui>, shape: String) {
    g.set_pointer(shape);
}

#[chez::procedure(name = "gui-close!")]
fn gui_close(mut g: RefMut<gui::Gui>) {
    g.close();
}

chez::library! {
    /// `(quad native)`.
    pub fn native() -> "quad native" {
        blake3, version, make_ticker, ticker_fd, ticker_take,
        spawn_process, launch_process, process_pid, process_input_fd, process_output_fd,
        process_close_input, process_status, process_stop,
        mesh_host_start, mesh_host_fd, mesh_host_take, mesh_host_info,
        mesh_target_kind, mesh_connect, mesh_session_fd, mesh_session_editor,
        gui_open, gui_fd, gui_take, gui_paint, gui_set_title, gui_close,
        gui_headless, gui_headless_info, gui_headless_draw,
        gui_has_clipboard, gui_clipboard_set, gui_clipboard_get, gui_set_font, gui_set_pointer,
    }
}

/// Register `(quad native)`'s procedures with Chez Scheme: the kernel calls
/// this once the heap is built.
#[unsafe(no_mangle)]
pub extern "C" fn quad_native_register() {
    chez::quiet_panics();
    native().register();
}
