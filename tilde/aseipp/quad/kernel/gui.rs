// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The GUI's window: winit's, on Wayland or X11, drawn with Vulkan.
//!
//! The GUI is a client of the editor like the terminal is (core/gui.sls):
//! the server draws its frames as cells, and this draws the cells. A
//! window runs on a thread of its own, with its event loop; Scheme sends it
//! frames to paint ([`Gui::paint`]) and takes what happens to it -- keys,
//! the mouse, a new size, closing -- from a [`Mailbox`], as [`Event`]s in
//! the shape of the client protocol's messages.
//!
//! Nothing here links against Vulkan: ash loads the host's
//! `libvulkan.so.1` when a window opens ([`ash::Entry::load`]), winit
//! loads `libwayland-client` or `libX11`, and fontique loads fontconfig,
//! so an editor that never opens a window never needs them. They are the
//! host's, and the host's driver loads into this process, so the
//! executable must run on the host's C library (`:quad-host`; `host` on
//! chez.standalone).
//!
//! The renderer is Vulkan 1.3 with no render passes, descriptor sets or
//! vertex buffers: dynamic rendering, and two pipelines (kernel/gui.slang)
//! whose push constants point at a frame's data by buffer device address.
//! A frame is the cells' backgrounds and the cursor, as rectangles Scheme
//! makes; then their text, as glyphs font.rs lays out and Slug draws from
//! their curves; then underlines.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::Duration;

use chez::{IntoScheme, Mailbox, Scope, Sender, Value};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::platform::wayland::EventLoopBuilderExtWayland;
use winit::platform::x11::EventLoopBuilderExtX11;
use winit::raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use winit::window::{CursorIcon, Window, WindowId};

use crate::font::{CELL_BYTES, Fonts, RECT_BYTES};
use crate::render::{DrawList, Gpu, Headless, Renderer};

/// What happens to a window, for Scheme: each is a list, as the client
/// protocol's messages are (core/protocol.sls), which core/gui.sls turns
/// into the editor's events.
pub enum Event {
    /// ("resize" rows cols): the window holds this many cells.
    Resize { rows: u32, cols: u32 },
    /// ("char" "a" mods kind): a key that types a character, as it types
    /// it (shift applied), for `char-key`.
    Char {
        text: String,
        mods: u32,
        kind: &'static str,
    },
    /// ("special" "enter" mods kind): any other key, by the name keymaps
    /// give it, for `special-key`.
    Special {
        name: &'static str,
        mods: u32,
        kind: &'static str,
    },
    /// ("mouse" kind button col row mods), as the protocol has it.
    Mouse {
        kind: &'static str,
        button: u32,
        col: u32,
        row: u32,
        mods: u32,
    },
    /// ("focus" in?).
    Focus(bool),
    /// ("clipboard" target text): the system clipboard's contents ("c"),
    /// or the primary selection's ("p"), as asked for.
    Clipboard { target: String, text: String },
    /// ("dropped" path): a file dropped on the window.
    Dropped(String),
    /// ("closed"): the window was closed, or could not be opened.
    Closed,
    /// ("error" message): what went wrong; ("closed") follows.
    Error(String),
}

impl IntoScheme for Event {
    fn into_scheme(self, s: &Scope) -> chez::Result<Value<'_>> {
        let int = |n: u32| s.integer(i64::from(n));
        Ok(match self {
            Event::Resize { rows, cols } => s.list([s.string("resize"), int(rows), int(cols)]),
            Event::Char { text, mods, kind } => {
                s.list([s.string("char"), s.string(&text), int(mods), s.string(kind)])
            }
            Event::Special { name, mods, kind } => s.list([
                s.string("special"),
                s.string(name),
                int(mods),
                s.string(kind),
            ]),
            Event::Mouse {
                kind,
                button,
                col,
                row,
                mods,
            } => s.list([
                s.string("mouse"),
                s.string(kind),
                int(button),
                int(col),
                int(row),
                int(mods),
            ]),
            Event::Focus(focused) => s.list([s.string("focus"), s.boolean(focused)]),
            Event::Clipboard { target, text } => {
                s.list([s.string("clipboard"), s.string(&target), s.string(&text)])
            }
            Event::Dropped(path) => s.list([s.string("dropped"), s.string(&path)]),
            Event::Closed => s.list([s.string("closed")]),
            Event::Error(message) => s.list([s.string("error"), s.string(&message)]),
        })
    }
}

/// What Scheme asks of the windows' thread, about the window `key` names.
enum Request {
    /// Open a window; `done` says whether it opened.
    Open {
        key: u64,
        title: String,
        size: (u32, u32),
        font: FontSpec,
        events: Sender<Event>,
        done: mpsc::Sender<Result<(), String>>,
    },
    Paint(u64, Frame),
    Title(u64, String),
    /// Draw text in this font.
    SetFont(u64, FontSpec),
    /// Show the pointer so: a CSS cursor name.
    Pointer(u64, String),
    /// Put text on the clipboard ("c") or the primary selection ("p").
    ClipboardSet {
        target: String,
        text: String,
    },
    /// Ask for the clipboard's or primary selection's contents, for a
    /// window.
    ClipboardGet {
        key: u64,
        target: String,
    },
    /// Close a window; `done`, if there is one, says when it is gone.
    Close {
        key: u64,
        done: Option<mpsc::Sender<()>>,
    },
}

/// One frame, as core/gui.sls makes it.
#[derive(Default)]
struct Frame {
    /// Backgrounds and the cursor: [`RECT_BYTES`] each.
    rects: Vec<u8>,
    /// The cells with something to draw: [`CELL_BYTES`] each, with their
    /// texts in `text`.
    cells: Vec<u8>,
    text: Vec<u8>,
    /// 0xRRGGBB, where nothing else is drawn.
    background: u32,
    /// The text's color where cells leave it to the terminal: what text
    /// being composed (an input method's) is drawn in.
    foreground: u32,
    /// Where the cursor is, (row, column), if it is shown.
    cursor: Option<(u32, u32)>,
}

/// The font to draw with.
pub struct FontSpec {
    pub family: String,
    pub points: f32,
}

/// An open window, as Scheme holds it. Dropping it closes the window.
pub struct Gui {
    key: u64,
    pub events: Mailbox<Event>,
    /// Whether the window has the system's clipboard (Wayland's).
    pub has_clipboard: bool,
    closed: bool,
}

impl Gui {
    /// Opens a window `cols` by `rows` cells in size, titled `title`.
    pub fn open(title: String, cols: u32, rows: u32, font: FontSpec) -> Result<Gui, String> {
        Gui::open_window(title, (cols, rows), font).map_err(|error| match toolchain_linked() {
            Some(linker) => format!(
                "{error}\n(this quad runs on {linker}, the toolchain's C library, which cannot load \
                 the host's graphics libraries: use the host-linked one, :quad-host)"
            ),
            None => error,
        })
    }

    fn open_window(title: String, size: (u32, u32), font: FontSpec) -> Result<Gui, String> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let system = system()?;
        let key = NEXT.fetch_add(1, Ordering::Relaxed);
        let (tx, events) = Mailbox::new().map_err(|e| e.to_string())?;
        let (done, opened) = mpsc::channel();
        system.send(Request::Open {
            key,
            title,
            size,
            font,
            events: tx,
            done,
        })?;
        opened
            .recv()
            .map_err(|_| "the windows' thread stopped".to_string())??;
        Ok(Gui {
            key,
            events,
            has_clipboard: system.has_clipboard,
            closed: false,
        })
    }

    fn request(&self, request: Request) {
        // Where there is no thread, there is no window to ask.
        if let Ok(system) = system() {
            let _ = system.send(request);
        }
    }

    /// Paints a frame: `rects` packed as kernel/gui.slang's `Rect`s, then
    /// `cells` (packed as font.rs's [`CELL_BYTES`]) with their `text`, in
    /// `colors` (background, foreground: 0xRRGGBB), with the cursor where
    /// it is shown.
    pub fn paint(
        &self,
        rects: &[u8],
        cells: &[u8],
        text: &[u8],
        colors: (u32, u32),
        cursor: Option<(u32, u32)>,
    ) -> Result<(), String> {
        let (background, foreground) = colors;
        if rects.len() % RECT_BYTES != 0 {
            return Err(format!(
                "gui-paint!: rectangles are {RECT_BYTES} bytes each"
            ));
        }
        if cells.len() % CELL_BYTES != 0 {
            return Err(format!("gui-paint!: cells are {CELL_BYTES} bytes each"));
        }
        let frame = Frame {
            rects: rects.to_vec(),
            cells: cells.to_vec(),
            text: text.to_vec(),
            background,
            foreground,
            cursor,
        };
        self.request(Request::Paint(self.key, frame));
        Ok(())
    }

    pub fn set_title(&self, title: String) {
        self.request(Request::Title(self.key, title));
    }

    pub fn set_pointer(&self, shape: String) {
        self.request(Request::Pointer(self.key, shape));
    }

    pub fn set_font(&self, family: String, points: f32) {
        self.request(Request::SetFont(self.key, FontSpec { family, points }));
    }

    pub fn clipboard_set(&self, target: String, text: String) {
        self.request(Request::ClipboardSet { target, text });
    }

    /// Asks for the clipboard's contents, which come as an
    /// [`Event::Clipboard`].
    pub fn clipboard_get(&self, target: String) {
        self.request(Request::ClipboardGet {
            key: self.key,
            target,
        });
    }

    /// Closes the window, and waits (a while) until it is gone.
    pub fn close(&mut self) {
        if !self.closed {
            self.closed = true;
            let (done, gone) = mpsc::channel();
            self.request(Request::Close {
                key: self.key,
                done: Some(done),
            });
            let _ = gone.recv_timeout(Duration::from_secs(2));
        }
    }
}

impl Drop for Gui {
    fn drop(&mut self) {
        if !self.closed {
            self.request(Request::Close {
                key: self.key,
                done: None,
            });
        }
    }
}

/// The dynamic linker this process runs on, if it is a Nix store's: a
/// process on it cannot load the host's libraries.
fn toolchain_linked() -> Option<String> {
    let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
    maps.lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .find(|path| path.starts_with("/nix/store/") && path.contains("/ld-linux"))
        .map(str::to_string)
}

// MARK: The windows' thread

/// The thread every window of this process runs on: started for the first
/// one, it runs for as long as the process does, since winit allows a
/// process one event loop.
struct System {
    proxy: Mutex<EventLoopProxy<Request>>,
    has_clipboard: bool,
}

impl System {
    fn send(&self, request: Request) -> Result<(), String> {
        self.proxy
            .lock()
            .unwrap()
            .send_event(request)
            .map_err(|_| "the windows' thread stopped".to_string())
    }
}

/// The windows' thread, started if it is not yet; where it cannot start
/// (no display), it never will.
fn system() -> Result<&'static System, String> {
    static SYSTEM: OnceLock<Result<System, String>> = OnceLock::new();
    SYSTEM
        .get_or_init(|| {
            let (ready, started) = mpsc::channel();
            std::thread::Builder::new()
                .name("quad-gui".into())
                .spawn(move || run(ready))
                .map_err(|e| e.to_string())?;
            started
                .recv()
                .unwrap_or_else(|_| Err("the windows' thread stopped".into()))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn run(ready: mpsc::Sender<Result<System, String>>) {
    let mut builder = EventLoop::<Request>::with_user_event();
    // Scheme has the main thread; this one is the windows'.
    EventLoopBuilderExtWayland::with_any_thread(&mut builder, true);
    EventLoopBuilderExtX11::with_any_thread(&mut builder, true);
    if std::env::var_os("QUAD_GUI_X11").is_some_and(|v| v == "1") {
        builder.with_x11();
    } else if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        builder.with_wayland();
    }
    let event_loop = match builder.build() {
        Ok(event_loop) => event_loop,
        Err(error) => {
            let _ = ready.send(Err(format!("cannot open a display: {error}")));
            return;
        }
    };
    // The clipboard is the display's: on Wayland, through its connection.
    let clipboard = match event_loop.display_handle().map(|d| d.as_raw()) {
        // SAFETY: the display outlives the clipboard, which `windows` holds
        // and drops before the event loop.
        Ok(RawDisplayHandle::Wayland(d)) => {
            Some(unsafe { smithay_clipboard::Clipboard::new(d.display.as_ptr()) })
        }
        _ => None,
    };
    let _ = ready.send(Ok(System {
        proxy: Mutex::new(event_loop.create_proxy()),
        has_clipboard: clipboard.is_some(),
    }));
    let mut windows = Windows {
        open: HashMap::new(),
        ids: HashMap::new(),
        gpu: None,
        clipboard,
    };
    let _ = event_loop.run_app(&mut windows);
}

// Fields drop in order: the windows (and their renderers) before the device
// they share, and the clipboard before the display.
struct Windows {
    open: HashMap<u64, Win>,
    ids: HashMap<WindowId, u64>,
    gpu: Option<Rc<Gpu>>,
    clipboard: Option<smithay_clipboard::Clipboard>,
}

impl Windows {
    fn open_window(
        &mut self,
        event_loop: &ActiveEventLoop,
        key: u64,
        title: String,
        size: (u32, u32),
        font: FontSpec,
        events: Sender<Event>,
    ) -> Result<(), String> {
        // At a scale of 1 until the window says what it has: its cells are
        // logical pixels.
        let fonts = Fonts::new(&font.family, font.points, 1.0)?;
        let [w, h] = fonts.metrics.cell;
        let pad = 2.0 * f64::from(fonts.metrics.padding);
        let attributes = Window::default_attributes()
            .with_title(title)
            .with_inner_size(LogicalSize::new(
                f64::from(size.0) * f64::from(w) + pad,
                f64::from(size.1) * f64::from(h) + pad,
            ));
        let window = event_loop
            .create_window(attributes)
            .map_err(|e| format!("cannot create a window: {e}"))?;
        let renderer = Renderer::new(&window, &mut self.gpu)?;
        // Input methods (and their text being composed) and compose
        // sequences.
        window.set_ime_allowed(true);
        let size = window.inner_size();
        let id = window.id();
        let mut win = Win {
            renderer,
            window,
            events,
            fonts,
            frame: Frame::default(),
            grid: (0, 0),
            modifiers: ModifiersState::empty(),
            preedit: String::new(),
            pointer: None,
            held: None,
            scroll: 0.0,
        };
        win.resized(size);
        self.ids.insert(id, key);
        self.open.insert(key, win);
        Ok(())
    }

    /// Closes a window, returning where its events went.
    fn close(&mut self, key: u64) -> Option<Sender<Event>> {
        let win = self.open.remove(&key)?;
        self.ids.remove(&win.window.id());
        Some(win.events.clone())
    }
}

impl ApplicationHandler<Request> for Windows {
    // Windows open when Scheme asks.
    fn resumed(&mut self, _: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, request: Request) {
        match request {
            Request::Open {
                key,
                title,
                size,
                font,
                events,
                done,
            } => {
                let _ = done.send(self.open_window(event_loop, key, title, size, font, events));
            }
            Request::Paint(key, frame) => {
                if let Some(win) = self.open.get_mut(&key) {
                    win.paint(frame);
                }
            }
            Request::Title(key, title) => {
                if let Some(win) = self.open.get(&key) {
                    win.window.set_title(&title);
                }
            }
            Request::SetFont(key, font) => {
                if let Some(win) = self.open.get_mut(&key) {
                    win.set_font(font);
                }
            }
            Request::Pointer(key, shape) => {
                if let Some(win) = self.open.get(&key) {
                    win.window
                        .set_cursor(shape.parse::<CursorIcon>().unwrap_or_default());
                }
            }
            Request::ClipboardSet { target, text } => {
                if let Some(clipboard) = &self.clipboard {
                    if target == "p" {
                        clipboard.store_primary(text);
                    } else {
                        clipboard.store(text);
                    }
                }
            }
            Request::ClipboardGet { key, target } => {
                // Nothing on it (or no clipboard) reads as empty.
                let text = self
                    .clipboard
                    .as_ref()
                    .and_then(|c| {
                        if target == "p" {
                            c.load_primary()
                        } else {
                            c.load()
                        }
                        .ok()
                    })
                    .unwrap_or_default();
                if let Some(win) = self.open.get(&key) {
                    win.send(Event::Clipboard { target, text });
                }
            }
            Request::Close { key, done } => {
                self.close(key);
                if let Some(done) = done {
                    let _ = done.send(());
                }
            }
        }
    }

    fn window_event(&mut self, _: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(&key) = self.ids.get(&id) else {
            return;
        };
        if let WindowEvent::CloseRequested = event {
            if let Some(events) = self.close(key) {
                let _ = events.send(Event::Closed);
            }
        } else if let Some(win) = self.open.get_mut(&key) {
            win.event(event);
        }
    }
}

// Fields drop in order: the renderer before the window it draws to.
struct Win {
    renderer: Renderer,
    window: Window,
    events: Sender<Event>,
    fonts: Fonts,
    frame: Frame,
    /// Cells the window holds, (rows, cols), as last told to Scheme.
    grid: (u32, u32),
    modifiers: ModifiersState,
    /// What an input method has composed so far, not yet committed.
    preedit: String,
    /// The cell under the pointer, (col, row).
    pointer: Option<(u32, u32)>,
    /// The mouse button held down, for drags.
    held: Option<u32>,
    /// Pixels scrolled that do not yet make a line.
    scroll: f64,
}

impl Win {
    fn send(&self, event: Event) {
        let _ = self.events.send(event);
    }

    // Drawn at the compositor's next frame callback: a burst of frames
    // (key repeat, scrolling) is one frame per refresh, and a window no
    // one can see draws nothing. Snapshots draw at once, since a hidden
    // window gets no callbacks.
    fn paint(&mut self, frame: Frame) {
        self.frame = frame;
        if std::env::var_os("QUAD_GUI_SNAPSHOT").is_some() {
            self.draw();
        } else {
            self.window.request_redraw();
        }
    }

    fn set_font(&mut self, font: FontSpec) {
        if let Err(error) = self.fonts.set_font(&font.family, font.points) {
            self.send(Event::Error(error));
        }
        // The grid holds as many cells of the new size as fit.
        self.grid = (0, 0);
        self.resized(self.window.inner_size());
        self.window.request_redraw();
    }

    fn event(&mut self, event: WindowEvent) {
        match event {
            WindowEvent::Resized(size) => self.resized(size),
            WindowEvent::ScaleFactorChanged { .. } => self.resized(self.window.inner_size()),
            WindowEvent::RedrawRequested => self.draw(),
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
                // What the pointer is over can depend on them: ctrl
                // makes a link under it one to follow.
                if self.held.is_none() {
                    self.mouse("move", 0);
                }
            }
            WindowEvent::KeyboardInput { event, .. } => self.key(&event),
            WindowEvent::Ime(ime) => self.ime(ime),
            WindowEvent::DroppedFile(path) => {
                self.send(Event::Dropped(path.to_string_lossy().into_owned()))
            }
            WindowEvent::Focused(focused) => self.send(Event::Focus(focused)),
            WindowEvent::CursorMoved { position, .. } => self.pointer_moved(position),
            WindowEvent::CursorLeft { .. } => {
                // A move to a cell past the screen: the pointer is over
                // nothing of the editor's.
                if self.held.is_none() {
                    self.pointer = Some((u32::MAX, u32::MAX));
                    self.mouse("move", 0);
                }
                self.pointer = None;
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let button = match button {
                    MouseButton::Left => 0,
                    MouseButton::Middle => 1,
                    MouseButton::Right => 2,
                    _ => return,
                };
                if state == ElementState::Pressed {
                    self.held = Some(button);
                    self.mouse("press", button);
                } else {
                    self.held = None;
                    self.mouse("release", button);
                }
            }
            WindowEvent::MouseWheel { delta, .. } => self.wheel(delta),
            _ => {}
        }
    }

    /// A cell's size in pixels.
    fn cell(&self) -> (f64, f64) {
        let [w, h] = self.fonts.metrics.cell;
        (f64::from(w), f64::from(h))
    }

    fn resized(&mut self, size: PhysicalSize<u32>) {
        if self.fonts.set_scale(self.window.scale_factor() as f32) {
            self.window.request_redraw();
        }
        let (w, h) = self.cell();
        let pad = 2.0 * f64::from(self.fonts.metrics.padding);
        let grid = (
            (((f64::from(size.height) - pad) / h) as u32).max(1),
            (((f64::from(size.width) - pad) / w) as u32).max(1),
        );
        self.renderer.resize(size);
        if grid != self.grid {
            self.grid = grid;
            self.send(Event::Resize {
                rows: grid.0,
                cols: grid.1,
            });
        }
    }

    fn mods(&self) -> u32 {
        let m = self.modifiers;
        // As (quad event) has them: shift 1, alt 2, ctrl 4, super 8.
        u32::from(m.shift_key())
            | u32::from(m.alt_key()) << 1
            | u32::from(m.control_key()) << 2
            | u32::from(m.super_key()) << 3
    }

    fn key(&self, event: &KeyEvent) {
        use winit::platform::modifier_supplement::KeyEventExtModifierSupplement;
        if event.state == ElementState::Released {
            return;
        }
        let kind = if event.repeat { "repeat" } else { "press" };
        let mods = self.mods();
        // What a key types, where it types something: a composed
        // character after a dead key or the compose key, or the key's own.
        // Keys with ctrl, alt or super are commands, named by the key.
        if mods & !SHIFT == 0 {
            if let Some(text) = event
                .text
                .as_deref()
                .filter(|t| !t.chars().any(char::is_control))
            {
                self.type_text(text, mods, kind);
                return;
            }
        }
        match &event.logical_key {
            Key::Named(NamedKey::Space) => self.send(Event::Char {
                text: " ".into(),
                mods,
                kind,
            }),
            Key::Named(named) => {
                if let Some(name) = key_name(*named) {
                    self.send(Event::Special { name, mods, kind });
                }
            }
            Key::Character(text) => {
                // Control keys come as control characters on some layouts:
                // the key's own character is the one keymaps name.
                let text = if text.chars().all(char::is_control) {
                    match event.key_without_modifiers() {
                        Key::Character(plain) => plain.to_string(),
                        _ => return,
                    }
                } else {
                    text.to_string()
                };
                if text.chars().count() == 1 {
                    self.send(Event::Char { text, mods, kind });
                }
            }
            _ => {}
        }
    }

    /// Text typed, a character at a time, as keys that type it.
    fn type_text(&self, text: &str, mods: u32, kind: &'static str) {
        for c in text.chars() {
            self.send(Event::Char {
                text: c.to_string(),
                mods,
                kind,
            });
        }
    }

    /// What an input method says: text composed so far (drawn at the
    /// cursor), and text it commits (typed).
    fn ime(&mut self, ime: Ime) {
        match ime {
            Ime::Preedit(text, _) => self.preedit = text,
            Ime::Commit(text) => {
                self.preedit.clear();
                self.type_text(&text, 0, "press");
            }
            Ime::Enabled | Ime::Disabled => self.preedit.clear(),
        }
        self.window.request_redraw();
    }

    fn pointer_moved(&mut self, position: PhysicalPosition<f64>) {
        let (w, h) = self.cell();
        let pad = f64::from(self.fonts.metrics.padding);
        let cell = (
            ((position.x - pad).max(0.0) / w) as u32,
            ((position.y - pad).max(0.0) / h) as u32,
        );
        if self.pointer != Some(cell) {
            self.pointer = Some(cell);
            match self.held {
                Some(button) => self.mouse("drag", button),
                // For the pointer's shape over what is there.
                None => self.mouse("move", 0),
            }
        }
    }

    fn mouse(&self, kind: &'static str, button: u32) {
        if let Some((col, row)) = self.pointer {
            self.send(Event::Mouse {
                kind,
                button,
                col,
                row,
                mods: self.mods(),
            });
        }
    }

    fn wheel(&mut self, delta: MouseScrollDelta) {
        let lines = match delta {
            MouseScrollDelta::LineDelta(_, y) => f64::from(y),
            MouseScrollDelta::PixelDelta(p) => {
                self.scroll += p.y;
                let lines = (self.scroll / self.cell().1).trunc();
                self.scroll -= lines * self.cell().1;
                lines
            }
        };
        let kind = if lines > 0.0 {
            "scroll-up"
        } else {
            "scroll-down"
        };
        for _ in 0..(lines.abs() as u32) {
            self.mouse(kind, 0);
        }
    }

    fn draw(&mut self) {
        // Text being composed covers the cells after the cursor.
        let preedit = match self.frame.cursor {
            Some(cursor) if !self.preedit.is_empty() => Some(preedit_cells(
                &self.preedit,
                cursor,
                self.frame.foreground,
                self.frame.background,
                self.frame.text.len(),
            )),
            _ => None,
        };
        let (rects, glyphs, decorations) = match &preedit {
            Some((rects, cells, text)) => {
                let mut all_cells = self.frame.cells.clone();
                all_cells.extend_from_slice(cells);
                let mut all_text = self.frame.text.clone();
                all_text.extend_from_slice(text);
                let mut all_rects = self.frame.rects.clone();
                all_rects.extend_from_slice(rects);
                let (glyphs, decorations) = self.fonts.layout(&all_cells, &all_text);
                (std::borrow::Cow::Owned(all_rects), glyphs, decorations)
            }
            None => {
                let (glyphs, decorations) = self.fonts.layout(&self.frame.cells, &self.frame.text);
                (
                    std::borrow::Cow::Borrowed(&self.frame.rects[..]),
                    glyphs,
                    decorations,
                )
            }
        };
        // The input method's candidates go by the cursor.
        if let Some((row, col)) = self.frame.cursor {
            let window = &self.window;
            let [w, h] = self.fonts.metrics.cell;
            let pad = self.fonts.metrics.padding;
            window.set_ime_cursor_area(
                PhysicalPosition::new(pad + col as f32 * w, pad + row as f32 * h),
                PhysicalSize::new(w, h),
            );
        }
        let list = DrawList {
            rects: &rects,
            glyphs: &glyphs,
            decorations: &decorations,
            atlas: &self.fonts.atlas,
            background: self.frame.background,
            cell: self.fonts.metrics.cell,
            origin: [self.fonts.metrics.padding; 2],
        };
        // Before presenting, so that Wayland asks the compositor for the
        // frame callback that paces the next request_redraw.
        self.window.pre_present_notify();
        match self.renderer.draw(&list) {
            Ok(true) => {}
            // Again at the compositor's next frame callback, which comes
            // once the window can be seen.
            Ok(false) => self.window.request_redraw(),
            Err(error) => self.send(Event::Error(error)),
        }
    }
}

/// Shift, as (quad event) has it; the other modifiers are alt (2), ctrl
/// (4) and super (8).
const SHIFT: u32 = 1;

/// Text an input method is composing, drawn over the cells from `cursor`
/// on as a terminal would show it: underlined, in `foreground` on
/// `background`. Returns rectangles (its background), cells (as font.rs
/// reads them) and their text, which follows `text_offset` bytes of
/// others'.
fn preedit_cells(
    preedit: &str,
    (row, col): (u32, u32),
    foreground: u32,
    background: u32,
    text_offset: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    use unicode_width::UnicodeWidthChar;
    let (mut rects, mut cells, mut text) = (Vec::new(), Vec::new(), Vec::new());
    let mut at = col;
    for c in preedit.chars() {
        let width = c.width().unwrap_or(0) as u32;
        if width == 0 {
            continue;
        }
        let start = (text_offset + text.len()) as u32;
        let mut buf = [0; 4];
        text.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        // Underlined (4).
        for v in [
            row << 16 | at,
            width << 16 | 4,
            0xff00_0000 | foreground,
            background,
            0,
            start,
            c.len_utf8() as u32,
        ] {
            cells.extend_from_slice(&v.to_ne_bytes());
        }
        at += width;
    }
    for v in [col as f32, row as f32, (at - col) as f32, 1.0] {
        rects.extend_from_slice(&v.to_ne_bytes());
    }
    for v in [0xff00_0000 | background, 0, 0, 0] {
        rects.extend_from_slice(&v.to_ne_bytes());
    }
    (rects, cells, text)
}

/// The name keymaps give a key (core/term.sls names them the same), or
/// None for keys the editor does not take (modifiers on their own).
fn key_name(key: NamedKey) -> Option<&'static str> {
    Some(match key {
        NamedKey::Enter => "enter",
        NamedKey::Escape => "esc",
        NamedKey::Tab => "tab",
        NamedKey::Backspace => "backspace",
        NamedKey::Delete => "delete",
        NamedKey::Insert => "insert",
        NamedKey::ArrowLeft => "left",
        NamedKey::ArrowRight => "right",
        NamedKey::ArrowUp => "up",
        NamedKey::ArrowDown => "down",
        NamedKey::Home => "home",
        NamedKey::End => "end",
        NamedKey::PageUp => "pageup",
        NamedKey::PageDown => "pagedown",
        NamedKey::F1 => "f1",
        NamedKey::F2 => "f2",
        NamedKey::F3 => "f3",
        NamedKey::F4 => "f4",
        NamedKey::F5 => "f5",
        NamedKey::F6 => "f6",
        NamedKey::F7 => "f7",
        NamedKey::F8 => "f8",
        NamedKey::F9 => "f9",
        NamedKey::F10 => "f10",
        NamedKey::F11 => "f11",
        NamedKey::F12 => "f12",
        _ => return None,
    })
}

// MARK: Without a window

/// Frames drawn into images, with no window: what a window would show, for
/// tests and snapshots (see render.rs's [`Headless`]).
pub struct Snapshots {
    fonts: Fonts,
    gpu: Headless,
}

impl Snapshots {
    pub fn new(font: FontSpec) -> Result<Snapshots, String> {
        let fonts = Fonts::new(&font.family, font.points, 1.0)?;
        let gpu = Headless::new()?;
        Ok(Snapshots { fonts, gpu })
    }

    /// A cell's size, in pixels.
    pub fn cell(&self) -> [f32; 2] {
        self.fonts.metrics.cell
    }

    pub fn device_name(&self) -> String {
        self.gpu.device_name()
    }

    /// Draws a frame of `cols` by `rows` cells, as [`Gui::paint`] takes
    /// it; returns its pixels, RGBA, top row first.
    pub fn draw(
        &mut self,
        rects: &[u8],
        cells: &[u8],
        text: &[u8],
        background: u32,
        cols: u32,
        rows: u32,
    ) -> Result<Vec<u8>, String> {
        if rects.len() % RECT_BYTES != 0 || cells.len() % CELL_BYTES != 0 {
            return Err(format!(
                "rectangles are {RECT_BYTES} bytes each, and cells {CELL_BYTES}"
            ));
        }
        let (glyphs, decorations) = self.fonts.layout(cells, text);
        let [w, h] = self.fonts.metrics.cell;
        let list = DrawList {
            rects,
            glyphs: &glyphs,
            decorations: &decorations,
            atlas: &self.fonts.atlas,
            background,
            cell: [w, h],
            // Frames as the grid is, with no padding around them.
            origin: [0.0, 0.0],
        };
        self.gpu.draw(&list, cols * w as u32, rows * h as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_being_composed_covers_the_cells_after_the_cursor() {
        let (rects, cells, text) = preedit_cells("にほ", (3, 5), 0x00ffffff, 0x00102030, 7);
        assert_eq!(text, "にほ".as_bytes());
        // Two wide cells, from column 5, underlined, after 7 bytes of text.
        let words: Vec<u32> = cells
            .chunks_exact(4)
            .map(|w| u32::from_ne_bytes(w.try_into().unwrap()))
            .collect();
        assert_eq!(
            words[..7],
            [3 << 16 | 5, 2 << 16 | 4, 0xffffffff, 0x102030, 0, 7, 3]
        );
        assert_eq!(words[7..9], [3 << 16 | 7, 2 << 16 | 4]);
        assert_eq!(words[12], 10);
        // One background rectangle over the four columns.
        let bounds: Vec<f32> = rects[..16]
            .chunks_exact(4)
            .map(|w| f32::from_ne_bytes(w.try_into().unwrap()))
            .collect();
        assert_eq!(bounds, [5.0, 3.0, 4.0, 1.0]);
    }
}
