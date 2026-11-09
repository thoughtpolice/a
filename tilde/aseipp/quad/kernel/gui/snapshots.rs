// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Frames drawn into images with no window, for tests and snapshots.

use super::*;

/// Frames drawn into images, with no window: what a window would show, for
/// tests and snapshots (see render's [`Headless`]).
pub struct Snapshots {
    fonts: Fonts,
    gpu: Headless,
    images: Images,
    pixels: FramePixels,
    screen: Screen,
}

impl Snapshots {
    /// Snapshots in `font`, with the system's fonts if `system_fonts`
    /// (else the built-in ones alone, which draw the same everywhere).
    pub fn new(font: FontSpec, system_fonts: bool) -> Result<Snapshots, String> {
        let fonts = if system_fonts {
            Fonts::new(&font, 1.0)?
        } else {
            Fonts::built_in_only(&font, 1.0)?
        };
        let gpu = Headless::new()?;
        Ok(Snapshots {
            fonts,
            gpu,
            images: Images::default(),
            pixels: FramePixels::default(),
            screen: Screen::default(),
        })
    }

    /// Takes a PNG, for frames to place by `key`.
    pub fn add_image(&mut self, key: String, png: &[u8]) -> Result<(), String> {
        self.images.add(key, png)
    }

    /// A cell's size, in pixels.
    pub fn cell(&self) -> [f32; 2] {
        self.fonts.metrics.cell
    }

    pub fn device_name(&self) -> String {
        self.gpu.device_name()
    }

    /// Takes a frame's changes, as [`Gui::paint`] does, and draws the
    /// screen, `cols` cells wide; returns its pixels, RGBA, top row first.
    pub fn draw(&mut self, update: Update, cols: u32) -> Result<Vec<u8>, String> {
        let rows = update.rows;
        self.screen.apply(update);
        let (rects, laid) = self.screen.layout(&mut self.fonts);
        let [w, h] = self.fonts.metrics.cell;
        let pictures = self.pixels.pictures(
            &mut self.images,
            &self.screen.placements,
            [w, h],
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
            cell: [w, h],
            // Frames as the grid is, with no padding around them.
            origin: [0.0, 0.0],
        };
        self.gpu.draw(&list, cols * w as u32, rows * h as u32)
    }
}
