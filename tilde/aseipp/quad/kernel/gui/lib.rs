// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The GUI's window: winit's, on Wayland, X11 or Windows drawn with
//! Vulkan, and on macOS drawn with Metal 4.
//!
//! The GUI is a client of the editor like the terminal is (core/gui.sls):
//! the server draws its frames as cells, and this draws the cells. Windows
//! run on the process's main thread, in its event loop, as AppKit has it on
//! macOS, and Scheme on a thread of its own (main_thread.rs); Scheme sends
//! a window frames to paint ([`Gui::paint`]) and takes what happens to it
//! -- keys, the mouse, a new size, closing -- from a [`Mailbox`], as
//! [`Event`]s in the shape of the client protocol's messages.
//!
//! Nothing here links against Vulkan: ash loads the host's
//! `libvulkan.so.1` when a window opens (`ash::Entry::load`), winit
//! loads `libwayland-client` or `libX11`, and fontique loads fontconfig,
//! so an editor that never opens a window never needs them. They are the
//! host's, and the host's driver loads into this process, so the
//! executable must run on the host's C library (`:quad` does: `host` on
//! chez.standalone). macOS's frameworks are the system's, linked as usual.
//!
//! The renderer has no render passes, descriptor sets or vertex buffers:
//! three pipelines (kernel/render/gui.slang) are given a frame's data by address
//! (render/). A frame is the cells' backgrounds and the cursor, as
//! rectangles Scheme makes; then images; then their text, as glyphs font/
//! lays out and Slug draws from their curves; then underlines. A window
//! keeps its screen (screen.rs): Scheme sends only the rows that changed.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::Duration;

use chez::{IntoScheme, Mailbox, Scope, Sender, Value};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
#[cfg(target_os = "linux")]
use winit::platform::wayland::WindowAttributesExtWayland;
#[cfg(target_os = "linux")]
use winit::platform::x11::EventLoopBuilderExtX11;
#[cfg(target_os = "linux")]
use winit::raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use winit::window::{CursorIcon, Window, WindowId};

use crate::access::Access;
use crate::screen::{Screen, Update};
pub use quad_font::FontSpec;
use quad_font::{Fonts, Layout, Metrics};
use quad_image::{Images, PICTURE_BYTES};
use quad_render::{DrawList, Gpu, Headless, Renderer};
use quad_timing as timing;

mod access;
mod input;
#[cfg(target_os = "macos")]
mod macos;
mod main_thread;
pub mod screen;
mod snapshots;
#[cfg(windows)]
mod win32;
mod window;
mod windows;

use input::*;
pub use snapshots::Snapshots;
use window::*;
use windows::*;

/// Whether a window could open here: a display to show it on. On Linux, a
/// Wayland or X11 display, as the environment names them; on macOS, the
/// window server, which a login session at the Mac reaches and one over ssh
/// does not; on Windows, the desktop, which a desktop session shows and a
/// service or a session over ssh does not. `QUAD_NO_DISPLAY=1` says there
/// is none, wherever there is.
pub fn display_available() -> bool {
    if told_no_display() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        ["WAYLAND_DISPLAY", "DISPLAY"]
            .iter()
            .any(|v| std::env::var_os(v).is_some_and(|s| !s.is_empty()))
    }
    #[cfg(target_os = "macos")]
    {
        macos::window_server()
    }
    #[cfg(windows)]
    {
        win32::interactive()
    }
}

/// Starts making what the first window draws with, where one could open:
/// kernel.c calls this before Scheme boots, in a process started to open a
/// window, so that the device is made while Scheme boots.
#[unsafe(no_mangle)]
pub extern "C" fn quad_gui_prepare_early() {
    if display_available() {
        quad_render::prepare();
    }
}

/// Whether this process is told it has no display (`QUAD_NO_DISPLAY=1`).
fn told_no_display() -> bool {
    std::env::var_os("QUAD_NO_DISPLAY").is_some_and(|v| v == "1")
}

/// Whether no window can open here, known before trying: on macOS, where
/// AppKit cannot reach a window server without a session with it; on
/// Windows, where a window made off the interactive desktop is made, and
/// never seen; and wherever this process is told so. On Linux winit finds
/// out otherwise (a Wayland display passed as WAYLAND_SOCKET, say).
fn no_display() -> bool {
    if cfg!(any(target_os = "macos", windows)) {
        !display_available()
    } else {
        told_no_display()
    }
}

/// Ends the process with `status` from the windows' event loop, which runs
/// on the main thread (main_thread.rs): false where no window has opened,
/// and the event loop does not run.
pub(crate) fn exit_from_windows(status: i32) -> bool {
    started().is_some_and(|system| system.send(Request::Exit(status)).is_ok())
}

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
    Paint(u64, Update),
    /// A PNG, to be placed by its key.
    Image(u64, String, Vec<u8>),
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
    /// A screen reader's request (through AccessKit's adapter).
    Access(accesskit_winit::Event),
    /// Close a window; `done`, if there is one, says when it is gone.
    Close {
        key: u64,
        done: Option<mpsc::Sender<()>>,
    },
    /// Close every window, as its close button would: the menu's Quit.
    #[cfg(target_os = "macos")]
    CloseAll,
    /// End the process with this status, from the main thread: Scheme is
    /// done (main_thread.rs).
    Exit(i32),
}

impl From<accesskit_winit::Event> for Request {
    fn from(event: accesskit_winit::Event) -> Request {
        Request::Access(event)
    }
}

/// An open window, as Scheme holds it. Dropping it closes the window.
pub struct Gui {
    key: u64,
    pub events: Mailbox<Event>,
    /// Whether the window has the system's clipboard (Wayland's, or
    /// macOS's pasteboard).
    pub has_clipboard: bool,
    /// Whether it has a primary selection too (Wayland's).
    pub has_primary: bool,
    closed: bool,
}

impl Gui {
    /// Opens a window `cols` by `rows` cells in size, titled `title`.
    pub fn open(title: String, cols: u32, rows: u32, font: FontSpec) -> Result<Gui, String> {
        Gui::open_window(title, (cols, rows), font).map_err(|error| match toolchain_linked() {
            Some(linker) => format!(
                "{error}\n(this quad runs on {linker}, the toolchain's C library, which cannot load \
                 the host's graphics libraries: use the host-linked one, :quad)"
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
            has_primary: system.has_primary,
            closed: false,
        })
    }

    fn request(&self, request: Request) {
        // Where there is no thread, there is no window to ask.
        if let Ok(system) = system() {
            let _ = system.send(request);
        }
    }

    /// Paints a frame: what changed since the last (screen.rs).
    pub fn paint(&self, update: Update) {
        self.request(Request::Paint(self.key, update));
    }

    /// Takes a PNG, for frames to place by `key` (see image.rs).
    pub fn add_image(&self, key: String, png: Vec<u8>) {
        self.request(Request::Image(self.key, key, png));
    }

    pub fn set_title(&self, title: String) {
        self.request(Request::Title(self.key, title));
    }

    pub fn set_pointer(&self, shape: String) {
        self.request(Request::Pointer(self.key, shape));
    }

    pub fn set_font(&self, font: FontSpec) {
        self.request(Request::SetFont(self.key, font));
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
/// process on it cannot load the host's libraries. (On macOS, the
/// toolchain's C library is the system's.)
fn toolchain_linked() -> Option<String> {
    if cfg!(not(target_os = "linux")) {
        return None;
    }
    let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
    maps.lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .find(|path| path.starts_with("/nix/store/") && path.contains("/ld-linux"))
        .map(str::to_string)
}
