// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The platform implements the generated SDK traits using the generated HAL.

#![no_main]

mod bindings;
mod font;
mod runtime;

use std::sync::{Arc, Mutex, MutexGuard};

use bindings::console::hal::raw as hal;
use bindings::exports::console::sdk::{audio, clock, files, gfx, input, log, process, system};

const DISPLAY_WIDTH: u32 = 320;
const DISPLAY_HEIGHT: u32 = 240;
const MAX_DISPLAY: u32 = 4096;
const KEY_COUNT: usize = input::Key::KpDivide as usize + 1;

struct Platform;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn rgba(color: gfx::Color) -> [u8; 4] {
    [color.r, color.g, color.b, color.a]
}

/// Width by height pixels of `bytes_per_pixel` each, packed by row.
fn sized(width: u32, height: u32, len: usize, bytes_per_pixel: u64) -> bool {
    let bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(bytes_per_pixel));
    width != 0 && height != 0 && bytes == Some(len as u64)
}

struct Frame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Frame {
    fn blank(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width * height * 4) as usize],
        }
    }

    fn expand(indexed: &Frame, palette: &[[u8; 4]; 256]) -> Self {
        let mut pixels = Vec::with_capacity(indexed.pixels.len() * 4);
        for index in &indexed.pixels {
            pixels.extend_from_slice(&palette[*index as usize]);
        }
        Self {
            width: indexed.width,
            height: indexed.height,
            pixels,
        }
    }
}

/// A sheet's image, shared with the commands that draw from it until the
/// frame ends, so dropping the sheet mid-frame loses nothing.
struct Sheet {
    width: u32,
    height: u32,
    pixels: Arc<Vec<u8>>,
}

enum Command {
    Clear([u8; 4]),
    FillRect(gfx::Rect, [u8; 4]),
    DrawRect(gfx::Rect, [u8; 4]),
    Line(i32, i32, i32, i32, [u8; 4]),
    Circle(i32, i32, u32, [u8; 4]),
    Text(i32, i32, String, [u8; 4]),
    Clip(Option<gfx::Rect>),
    Camera(i32, i32),
    Sprite(Arc<Vec<u8>>, u32, u32, gfx::Rect, i32, i32, gfx::Flip),
}

/// What a frame is made of: the image the game presented, whole, and the
/// overlay commands it drew, rasterized when the frame ends.
struct Screen {
    palette: [[u8; 4]; 256],
    presented: Option<Frame>,
    indexed: Option<Frame>,
    commands: Vec<Command>,
    /// The frame a game that never presents draws on.
    display: (u32, u32),
    /// Frames ended so far.
    frames: u64,
}

static SCREEN: Mutex<Screen> = Mutex::new(Screen {
    palette: [[0, 0, 0, 255]; 256],
    presented: None,
    indexed: None,
    commands: Vec::new(),
    display: (DISPLAY_WIDTH, DISPLAY_HEIGHT),
    frames: 0,
});

fn draw(command: Command) {
    lock(&SCREEN).commands.push(command);
}

/// Half-open bounds in frame pixels.
#[derive(Clone, Copy)]
struct Clip {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

struct Raster<'a> {
    frame: &'a mut Frame,
    clip: Clip,
    camera: (i32, i32),
}

impl Raster<'_> {
    fn bounds(&self) -> Clip {
        Clip {
            x0: 0,
            y0: 0,
            x1: self.frame.width as i32,
            y1: self.frame.height as i32,
        }
    }

    fn plot(&mut self, x: i32, y: i32, color: [u8; 4]) {
        let clip = self.clip;
        if x >= clip.x0 && x < clip.x1 && y >= clip.y0 && y < clip.y1 {
            let at = (y as usize * self.frame.width as usize + x as usize) * 4;
            self.frame.pixels[at..at + 4].copy_from_slice(&color);
        }
    }

    /// Fills the rectangle at x, y of w by h pixels, already in frame space.
    fn fill(&mut self, x: i64, y: i64, w: i64, h: i64, color: [u8; 4]) {
        let clip = self.clip;
        let x0 = x.max(i64::from(clip.x0));
        let y0 = y.max(i64::from(clip.y0));
        let x1 = (x + w).min(i64::from(clip.x1));
        let y1 = (y + h).min(i64::from(clip.y1));
        for row in y0..y1 {
            for column in x0..x1 {
                let at = (row as usize * self.frame.width as usize + column as usize) * 4;
                self.frame.pixels[at..at + 4].copy_from_slice(&color);
            }
        }
    }

    fn rect(&self, rect: gfx::Rect) -> (i64, i64, i64, i64) {
        (
            i64::from(rect.x) - i64::from(self.camera.0),
            i64::from(rect.y) - i64::from(self.camera.1),
            i64::from(rect.w),
            i64::from(rect.h),
        )
    }

    fn line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, color: [u8; 4]) {
        let (mut x, mut y) = (i64::from(x0), i64::from(y0));
        let (end_x, end_y) = (i64::from(x1), i64::from(y1));
        let dx = (end_x - x).abs();
        let dy = -(end_y - y).abs();
        let step_x = if x < end_x { 1 } else { -1 };
        let step_y = if y < end_y { 1 } else { -1 };
        let mut error = dx + dy;
        loop {
            if let (Ok(px), Ok(py)) = (i32::try_from(x), i32::try_from(y)) {
                self.plot(px, py, color);
            }
            if x == end_x && y == end_y {
                break;
            }
            let doubled = 2 * error;
            if doubled >= dy {
                error += dy;
                x += step_x;
            }
            if doubled <= dx {
                error += dx;
                y += step_y;
            }
        }
    }

    fn circle(&mut self, cx: i32, cy: i32, radius: u32, color: [u8; 4]) {
        let r = i64::from(radius);
        for dy in -r..=r {
            let mut dx = 0;
            while (dx + 1) * (dx + 1) + dy * dy <= r * r {
                dx += 1;
            }
            self.fill(i64::from(cx) - dx, i64::from(cy) + dy, 2 * dx + 1, 1, color);
        }
    }

    fn text(&mut self, x: i32, y: i32, text: &str, color: [u8; 4]) {
        let (mut column, mut row) = (x, y);
        for c in text.chars() {
            if c == '\n' {
                column = x;
                row = row.saturating_add(font::LINE);
                continue;
            }
            if let Some(glyph) = font::glyph(c) {
                for (dy, bits) in glyph.iter().enumerate() {
                    for dx in 0..font::WIDTH {
                        if bits & (1 << (font::WIDTH - 1 - dx)) != 0 {
                            self.plot(
                                column.saturating_add(dx),
                                row.saturating_add(dy as i32),
                                color,
                            );
                        }
                    }
                }
            }
            column = column.saturating_add(font::ADVANCE);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn sprite(
        &mut self,
        pixels: &[u8],
        width: u32,
        height: u32,
        source: gfx::Rect,
        x: i32,
        y: i32,
        flip: gfx::Flip,
    ) {
        for sy in 0..source.h {
            for sx in 0..source.w {
                let (Some(px), Some(py)) = (
                    source.x.checked_add(sx as i32),
                    source.y.checked_add(sy as i32),
                ) else {
                    continue;
                };
                if px < 0 || py < 0 || px as u32 >= width || py as u32 >= height {
                    continue;
                }
                let at = (py as usize * width as usize + px as usize) * 4;
                let pixel = [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
                if pixel[3] == 0 {
                    continue;
                }
                let fx = if flip.contains(gfx::Flip::HORIZONTAL) {
                    source.w - 1 - sx
                } else {
                    sx
                };
                let fy = if flip.contains(gfx::Flip::VERTICAL) {
                    source.h - 1 - sy
                } else {
                    sy
                };
                if let (Some(dx), Some(dy)) = (x.checked_add(fx as i32), y.checked_add(fy as i32)) {
                    self.plot(dx, dy, pixel);
                }
            }
        }
    }

    fn run(&mut self, command: &Command) {
        let opaque = |color: &[u8; 4]| color[3] != 0;
        match command {
            Command::Clear(color) => {
                if opaque(color) {
                    for pixel in self.frame.pixels.chunks_exact_mut(4) {
                        pixel.copy_from_slice(color);
                    }
                }
            }
            Command::FillRect(rect, color) if opaque(color) => {
                let (x, y, w, h) = self.rect(*rect);
                self.fill(x, y, w, h, *color);
            }
            Command::DrawRect(rect, color) if opaque(color) => {
                let (x, y, w, h) = self.rect(*rect);
                if w > 0 && h > 0 {
                    self.fill(x, y, w, 1, *color);
                    self.fill(x, y + h - 1, w, 1, *color);
                    self.fill(x, y, 1, h, *color);
                    self.fill(x + w - 1, y, 1, h, *color);
                }
            }
            Command::Line(x0, y0, x1, y1, color) if opaque(color) => {
                let (cx, cy) = self.camera;
                self.line(
                    x0.wrapping_sub(cx),
                    y0.wrapping_sub(cy),
                    x1.wrapping_sub(cx),
                    y1.wrapping_sub(cy),
                    *color,
                );
            }
            Command::Circle(cx, cy, radius, color) if opaque(color) => {
                let (dx, dy) = self.camera;
                self.circle(cx.wrapping_sub(dx), cy.wrapping_sub(dy), *radius, *color);
            }
            Command::Text(x, y, text, color) if opaque(color) => {
                let (dx, dy) = self.camera;
                self.text(x.wrapping_sub(dx), y.wrapping_sub(dy), text, *color);
            }
            Command::Clip(rect) => {
                let bounds = self.bounds();
                self.clip = match rect {
                    Some(rect) => {
                        let (x, y, w, h) = (
                            i64::from(rect.x),
                            i64::from(rect.y),
                            i64::from(rect.w),
                            i64::from(rect.h),
                        );
                        Clip {
                            x0: x.max(i64::from(bounds.x0)) as i32,
                            y0: y.max(i64::from(bounds.y0)) as i32,
                            x1: (x + w).min(i64::from(bounds.x1)).max(i64::from(bounds.x0)) as i32,
                            y1: (y + h).min(i64::from(bounds.y1)).max(i64::from(bounds.y0)) as i32,
                        }
                    }
                    None => bounds,
                };
            }
            Command::Camera(dx, dy) => self.camera = (*dx, *dy),
            Command::Sprite(pixels, width, height, source, x, y, flip) => {
                let (cx, cy) = self.camera;
                self.sprite(
                    pixels,
                    *width,
                    *height,
                    *source,
                    x.wrapping_sub(cx),
                    y.wrapping_sub(cy),
                    *flip,
                );
            }
            _ => {}
        }
    }
}

impl bindings::Guest for Platform {
    fn end_frame() {
        let mut screen = lock(&SCREEN);
        screen.frames += 1;
        let commands = std::mem::take(&mut screen.commands);
        let indexed = screen.indexed.take();
        let presented = screen.presented.take();
        // A frame with no overlay goes to the host as the game gave it, an
        // indexed one with its palette for the host to expand.
        if commands.is_empty() {
            if let Some(frame) = indexed {
                let entries: Vec<u32> = screen
                    .palette
                    .iter()
                    .map(|entry| u32::from_le_bytes(*entry))
                    .collect();
                hal::present_indexed(frame.width, frame.height, &frame.pixels, &entries);
            } else if let Some(frame) = presented {
                hal::present(frame.width, frame.height, &frame.pixels);
            }
            return;
        }
        let mut frame = match (presented, indexed) {
            (Some(frame), _) => frame,
            (None, Some(frame)) => Frame::expand(&frame, &screen.palette),
            (None, None) => Frame::blank(screen.display.0, screen.display.1),
        };
        let mut raster = Raster {
            clip: Clip {
                x0: 0,
                y0: 0,
                x1: frame.width as i32,
                y1: frame.height as i32,
            },
            camera: (0, 0),
            frame: &mut frame,
        };
        for command in &commands {
            raster.run(command);
        }
        hal::present(frame.width, frame.height, &frame.pixels);
    }
}

impl gfx::Guest for Platform {
    type Sheet = Sheet;

    fn info() -> gfx::DisplayInfo {
        let display = lock(&SCREEN).display;
        gfx::DisplayInfo {
            width: display.0,
            height: display.1,
            refresh_hz: hal::frames_per_second(),
        }
    }

    fn set_mode(width: u32, height: u32) -> bool {
        let accepted = (1..=MAX_DISPLAY).contains(&width) && (1..=MAX_DISPLAY).contains(&height);
        if accepted {
            lock(&SCREEN).display = (width, height);
        }
        accepted
    }

    fn present(width: u32, height: u32, pixels: Vec<u8>) {
        if sized(width, height, pixels.len(), 4) {
            let mut screen = lock(&SCREEN);
            screen.presented = Some(Frame {
                width,
                height,
                pixels,
            });
            screen.indexed = None;
        }
    }

    fn set_palette(first: u8, colors: Vec<gfx::Color>) {
        let mut screen = lock(&SCREEN);
        for (index, color) in colors.into_iter().enumerate().take(256 - first as usize) {
            screen.palette[first as usize + index] = rgba(color);
        }
    }

    fn present_indexed(width: u32, height: u32, pixels: Vec<u8>) {
        if sized(width, height, pixels.len(), 1) {
            let mut screen = lock(&SCREEN);
            screen.indexed = Some(Frame {
                width,
                height,
                pixels,
            });
            screen.presented = None;
        }
    }

    fn clear(color: gfx::Color) {
        draw(Command::Clear(rgba(color)));
    }

    fn fill_rect(rect: gfx::Rect, color: gfx::Color) {
        draw(Command::FillRect(rect, rgba(color)));
    }

    fn draw_rect(rect: gfx::Rect, color: gfx::Color) {
        draw(Command::DrawRect(rect, rgba(color)));
    }

    fn draw_line(x0: i32, y0: i32, x1: i32, y1: i32, color: gfx::Color) {
        draw(Command::Line(x0, y0, x1, y1, rgba(color)));
    }

    fn fill_circle(cx: i32, cy: i32, radius: u32, color: gfx::Color) {
        draw(Command::Circle(cx, cy, radius, rgba(color)));
    }

    fn draw_text(x: i32, y: i32, text: String, color: gfx::Color) {
        draw(Command::Text(x, y, text, rgba(color)));
    }

    fn set_clip(rect: Option<gfx::Rect>) {
        draw(Command::Clip(rect));
    }

    fn set_camera(dx: i32, dy: i32) {
        draw(Command::Camera(dx, dy));
    }

    fn draw_sprite(
        sheet: gfx::SheetBorrow<'_>,
        source: gfx::Rect,
        x: i32,
        y: i32,
        flip: gfx::Flip,
    ) {
        let sheet = sheet.get::<Sheet>();
        draw(Command::Sprite(
            sheet.pixels.clone(),
            sheet.width,
            sheet.height,
            source,
            x,
            y,
            flip,
        ));
    }
}

impl gfx::GuestSheet for Sheet {
    fn new(width: u32, height: u32, rgba: Vec<u8>) -> Self {
        if sized(width, height, rgba.len(), 4) {
            Sheet {
                width,
                height,
                pixels: Arc::new(rgba),
            }
        } else {
            Sheet {
                width: 0,
                height: 0,
                pixels: Arc::new(Vec::new()),
            }
        }
    }
}

/// Key state, kept from the transitions the HAL reports so `poll` can read
/// held keys while `read-events` still delivers every transition.
struct Keys {
    held: [bool; KEY_COUNT],
    pending: Vec<input::KeyEvent>,
}

static KEYS: Mutex<Keys> = Mutex::new(Keys {
    held: [false; KEY_COUNT],
    pending: Vec::new(),
});

fn refresh_keys(keys: &mut Keys) {
    for event in hal::read_events() {
        if event.key < KEY_COUNT as u32 {
            keys.held[event.key as usize] = event.pressed;
            keys.pending.push(input::KeyEvent {
                // The HAL uses ordinals. WIT enum discriminants are contiguous
                // and KpDivide is the last variant; the check validates _lift.
                key: unsafe { input::Key::_lift(event.key as u8) },
                pressed: event.pressed,
            });
        }
    }
}

impl input::Guest for Platform {
    /// The d-pad is the arrows, A and B are Z and X, start is enter and
    /// select is shift.
    fn poll() -> input::Buttons {
        let mut keys = lock(&KEYS);
        refresh_keys(&mut keys);
        let mapping = [
            (input::Key::Up, input::Buttons::UP),
            (input::Key::Down, input::Buttons::DOWN),
            (input::Key::Left, input::Buttons::LEFT),
            (input::Key::Right, input::Buttons::RIGHT),
            (input::Key::Z, input::Buttons::A),
            (input::Key::X, input::Buttons::B),
            (input::Key::Enter, input::Buttons::START),
            (input::Key::Shift, input::Buttons::SELECT),
        ];
        let mut buttons = input::Buttons::empty();
        for (key, button) in mapping {
            if keys.held[key as usize] {
                buttons |= button;
            }
        }
        buttons
    }

    fn capabilities() -> input::Capability {
        input::Capability::from_bits_truncate(hal::input_capabilities() as u8)
    }

    fn read_events() -> Vec<input::KeyEvent> {
        let mut keys = lock(&KEYS);
        refresh_keys(&mut keys);
        std::mem::take(&mut keys.pending)
    }

    fn mouse() -> input::MouseState {
        let state = hal::read_mouse();
        input::MouseState {
            x: state.x,
            y: state.y,
            dx: state.dx,
            dy: state.dy,
            buttons: input::MouseButtons::from_bits_truncate(state.buttons as u8),
            wheel: state.wheel,
        }
    }

    fn capture_pointer(captured: bool) -> bool {
        hal::capture_pointer(u32::from(captured)) != 0
    }

    fn read_text() -> String {
        hal::read_text()
    }
}

impl audio::Guest for Platform {
    fn format() -> audio::SampleFormat {
        audio::SampleFormat {
            sample_rate: 44100,
            channels: 2,
        }
    }

    fn write(samples: Vec<i16>) -> u32 {
        hal::audio_write(&samples[..samples.len() / 2 * 2])
    }

    fn queued() -> u32 {
        hal::audio_queued()
    }
}

impl clock::Guest for Platform {
    fn now_ms() -> u64 {
        hal::now_ms()
    }

    fn frame() -> u64 {
        lock(&SCREEN).frames
    }

    fn unix_seconds() -> i64 {
        hal::unix_seconds()
    }

    fn set_frame_rate(hz: u32) -> u32 {
        hal::set_frame_rate(hz)
    }
}

impl system::Guest for Platform {
    fn info() -> system::HostInfo {
        system::HostInfo {
            name: hal::host_name(),
            features: system::Features::from_bits_truncate(hal::host_features() as u8),
        }
    }

    fn random_seed() -> u64 {
        hal::random_seed()
    }

    fn set_title(title: String) {
        hal::set_title(&title);
    }
}

/// A file the HAL has open. The game holds it as a resource handle, so
/// dropping the handle is what closes the file.
struct File {
    handle: u32,
}

impl files::Guest for Platform {
    type File = File;

    fn open(path: String, write: bool) -> Option<files::File> {
        u32::try_from(hal::file_open(&path, write))
            .ok()
            .map(|handle| files::File::new(File { handle }))
    }

    fn list_directory(path: String) -> Option<Vec<files::Entry>> {
        let listing = hal::file_list_directory(&path);
        (listing.status == 0).then(|| {
            listing
                .entries
                .into_iter()
                .map(|entry| files::Entry {
                    name: entry.name,
                    size: entry.size,
                    directory: entry.directory,
                })
                .collect()
        })
    }

    fn remove(path: String) -> bool {
        hal::file_remove(&path) == 0
    }

    fn rename(path: String, to: String) -> bool {
        hal::file_rename(&path, &to) == 0
    }

    fn create_directory(path: String) -> bool {
        hal::file_create_directory(&path) == 0
    }
}

impl files::GuestFile for File {
    fn size(&self) -> i64 {
        hal::file_size(self.handle)
    }

    fn read_at(&self, offset: u64, length: u32) -> Result<Vec<u8>, ()> {
        let result = hal::file_read_at(self.handle, offset, length);
        if result.status != 0 || result.data.len() > length as usize {
            Err(())
        } else {
            Ok(result.data)
        }
    }

    fn write_at(&self, offset: u64, data: Vec<u8>) -> i32 {
        hal::file_write_at(self.handle, offset, &data)
    }
}

impl Drop for File {
    fn drop(&mut self) {
        hal::file_close(self.handle);
    }
}

impl process::Guest for Platform {
    fn arg_count() -> u32 {
        hal::arg_count()
    }

    fn arg(index: u32) -> String {
        hal::arg(index)
    }

    fn exit(code: i32) {
        hal::exit(code);
        std::process::abort();
    }
}

impl log::Guest for Platform {
    fn log(level: log::Level, message: String) {
        hal::write_log(level as u32, &format!("game: {message}"));
    }
}

bindings::export!(Platform with_types_in bindings);
