// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A window: its screen, fonts and renderer, what it draws at each frame
//! callback, and its events turned into the editor's.

use super::*;

pub(super) struct Win {
    pub(super) renderer: Renderer,
    /// Shared with its renderer's surface, which draws to it.
    pub(super) window: Arc<Window>,
    /// What it shows, for screen readers.
    pub(super) access: Access,
    pub(super) title: String,
    pub(super) events: Sender<Event>,
    pub(super) fonts: Fonts,
    pub(super) screen: Screen,
    /// The rows that changed since the last frame presented, for the
    /// compositor; None, everything.
    pub(super) damage: Option<Vec<bool>>,
    pub(super) images: Images,
    pub(super) pixels: FramePixels,
    /// Cells the window holds, (rows, cols), as last told to Scheme.
    pub(super) grid: (u32, u32),
    pub(super) modifiers: ModifiersState,
    /// What an input method has composed so far, not yet committed.
    pub(super) preedit: String,
    /// The cell under the pointer, (col, row).
    pub(super) pointer: Option<(u32, u32)>,
    /// The mouse button held down, for drags.
    pub(super) held: Option<u32>,
    /// Pixels scrolled that do not yet make a line.
    pub(super) scroll: f64,
}

impl Win {
    pub(super) fn send(&self, event: Event) {
        let _ = self.events.send(event);
    }

    // Drawn at the compositor's next frame callback: a burst of frames
    // (key repeat, scrolling) is one frame per refresh, and a window no
    // one can see draws nothing. Snapshots draw at once, since a hidden
    // window gets no callbacks.
    pub(super) fn paint(&mut self, update: Update) {
        let placed = std::mem::take(&mut self.screen.placements);
        // A whole frame can change what is around the rows too: the
        // padding, in a new background.
        let whole = update.whole;
        let changed = self.screen.apply(update);
        if whole {
            self.tell_access_all();
        } else {
            let (screen, metrics, title) = (&self.screen, self.fonts.metrics, &self.title);
            let cols = self.grid.1;
            self.access.changed(screen.row_count(), &changed, || {
                access_view(screen, metrics, title, cols)
            });
        }
        if whole || placed != self.screen.placements {
            self.damage = None;
        }
        if let Some(damage) = &mut self.damage {
            damage.resize(damage.len().max(changed.len()), false);
            for (d, c) in damage.iter_mut().zip(changed) {
                *d |= c;
            }
        }
        if std::env::var_os("QUAD_GUI_SNAPSHOT").is_some() {
            self.draw();
        } else {
            self.window.request_redraw();
        }
    }

    /// Gives screen readers the whole screen again, as something asked
    /// for it or as it all changed (where it is, or its title).
    pub(super) fn tell_access_all(&mut self) {
        let (screen, metrics, title) = (&self.screen, self.fonts.metrics, &self.title);
        let cols = self.grid.1;
        self.access
            .whole(|| access_view(screen, metrics, title, cols));
    }

    pub(super) fn set_font(&mut self, font: FontSpec) {
        if let Err(error) = self.fonts.set_font(&font) {
            self.send(Event::Error(error));
        }
        // The grid holds as many cells of the new size as fit.
        self.grid = (0, 0);
        self.damage = None;
        self.resized(self.window.inner_size());
        self.window.request_redraw();
    }

    pub(super) fn event(&mut self, event: WindowEvent) {
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
    pub(super) fn cell(&self) -> (f64, f64) {
        let [w, h] = self.fonts.metrics.cell;
        (f64::from(w), f64::from(h))
    }

    pub(super) fn resized(&mut self, size: PhysicalSize<u32>) {
        self.damage = None;
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

    pub(super) fn mods(&self) -> u32 {
        let m = self.modifiers;
        // As (quad event) has them: shift 1, alt 2, ctrl 4, super 8.
        u32::from(m.shift_key())
            | u32::from(m.alt_key()) << 1
            | u32::from(m.control_key()) << 2
            | u32::from(m.super_key()) << 3
    }

    pub(super) fn key(&self, event: &KeyEvent) {
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
    pub(super) fn type_text(&self, text: &str, mods: u32, kind: &'static str) {
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
    pub(super) fn ime(&mut self, ime: Ime) {
        match ime {
            Ime::Preedit(text, _) => self.preedit = text,
            Ime::Commit(text) => {
                self.preedit.clear();
                self.type_text(&text, 0, "press");
            }
            Ime::Enabled | Ime::Disabled => self.preedit.clear(),
        }
        self.damage = None;
        self.window.request_redraw();
    }

    pub(super) fn pointer_moved(&mut self, position: PhysicalPosition<f64>) {
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

    pub(super) fn mouse(&self, kind: &'static str, button: u32) {
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

    pub(super) fn wheel(&mut self, delta: MouseScrollDelta) {
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

    pub(super) fn draw(&mut self) {
        let (mut rects, mut laid) = self.screen.layout(&mut self.fonts);
        // Text being composed covers the cells after the cursor.
        if let Some(cursor) = self.screen.cursor.filter(|_| !self.preedit.is_empty()) {
            let (more_rects, cells, text) = preedit_cells(
                &self.preedit,
                cursor,
                self.screen.foreground,
                self.screen.background,
                0,
            );
            rects.extend_from_slice(&more_rects);
            let more = self.fonts.layout(&cells, &text);
            laid.glyphs.extend_from_slice(&more.glyphs);
            laid.rects.extend_from_slice(&more.rects);
            laid.pictures.extend_from_slice(&more.pictures);
        }
        // The input method's candidates go by the cursor.
        if let Some((row, col)) = self.screen.cursor {
            let window = &self.window;
            let [w, h] = self.fonts.metrics.cell;
            let pad = self.fonts.metrics.padding;
            window.set_ime_cursor_area(
                PhysicalPosition::new(pad + col as f32 * w, pad + row as f32 * h),
                PhysicalSize::new(w, h),
            );
        }
        let pictures = self.pixels.pictures(
            &mut self.images,
            &self.screen.placements,
            self.fonts.metrics.cell,
            &self.fonts.colors,
            &laid.pictures,
        );
        let list = DrawList {
            rects: &rects,
            pictures: &pictures,
            pixels: (&self.pixels.pixels, self.pixels.generation),
            glyphs: &laid.glyphs,
            decorations: &laid.rects,
            atlas: &self.fonts.atlas,
            background: self.screen.background,
            cell: self.fonts.metrics.cell,
            origin: [self.fonts.metrics.padding; 2],
        };
        // Before presenting, so that Wayland asks the compositor for the
        // frame callback that paces the next request_redraw.
        self.window.pre_present_notify();
        let damage = self.damage.as_deref().map(|rows| {
            damage_bands(
                rows,
                self.fonts.metrics.cell[1],
                self.fonts.metrics.padding,
                self.window.inner_size().width,
            )
        });
        match self.renderer.draw(&list, damage.as_deref()) {
            Ok(true) => {
                if self.damage.is_none() {
                    timing::mark("a whole frame presented");
                }
                self.damage = Some(Vec::new());
            }
            // Again at the compositor's next frame callback, which comes
            // once the window can be seen.
            Ok(false) => self.window.request_redraw(),
            Err(error) => self.send(Event::Error(error)),
        }
    }
}

/// What the screen shows, for screen readers.
pub(super) fn access_view(
    screen: &Screen,
    metrics: Metrics,
    title: &str,
    cols: u32,
) -> access::View {
    access::View {
        title: title.to_string(),
        rows: screen.characters(),
        cols,
        cell: metrics.cell,
        origin: metrics.padding,
        cursor: screen.cursor,
    }
}

/// Rows that changed, as rectangles of the window (x, y, width, height,
/// in pixels): a band across it for each run of changed rows, `cell_h`
/// pixels high each, below `padding`.
pub(super) fn damage_bands(rows: &[bool], cell_h: f32, padding: f32, width: u32) -> Vec<[u32; 4]> {
    let mut bands = Vec::new();
    let mut r = 0;
    while r < rows.len() {
        if !rows[r] {
            r += 1;
            continue;
        }
        let start = r;
        while r < rows.len() && rows[r] {
            r += 1;
        }
        let top = (padding + start as f32 * cell_h).floor() as u32;
        let bottom = (padding + r as f32 * cell_h).ceil() as u32;
        bands.push([0, top, width, bottom - top]);
    }
    bands
}

/// A frame's pictures, and the pixels they show: the images', then the
/// color glyphs' (font/'s [`Colors`]), which their pictures find from
/// the start of the fonts' pixels, and so past the images' here.
#[derive(Default)]
pub(super) struct FramePixels {
    /// The generations of the images' and the glyphs' pixels it holds.
    pub(super) from: Option<(u64, u64)>,
    pub(super) pixels: Vec<u32>,
    pub(super) generation: u64,
}

impl FramePixels {
    /// The pictures of `placements`' images and of color glyphs (`glyphs`,
    /// a layout's): [`PICTURE_BYTES`] each, showing [`FramePixels::pixels`].
    pub(super) fn pictures(
        &mut self,
        images: &mut Images,
        placements: &[Placement],
        cell: [f32; 2],
        colors: &Colors,
        glyphs: &[u8],
    ) -> Vec<u8> {
        let mut pictures = images.layout(placements, cell);
        let base = images.pixels.len() as u32;
        let start = pictures.len();
        pictures.extend_from_slice(glyphs);
        for record in pictures[start..].chunks_exact_mut(PICTURE_BYTES) {
            let offset = u32::from_ne_bytes(record[16..20].try_into().unwrap()) + base;
            record[16..20].copy_from_slice(&offset.to_ne_bytes());
        }
        let from = (images.generation, colors.generation);
        if self.from != Some(from) {
            self.pixels.clear();
            self.pixels.extend_from_slice(&images.pixels);
            self.pixels.extend_from_slice(&colors.pixels);
            self.from = Some(from);
            self.generation += 1;
        }
        pictures
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    #[test]
    fn changed_rows_are_bands_across_the_window() {
        let rows = [false, true, true, false, true];
        assert_eq!(
            damage_bands(&rows, 10.5, 2.0, 300),
            [[0, 12, 300, 22], [0, 44, 300, 11]]
        );
        assert!(damage_bands(&[false; 3], 10.0, 0.0, 300).is_empty());
    }

    /// The compositor is told of exactly the rows that changed: the bands
    /// cover them, and only them.
    #[hegel::test(test_cases = 300, database = None)]
    fn bands_are_the_changed_rows(tc: TestCase) {
        let rows = tc.draw(gs::vecs(gs::booleans()).max_size(40));
        let (cell_h, padding) = (tc.draw(gs::integers::<u32>().min_value(1).max_value(40)), 2);
        let bands = damage_bands(&rows, cell_h as f32, padding as f32, 300);
        let mut covered = vec![false; rows.len()];
        for [x, y, w, h] in bands {
            assert_eq!((x, w), (0, 300));
            assert_eq!((y - padding) % cell_h, 0);
            assert_eq!(h % cell_h, 0);
            for r in (y - padding) / cell_h..(y - padding + h) / cell_h {
                assert!(!covered[r as usize], "row {r} twice");
                covered[r as usize] = true;
            }
        }
        assert_eq!(covered, rows);
    }
}
