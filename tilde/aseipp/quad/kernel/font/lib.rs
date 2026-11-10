// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The GUI's text: fonts from the system (fontique, which asks fontconfig),
//! shaped with HarfRust, drawn from their outlines (skrifa) as Slug shapes
//! (slug.rs) at whatever size, on a grid of cells as a terminal's.
//!
//! [`Fonts::layout`] takes a frame's cells and returns what to draw: glyphs
//! (kernel/render/gui.slang's `Glyph`) and rectangles for underlines. Runs of
//! cells in one style and color are shaped together, so ligatures and
//! combining marks work; each glyph is placed at the cell its cluster
//! starts in, so the grid stays a grid whatever the font's advances.
//! Characters the font lacks come from a fallback font for their script.
//! A style a font lacks is made up, as fontique suggests: from its axes
//! where it is variable (its weight), else by emboldening or slanting its
//! outlines (slug.rs).
//!
//! Emoji come from a color font where one has them, painted in their own
//! colors (color.rs) into pictures the size of their cells, which the
//! image pipeline draws: those asked for as emoji (U+FE0F after them), and
//! those the editor gives two cells, as it does emoji that are pictures by
//! default.
//!
//! Box drawing and block characters are drawn here, as ghostty and other
//! terminals do, to fill their cells exactly and join their neighbors:
//! they are shapes in a cell's own coordinates, built for the cell size.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use fontique::{
    Attributes, Collection, CollectionOptions, FallbackKey, FontStyle, FontWeight, FontWidth,
    GenericFamily, QueryFamily, QueryStatus, SourceCache, Synthesis,
};
use harfrust::{Buffer, Feature, ShapeOptions, ShaperFont};
use skrifa::{DrawMemory, GlyphId, ScalerFont};

use crate::color::Placing;
use crate::slug::{Atlas, Curve, Outline, Shape, embolden, slant};
use quad_image::PICTURE_BYTES;
use quad_timing as timing;

mod cells;
pub mod color;
mod faces;
mod layout;
pub mod slug;
mod sprites;

pub use cells::characters;
use cells::*;
use faces::*;
pub use layout::Layout;
use sprites::Sprite;

/// A glyph as the shader reads it: `Glyph` in kernel/render/gui.slang.
pub const GLYPH_BYTES: usize = 64;
/// A rectangle as the shader reads it: `Rect` in kernel/render/gui.slang.
pub const RECT_BYTES: usize = 32;
/// A cell as Scheme sends it (core/gui.sls): seven u32s.
pub const CELL_BYTES: usize = 28;

/// How many shaped runs to remember, before starting afresh.
const SHAPED_RUNS: usize = 8192;

/// How many laid-out rows to remember, before starting afresh.
const LAID_ROWS: usize = 4096;

/// The last [`Fonts::epoch`] (or [`Colors::generation`]) given out: a
/// family change makes new `Fonts`, whose layouts must not pass for the old
/// ones'.
static EPOCHS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_epoch() -> u64 {
    EPOCHS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

/// How many pixels of color glyphs to keep, before starting afresh: 16 MB.
const COLOR_PIXELS: usize = 1 << 22;

// Cell attributes, as (quad display) has them.
const BOLD: u32 = 1;
const ITALIC: u32 = 2;
const UNDERLINE: u32 = 4;
const UNDERCURL: u32 = 8;
const DIM: u32 = 16;
const DOUBLE_UNDERLINE: u32 = 64;
const DOTTED_UNDERLINE: u32 = 128;
const DASHED_UNDERLINE: u32 = 256;
const STRIKETHROUGH: u32 = 512;
const OVERLINE: u32 = 1024;

/// The default font, built in so that it is there wherever quad is:
/// JetBrains Mono (third-party//by-name/je/jetbrains-mono, OFL-1.1, whose
/// copyright and license are in each file's name table).
pub(crate) const BUILT_IN: [&[u8]; 4] = [
    include_bytes!("fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("fonts/JetBrainsMono-Bold.ttf"),
    include_bytes!("fonts/JetBrainsMono-Italic.ttf"),
    include_bytes!("fonts/JetBrainsMono-BoldItalic.ttf"),
];

/// The font to draw with: `gui-font-family` and the other variables of
/// core/gui.sls.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FontSpec {
    pub family: String,
    pub points: f32,
    /// OpenType features, as HarfBuzz writes them: "-calt" (no contextual
    /// alternates, so none of some fonts' ligatures), "ss01", "cv05=2".
    pub features: Vec<String>,
    /// Families to draw characters the font lacks in, in order, before
    /// those fontconfig suggests for their script.
    pub fallbacks: Vec<String>,
}

/// Features from their HarfBuzz spellings, and those not understood.
fn parse_features(spellings: &[String]) -> (Vec<Feature>, Vec<String>) {
    let mut features = Vec::new();
    let mut bad = Vec::new();
    for s in spellings
        .iter()
        .flat_map(|s| s.split(|c: char| c == ',' || c.is_whitespace()))
        .filter(|s| !s.is_empty())
    {
        match s.parse::<Feature>() {
            Ok(f) => features.push(f),
            Err(_) => bad.push(s.to_string()),
        }
    }
    (features, bad)
}

/// The size of everything on the grid, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    /// A cell's width and height: whole pixels, so cells tile exactly.
    pub cell: [f32; 2],
    /// The baseline's distance below a cell's top.
    pub baseline: f32,
    pub px_per_em: f32,
    /// Where an underline's top is, below the baseline, and how thick.
    pub underline: [f32; 2],
    /// Where a strikethrough's top is, above the baseline, and how thick.
    pub strikethrough: [f32; 2],
    /// Between the grid and the window's edges, on every side: ghostty's
    /// default, 2 points at 96 dots an inch, in whole pixels.
    pub padding: f32,
}

struct Face {
    /// The font, at the variations its synthesis asks for (a weight, say).
    font: skrifa::Font,
    /// The font file, the index in it, and what is made up for the style
    /// it is used for, so each is loaded once.
    key: (u64, u32, Synthesis),
    units_per_em: f32,
    /// For a bold style the font lacks: how far its outlines grow on each
    /// side, in ems.
    embolden: f32,
    /// For an italic style the font lacks: how far its outlines lean right,
    /// in ems for each em up.
    slant: f32,
    /// It has glyphs in color (a `COLR` table, or bitmaps).
    color: bool,
}

/// Color glyphs painted so far (color.rs), their pixels end to end: what
/// the pictures of [`Layout`]s show.
pub struct Colors {
    /// 0xAABBGGRR, as kernel/image/'s pixels are.
    pub pixels: Vec<u32>,
    /// Changes whenever `pixels` does; never the same for two contents.
    pub generation: u64,
    /// Where each glyph painted for a cell's width (and, for those that
    /// use it, the text's color) is in `pixels`, and its size; None for
    /// glyphs with no color.
    placed: HashMap<(usize, u32, u32, u32), Option<(u32, u32, u32)>>,
    /// The glyphs painted in part in the text's color.
    in_text_color: HashSet<(usize, u32)>,
}

impl Colors {
    fn new() -> Colors {
        Colors {
            pixels: Vec::new(),
            generation: next_epoch(),
            placed: HashMap::new(),
            in_text_color: HashSet::new(),
        }
    }
}

/// Synthesized bold makes strokes this much (in ems) thicker on each side,
/// as FreeType's `FT_GlyphSlot_Embolden` does: about the difference between
/// a regular and a bold font's stems.
const EMBOLDEN: f32 = 1.0 / 48.0;

pub struct Fonts {
    collection: Collection,
    cache: SourceCache,
    /// The built-in fonts, as fontique holds them: the same blobs whichever
    /// collection has them, so that faces made from them are too.
    built_in: Vec<fontique::Blob<u8>>,
    /// Whether the system's fonts are in `collection` yet.
    system: SystemFonts,
    spec: FontSpec,
    features: Vec<Feature>,
    scale: f32,
    faces: Vec<Face>,
    /// The face for regular, bold, italic and bold italic text.
    styles: [usize; 4],
    /// The face for characters the styles' fonts lack, by style, and
    /// whether they are wanted as emoji.
    fallbacks: HashMap<(usize, char, bool), usize>,
    shapes: HashMap<(usize, u32), Option<Shape>>,
    /// Rows already laid out, at the top: by what is in them (row_key).
    /// Their glyphs name the atlas's shapes, so they go when it is cleared.
    rows: HashMap<Vec<u8>, Rc<Layout>>,
    /// Runs already shaped: by face, text, and where each cell starts.
    shaped: HashMap<(usize, String, Vec<u32>), Rc<[(u32, f32, f32, usize)]>>,
    sprites: HashMap<Sprite, Option<Shape>>,
    pub atlas: Atlas,
    pub colors: Colors,
    pub metrics: Metrics,
    /// Changes whenever layouts made before are no longer good (the font
    /// or its size changed, and the atlas was made afresh): never the same
    /// for two atlases, even of two `Fonts`.
    pub epoch: u64,
}

impl Fonts {
    /// The family's fonts at its size, on a display scaled by `scale`; the
    /// generic monospace family where the family is not installed. The
    /// built-in JetBrains Mono is always there. Features not understood
    /// are left out.
    ///
    /// The system's fonts are listed (which takes fontconfig 10 to 40 ms)
    /// only once something needs them: a family that is not built in, or
    /// a character the font lacks.
    pub fn new(spec: &FontSpec, scale: f32) -> Result<Fonts, String> {
        Fonts::with_system_fonts(spec, scale, true)
    }

    /// The built-in fonts' alone, never the system's (whose fonts differ
    /// from machine to machine): for images that must come out the same
    /// everywhere. Other families are JetBrains Mono, and characters it
    /// lacks are its missing-glyph box.
    pub fn built_in_only(spec: &FontSpec, scale: f32) -> Result<Fonts, String> {
        Fonts::with_system_fonts(spec, scale, false)
    }

    fn with_system_fonts(spec: &FontSpec, scale: f32, system: bool) -> Result<Fonts, String> {
        let family = &spec.family;
        let built_in: Vec<fontique::Blob<u8>> = BUILT_IN
            .iter()
            .map(|&data| fontique::Blob::new(std::sync::Arc::new(data)))
            .collect();
        let mut fonts = Fonts {
            collection: collection(&built_in, false),
            cache: SourceCache::default(),
            built_in,
            system: if system {
                SystemFonts::Unlisted
            } else {
                SystemFonts::Never
            },
            spec: spec.clone(),
            features: parse_features(&spec.features).0,
            scale,
            faces: Vec::new(),
            styles: [0; 4],
            fallbacks: HashMap::new(),
            shapes: HashMap::new(),
            shaped: HashMap::new(),
            rows: HashMap::new(),
            sprites: HashMap::new(),
            atlas: Atlas::default(),
            colors: Colors::new(),
            metrics: Metrics {
                cell: [1.0, 1.0],
                baseline: 0.0,
                px_per_em: 1.0,
                underline: [1.0, 1.0],
                strikethrough: [1.0, 1.0],
                padding: 0.0,
            },
            epoch: 0,
        };
        // A family that is not built in is the system's.
        if fonts.find(FontWeight::NORMAL, FontStyle::Normal).is_none() {
            fonts.list_system_fonts();
        }
        for (i, (weight, style)) in [
            (FontWeight::NORMAL, FontStyle::Normal),
            (FontWeight::BOLD, FontStyle::Normal),
            (FontWeight::NORMAL, FontStyle::Italic),
            (FontWeight::BOLD, FontStyle::Italic),
        ]
        .into_iter()
        .enumerate()
        {
            fonts.styles[i] = match fonts.find(weight, style) {
                Some(face) => face,
                // A style the family lacks is drawn regular.
                None if i > 0 => fonts.styles[0],
                None => return Err(format!("no font for {family:?}, nor any monospace font")),
            };
        }
        fonts.measure();
        timing::mark("fonts found");
        Ok(fonts)
    }

    /// Draws as `spec` says from now on: the same faces at another size or
    /// with other features, or another family's. Features that are not
    /// understood are left out, and named in the error.
    pub fn set_font(&mut self, spec: &FontSpec) -> Result<(), String> {
        if spec.family != self.spec.family || spec.fallbacks != self.spec.fallbacks {
            let scale = self.scale;
            *self = Fonts::new(spec, scale)?;
        } else {
            if spec.points != self.spec.points {
                self.spec.points = spec.points;
                self.measure();
            }
            if spec.features != self.spec.features {
                self.spec.features = spec.features.clone();
                self.features = parse_features(&spec.features).0;
                // Text shapes otherwise; the glyphs drawn so far are good.
                self.shaped.clear();
                self.rows.clear();
                self.epoch = next_epoch();
            }
        }
        match parse_features(&spec.features).1 {
            bad if bad.is_empty() => Ok(()),
            bad => Err(format!(
                "font features not understood: {} (HarfBuzz's spelling: \"-calt\", \"ss01\", \"cv05=2\")",
                bad.join(" ")
            )),
        }
    }

    /// Changes the display's scale; returns whether anything changed.
    pub fn set_scale(&mut self, scale: f32) -> bool {
        if scale == self.scale {
            return false;
        }
        self.scale = scale;
        self.measure();
        true
    }

    /// Sizes the grid from the regular face, and forgets the shapes made
    /// for the old size: box drawing is made for its cells.
    fn measure(&mut self) {
        let face = &self.faces[self.styles[0]];
        let metrics = face.font.metrics();
        let upem = face.units_per_em;
        // Points at 96 pixels per inch, as ghostty and browsers have it.
        let mut px_per_em = self.spec.points * 96.0 / 72.0 * self.scale;
        // Lengyel's advice for unhinted text: a size at which capitals are
        // a whole number of pixels tall puts their tops and bottoms on the
        // pixel grid.
        if let Some(cap) = metrics.cap_height.map(|c| c.to_f32()).filter(|&c| c > 0.0) {
            let px = (px_per_em * cap / upem).round().max(1.0);
            px_per_em = px * upem / cap;
        }
        let px = px_per_em / upem;
        let (ascent, descent, gap) = line_metrics(face);
        let charmap = face.font.charmap();
        let advance = charmap
            .map_unicode('M')
            .map(|g| face.font.glyph_metrics().h_advance(g))
            .filter(|&a| a > 0.0)
            .unwrap_or(0.6 * upem);
        let height = ((ascent - descent + gap) * px).round().max(1.0);
        let style = face.font.style_metrics();
        let (position, thickness) = style.underline.map_or((-0.1 * upem, 0.05 * upem), |u| {
            (u.position.to_f32(), u.thickness.to_f32())
        });
        let thickness = (thickness * px).round().max(1.0);
        // The strikethrough, where the font says, else across the middle
        // of its lowercase letters.
        let x_height = metrics.x_height.map_or(0.5 * upem, |x| x.to_f32());
        let (strike, strike_thickness) = style
            .strike_through
            .map_or((x_height / 2.0 + 0.025 * upem, 0.05 * upem), |s| {
                (s.position.to_f32(), s.thickness.to_f32())
            });
        self.metrics = Metrics {
            cell: [(advance * px).round().max(1.0), height],
            baseline: ((ascent + gap / 2.0) * px).round(),
            px_per_em,
            underline: [(-position * px).round().max(1.0), thickness],
            strikethrough: [
                (strike * px).round(),
                (strike_thickness * px).round().max(1.0),
            ],
            padding: (2.0 * 96.0 / 72.0 * self.scale).floor(),
        };
        self.shapes.clear();
        self.sprites.clear();
        self.rows.clear();
        self.atlas.clear();
        self.colors = Colors::new();
        self.epoch = next_epoch();
    }

    /// Starts the color glyphs afresh where they have grown too many, and
    /// with them the layouts showing them: between frames, before any is
    /// laid out.
    pub fn trim(&mut self) {
        if self.colors.pixels.len() > COLOR_PIXELS {
            self.colors = Colors::new();
            self.rows.clear();
            self.epoch = next_epoch();
        }
    }

    /// A glyph's shape, made the first time it is asked for.
    fn glyph(&mut self, face: usize, glyph: u32) -> Option<Shape> {
        if let Some(shape) = self.shapes.get(&(face, glyph)) {
            return *shape;
        }
        let f = &self.faces[face];
        let scaler = ScalerFont::unhinted(f.font.clone(), None);
        let mut outline = Outline::new(1.0 / f.units_per_em);
        let drawn = scaler
            .outline(GlyphId::new(glyph))
            .and_then(|o| o.draw(DrawMemory::Scratch, &mut outline).ok())
            .is_some();
        let mut contours = if drawn { outline.finish() } else { Vec::new() };
        if f.embolden > 0.0 {
            embolden(&mut contours, f.embolden);
        }
        if f.slant != 0.0 {
            slant(&mut contours, f.slant);
        }
        let shape = self.atlas.add(&contours);
        self.shapes.insert((face, glyph), shape);
        shape
    }

    /// What to draw for a frame's `cells` ([`CELL_BYTES`] each, with their
    /// texts in `text`): glyphs, rectangles (in cells) for underlines, and
    /// pictures of color glyphs.
    pub fn layout(&mut self, cells: &[u8], text: &[u8]) -> Layout {
        let cells: Vec<Cell> = cells
            .chunks_exact(CELL_BYTES)
            .filter_map(|b| Cell::parse(b, text))
            .collect();
        let mut out = Layout::default();
        let ch = self.metrics.cell[1];
        // A row at a time: most of a frame's rows were on the last one too,
        // perhaps elsewhere (scrolled), so each is laid out as row 0 once
        // and moved down to where it is.
        for row in cells.chunk_by(|a, b| a.row == b.row) {
            let y = row[0].row;
            let laid = self.laid_row(row);
            out.append_moved(&laid, y as f32 * ch, y as f32);
        }
        out
    }

    /// One row's `cells` (their rows are not looked at), as [`layout`]
    /// lays them out, at the top: its glyphs, and rectangles for its lines.
    /// It is good until [`Fonts::epoch`] changes.
    ///
    /// [`layout`]: Fonts::layout
    pub fn row(&mut self, cells: &[u8], text: &[u8]) -> Rc<Layout> {
        let cells: Vec<Cell> = cells
            .chunks_exact(CELL_BYTES)
            .filter_map(|b| Cell::parse(b, text))
            .collect();
        self.laid_row(&cells)
    }

    /// Cells of one row laid out at the top, made once for each look.
    fn laid_row(&mut self, row: &[Cell]) -> Rc<Layout> {
        let key = row_key(row);
        if let Some(laid) = self.rows.get(&key) {
            return laid.clone();
        }
        let at_top: Vec<Cell> = row.iter().map(|c| Cell { row: 0, ..*c }).collect();
        let mut laid = Layout::default();
        self.layout_row(&at_top, &mut laid);
        let laid = Rc::new(laid);
        if self.rows.len() >= LAID_ROWS {
            self.rows.clear();
        }
        self.rows.insert(key, laid.clone());
        laid
    }

    /// Lays out one row's cells.
    fn layout_row(&mut self, cells: &[Cell], out: &mut Layout) {
        let mut start = 0;
        while start < cells.len() {
            let first = &cells[start];
            if let Some(sprite) = Sprite::of(first.text) {
                self.decorate(first, out);
                self.sprite(sprite, first, out);
                start += 1;
                continue;
            }
            // A run: cells side by side in one style and color, none of
            // them drawn as sprites.
            let mut end = start + 1;
            while end < cells.len() {
                let (prev, c) = (&cells[end - 1], &cells[end]);
                if c.col != prev.col + prev.width
                    || c.style() != first.style()
                    || c.color != first.color
                    || Sprite::of(c.text).is_some()
                {
                    break;
                }
                end += 1;
            }
            for cell in &cells[start..end] {
                self.decorate(cell, out);
            }
            self.run(&cells[start..end], out);
            start = end;
        }
    }

    /// Shapes a run, in pieces that each take one face.
    fn run(&mut self, run: &[Cell], out: &mut Layout) {
        let style = run[0].style();
        let faces: Vec<usize> = run.iter().map(|c| self.face_for(style, c)).collect();
        let mut start = 0;
        while start < run.len() {
            let end = (start..run.len())
                .find(|&i| faces[i] != faces[start])
                .unwrap_or(run.len());
            self.shape(faces[start], &run[start..end], out);
            start = end;
        }
    }

    fn shape(&mut self, face: usize, cells: &[Cell], out: &mut Layout) {
        let mut text = String::new();
        // Each cell's first byte in `text`, for clusters to find their cell.
        let mut starts = Vec::with_capacity(cells.len());
        for c in cells {
            starts.push(text.len() as u32);
            text.push_str(c.text);
        }
        // Most of a frame's text was on the last one too.
        let key = (face, text, starts);
        let placed = match self.shaped.get(&key) {
            Some(placed) => placed.clone(),
            None => {
                let placed = self.place(face, &key.1, &key.2);
                if self.shaped.len() >= SHAPED_RUNS {
                    self.shaped.clear();
                }
                self.shaped.insert(key, placed.clone());
                placed
            }
        };
        // Pixels per font unit, for HarfRust's positions; shapes are in ems.
        let px = self.metrics.px_per_em / self.faces[face].units_per_em;
        let [cw, ch] = self.metrics.cell;
        let color = self.faces[face].color;
        // The last cell a color glyph was painted in: one picture each.
        let mut painted = None;
        for &(glyph, x, y, cell) in placed.iter() {
            let c = &cells[cell];
            if color && painted == Some(cell) {
                continue;
            }
            if color {
                if let Some((offset, w, h)) = self.color_glyph(face, glyph, c) {
                    let at = [c.col as f32 * cw, c.row as f32 * ch];
                    out.picture([at[0], at[1], w as f32, h as f32], offset, w);
                    painted = Some(cell);
                    continue;
                }
            }
            let Some(shape) = self.glyph(face, glyph) else {
                continue;
            };
            let origin = [
                c.col as f32 * cw + x * px,
                c.row as f32 * ch + self.metrics.baseline - y * px,
            ];
            out.glyph(
                &shape,
                origin,
                self.metrics.px_per_em,
                c.color,
                c.background,
            );
        }
    }

    /// Where a color glyph is in [`Fonts::colors`], painted for cell `c`
    /// (its width, and its color, if it uses that), and its size: painted
    /// the first time it is asked for. None for glyphs with no color.
    fn color_glyph(&mut self, face: usize, glyph: u32, c: &Cell) -> Option<(u32, u32, u32)> {
        let [cw, ch] = self.metrics.cell;
        let (w, h) = ((cw * c.width as f32) as u32, ch as u32);
        let in_text_color = self.colors.in_text_color.contains(&(face, glyph));
        let mut key = (
            face,
            glyph,
            c.width,
            if in_text_color { c.color } else { 0 },
        );
        if let Some(&placed) = self.colors.placed.get(&key) {
            return placed;
        }
        let f = &self.faces[face];
        let id = GlyphId::new(glyph);
        let painted = color::paint_colr(&f.font, id, w, h, colr_placing(f, id, w, h), c.color)
            .or_else(|| color::paint_bitmap(&f.font, id, w, h, self.metrics.px_per_em));
        let placed = painted.map(|p| {
            if p.uses_foreground && !in_text_color {
                // Painted in this cell's color: kept for it alone.
                self.colors.in_text_color.insert((face, glyph));
                key.3 = c.color;
            }
            let offset = self.colors.pixels.len() as u32;
            self.colors.pixels.extend_from_slice(&p.pixels);
            self.colors.generation = next_epoch();
            (offset, p.width, p.height)
        });
        self.colors.placed.insert(key, placed);
        placed
    }

    /// Shapes `text`, a run of cells starting at `starts` in it, in
    /// `face`: its glyphs, each with its position in font units from the
    /// start of the cell its cluster starts in. Glyphs of one cluster
    /// follow on from each other; each cluster starts at its cell, so the
    /// grid stays a grid whatever the font's advances.
    fn place(&self, face: usize, text: &str, starts: &[u32]) -> Rc<[(u32, f32, f32, usize)]> {
        let font = &self.faces[face].font;
        let shaper = ShaperFont::new(font);
        let mut buffer = Buffer::new();
        buffer.push_str(text);
        buffer.guess_segment_properties();
        let options = ShapeOptions::new().features(&self.features);
        if harfrust::shape(&shaper, &mut buffer, options).is_err() {
            return Rc::from([]);
        }
        let mut cluster = u32::MAX;
        let mut pen = 0.0;
        buffer
            .glyph_infos()
            .iter()
            .zip(buffer.glyph_positions())
            .map(|(info, pos)| {
                if info.cluster != cluster {
                    cluster = info.cluster;
                    pen = 0.0;
                }
                let cell = starts
                    .partition_point(|&s| s <= info.cluster)
                    .saturating_sub(1);
                let x = pen + pos.x_offset as f32;
                pen += pos.x_advance as f32;
                (info.glyph_id, x, pos.y_offset as f32, cell)
            })
            .collect()
    }

    /// A cell's lines: its underline, in the underline's color (else the
    /// text's), single, double, curly, dotted or dashed; its
    /// strikethrough and overline, in the text's.
    fn decorate(&mut self, c: &Cell, out: &mut Layout) {
        let [cw, ch] = self.metrics.cell;
        let [below, t] = self.metrics.underline;
        let top = self.metrics.baseline + below;
        let line = if c.underline >> 24 != 0 {
            c.underline
        } else {
            c.color
        };
        let (x, y, w) = (c.col as f32, c.row as f32, c.width as f32);
        // A rectangle from pixel x0 to x1 along the cell, at pixel top.
        let mut span = |x0: f32, x1: f32, top: f32, thickness: f32, color: u32| {
            out.rect(
                [x + x0 / cw, y + top / ch, (x1 - x0) / cw, thickness / ch],
                color,
            )
        };
        let width_px = w * cw;
        if c.flags & UNDERLINE != 0 {
            span(0.0, width_px, top, t, line);
        }
        if c.flags & DOUBLE_UNDERLINE != 0 {
            // Two lines a line apart, both inside the cell.
            let second = (top + 2.0 * t).min(ch - t);
            span(0.0, width_px, second - 2.0 * t, t, line);
            span(0.0, width_px, second, t, line);
        }
        if c.flags & DOTTED_UNDERLINE != 0 {
            // Square dots a dot apart.
            let mut at = 0.0;
            while at < width_px {
                span(at, (at + t).min(width_px), top, t, line);
                at += 2.0 * t;
            }
        }
        if c.flags & DASHED_UNDERLINE != 0 {
            // A dash in the middle half of each cell.
            for i in 0..c.width {
                let x0 = i as f32 * cw;
                span(
                    x0 + (cw / 4.0).round(),
                    x0 + (3.0 * cw / 4.0).round(),
                    top,
                    t,
                    line,
                );
            }
        }
        if c.flags & STRIKETHROUGH != 0 {
            let [above, thickness] = self.metrics.strikethrough;
            span(
                0.0,
                width_px,
                self.metrics.baseline - above,
                thickness,
                c.color,
            );
        }
        if c.flags & OVERLINE != 0 {
            span(0.0, width_px, 0.0, t, c.color);
        }
        if c.flags & UNDERCURL != 0 {
            for i in 0..c.width {
                let cell = Cell {
                    col: c.col + i,
                    width: 1,
                    color: line,
                    ..*c
                };
                self.sprite(Sprite::Undercurl, &cell, out);
            }
        }
    }

    /// A shape in a cell's own coordinates: pixels from its bottom left.
    fn sprite(&mut self, sprite: Sprite, c: &Cell, out: &mut Layout) {
        let shape = match self.sprites.get(&sprite) {
            Some(shape) => *shape,
            None => {
                let contours = sprite.draw(&self.metrics);
                let shape = self.atlas.add(&contours);
                self.sprites.insert(sprite, shape);
                shape
            }
        };
        if let Some(shape) = shape {
            let [cw, ch] = self.metrics.cell;
            // The cell's bottom left, as a baseline at 1 pixel per unit.
            out.glyph(
                &shape,
                [c.col as f32 * cw, (c.row + 1) as f32 * ch],
                1.0,
                c.color,
                c.background,
            );
        }
    }
}

/// A face's ascent, descent (below the baseline, so negative) and line
/// gap, in font units: from the metrics its `OS/2` table says to use.
fn line_metrics(face: &Face) -> (f32, f32, f32) {
    let metrics = face.font.metrics();
    let upem = face.units_per_em;
    let line = if metrics.use_typo_metrics {
        metrics.typo_line.or(metrics.hhea_line)
    } else {
        metrics.hhea_line.or(metrics.typo_line)
    };
    line.map_or((0.8 * upem, -0.2 * upem, 0.0), |l| {
        (
            l.ascender.to_f32(),
            l.descender.to_f32(),
            l.line_gap.to_f32(),
        )
    })
}

/// Where a color glyph goes in a `w` by `h` box: as large as lets the
/// font's line fit the box's height and the glyph's advance its width,
/// centered across it, as the font would set it in a line that tall.
fn colr_placing(face: &Face, glyph: GlyphId, w: u32, h: u32) -> Placing {
    let (ascent, descent, _) = line_metrics(face);
    let height = (ascent - descent).max(1.0);
    let advance = Some(face.font.glyph_metrics().h_advance(glyph))
        .filter(|&a| a > 0.0)
        .unwrap_or(face.units_per_em);
    let scale = (h as f32 / height).min(w as f32 / advance);
    Placing {
        scale,
        origin: [
            (w as f32 - advance * scale) / 2.0,
            (h as f32 - height * scale) / 2.0 + ascent * scale,
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    fn jetbrains(points: f32) -> FontSpec {
        FontSpec {
            family: "JetBrains Mono".into(),
            points,
            ..FontSpec::default()
        }
    }

    /// Cells for `text`, one character each, from column 0.
    fn cells_of(text: &str) -> Vec<u8> {
        let mut cells = Vec::new();
        for (col, (at, c)) in text.char_indices().enumerate() {
            for v in [
                col as u32,
                1 << 16,
                0xff00_0000,
                0,
                0,
                at as u32,
                c.len_utf8() as u32,
            ] {
                cells.extend_from_slice(&v.to_ne_bytes());
            }
        }
        cells
    }

    #[test]
    fn features_change_what_text_shapes_to() {
        // JetBrains Mono's ligatures are contextual alternates: "->" is an
        // arrow drawn over both cells, and an empty spacer, with them, and
        // the two characters without.
        let mut fonts = Fonts::new(&jetbrains(12.0), 1.0).unwrap();
        let with = fonts.layout(&cells_of("->"), b"->").glyphs;
        let epoch = fonts.epoch;
        let off = FontSpec {
            features: vec!["-calt".into()],
            ..jetbrains(12.0)
        };
        fonts.set_font(&off).unwrap();
        assert_ne!(fonts.epoch, epoch, "rows laid out before are not good");
        let without = fonts.layout(&cells_of("->"), b"->").glyphs;
        assert_eq!(with.len(), GLYPH_BYTES);
        assert_eq!(without.len(), 2 * GLYPH_BYTES);
        // Spellings not understood are named, and the rest still apply.
        let bad = FontSpec {
            features: vec!["-calt, nonsense=x".into()],
            ..jetbrains(12.0)
        };
        let error = fonts.set_font(&bad).unwrap_err();
        assert!(
            error.contains("nonsense=x") && !error.contains("-calt "),
            "{error}"
        );
        assert_eq!(fonts.layout(&cells_of("->"), b"->").glyphs, without);
    }

    #[test]
    fn the_built_in_font_is_always_there() {
        // Tests run where fontconfig may not load: the built-in font needs
        // none.
        let mut fonts = Fonts::new(&jetbrains(12.0), 1.0).unwrap();
        let m = fonts.metrics;
        // JetBrains Mono's advance is 0.6 em, and its line about 1.32 em.
        assert!((m.cell[0] / m.px_per_em - 0.6).abs() < 0.05, "{m:?}");
        assert!(m.cell[1] > m.cell[0] && m.baseline < m.cell[1], "{m:?}");
        // Text lays out as glyphs, one per character here.
        let mut cells = Vec::new();
        for col in 0u32..3 {
            // Column col, width 1, opaque black on black, text byte col.
            for v in [col, 1 << 16, 0xff00_0000, 0, 0, col, 1] {
                cells.extend_from_slice(&v.to_ne_bytes());
            }
        }
        let laid = fonts.layout(&cells, b"abc");
        assert_eq!(laid.glyphs.len(), 3 * GLYPH_BYTES);
        assert!(laid.rects.is_empty() && laid.pictures.is_empty());
    }

    #[test]
    fn the_systems_fonts_are_listed_only_when_needed() {
        let mut fonts = Fonts::new(&jetbrains(12.0), 1.0).unwrap();
        fonts.layout(&cells_of("abc"), b"abc");
        assert!(
            fonts.system == SystemFonts::Unlisted,
            "built-in text needs none"
        );
        // A character JetBrains Mono lacks: Devanagari.
        fonts.layout(&cells_of("क"), "क".as_bytes());
        assert!(fonts.system == SystemFonts::Listed);
        let mut only = Fonts::built_in_only(
            &FontSpec {
                family: "No Such Family".into(),
                ..jetbrains(12.0)
            },
            1.0,
        )
        .unwrap();
        only.layout(&cells_of("क"), "क".as_bytes());
        assert!(only.system == SystemFonts::Never);
        assert_eq!(
            only.metrics,
            Fonts::new(&jetbrains(12.0), 1.0).unwrap().metrics
        );
    }

    #[test]
    fn a_larger_font_makes_larger_cells() {
        let mut fonts = Fonts::new(&jetbrains(12.0), 1.0).unwrap();
        let small = fonts.metrics;
        fonts.set_font(&jetbrains(24.0)).unwrap();
        let large = fonts.metrics;
        assert!(
            large.cell[0] > small.cell[0] * 1.8 && large.cell[1] > small.cell[1] * 1.8,
            "{small:?} {large:?}"
        );
        assert!(
            fonts.atlas.curves.is_empty(),
            "shapes for the old size are gone"
        );
    }

    #[test]
    fn rows_laid_out_at_the_top_move_to_where_they_are() {
        let shape = Shape {
            bounds: [0.0, 0.0, 0.5, 0.5],
            banding: [1.0, 1.0, 0.0, 0.0],
            location: 7,
            band_max: [0, 0],
        };
        let mut row = Layout::default();
        row.glyph(&shape, [10.0, 15.0], 16.0, 0xff00_0000, 0x123456);
        row.rect([2.0, 0.9, 1.0, 0.05], 0xff00_0000);
        let mut frame = Layout::default();
        frame.append_moved(&row, 40.0, 2.0);
        frame.append_moved(&row, 60.0, 3.0);
        let y = |bytes: &[u8], record: usize, size: usize| {
            f32::from_ne_bytes(
                bytes[record * size + 4..record * size + 8]
                    .try_into()
                    .unwrap(),
            )
        };
        let top = y(&row.glyphs, 0, GLYPH_BYTES);
        assert_eq!(y(&frame.glyphs, 0, GLYPH_BYTES), top + 40.0);
        assert_eq!(y(&frame.glyphs, 1, GLYPH_BYTES), top + 60.0);
        assert_eq!(y(&frame.rects, 0, RECT_BYTES), 2.9);
        assert_eq!(y(&frame.rects, 1, RECT_BYTES), 3.9);
        // The rest is as it was.
        assert_eq!(frame.glyphs[8..GLYPH_BYTES], row.glyphs[8..]);
    }

    #[test]
    fn a_rows_key_is_what_is_in_it_wherever_it_is() {
        let cell = |row, text| Cell {
            row,
            col: 3,
            width: 1,
            flags: 0,
            color: 0xff11_2233,
            background: 0,
            underline: 0,
            text,
        };
        assert_eq!(row_key(&[cell(1, "a")]), row_key(&[cell(9, "a")]));
        assert_ne!(row_key(&[cell(1, "a")]), row_key(&[cell(1, "b")]));
        assert_ne!(
            row_key(&[cell(1, "ab")]),
            row_key(&[
                cell(1, "a"),
                Cell {
                    col: 4,
                    ..cell(1, "b")
                }
            ])
        );
    }

    #[test]
    fn cells_parse_as_core_gui_sls_packs_them() {
        let text = b"xa\xcc\x81";
        let mut b = Vec::new();
        for v in [
            3u32 << 16 | 7,
            1 << 16 | (BOLD | DIM),
            0xff12_3456,
            0x00ab_cdef,
            0xff00_ff00,
            1,
            3,
        ] {
            b.extend_from_slice(&v.to_ne_bytes());
        }
        let c = Cell::parse(&b, text).unwrap();
        assert_eq!((c.row, c.col, c.width, c.text), (3, 7, 1, "a\u{301}"));
        assert_eq!(c.style(), 1);
        assert_eq!(c.color, 0x8012_3456, "faint text is half strength");
        assert_eq!(c.background, 0xab_cdef);
        // Text out of range, or not UTF-8, is no cell.
        let mut bad = b.clone();
        bad[24..28].copy_from_slice(&9u32.to_ne_bytes());
        assert!(Cell::parse(&bad, text).is_none());
    }

    /// Feature settings, whatever is typed, are taken or named as not
    /// understood: none is lost, and nothing panics.
    #[hegel::test(test_cases = 300, database = None)]
    fn any_feature_text_is_taken_or_refused(tc: TestCase) {
        let text = tc.draw(gs::text().max_size(40));
        let (features, bad) = parse_features(&[text.clone()]);
        let words = text
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|s| !s.is_empty())
            .count();
        assert_eq!(features.len() + bad.len(), words);
    }

    /// Whatever bytes a cell is, it is read or refused, never more.
    #[hegel::test(test_cases = 300, database = None)]
    fn any_cell_is_read_or_refused(tc: TestCase) {
        let cell = tc.draw(gs::binary().min_size(CELL_BYTES).max_size(CELL_BYTES));
        let text = tc.draw(gs::binary().max_size(16));
        if let Some(c) = Cell::parse(&cell, &text) {
            assert!(c.width >= 1 && c.text.len() <= text.len());
        }
    }
}
