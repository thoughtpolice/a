// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The windows' thread: winit's event loop, which all of a process's
//! windows share, and what it does with Scheme's requests and the
//! windows' events.

use super::*;

/// The thread every window of this process runs on, the main one
/// (main_thread.rs): its event loop starts for the first window, and runs
/// for as long as the process does, since winit allows a process one.
pub(super) struct System {
    pub(super) proxy: Mutex<EventLoopProxy<Request>>,
    pub(super) has_clipboard: bool,
    pub(super) has_primary: bool,
}

impl System {
    pub(super) fn send(&self, request: Request) -> Result<(), String> {
        self.proxy
            .lock()
            .unwrap()
            .send_event(request)
            .map_err(|_| "the windows' thread stopped".to_string())
    }
}

static SYSTEM: OnceLock<Result<System, String>> = OnceLock::new();

/// The windows' thread, started if it is not yet; where it cannot start
/// (no display), it never will.
pub(super) fn system() -> Result<&'static System, String> {
    SYSTEM
        .get_or_init(|| {
            if no_display() {
                return Err("there is no display to open a window on".into());
            }
            // The device, while the event loop and the window are made.
            crate::render::prepare();
            let (ready, started) = mpsc::channel();
            start(ready)?;
            started
                .recv()
                .unwrap_or_else(|_| Err("the windows' thread stopped".into()))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The windows' event loop, if it has started.
pub(super) fn started() -> Option<&'static System> {
    SYSTEM.get()?.as_ref().ok()
}

/// Runs the event loop on the main thread.
fn start(ready: mpsc::Sender<Result<System, String>>) -> Result<(), String> {
    crate::main_thread::run(move || run(ready))
}

pub(super) fn run(ready: mpsc::Sender<Result<System, String>>) {
    let mut builder = EventLoop::<Request>::with_user_event();
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("QUAD_GUI_X11").is_some_and(|v| v == "1") {
            builder.with_x11();
        } else if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            builder.with_wayland();
        }
    }
    #[cfg(target_os = "macos")]
    {
        // The menu is ours (macos.rs): winit's quits the process at once.
        use winit::platform::macos::EventLoopBuilderExtMacOS;
        builder.with_default_menu(false);
    }
    let event_loop = match builder.build() {
        Ok(event_loop) => event_loop,
        Err(error) => {
            let _ = ready.send(Err(format!("cannot open a display: {error}")));
            return;
        }
    };
    let clipboard = Clipboard::new(&event_loop);
    let _ = ready.send(Ok(System {
        proxy: Mutex::new(event_loop.create_proxy()),
        has_clipboard: clipboard.has_clipboard(),
        has_primary: clipboard.has_primary(),
    }));
    let mut windows = Windows {
        proxy: event_loop.create_proxy(),
        open: HashMap::new(),
        ids: HashMap::new(),
        gpu: None,
        clipboard,
        #[cfg(target_os = "macos")]
        menu: None,
    };
    let _ = event_loop.run_app(&mut windows);
}

/// The display's clipboard and primary selection: Wayland's, through its
/// connection.
#[cfg(target_os = "linux")]
pub(super) struct Clipboard(Option<smithay_clipboard::Clipboard>);

#[cfg(target_os = "linux")]
impl Clipboard {
    fn new(event_loop: &EventLoop<Request>) -> Clipboard {
        Clipboard(match event_loop.display_handle().map(|d| d.as_raw()) {
            // SAFETY: the display outlives the clipboard, which `windows`
            // holds and drops before the event loop.
            Ok(RawDisplayHandle::Wayland(d)) => {
                Some(unsafe { smithay_clipboard::Clipboard::new(d.display.as_ptr()) })
            }
            _ => None,
        })
    }

    fn has_clipboard(&self) -> bool {
        self.0.is_some()
    }

    fn has_primary(&self) -> bool {
        self.0.is_some()
    }

    /// Puts text on the clipboard ("c") or the primary selection ("p").
    fn store(&self, target: &str, text: String) {
        if let Some(clipboard) = &self.0 {
            if target == "p" {
                clipboard.store_primary(text);
            } else {
                clipboard.store(text);
            }
        }
    }

    /// What is on the clipboard ("c") or the primary selection ("p").
    fn load(&self, target: &str) -> Option<String> {
        let clipboard = self.0.as_ref()?;
        if target == "p" {
            clipboard.load_primary()
        } else {
            clipboard.load()
        }
        .ok()
    }
}

#[cfg(target_os = "macos")]
use super::macos::Clipboard;

// Fields drop in order: the windows (and their renderers) before the device
// they share, and the clipboard before the display.
pub(super) struct Windows {
    /// For screen readers' requests, which AccessKit sends as requests.
    pub(super) proxy: EventLoopProxy<Request>,
    pub(super) open: HashMap<u64, Win>,
    pub(super) ids: HashMap<WindowId, u64>,
    pub(super) gpu: Option<Rc<Gpu>>,
    pub(super) clipboard: Clipboard,
    /// The application's menu, once it has launched.
    #[cfg(target_os = "macos")]
    pub(super) menu: Option<super::macos::Menu>,
}

impl Windows {
    pub(super) fn open_window(
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
        let fonts = Fonts::new(&font, font_scale(1.0))?;
        let [w, h] = fonts.metrics.cell;
        let pad = 2.0 * f64::from(fonts.metrics.padding);
        // Shown once AccessKit's adapter is made, as it must be.
        let attributes = Window::default_attributes()
            .with_visible(false)
            .with_title(title.clone())
            .with_inner_size(LogicalSize::new(
                f64::from(size.0) * f64::from(w) + pad,
                f64::from(size.1) * f64::from(h) + pad,
            ));
        // The app id (Wayland) and class (X11): what launchers and the
        // compositor match to dist/quad.desktop.
        #[cfg(target_os = "linux")]
        let attributes = attributes.with_name("quad", "quad");
        let window = Arc::new(
            event_loop
                .create_window(attributes)
                .map_err(|e| format!("cannot create a window: {e}"))?,
        );
        timing::mark("window made");
        let access = Access::new(event_loop, &window, self.proxy.clone());
        let renderer = Renderer::new(&window, &mut self.gpu)?;
        timing::mark("renderer made");
        window.set_visible(true);
        // Input methods (and their text being composed) and compose
        // sequences.
        window.set_ime_allowed(true);
        let size = window.inner_size();
        let id = window.id();
        let mut win = Win {
            renderer,
            window,
            access,
            title,
            events,
            fonts,
            screen: Screen::default(),
            damage: None,
            images: Images::default(),
            pixels: FramePixels::default(),
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
    pub(super) fn close(&mut self, key: u64) -> Option<Sender<Event>> {
        let win = self.open.remove(&key)?;
        self.ids.remove(&win.window.id());
        Some(win.events.clone())
    }
}

impl ApplicationHandler<Request> for Windows {
    // Windows open when Scheme asks. On macOS, the application has launched
    // by now, and has a menu bar to put the menu in.
    fn resumed(&mut self, _: &ActiveEventLoop) {
        #[cfg(target_os = "macos")]
        if self.menu.is_none() {
            self.menu = super::macos::Menu::install(self.proxy.clone());
        }
    }

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
            Request::Paint(key, update) => {
                if let Some(win) = self.open.get_mut(&key) {
                    win.paint(update);
                }
            }
            Request::Title(key, title) => {
                if let Some(win) = self.open.get_mut(&key) {
                    win.window.set_title(&title);
                    win.title = title;
                    win.tell_access_all();
                }
            }
            Request::SetFont(key, font) => {
                if let Some(win) = self.open.get_mut(&key) {
                    win.set_font(font);
                }
            }
            Request::Image(key, image, png) => {
                if let Some(win) = self.open.get_mut(&key) {
                    if let Err(error) = win.images.add(image, &png) {
                        win.send(Event::Error(error));
                    }
                }
            }
            Request::Pointer(key, shape) => {
                if let Some(win) = self.open.get(&key) {
                    win.window
                        .set_cursor(shape.parse::<CursorIcon>().unwrap_or_default());
                }
            }
            Request::ClipboardSet { target, text } => self.clipboard.store(&target, text),
            Request::ClipboardGet { key, target } => {
                // Nothing on it (or no clipboard) reads as empty.
                let text = self.clipboard.load(&target).unwrap_or_default();
                if let Some(win) = self.open.get(&key) {
                    win.send(Event::Clipboard { target, text });
                }
            }
            Request::Access(event) => {
                let key = self.ids.get(&event.window_id).copied();
                if let Some(win) = key.and_then(|key| self.open.get_mut(&key)) {
                    // Screen readers only read; there is nothing they ask
                    // the window to do (focus is the terminal's already).
                    if let accesskit_winit::WindowEvent::InitialTreeRequested = event.window_event {
                        win.tell_access_all();
                    }
                }
            }
            Request::Close { key, done } => {
                self.close(key);
                if let Some(done) = done {
                    let _ = done.send(());
                }
            }
            #[cfg(target_os = "macos")]
            Request::CloseAll => {
                let keys: Vec<u64> = self.open.keys().copied().collect();
                for key in keys {
                    if let Some(events) = self.close(key) {
                        let _ = events.send(Event::Closed);
                    }
                }
            }
            Request::Exit(status) => std::process::exit(status),
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
            win.access.process_event(&win.window, &event);
            win.event(event);
        }
    }
}

// Fields drop in order: the renderer before the window it draws to.
