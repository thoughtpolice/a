// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! depot: <nogfx/window.hpp>'s window on Linux, which upstream does not have,
//! through winit: Wayland, or X11 (through Xlib) where there is no
//! Wayland compositor or `NOGRAPHICSAPI_X11=1` asks for it. winit loads
//! libwayland-client and libX11 at run time.
//!
//! The C ABI here is what `window.cpp` needs to implement `open_window` and
//! friends: open a window, hand out the
//! native handles a Vulkan surface is made from, pump its events (keeping
//! its size current, which a Wayland swapchain is sized from), and close it.
//! All of it runs on the thread that opened the window.

use std::ffi::{CStr, c_char, c_void};
use std::ptr;
use std::time::Duration;

use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalSize};
use winit::event::{ElementState, KeyEvent, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};
use winit::platform::wayland::EventLoopBuilderExtWayland;
use winit::platform::x11::EventLoopBuilderExtX11;
use winit::raw_window_handle::{
    HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use winit::window::{Window, WindowAttributes, WindowId};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// What NoGraphicsAPI's `LinuxWindow` needs; `platform` is its
/// `LinuxWindow::Platform` (0 for Wayland, 1 for Xlib).
#[repr(C)]
pub struct NativeWindow {
    platform: u32,
    display: *mut c_void,
    wayland_surface: *mut c_void,
    xlib_window: u64,
}

struct App {
    attributes: Option<WindowAttributes>,
    window: Option<Window>,
    size: PhysicalSize<u32>,
    open: bool,
}

impl ApplicationHandler for App {
    // winit creates windows once the event loop runs, which it starts doing
    // on the first pump.
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let Some(attributes) = self.attributes.take() else {
            return;
        };
        match event_loop.create_window(attributes) {
            Ok(window) => {
                self.size = window.inner_size();
                self.window = Some(window);
            }
            Err(error) => {
                eprintln!("nogfx: cannot create a window: {error}");
                self.open = false;
            }
        }
    }

    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested
            | WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        logical_key: Key::Named(NamedKey::Escape),
                        state: ElementState::Pressed,
                        ..
                    },
                ..
            } => self.open = false,
            WindowEvent::Resized(size) => self.size = size,
            _ => {}
        }
    }
}

// Fields drop in order: the window (in `app`) before its event loop.
pub struct WinitWindow {
    app: App,
    event_loop: EventLoop<()>,
}

impl WinitWindow {
    fn pump(&mut self, timeout: Option<Duration>) -> bool {
        if let PumpStatus::Exit(_) = self.event_loop.pump_app_events(timeout, &mut self.app) {
            self.app.open = false;
        }
        self.app.open
    }
}

/// Opens a window of `width` by `height` logical pixels, or returns null
/// (having said why on stderr).
///
/// # Safety
///
/// `title` must be a NUL-terminated string. Call this, and the others with
/// the window it returns, from one thread.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nogfx_window_open(
    title: *const c_char,
    width: u32,
    height: u32,
) -> *mut WinitWindow {
    let title = unsafe { CStr::from_ptr(title) }
        .to_string_lossy()
        .into_owned();
    let mut builder = EventLoop::builder();
    if std::env::var_os("NOGRAPHICSAPI_X11").is_some_and(|value| value == "1") {
        builder.with_x11();
    } else if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        builder.with_wayland();
    }
    let event_loop = match builder.build() {
        Ok(event_loop) => event_loop,
        Err(error) => {
            eprintln!("nogfx: cannot open a display: {error}");
            return ptr::null_mut();
        }
    };
    let attributes = Window::default_attributes()
        .with_title(title)
        .with_inner_size(LogicalSize::new(width, height));
    let mut window = Box::new(WinitWindow {
        app: App {
            attributes: Some(attributes),
            window: None,
            size: PhysicalSize::new(width, height),
            open: true,
        },
        event_loop,
    });
    while window.app.window.is_none() {
        if !window.pump(Some(Duration::from_millis(10))) {
            return ptr::null_mut();
        }
    }
    Box::into_raw(window)
}

/// Writes the window's native handles to `out`. Returns false if winit's
/// window is neither Wayland's nor Xlib's.
///
/// # Safety
///
/// `window` must come from `nogfx_window_open`, and `out` point to a
/// writable `NativeWindow`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nogfx_window_native(
    window: *const WinitWindow,
    out: *mut NativeWindow,
) -> bool {
    let Some(native) = unsafe { &*window }.app.window.as_ref() else {
        return false;
    };
    let (Ok(display), Ok(handle)) = (native.display_handle(), native.window_handle()) else {
        return false;
    };
    let out = unsafe { &mut *out };
    match (display.as_raw(), handle.as_raw()) {
        (RawDisplayHandle::Wayland(display), RawWindowHandle::Wayland(surface)) => {
            *out = NativeWindow {
                platform: 0,
                display: display.display.as_ptr(),
                wayland_surface: surface.surface.as_ptr(),
                xlib_window: 0,
            };
            true
        }
        (RawDisplayHandle::Xlib(display), RawWindowHandle::Xlib(xlib)) => {
            *out = NativeWindow {
                platform: 1,
                display: display
                    .display
                    .map_or(ptr::null_mut(), |display| display.as_ptr()),
                wayland_surface: ptr::null_mut(),
                xlib_window: xlib.window as u64,
            };
            true
        }
        _ => false,
    }
}

/// Handles the window's pending events without waiting for more, and writes
/// its current size in pixels. Returns false once it has been closed (or
/// Escape pressed).
///
/// # Safety
///
/// `window` must come from `nogfx_window_open`; `width` and `height`
/// must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nogfx_window_pump(
    window: *mut WinitWindow,
    width: *mut u32,
    height: *mut u32,
) -> bool {
    let window = unsafe { &mut *window };
    let open = window.pump(Some(Duration::ZERO));
    unsafe {
        *width = window.app.size.width;
        *height = window.app.size.height;
    }
    open
}

/// Closes and frees the window.
///
/// # Safety
///
/// `window` must come from `nogfx_window_open`, or be null; it is
/// not usable afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nogfx_window_close(window: *mut WinitWindow) {
    if !window.is_null() {
        drop(unsafe { Box::from_raw(window) });
    }
}
