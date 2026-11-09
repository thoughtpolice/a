// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The GUI's text: fonts from the system (fontique, which asks fontconfig),
//! shaped with HarfRust, drawn from their outlines (skrifa) as Slug shapes
//! (slug.rs) at whatever size, on a grid of cells as a terminal's.
//!
//! [`Fonts::layout`] takes a frame's cells and returns what to draw: glyphs
//! (kernel/gui.slang's `Glyph`) and rectangles for underlines. Runs of
//! cells in one style and color are shaped together, so ligatures and
//! combining marks work; each glyph is placed at the cell its cluster
//! starts in, so the grid stays a grid whatever the font's advances.
//! Characters the font lacks come from a fallback font for their script.
//!
//! Box drawing and block characters are drawn here, as ghostty and other
//! terminals do, to fill their cells exactly and join their neighbors:
//! they are shapes in a cell's own coordinates, built for the cell size.

use std::collections::HashMap;
use std::rc::Rc;

use fontique::{
    Attributes, Collection, CollectionOptions, FallbackKey, FontStyle, FontWeight, FontWidth,
    GenericFamily, QueryFamily, QueryStatus, SourceCache,
};
use harfrust::{Buffer, ShapeOptions, ShaperFont};
use skrifa::{DrawMemory, GlyphId, ScalerFont};

use crate::slug::{Atlas, Curve, Outline, Shape};

/// A glyph as the shader reads it: `Glyph` in kernel/gui.slang.
pub const GLYPH_BYTES: usize = 64;
/// A rectangle as the shader reads it: `Rect` in kernel/gui.slang.
pub const RECT_BYTES: usize = 32;
/// A cell as Scheme sends it (core/gui.sls): seven u32s.
pub const CELL_BYTES: usize = 28;

/// How many shaped runs to remember, before starting afresh.
const SHAPED_RUNS: usize = 8192;

/// How many laid-out rows to remember, before starting afresh.
const LAID_ROWS: usize = 4096;

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
const BUILT_IN: [&[u8]; 4] = [
    include_bytes!("fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("fonts/JetBrainsMono-Bold.ttf"),
    include_bytes!("fonts/JetBrainsMono-Italic.ttf"),
    include_bytes!("fonts/JetBrainsMono-BoldItalic.ttf"),
];

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
    font: skrifa::Font,
    /// The font file and the index in it, so each is loaded once.
    key: (u64, u32),
    units_per_em: f32,
}

pub struct Fonts {
    collection: Collection,
    cache: SourceCache,
    family: String,
    points: f32,
    scale: f32,
    faces: Vec<Face>,
    /// The face for regular, bold, italic and bold italic text.
    styles: [usize; 4],
    /// The face for characters the styles' fonts lack, by style.
    fallbacks: HashMap<(usize, char), usize>,
    shapes: HashMap<(usize, u32), Option<Shape>>,
    /// Rows already laid out, at the top: by what is in them (row_key).
    /// Their glyphs name the atlas's shapes, so they go when it is cleared.
    rows: HashMap<Vec<u8>, Rc<Layout>>,
    /// Runs already shaped: by face, text, and where each cell starts.
    shaped: HashMap<(usize, String, Vec<u32>), Rc<[(u32, f32, f32, usize)]>>,
    sprites: HashMap<Sprite, Option<Shape>>,
    pub atlas: Atlas,
    pub metrics: Metrics,
}

impl Fonts {
    /// The family's fonts at `points`, on a display scaled by `scale`; the
    /// generic monospace family where the family is not installed. The
    /// built-in JetBrains Mono is always there.
    pub fn new(family: &str, points: f32, scale: f32) -> Result<Fonts, String> {
        let mut collection = Collection::new(CollectionOptions {
            shared: false,
            system_fonts: true,
        });
        for data in BUILT_IN {
            collection.register_fonts(fontique::Blob::new(std::sync::Arc::new(data)), None);
        }
        let mut fonts = Fonts {
            collection,
            cache: SourceCache::default(),
            family: family.to_string(),
            points,
            scale,
            faces: Vec::new(),
            styles: [0; 4],
            fallbacks: HashMap::new(),
            shapes: HashMap::new(),
            shaped: HashMap::new(),
            rows: HashMap::new(),
            sprites: HashMap::new(),
            atlas: Atlas::default(),
            metrics: Metrics {
                cell: [1.0, 1.0],
                baseline: 0.0,
                px_per_em: 1.0,
                underline: [1.0, 1.0],
                strikethrough: [1.0, 1.0],
                padding: 0.0,
            },
        };
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
        Ok(fonts)
    }

    /// Draws in `family` at `points` from now on: the same faces at another
    /// size, or another family's.
    pub fn set_font(&mut self, family: &str, points: f32) -> Result<(), String> {
        if family != self.family {
            let scale = self.scale;
            *self = Fonts::new(family, points, scale)?;
        } else if points != self.points {
            self.points = points;
            self.measure();
        }
        Ok(())
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
        let mut px_per_em = self.points * 96.0 / 72.0 * self.scale;
        // Lengyel's advice for unhinted text: a size at which capitals are
        // a whole number of pixels tall puts their tops and bottoms on the
        // pixel grid.
        if let Some(cap) = metrics.cap_height.map(|c| c.to_f32()).filter(|&c| c > 0.0) {
            let px = (px_per_em * cap / upem).round().max(1.0);
            px_per_em = px * upem / cap;
        }
        let px = px_per_em / upem;
        let line = if metrics.use_typo_metrics {
            metrics.typo_line.or(metrics.hhea_line)
        } else {
            metrics.hhea_line.or(metrics.typo_line)
        };
        let (ascent, descent, gap) = line.map_or((0.8 * upem, -0.2 * upem, 0.0), |l| {
            (
                l.ascender.to_f32(),
                l.descender.to_f32(),
                l.line_gap.to_f32(),
            )
        });
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
    }

    /// The face of `self.family` (else any monospace font) nearest to
    /// weight and style.
    fn find(&mut self, weight: FontWeight, style: FontStyle) -> Option<usize> {
        let family = self.family.clone();
        let mut query = self.collection.query(&mut self.cache);
        query.set_families([
            QueryFamily::Named(&family),
            QueryFamily::Generic(GenericFamily::Monospace),
        ]);
        query.set_attributes(Attributes::new(FontWidth::NORMAL, style, weight));
        let found = query.first_available_font()?;
        drop(query);
        self.face(found.blob, found.index)
    }

    fn face(&mut self, blob: fontique::Blob<u8>, index: u32) -> Option<usize> {
        let key = (blob.id(), index);
        if let Some(i) = self.faces.iter().position(|f| f.key == key) {
            return Some(i);
        }
        let (data, _) = blob.into_raw_parts();
        let font = skrifa::Font::new(data, index)?;
        let units_per_em = f32::from(font.units_per_em().max(1));
        self.faces.push(Face {
            font,
            key,
            units_per_em,
        });
        Some(self.faces.len() - 1)
    }

    /// The face to draw `c` with in style `style`: the style's own, else a
    /// fallback font for c's script that has it, else the style's own
    /// (whose missing-glyph box says so).
    fn face_for(&mut self, style: usize, c: char) -> usize {
        let own = self.styles[style];
        if c.is_ascii() || self.faces[own].font.charmap().map_unicode(c).is_some() {
            return own;
        }
        if let Some(&face) = self.fallbacks.get(&(style, c)) {
            return face;
        }
        let face = self.fallback(style, c).unwrap_or(own);
        self.fallbacks.insert((style, c), face);
        face
    }

    fn fallback(&mut self, style: usize, c: char) -> Option<usize> {
        // The character's script, as HarfRust guesses it.
        let mut buffer = Buffer::new();
        buffer.push_str(c.encode_utf8(&mut [0; 4]));
        buffer.guess_segment_properties();
        let script = buffer
            .script()
            .map(|s| fontique::Script::from_bytes(s.tag().to_be_bytes()));
        let (weight, slant) = match style {
            1 => (FontWeight::BOLD, FontStyle::Normal),
            2 => (FontWeight::NORMAL, FontStyle::Italic),
            3 => (FontWeight::BOLD, FontStyle::Italic),
            _ => (FontWeight::NORMAL, FontStyle::Normal),
        };
        let mut query = self.collection.query(&mut self.cache);
        query.set_families([QueryFamily::Generic(GenericFamily::Monospace)]);
        query.set_attributes(Attributes::new(FontWidth::NORMAL, slant, weight));
        if let Some(script) = script {
            query.set_fallbacks(FallbackKey::new(script, None));
        }
        let mut found = None;
        query.matches_with(|font| {
            if font.charmap().is_some_and(|m| m.map(c).is_some()) {
                found = Some((font.blob.clone(), font.index));
                QueryStatus::Stop
            } else {
                QueryStatus::Continue
            }
        });
        drop(query);
        if found.is_none() {
            found = self.any_family_with(c, slant, weight);
        }
        let (blob, index) = found?;
        self.face(blob, index)
    }

    /// The first font of any family that has `c`, for characters no script
    /// has fallbacks for (dingbats and other symbols are Common): slow, but
    /// once a character, as fontconfig's matching by character set is.
    fn any_family_with(
        &mut self,
        c: char,
        slant: FontStyle,
        weight: FontWeight,
    ) -> Option<(fontique::Blob<u8>, u32)> {
        let families: Vec<fontique::FamilyId> = self.collection.family_ids().collect();
        for family in families {
            let mut query = self.collection.query(&mut self.cache);
            query.set_families([QueryFamily::Id(family)]);
            query.set_attributes(Attributes::new(FontWidth::NORMAL, slant, weight));
            let mut found = None;
            query.matches_with(|font| {
                if font.charmap().is_some_and(|m| m.map(c).is_some()) {
                    found = Some((font.blob.clone(), font.index));
                }
                QueryStatus::Stop
            });
            if found.is_some() {
                return found;
            }
        }
        None
    }

    /// A glyph's shape, made the first time it is asked for.
    fn glyph(&mut self, face: usize, glyph: u32) -> Option<Shape> {
        if let Some(shape) = self.shapes.get(&(face, glyph)) {
            return *shape;
        }
        let f = &self.faces[face];
        let scaler = ScalerFont::unhinted(f.font.clone(), None);
        let mut outline = Outline::new(1.0 / f.units_per_em);
        let shape = scaler
            .outline(GlyphId::new(glyph))
            .and_then(|o| o.draw(DrawMemory::Scratch, &mut outline).ok())
            .and_then(|_| self.atlas.add(&outline.finish()));
        self.shapes.insert((face, glyph), shape);
        shape
    }

    /// What to draw for a frame's `cells` ([`CELL_BYTES`] each, with their
    /// texts in `text`): glyphs, and rectangles (in cells) for underlines.
    pub fn layout(&mut self, cells: &[u8], text: &[u8]) -> (Vec<u8>, Vec<u8>) {
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
            let key = row_key(row);
            let laid = match self.rows.get(&key) {
                Some(laid) => laid.clone(),
                None => {
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
            };
            out.append_moved(&laid, y as f32 * ch, y as f32);
        }
        (out.glyphs, out.rects)
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
        let faces: Vec<usize> = run
            .iter()
            .map(|c| self.face_for(style, c.text.chars().next().unwrap_or(' ')))
            .collect();
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
        for &(glyph, x, y, cell) in placed.iter() {
            let Some(shape) = self.glyph(face, glyph) else {
                continue;
            };
            let c = &cells[cell];
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
        if harfrust::shape(&shaper, &mut buffer, ShapeOptions::new()).is_err() {
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

/// A cell, as core/gui.sls sends it.
#[derive(Clone, Copy)]
struct Cell<'t> {
    row: u32,
    col: u32,
    width: u32,
    flags: u32,
    /// 0xAARRGGBB.
    color: u32,
    /// 0xRRGGBB: what is behind its text.
    background: u32,
    /// 0xAARRGGBB: its underline's color; alpha 0 for its text's.
    underline: u32,
    text: &'t str,
}

impl<'t> Cell<'t> {
    fn parse(b: &[u8], text: &'t [u8]) -> Option<Cell<'t>> {
        let word =
            |i: usize| u32::from_ne_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]]);
        let (place, attrs, color, background, underline, start, len) = (
            word(0),
            word(1),
            word(2),
            word(3),
            word(4),
            word(5),
            word(6),
        );
        let text = text.get(start as usize..start.checked_add(len)? as usize)?;
        let flags = attrs & 0xffff;
        Some(Cell {
            row: place >> 16,
            col: place & 0xffff,
            width: (attrs >> 16).max(1),
            flags,
            // Faint text, at half strength, as ghostty draws it.
            color: if flags & DIM != 0 {
                color & 0x00ff_ffff | 0x8000_0000
            } else {
                color
            },
            background: background & 0x00ff_ffff,
            underline,
            text: std::str::from_utf8(text).ok()?,
        })
    }

    fn style(&self) -> usize {
        usize::from(self.flags & BOLD != 0) | usize::from(self.flags & ITALIC != 0) << 1
    }
}

/// What makes a row look as it does: each cell's column, width,
/// attributes, color and text, whatever row it is on.
fn row_key(cells: &[Cell]) -> Vec<u8> {
    let mut key = Vec::with_capacity(cells.len() * 20);
    for c in cells {
        for v in [
            c.col,
            c.width << 16 | c.flags,
            c.color,
            c.background,
            c.underline,
            c.text.len() as u32,
        ] {
            key.extend_from_slice(&v.to_ne_bytes());
        }
        key.extend_from_slice(c.text.as_bytes());
    }
    key
}

#[derive(Default)]
struct Layout {
    glyphs: Vec<u8>,
    rects: Vec<u8>,
}

impl Layout {
    /// Appends `other`, moved down `pixels` (its glyphs) and `cells` (its
    /// rectangles): a row laid out at the top, put where it is.
    fn append_moved(&mut self, other: &Layout, pixels: f32, cells: f32) {
        let moved = |out: &mut Vec<u8>, from: &[u8], size: usize, dy: f32| {
            let start = out.len();
            out.extend_from_slice(from);
            // y is each record's second f32.
            for record in out[start..].chunks_exact_mut(size) {
                let y = f32::from_ne_bytes(record[4..8].try_into().unwrap()) + dy;
                record[4..8].copy_from_slice(&y.to_ne_bytes());
            }
        };
        moved(&mut self.glyphs, &other.glyphs, GLYPH_BYTES, pixels);
        moved(&mut self.rects, &other.rects, RECT_BYTES, cells);
    }

    /// A glyph whose em-space origin is at pixel `origin`, `px` pixels to
    /// the em. Its quad is a pixel wider on each side than the shape, for
    /// the edges' antialiasing.
    fn glyph(&mut self, shape: &Shape, origin: [f32; 2], px: f32, color: u32, background: u32) {
        let [x0, y0, x1, y1] = shape.bounds;
        let pad = 1.0 / px;
        let em = [x0 - pad, y1 + pad, x1 + pad, y0 - pad];
        let rect = [
            origin[0] + em[0] * px,
            origin[1] - em[1] * px,
            (em[2] - em[0]) * px,
            (em[1] - em[3]) * px,
        ];
        for v in rect.into_iter().chain(em).chain(shape.banding) {
            self.glyphs.extend_from_slice(&v.to_ne_bytes());
        }
        let band_max = u32::from(shape.band_max[0]) | u32::from(shape.band_max[1]) << 16;
        for v in [shape.location, band_max, color, background] {
            self.glyphs.extend_from_slice(&v.to_ne_bytes());
        }
    }

    /// A rectangle, in cells.
    fn rect(&mut self, bounds: [f32; 4], color: u32) {
        for v in bounds {
            self.rects.extend_from_slice(&v.to_ne_bytes());
        }
        for v in [color, 0, 0, 0] {
            self.rects.extend_from_slice(&v.to_ne_bytes());
        }
    }
}

// MARK: Sprites

/// Characters drawn to fit their cells, and the undercurl.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Sprite {
    /// Box drawing lines from the center: weights (0 none, 1 light, 2
    /// heavy) of the arms left, right, up and down.
    Lines([u8; 4]),
    /// A rounded corner, with arms right (true) or left, and up (true) or
    /// down.
    Arc {
        right: bool,
        up: bool,
    },
    /// A block: left, bottom, right and top, in eighths of the cell.
    Block([u8; 4]),
    Undercurl,
}

impl Sprite {
    fn of(text: &str) -> Option<Sprite> {
        let mut chars = text.chars();
        let c = chars.next()?;
        if chars.next().is_some() {
            return None;
        }
        // Arms: left, right, up, down.
        let lines = |l, r, u, d| Some(Sprite::Lines([l, r, u, d]));
        match c {
            '─' => lines(1, 1, 0, 0),
            '━' => lines(2, 2, 0, 0),
            '│' => lines(0, 0, 1, 1),
            '┃' => lines(0, 0, 2, 2),
            '┌' => lines(0, 1, 0, 1),
            '┐' => lines(1, 0, 0, 1),
            '└' => lines(0, 1, 1, 0),
            '┘' => lines(1, 0, 1, 0),
            '├' => lines(0, 1, 1, 1),
            '┤' => lines(1, 0, 1, 1),
            '┬' => lines(1, 1, 0, 1),
            '┴' => lines(1, 1, 1, 0),
            '┼' => lines(1, 1, 1, 1),
            '┏' => lines(0, 2, 0, 2),
            '┓' => lines(2, 0, 0, 2),
            '┗' => lines(0, 2, 2, 0),
            '┛' => lines(2, 0, 2, 0),
            '╴' => lines(1, 0, 0, 0),
            '╵' => lines(0, 0, 1, 0),
            '╶' => lines(0, 1, 0, 0),
            '╷' => lines(0, 0, 0, 1),
            '╭' => Some(Sprite::Arc {
                right: true,
                up: false,
            }),
            '╮' => Some(Sprite::Arc {
                right: false,
                up: false,
            }),
            '╯' => Some(Sprite::Arc {
                right: false,
                up: true,
            }),
            '╰' => Some(Sprite::Arc {
                right: true,
                up: true,
            }),
            '█' => Some(Sprite::Block([0, 0, 8, 8])),
            '▀' => Some(Sprite::Block([0, 4, 8, 8])),
            '▄' => Some(Sprite::Block([0, 0, 8, 4])),
            '▌' => Some(Sprite::Block([0, 0, 4, 8])),
            '▐' => Some(Sprite::Block([4, 0, 8, 8])),
            // Lower eighths: ▁ is one, ▇ seven.
            '▁'..='▇' => Some(Sprite::Block([0, 0, 8, (c as u32 - 0x2580) as u8])),
            _ => None,
        }
    }

    /// The sprite's contours, in pixels from the cell's bottom left.
    fn draw(&self, m: &Metrics) -> Vec<Vec<Curve>> {
        let [w, h] = m.cell;
        let light = m.underline[1];
        let thickness = |weight: u8| light * f32::from(weight);
        // Where a line of thickness t is centered, on whole pixels.
        let center = |extent: f32, t: f32| ((extent - t) / 2.0).floor() + t / 2.0;
        let mut contours = Vec::new();
        match *self {
            Sprite::Lines([l, r, u, d]) => {
                let horizontal = thickness(l.max(r));
                let vertical = thickness(u.max(d));
                // Centered as a light line is, so lines of either weight
                // meet light ones in the next cell.
                let (cx, cy) = (center(w, light), center(h, light));
                // Arms reach past the center by half the crossing line,
                // so corners close.
                let (reach_x, reach_y) = (vertical / 2.0, horizontal / 2.0);
                let half = |weight: u8| thickness(weight) / 2.0;
                let arms = [
                    (l, [0.0, cy - half(l), cx + reach_x, cy + half(l)]),
                    (r, [cx - reach_x, cy - half(r), w, cy + half(r)]),
                    (u, [cx - half(u), cy - reach_y, cx + half(u), h]),
                    (d, [cx - half(d), 0.0, cx + half(d), cy + reach_y]),
                ];
                for (weight, [x0, y0, x1, y1]) in arms {
                    if weight > 0 {
                        contours.push(rect(x0, y0, x1, y1));
                    }
                }
            }
            Sprite::Arc { right, up } => {
                let t = light;
                let (cx, cy) = (center(w, t), center(h, t));
                let (sx, sy) = (if right { 1.0 } else { -1.0 }, if up { 1.0 } else { -1.0 });
                // The arc's radius: as large as the cell allows.
                let r = (if right { w - cx } else { cx }).min(if up { h - cy } else { cy });
                let r = r.min(w / 2.0).max(t);
                let (ax, ay) = (cx + sx * r, cy + sy * r);
                // The arms beyond the arc, to the cell's edges.
                if right {
                    contours.push(rect(ax, cy - t / 2.0, w, cy + t / 2.0));
                } else {
                    contours.push(rect(0.0, cy - t / 2.0, ax, cy + t / 2.0));
                }
                if up {
                    contours.push(rect(cx - t / 2.0, ay, cx + t / 2.0, h));
                } else {
                    contours.push(rect(cx - t / 2.0, 0.0, cx + t / 2.0, ay));
                }
                // The quarter ring around (ax, ay), from the horizontal
                // arm's end to the vertical's.
                contours.push(ring_quarter(
                    [ax, ay],
                    r - t / 2.0,
                    r + t / 2.0,
                    [0.0, -sy],
                    [-sx, 0.0],
                ));
            }
            Sprite::Block([l, b, r, t]) => {
                let x = |e: u8| (w * f32::from(e) / 8.0).round();
                let y = |e: u8| (h * f32::from(e) / 8.0).round();
                contours.push(rect(x(l), y(b), x(r), y(t)));
            }
            Sprite::Undercurl => {
                // One period of a wave per cell, under the baseline.
                let t = light;
                let mid = h - (m.baseline + m.underline[0] + t / 2.0);
                let a = (t * 1.5).min(mid.max(t));
                let wave = |offset: f32| -> Vec<[f32; 2]> {
                    // Quarter periods: the points, and between each two a
                    // control point where their tangents meet.
                    let ys = [0.0, 1.0, 0.0, -1.0, 0.0];
                    let mut points = Vec::new();
                    for i in 0..4 {
                        let (x0, x1) = (w * i as f32 / 4.0, w * (i + 1) as f32 / 4.0);
                        let (y0, y1) = (mid + offset + a * ys[i], mid + offset + a * ys[i + 1]);
                        // Slopes of a·sin at the ends of the quarter.
                        let k = a * std::f32::consts::TAU / w;
                        let slope = |i: usize| k * [1.0, 0.0, -1.0, 0.0, 1.0][i];
                        let (m0, m1) = (slope(i), slope(i + 1));
                        let cx = if (m0 - m1).abs() > 1e-6 {
                            ((y1 - m1 * x1) - (y0 - m0 * x0)) / (m0 - m1)
                        } else {
                            (x0 + x1) / 2.0
                        };
                        let cy = y0 + m0 * (cx - x0);
                        if i == 0 {
                            points.push([x0, y0]);
                        }
                        points.push([cx, cy]);
                        points.push([x1, y1]);
                    }
                    points
                };
                let (top, bottom) = (wave(t / 2.0), wave(-t / 2.0));
                let mut o = Outline::new(1.0);
                o.move_to_scaled(bottom[0]);
                for q in bottom[1..].chunks(2) {
                    o.quad_to_scaled(q[0], q[1]);
                }
                let rev: Vec<[f32; 2]> = top.into_iter().rev().collect();
                o.line_to_scaled(rev[0]);
                for q in rev[1..].chunks(2) {
                    o.quad_to_scaled(q[0], q[1]);
                }
                contours.extend(o.finish());
            }
        }
        contours
    }
}

/// A rectangle, counterclockwise (y up), as every sprite's contours are,
/// so that overlaps add up and never cancel.
fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<Curve> {
    let mut o = Outline::new(1.0);
    o.move_to_scaled([x0, y0]);
    o.line_to_scaled([x1, y0]);
    o.line_to_scaled([x1, y1]);
    o.line_to_scaled([x0, y1]);
    o.finish().pop().unwrap_or_default()
}

/// A quarter of a ring around `c`, between radii r0 and r1, from direction
/// `from` to direction `to` (unit vectors a right angle apart),
/// counterclockwise.
fn ring_quarter(c: [f32; 2], r0: f32, r1: f32, from: [f32; 2], to: [f32; 2]) -> Vec<Curve> {
    // A quarter circle as two eighths, each a quadratic whose control
    // point is where the ends' tangents meet.
    let arc = |o: &mut Outline, r: f32, a: [f32; 2], b: [f32; 2]| {
        let m = [(a[0] + b[0]), (a[1] + b[1])];
        let len = (m[0] * m[0] + m[1] * m[1]).sqrt();
        let mid = [m[0] / len, m[1] / len];
        let k = 1.0 / (std::f32::consts::PI / 8.0).cos();
        for (p, q) in [(a, mid), (mid, b)] {
            let h = [p[0] + q[0], p[1] + q[1]];
            let hl = (h[0] * h[0] + h[1] * h[1]).sqrt();
            let ctrl = [c[0] + h[0] / hl * r * k, c[1] + h[1] / hl * r * k];
            o.quad_to_scaled(ctrl, [c[0] + q[0] * r, c[1] + q[1] * r]);
        }
    };
    let mut o = Outline::new(1.0);
    o.move_to_scaled([c[0] + from[0] * r1, c[1] + from[1] * r1]);
    arc(&mut o, r1, from, to);
    o.line_to_scaled([c[0] + to[0] * r0, c[1] + to[1] * r0]);
    arc(&mut o, r0, to, from);
    let contour = o.finish().pop().unwrap_or_default();
    counterclockwise(contour)
}

fn counterclockwise(mut contour: Vec<Curve>) -> Vec<Curve> {
    let area: f32 = contour
        .iter()
        .map(|c| c.p1[0] * c.p3[1] - c.p3[0] * c.p1[1])
        .sum();
    if area < 0.0 {
        contour.reverse();
        for c in &mut contour {
            std::mem::swap(&mut c.p1, &mut c.p3);
        }
    }
    contour
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics() -> Metrics {
        Metrics {
            cell: [10.0, 20.0],
            baseline: 15.0,
            px_per_em: 16.0,
            underline: [2.0, 1.0],
            strikethrough: [4.0, 1.0],
            padding: 2.0,
        }
    }

    #[test]
    fn box_drawing_is_drawn_and_text_is_not() {
        assert_eq!(Sprite::of("─"), Some(Sprite::Lines([1, 1, 0, 0])));
        assert_eq!(
            Sprite::of("╭"),
            Some(Sprite::Arc {
                right: true,
                up: false
            })
        );
        assert_eq!(Sprite::of("▄"), Some(Sprite::Block([0, 0, 8, 4])));
        assert_eq!(Sprite::of("▁"), Some(Sprite::Block([0, 0, 8, 1])));
        assert_eq!(Sprite::of("a"), None);
        assert_eq!(Sprite::of("─a"), None);
    }

    #[test]
    fn lines_reach_the_cells_edges_and_meet_in_the_middle() {
        let m = metrics();
        let mut atlas = Atlas::default();
        for sprite in [Sprite::Lines([1, 1, 0, 0]), Sprite::Lines([0, 0, 1, 1])] {
            let shape = atlas.add(&sprite.draw(&m)).unwrap();
            let [x0, y0, x1, y1] = shape.bounds;
            match sprite {
                Sprite::Lines([1, ..]) => {
                    assert_eq!((x0, x1), (0.0, 10.0));
                    assert_eq!(y1 - y0, 1.0, "one light line thick");
                }
                _ => {
                    assert_eq!((y0, y1), (0.0, 20.0));
                    assert_eq!(x1 - x0, 1.0);
                }
            }
        }
    }

    #[test]
    fn rounded_corners_join_their_neighbors() {
        let m = metrics();
        let mut atlas = Atlas::default();
        // ╭: arms right and down, so it touches the right and bottom edges
        // where ─ and │ are.
        let corner = atlas
            .add(
                &Sprite::Arc {
                    right: true,
                    up: false,
                }
                .draw(&m),
            )
            .unwrap();
        let line = atlas.add(&Sprite::Lines([1, 1, 0, 0]).draw(&m)).unwrap();
        assert_eq!(corner.bounds[2], 10.0);
        assert_eq!(corner.bounds[1], 0.0);
        // Its horizontal arm is where the line is.
        assert!(
            (corner.bounds[3] - line.bounds[3]).abs() < 1e-3,
            "{:?} {:?}",
            corner.bounds,
            line.bounds
        );
        let arc = Sprite::Arc {
            right: true,
            up: false,
        };
        for contour in arc.draw(&m) {
            let area: f32 = contour
                .iter()
                .map(|c| c.p1[0] * c.p3[1] - c.p3[0] * c.p1[1])
                .sum();
            assert!(area > 0.0, "every contour winds the same way");
        }
    }

    #[test]
    fn the_built_in_font_is_always_there() {
        // Tests run where fontconfig may not load: the built-in font needs
        // none.
        let mut fonts = Fonts::new("JetBrains Mono", 12.0, 1.0).unwrap();
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
        let (glyphs, rects) = fonts.layout(&cells, b"abc");
        assert_eq!(glyphs.len(), 3 * GLYPH_BYTES);
        assert!(rects.is_empty());
    }

    #[test]
    fn a_larger_font_makes_larger_cells() {
        let mut fonts = Fonts::new("JetBrains Mono", 12.0, 1.0).unwrap();
        let small = fonts.metrics;
        fonts.set_font("JetBrains Mono", 24.0).unwrap();
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
}
