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
//! Components that run threads of their own -- iroh (mesh/), GUI windows
//! (gui/) -- hand Scheme
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

use quad_diff as diff;
use quad_files as files;
use quad_fx as fx;
use quad_gui as gui;
use quad_gui::screen;
use quad_image as image;
use quad_mesh as mesh;
use quad_render as render;
use quad_text as text;
use quad_text::search;
use quad_timing as timing;
use quad_voice as voice;

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

/// A command to run `argv` (the program, then its arguments, searched for
/// in PATH) in directory `cwd` (None: the editor's); `who` is the native
/// that asks, for its error.
fn command(who: &str, argv: &[String], cwd: Option<String>) -> Result<Command, String> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| format!("{who}: an empty command"))?;
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    Ok(cmd)
}

/// An exit status as Scheme has it: the code, or a signal's number,
/// negated, if one killed it.
fn status_number(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| -status.signal().unwrap_or(0))
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
    let mut cmd = command("spawn-process", &argv, cwd)?;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped());
    cmd.stderr(match stderr {
        Some(path) => File::options()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("{path}: {e}"))?
            .into(),
        None => Stdio::null(),
    });
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", argv[0]))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout is piped");
    Ok(Object(Process {
        child,
        stdin,
        stdout,
    }))
}

/// Start making what a window draws with (its Vulkan or Metal device), on
/// another thread, so that a window opened soon after opens sooner.
#[chez::procedure(name = "gui-prepare")]
fn gui_prepare() {
    render::prepare();
}

/// Whether a window could open here: a display to show it on (Wayland's or
/// X11's, or macOS's window server), unless `QUAD_NO_DISPLAY=1`.
#[chez::procedure(name = "gui-display?")]
fn gui_display() -> bool {
    gui::display_available()
}

/// Write `rgba` (`width` by `height` RGBA pixels) to `path` as a PNG.
#[chez::procedure(name = "png-file-write")]
fn png_file_write(path: String, width: u32, height: u32, rgba: Bytes) -> Result<(), String> {
    let png = image::encode(width, height, &rgba)?;
    std::fs::write(&path, png).map_err(|e| format!("{path}: {e}"))
}

/// The pixels of the PNG at `path`, as RGBA; an error unless it is `width`
/// by `height`.
#[chez::procedure(name = "png-file-read")]
fn png_file_read(path: String, width: u32, height: u32) -> Result<ByteVec, String> {
    let png = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let decoded = image::decode(&png).map_err(|e| format!("{path}: {e}"))?;
    if (decoded.width, decoded.height) != (width, height) {
        return Err(format!(
            "{path} is {} by {}, not {width} by {height}",
            decoded.width, decoded.height
        ));
    }
    Ok(ByteVec(decoded.rgba))
}

/// Note that a step of starting up is done: with QUAD_TIMING=1, it is
/// written to standard error with the time since the process started.
#[chez::procedure(name = "timing-mark")]
fn timing_mark(step: String) {
    timing::mark(&step);
}

/// Run `argv` (the program, then its arguments, searched for in PATH) on
/// its own, as a desktop's launcher does: nothing is read from or written
/// to it, and a thread waits for it to exit, so that it is not left a
/// zombie.
#[chez::procedure(name = "launch-process")]
fn launch_process(argv: Vec<String>) -> Result<(), String> {
    let mut child = command("launch-process", &argv, None)?
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{}: {e}", argv[0]))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// A command run to its end on a thread of its own, its output and errors
/// collected: they come through command-take! once command-fd is
/// readable.
pub struct Run {
    done: Mailbox<RunDone>,
}

/// How a run ended: its exit status (a signal's number, negated, if one
/// killed it; -1000 if it could not start), what it printed, and its
/// errors, as text (invalid UTF-8 replaced).
pub struct RunDone {
    status: i32,
    out: String,
    err: String,
}

impl chez::IntoScheme for RunDone {
    fn into_scheme(self, s: &chez::Scope) -> chez::Result<chez::Value<'_>> {
        Ok(s.list([
            s.integer(i64::from(self.status)),
            s.string(&self.out),
            s.string(&self.err),
        ]))
    }
}

/// Run `argv` (searched for in PATH) in directory `cwd` (#f: the editor's),
/// with `env`'s "NAME=value" strings added to the environment and nothing
/// to read; a thread waits for it.
#[chez::procedure(name = "command-start")]
fn command_start(
    argv: Vec<String>,
    cwd: Option<String>,
    env: Vec<String>,
) -> Result<Object<Run>, String> {
    let mut cmd = command("command-start", &argv, cwd)?;
    cmd.stdin(Stdio::null());
    for kv in &env {
        let (k, v) = kv
            .split_once('=')
            .ok_or_else(|| format!("command-start: {kv} is not NAME=value"))?;
        cmd.env(k, v);
    }
    let (tx, done) = Mailbox::new().map_err(|e| e.to_string())?;
    let program = argv[0].clone();
    std::thread::spawn(move || {
        let _ = tx.send(match cmd.output() {
            Ok(o) => RunDone {
                status: status_number(o.status),
                out: String::from_utf8_lossy(&o.stdout).into_owned(),
                err: String::from_utf8_lossy(&o.stderr).into_owned(),
            },
            Err(e) => RunDone {
                status: -1000,
                out: String::new(),
                err: format!("{program}: {e}"),
            },
        });
    });
    Ok(Object(Run { done }))
}

#[chez::procedure]
fn command_fd(r: Ref<Run>) -> i32 {
    r.done.fd()
}

/// The run's end, once: a list of (status output errors), or the empty
/// list while it runs.
#[chez::procedure(name = "command-take!")]
fn command_take(r: Ref<Run>) -> Vec<RunDone> {
    r.done.take()
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
    let status = p.child.try_wait().map_err(|e| e.to_string())?;
    Ok(status.map(status_number))
}

/// Stop the process: close its input, wait up to `grace-ms` for it to exit,
/// then kill it.
#[chez::procedure(name = "process-stop!")]
fn process_stop(mut p: RefMut<Process>, grace_ms: u64) {
    p.stop(Duration::from_millis(grace_ms));
}

// ---------------------------------------------------------------------------
// Buffer text (text/, for core/text.sls): positions in characters, lines
// ending at "\n".

#[chez::procedure(name = "rope-new")]
fn rope_new(s: String) -> Object<text::Text> {
    Object(text::Text::new(&s))
}

/// The file at path, read straight into a rope: a file of tens of
/// megabytes need not become a Scheme string first.
#[chez::procedure(name = "rope-read")]
fn rope_read(path: String) -> Result<Object<text::Text>, String> {
    text::Text::read(&path)
        .map(Object)
        .map_err(|e| format!("{path}: {e}"))
}

#[chez::procedure]
fn rope_length(t: Ref<text::Text>) -> usize {
    t.len()
}

#[chez::procedure]
fn rope_line_count(t: Ref<text::Text>) -> usize {
    t.line_count()
}

#[chez::procedure]
fn rope_line_start(t: Ref<text::Text>, line: usize) -> usize {
    t.line_start(line)
}

#[chez::procedure]
fn rope_line_end(t: Ref<text::Text>, line: usize) -> usize {
    t.line_end(line)
}

#[chez::procedure]
fn rope_line_of(t: Ref<text::Text>, pos: usize) -> usize {
    t.line_of(pos)
}

/// The text from start to end, clamped to it.
#[chez::procedure]
fn rope_slice(t: Ref<text::Text>, start: usize, end: usize) -> String {
    t.slice(start, end)
}

#[chez::procedure(name = "rope-insert!")]
fn rope_insert(mut t: RefMut<text::Text>, pos: usize, s: String) {
    t.insert(pos, &s);
}

#[chez::procedure(name = "rope-remove!")]
fn rope_remove(mut t: RefMut<text::Text>, start: usize, end: usize) {
    t.remove(start, end);
}

/// A search for pattern (a regular expression if regex, else the text
/// itself), ignoring case with fold: an error says what is wrong with a
/// pattern that is not one.
#[chez::procedure(name = "search-new")]
fn search_new(pattern: String, regex: bool, fold: bool) -> Result<Object<search::Search>, String> {
    search::Search::new(&pattern, regex, fold).map(Object)
}

/// The first match at or after pos, as (start . end); with wrap, else the
/// first in the text; or #f.
#[chez::procedure]
fn search_next(
    s: Ref<search::Search>,
    t: Ref<text::Text>,
    pos: usize,
    wrap: bool,
) -> Option<(usize, usize)> {
    s.next(&t, pos, wrap)
}

/// The match starting nearest before pos, or at it; with wrap, else the
/// last in the text; or #f.
#[chez::procedure]
fn search_prev(
    s: Ref<search::Search>,
    t: Ref<text::Text>,
    pos: usize,
    wrap: bool,
) -> Option<(usize, usize)> {
    s.prev(&t, pos, wrap)
}

/// The matches from start to end, apart: ((start . end) ...).
#[chez::procedure]
fn search_all(
    s: Ref<search::Search>,
    t: Ref<text::Text>,
    start: usize,
    end: usize,
) -> Vec<(usize, usize)> {
    s.all(&t, start, end)
}

// ---------------------------------------------------------------------------
// A project's files (files/)

/// The files under dir that its ignore files do not ignore, relative to
/// it, at most limit of them.
#[chez::procedure]
fn project_files(dir: String, limit: usize) -> Vec<String> {
    files::project_files(&dir, limit)
}

/// Search the files under dir for pattern (a regular expression if regex,
/// else the text), ignoring case with fold: what it finds comes through
/// grep-take!, once grep-fd is readable. It stops when collected.
#[chez::procedure(name = "grep-start")]
fn grep_start(
    dir: String,
    pattern: String,
    regex: bool,
    fold: bool,
) -> Result<Object<files::Grep>, String> {
    files::Grep::start(&dir, &pattern, regex, fold).map(Object)
}

#[chez::procedure]
fn grep_fd(g: Ref<files::Grep>) -> i32 {
    g.found.fd()
}

/// What the search found since last asked: ("hit" path line column text)
/// for each line, from line 0 and column 0, then ("done" hits stopped?).
#[chez::procedure(name = "grep-take!")]
fn grep_take(g: Ref<files::Grep>) -> Vec<files::Found> {
    g.found.take()
}

// ---------------------------------------------------------------------------
// Line diffs (diff/): where a buffer's lines differ from a version of its
// file, for the gutter

/// A version of a file to diff buffers against: its text, where its lines
/// start (in bytes), and their hashes.
pub struct DiffBase {
    text: String,
    starts: Vec<usize>,
    hashes: Vec<u64>,
}

#[chez::procedure(name = "diff-base")]
fn diff_base(text: String) -> Object<DiffBase> {
    let starts = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let hashes = diff::hash_lines(&text);
    Object(DiffBase {
        text,
        starts,
        hashes,
    })
}

/// The base's lines from `start`, `count` of them, with their newlines.
#[chez::procedure(name = "diff-base-lines")]
fn diff_base_lines(b: Ref<DiffBase>, start: usize, count: usize) -> String {
    let at = |line: usize| b.starts.get(line).copied().unwrap_or(b.text.len());
    let start = start.min(b.starts.len());
    b.text[at(start)..at(start.saturating_add(count))].to_string()
}

/// The base's lines from `start`, `count` of them, as the text that
/// stands for them between the lines around them: with their newlines;
/// or, running to the end, with the newline before them instead (the last
/// line has none of its own), so that a hunk at the end can be put back.
#[chez::procedure(name = "diff-base-block")]
fn diff_base_block(b: Ref<DiffBase>, start: usize, count: usize) -> String {
    if count == 0 {
        return String::new();
    }
    let n = b.starts.len();
    let start = start.min(n);
    let end = start.saturating_add(count);
    if end < n {
        b.text[b.starts[start]..b.starts[end]].to_string()
    } else if start > 0 {
        b.text[b.starts[start] - 1..].to_string()
    } else {
        b.text.clone()
    }
}

/// Where the lines of `t` differ from the base's: a vector of hunks, each
/// #(old-start old-length new-start new-length) in lines, in order.
#[chez::procedure(name = "diff-hunks")]
fn diff_hunks(b: Ref<DiffBase>, mut t: RefMut<text::Text>) -> Hunks {
    Hunks(diff::diff(&b.hashes, t.line_hashes()))
}

pub struct Hunks(Vec<diff::Hunk>);

impl chez::IntoScheme for Hunks {
    fn into_scheme(self, s: &chez::Scope) -> chez::Result<chez::Value<'_>> {
        let n = |x: usize| s.unsigned(x as u64);
        Ok(s.vector(
            self.0
                .iter()
                .map(|h| s.vector([n(h.old_start), n(h.old_len), n(h.new_start), n(h.new_len)])),
        ))
    }
}

// ---------------------------------------------------------------------------
// Animation (fx/): timing and effects, for core/anim.sls

/// The easings' names, in the order timings give them by index.
#[chez::procedure(name = "fx-easing-names")]
fn fx_easing_names() -> Vec<String> {
    fx::easing_names()
}

/// Where `timing` (see fx::Timing::from_numbers) is at `elapsed`
/// milliseconds: (progress . next), its eased progress and the
/// milliseconds until that next changes (0 while it moves; #f once it is
/// done); or #f for a timing that is not one.
#[chez::procedure(name = "fx-sample")]
fn fx_sample(timing: Vec<f64>, elapsed: f64) -> Option<(f64, Option<f64>)> {
    fx::Timing::from_numbers(&timing).map(|t| (t.progress(elapsed), t.next_change(elapsed)))
}

fn effect_of(kind: u32, params: &[f64], color: u32) -> fx::Effect {
    let mut p = [0f32; 4];
    for (o, v) in p.iter_mut().zip(params) {
        *o = *v as f32;
    }
    fx::Effect {
        kind,
        params: p,
        color,
    }
}

/// The inks of `cols` by `rows` cells with the effect `kind` (1, a sheen)
/// of `params` and `color` at `progress` over them, each at its cell's
/// middle, a cell being twice as high as it is wide: `inks`, and what this
/// gives, are a native u32 0xRRGGBB for each, row by row, and 0xFFFFFFFF
/// for a cell with none.
#[chez::procedure(name = "fx-shade-cells")]
#[allow(clippy::too_many_arguments)]
fn fx_shade_cells(
    kind: u32,
    params: Vec<f64>,
    color: u32,
    progress: f64,
    cols: usize,
    rows: usize,
    inks: Bytes,
) -> Result<ByteVec, String> {
    if inks.len() != cols * rows * 4 {
        return Err("fx-shade-cells: an ink for each cell".into());
    }
    let amount =
        effect_of(kind, &params, color).amounts(progress as f32, [cols as f32, 2.0 * rows as f32]);
    let mut out = inks.to_vec();
    for (i, ink) in out.chunks_exact_mut(4).enumerate() {
        let v = u32::from_ne_bytes(ink.try_into().unwrap());
        if v != u32::MAX {
            let (k, r) = ((i % cols) as f32, (i / cols) as f32);
            let shaded = fx::mix(v, color, amount([k + 0.5, 2.0 * (r + 0.5)]));
            ink.copy_from_slice(&shaded.to_ne_bytes());
        }
    }
    Ok(ByteVec(out))
}

/// Cells (`texts`, and `colors`, each one's foreground then background),
/// `cols` across, drawn `cell-w` by `cell-h` pixels each with the effect
/// at `progress`, as a PNG; #f if one has a character the raster does not
/// draw (fx/raster.rs).
#[chez::procedure(name = "fx-raster")]
#[allow(clippy::too_many_arguments)]
fn fx_raster(
    texts: Vec<String>,
    colors: Vec<u32>,
    cols: usize,
    cell_w: usize,
    cell_h: usize,
    kind: u32,
    params: Vec<f64>,
    color: u32,
    progress: f64,
) -> Result<Option<ByteVec>, String> {
    if colors.len() != texts.len() * 2 || cols == 0 {
        return Err("fx-raster: a foreground and a background for each cell".into());
    }
    let cells: Vec<fx::raster::Cell> = texts
        .iter()
        .zip(colors.chunks_exact(2))
        .map(|(t, c)| fx::raster::Cell {
            text: t,
            fg: c[0],
            bg: c[1],
        })
        .collect();
    let effect = effect_of(kind, &params, color);
    let Some(rgba) = fx::raster::raster(&cells, cols, [cell_w, cell_h], &effect, progress as f32)
    else {
        return Ok(None);
    };
    let rows = texts.len().div_ceil(cols);
    image::encode_fast((cols * cell_w) as u32, (rows * cell_h) as u32, &rgba)
        .map(|png| Some(ByteVec(png)))
}

// ---------------------------------------------------------------------------
// Editors and clients over iroh (mesh/)

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

/// Starts connecting to the editor `target` names, in the background:
/// mesh-pending-take! has the connection once mesh-pending-fd is readable.
#[chez::procedure(name = "mesh-connect-start")]
fn mesh_connect_start(target: String, local: bool) -> Result<Object<mesh::Pending>, String> {
    mesh::connect_start(&target, local)
        .map(Object)
        .map_err(|e| e.to_string())
}

/// Readable once a connection being made is done.
#[chez::procedure]
fn mesh_pending_fd(p: Ref<mesh::Pending>) -> i32 {
    p.ready.fd()
}

/// The connection, once done (#f before); an error if it failed.
#[chez::procedure(name = "mesh-pending-take!")]
fn mesh_pending_take(p: Ref<mesh::Pending>) -> Result<Option<Object<mesh::Session>>, String> {
    p.take().transpose().map(|s| s.map(Object))
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

// ---------------------------------------------------------------------------
// Voice over iroh (voice/, for core/ext/voice.sls)

/// Whether the client descriptor `fd` is a connection over iroh: a
/// client's of this editor, or this client's to its editor.
#[chez::procedure(name = "voice-link?")]
fn voice_link(fd: i32) -> bool {
    voice::is_link(fd)
}

/// Put the connection `fd` in voice: a client's of this editor, if
/// `member?`, whose speech this editor sends on to everyone else in
/// voice; else this client's to its editor.
#[chez::procedure(name = "voice-join!")]
fn voice_join(fd: i32, member: bool) -> Result<(), String> {
    voice::join(fd, member)
}

/// Take the connection `fd` out of voice.
#[chez::procedure(name = "voice-leave!")]
fn voice_leave(fd: i32) {
    voice::leave(fd);
}

/// This process's person's sound: "on", "muted" (the microphone closed) or
/// "off". An error says why the sound server would not open.
#[chez::procedure(name = "voice-local!")]
fn voice_local(mode: String) -> Result<(), String> {
    voice::set_local(&mode)
}

/// Readable when who is talking changes.
#[chez::procedure]
fn voice_events_fd() -> Result<i32, String> {
    voice::events_fd()
}

/// Who is talking: the descriptors of connections in voice, and -1 for
/// this process's own person.
#[chez::procedure]
fn voice_talking() -> Vec<i32> {
    voice::talking()
}

// MARK: GUI windows (gui/, for core/gui.sls)

/// The font to draw with: `family` (else the system's monospace font) at
/// `points`, with OpenType `features` (HarfBuzz's spellings, separated by
/// spaces or commas), and `fallbacks`, families for what it lacks.
fn font_spec(
    family: String,
    points: f64,
    features: String,
    fallbacks: Vec<String>,
) -> gui::FontSpec {
    gui::FontSpec {
        family,
        points: points as f32,
        features: vec![features],
        fallbacks,
    }
}

/// Open a window `cols` by `rows` cells in size, drawing text in a font
/// (font_spec); its events come from gui-take!, once gui-fd is readable.
#[chez::procedure(name = "gui-open")]
fn gui_open(
    title: String,
    cols: u32,
    rows: u32,
    family: String,
    points: f64,
    features: String,
    fallbacks: Vec<String>,
) -> Result<Object<gui::Gui>, String> {
    let font = font_spec(family, points, features, fallbacks);
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

/// A frame's changes, as core/gui.sls encodes them (see screen.rs's
/// [`screen::Update`]): the screen's rows; whether every row is sent;
/// scrolls (three i32s each: top, bottom, n); the rows sent (four u32s
/// each: the row, and its rectangles, cells and bytes of text, taken in
/// turn from `rects` (gui.slang's Rect, 32 bytes each), `cells` (font/cells.rs's
/// CELL_BYTES each) and `text`); the background, and the color of text
/// left to the terminal's; the cursor, or -1s where it is hidden; and the
/// images placed (keys, and five u32s each, as image.rs's Placement
/// reads them); and the effects placed (fx::Placed::from_numbers's).
#[chez::procedure(name = "gui-frame")]
#[allow(clippy::too_many_arguments)]
fn gui_frame(
    rows: u32,
    whole: bool,
    scrolls: Bytes,
    index: Bytes,
    rects: Bytes,
    cells: Bytes,
    text: Bytes,
    background: u32,
    foreground: u32,
    cursor_row: i32,
    cursor_col: i32,
    image_keys: Vec<String>,
    image_places: Bytes,
    effects: Vec<Vec<f64>>,
) -> Result<Object<screen::Update>, String> {
    let (scrolls, changed) = screen::Update::rows_from(&scrolls, &index, &rects, &cells, &text)?;
    Ok(Object(screen::Update {
        rows,
        whole,
        scrolls,
        changed,
        background,
        foreground,
        cursor: (cursor_row >= 0 && cursor_col >= 0)
            .then_some((cursor_row as u32, cursor_col as u32)),
        placements: image::Placement::parse(image_keys, &image_places)?,
        effects: effects
            .iter()
            .map(|e| fx::Placed::from_numbers(e).ok_or("gui-frame: an effect is 21 numbers"))
            .collect::<Result<_, _>>()?,
    }))
}

/// Paint a frame (gui-frame), which is used up.
#[chez::procedure(name = "gui-paint!")]
fn gui_paint(g: Ref<gui::Gui>, mut frame: RefMut<screen::Update>) {
    g.paint(std::mem::take(&mut *frame));
}

/// Take a PNG, for frames to place by `key`: gui-paint!'s images are
/// placed by key, each over a rectangle of cells (five u32s: row, column,
/// rows, columns, and how many of the rows to draw).
#[chez::procedure(name = "gui-image!")]
fn gui_image(g: Ref<gui::Gui>, key: String, png: Bytes) {
    g.add_image(key, png.to_vec());
}

/// Take a PNG, for frames gui-headless-draw! draws to place by `key`.
#[chez::procedure(name = "gui-headless-image!")]
fn gui_headless_image(
    mut h: RefMut<gui::Snapshots>,
    key: String,
    png: Bytes,
) -> Result<(), String> {
    h.add_image(key, &png)
}

/// Draw frames into images, with no window, in the font `family` (else the
/// system's monospace font) at `points`: for tests, on a GPU or a software
/// renderer (QUAD_GUI_DEVICE=llvmpipe for Mesa's lavapipe). With
/// `system_fonts` false, only the built-in fonts draw, so that images come
/// out the same on every machine.
#[chez::procedure(name = "gui-headless")]
fn gui_headless(
    family: String,
    points: f64,
    system_fonts: bool,
) -> Result<Object<gui::Snapshots>, String> {
    let font = font_spec(family, points, String::new(), Vec::new());
    gui::Snapshots::new(font, system_fonts).map(Object)
}

/// A cell's width and height in pixels, and the device drawing.
#[chez::procedure(name = "gui-headless-info")]
fn gui_headless_info(h: Ref<gui::Snapshots>) -> Vec<String> {
    let [w, hh] = h.cell();
    vec![w.to_string(), hh.to_string(), h.device_name()]
}

/// Draw a frame (gui-frame, which is used up) as a window would, `cols`
/// cells wide: the screen's pixels, RGBA, top row first.
#[chez::procedure(name = "gui-headless-draw!")]
fn gui_headless_draw(
    mut h: RefMut<gui::Snapshots>,
    cols: u32,
    mut frame: RefMut<screen::Update>,
) -> Result<ByteVec, String> {
    h.draw(std::mem::take(&mut *frame), cols).map(ByteVec)
}

#[chez::procedure(name = "gui-set-title!")]
fn gui_set_title(g: Ref<gui::Gui>, title: String) {
    g.set_title(title);
}

/// Whether the window has the system's clipboard.
#[chez::procedure(name = "gui-clipboard?")]
fn gui_has_clipboard(g: Ref<gui::Gui>) -> bool {
    g.has_clipboard
}

/// Whether the window has a primary selection too (Wayland's: macOS has
/// none).
#[chez::procedure(name = "gui-primary-selection?")]
fn gui_has_primary(g: Ref<gui::Gui>) -> bool {
    g.has_primary
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

/// Draw the window's text in another font (font_spec); its grid is sized
/// again for it.
#[chez::procedure(name = "gui-set-font!")]
fn gui_set_font(
    g: Ref<gui::Gui>,
    family: String,
    points: f64,
    features: String,
    fallbacks: Vec<String>,
) {
    g.set_font(font_spec(family, points, features, fallbacks));
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
        blake3, version, timing_mark, png_file_write, png_file_read, make_ticker, ticker_fd, ticker_take,
        rope_new, rope_read, rope_length, rope_line_count, rope_line_start, rope_line_end, rope_line_of, rope_slice,
        rope_insert, rope_remove,
        search_new, search_next, search_prev, search_all,
        project_files, grep_start, grep_fd, grep_take,
        diff_base, diff_base_lines, diff_base_block, diff_hunks,
        fx_easing_names, fx_sample, fx_shade_cells, fx_raster,
        spawn_process, launch_process, process_input_fd, process_output_fd,
        command_start, command_fd, command_take,
        process_close_input, process_status, process_stop,
        mesh_host_start, mesh_host_fd, mesh_host_take, mesh_host_info,
        mesh_target_kind, mesh_connect, mesh_connect_start, mesh_pending_fd, mesh_pending_take,
        mesh_session_fd, mesh_session_editor,
        voice_link, voice_join, voice_leave, voice_local, voice_events_fd, voice_talking,
        gui_prepare, gui_display, gui_open, gui_fd, gui_take, gui_frame, gui_paint, gui_image, gui_set_title, gui_close,
        gui_headless, gui_headless_info, gui_headless_draw, gui_headless_image,
        gui_has_clipboard, gui_has_primary, gui_clipboard_set, gui_clipboard_get, gui_set_font, gui_set_pointer,
    }
}

/// Register `(quad native)`'s procedures with Chez Scheme: the kernel calls
/// this once the heap is built.
#[unsafe(no_mangle)]
pub extern "C" fn quad_native_register() {
    chez::quiet_panics();
    native().register();
}
