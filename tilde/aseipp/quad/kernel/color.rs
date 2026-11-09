// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Color glyphs: emoji and other glyphs drawn in their own colors, from a
//! font's `COLR` table (version 0's layers of outlines in solid colors,
//! version 1's gradients, transforms and compositing) or from its bitmaps
//! (`CBDT`, `sbix`).
//!
//! Text is drawn from outlines on the GPU (slug.rs); color glyphs are
//! painted here instead, on the CPU, once for each size and cell, into
//! pictures as big as their cells, which kernel/gui.slang's image pipeline
//! draws as it does images (kernel/image.rs). Paths are filled with
//! coverage found exactly from their areas, as font-rs's accumulation
//! rasterizer does, and layers are composited as the `COLR` specification
//! says, in premultiplied sRGB, as browsers do.

use skrifa::color::Transform;
use skrifa::font::glyph::bitmap::Pixels;
use skrifa::font::glyph::color::{Brush, Color, ColorStop, CompositeMode, Extend, PaintSink};
use skrifa::metrics::BoundingBox;
use skrifa::{DrawMemory, GlyphId, PathSink, ScalerFont};

use crate::image;

/// A color glyph, painted: `width` by `height` pixels, each 0xAABBGGRR
/// (RGBA bytes, little-endian), sRGB-encoded, alpha not premultiplied, as
/// kernel/image.rs's pixels are.
#[derive(Debug)]
pub struct Painted {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u32>,
    /// Whether some of it is in the text's color, as a font can ask: then
    /// it is painted again for each color.
    pub uses_foreground: bool,
}

/// Where a glyph goes in the box it is painted in: `scale` pixels to the
/// font unit, its origin (the left of its advance, on the baseline) at
/// `origin`, in pixels from the box's top left.
#[derive(Clone, Copy, Debug)]
pub struct Placing {
    pub scale: f32,
    pub origin: [f32; 2],
}

/// Paints `glyph` from `font`'s `COLR` table into a `width` by `height`
/// box, placed so; None if the table has no such glyph. `foreground`
/// (0xAARRGGBB) is the text's color, for what the font paints in it.
pub fn paint_colr(
    font: &skrifa::Font,
    glyph: GlyphId,
    width: u32,
    height: u32,
    at: Placing,
    foreground: u32,
) -> Option<Painted> {
    let glyphs = font.color_glyphs();
    let color = glyphs.get(glyph)?;
    let palettes = font.palettes();
    let palette = palettes.get(0).map_or(&[][..], |p| p.colors());
    let mut painter = Painter::new(font, palette, foreground, width, height, at);
    color.paint(&mut painter).ok()?;
    Some(painter.finish())
}

/// Paints `glyph` from `font`'s bitmaps, from the strike nearest `ppem`,
/// into a `width` by `height` box: as large as fits, never larger than
/// it is, centered. None if the font has no bitmap for it in color.
pub fn paint_bitmap(
    font: &skrifa::Font,
    glyph: GlyphId,
    width: u32,
    height: u32,
    ppem: f32,
) -> Option<Painted> {
    let bitmap = font.bitmap_strikes().select_bitmap(glyph, Some(ppem))?;
    let decoded = match bitmap.pixels() {
        Pixels::Png(png) => image::decode(png).ok()?,
        Pixels::Bgra(bgra) => {
            let mut rgba = Vec::with_capacity(bgra.data().len());
            for p in bgra.data().chunks_exact(4) {
                // Premultiplied BGRA, to straight RGBA.
                let a = p[3];
                let un = |v: u8| {
                    if a == 0 {
                        0
                    } else {
                        ((u32::from(v) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8
                    }
                };
                rgba.extend_from_slice(&[un(p[2]), un(p[1]), un(p[0]), a]);
            }
            image::Decoded {
                width: bgra.width(),
                height: bgra.height(),
                rgba,
            }
        }
        Pixels::Mask(_) => return None,
    };
    if decoded.width == 0 || decoded.height == 0 {
        return None;
    }
    let scale = (width as f32 / decoded.width as f32)
        .min(height as f32 / decoded.height as f32)
        .min(1.0);
    let w = ((decoded.width as f32 * scale).round() as u32).clamp(1, width);
    let h = ((decoded.height as f32 * scale).round() as u32).clamp(1, height);
    let scaled = image::scale_to(&decoded, w, h);
    let (x0, y0) = ((width - w) / 2, (height - h) / 2);
    let mut pixels = vec![0; (width * height) as usize];
    for y in 0..h {
        let to = ((y0 + y) * width + x0) as usize;
        let from = (y * w) as usize;
        pixels[to..to + w as usize].copy_from_slice(&scaled[from..from + w as usize]);
    }
    Some(Painted {
        width,
        height,
        pixels,
        uses_foreground: false,
    })
}

// MARK: Painting

/// A color, premultiplied: red, green, blue (sRGB-encoded) and alpha.
type Rgba = [f32; 4];

/// A `COLR` glyph's paint operations, carried out on a canvas of pixels:
/// a stack of transforms (font units to pixels), of clips (coverage
/// masks), and of layers.
struct Painter<'a> {
    scaler: ScalerFont,
    palette: &'a [Color],
    /// The text's color, not premultiplied.
    foreground: Rgba,
    uses_foreground: bool,
    width: u32,
    height: u32,
    transforms: Vec<Transform>,
    clips: Vec<Vec<f32>>,
    layers: Vec<(Vec<Rgba>, CompositeMode)>,
}

impl<'a> Painter<'a> {
    fn new(
        font: &skrifa::Font,
        palette: &'a [Color],
        foreground: u32,
        width: u32,
        height: u32,
        at: Placing,
    ) -> Painter<'a> {
        let n = (width * height) as usize;
        let channel = |shift: u32| ((foreground >> shift) & 0xff) as f32 / 255.0;
        Painter {
            scaler: ScalerFont::unhinted(font.clone(), None),
            palette,
            foreground: [channel(16), channel(8), channel(0), channel(24)],
            uses_foreground: false,
            width,
            height,
            // Font units, y up, to pixels, y down.
            transforms: vec![Transform {
                xx: at.scale,
                yx: 0.0,
                xy: 0.0,
                yy: -at.scale,
                dx: at.origin[0],
                dy: at.origin[1],
            }],
            clips: vec![vec![1.0; n]],
            layers: vec![(vec![[0.0; 4]; n], CompositeMode::SrcOver)],
        }
    }

    fn transform(&self) -> Transform {
        *self.transforms.last().expect("the base transform")
    }

    /// Clips to `mask` as well as to what is clipped to already.
    fn push_mask(&mut self, mut mask: Vec<f32>) {
        let clip = self.clips.last().expect("the base clip");
        for (m, c) in mask.iter_mut().zip(clip) {
            *m *= c;
        }
        self.clips.push(mask);
    }

    /// A palette color, or the text's (0xFFFF), premultiplied, times
    /// `alpha`.
    fn color(&mut self, index: u16, alpha: f32) -> Rgba {
        let c = if index == 0xFFFF {
            self.uses_foreground = true;
            self.foreground
        } else {
            self.palette.get(usize::from(index)).map_or([0.0; 4], |c| {
                [
                    f32::from(c.red) / 255.0,
                    f32::from(c.green) / 255.0,
                    f32::from(c.blue) / 255.0,
                    f32::from(c.alpha) / 255.0,
                ]
            })
        };
        let a = c[3] * alpha;
        [c[0] * a, c[1] * a, c[2] * a, a]
    }

    fn stops(&mut self, stops: &[ColorStop]) -> Vec<(f32, Rgba)> {
        stops
            .iter()
            .map(|s| (s.offset, self.color(s.palette_index, s.alpha)))
            .collect()
    }

    fn finish(self) -> Painted {
        let (layer, _) = &self.layers[0];
        let pixels = layer
            .iter()
            .map(|&[r, g, b, a]| {
                if a <= 0.0 {
                    return 0;
                }
                let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
                byte(r / a) | byte(g / a) << 8 | byte(b / a) << 16 | byte(a) << 24
            })
            .collect();
        Painted {
            width: self.width,
            height: self.height,
            pixels,
            uses_foreground: self.uses_foreground,
        }
    }
}

impl PaintSink for Painter<'_> {
    fn push_transform(&mut self, transform: Transform) {
        let t = compose(self.transform(), transform);
        self.transforms.push(t);
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
    }

    fn push_clip_glyph(&mut self, glyph: GlyphId) {
        let mut raster = Raster::new(self.width, self.height);
        if let Some(outline) = self.scaler.outline(glyph) {
            let mut pen = Pen::new(&mut raster, self.transform());
            let _ = outline.draw(DrawMemory::Scratch, &mut pen);
            pen.close();
        }
        self.push_mask(raster.coverage());
    }

    fn push_clip_box(&mut self, b: BoundingBox) {
        let mut raster = Raster::new(self.width, self.height);
        let mut pen = Pen::new(&mut raster, self.transform());
        pen.move_to(b.x_min, b.y_min);
        pen.line_to(b.x_max, b.y_min);
        pen.line_to(b.x_max, b.y_max);
        pen.line_to(b.x_min, b.y_max);
        pen.close();
        self.push_mask(raster.coverage());
    }

    fn pop_clip(&mut self) {
        if self.clips.len() > 1 {
            self.clips.pop();
        }
    }

    fn fill(&mut self, brush: Brush<'_>) {
        // Each pixel's color, from where its center is in the brush's
        // space (font units, under the transforms).
        let Some(inverse) = invert(self.transform()) else {
            return;
        };
        let paint: Box<dyn Fn([f32; 2]) -> Rgba> = match brush {
            Brush::Solid {
                palette_index,
                alpha,
            } => {
                let c = self.color(palette_index, alpha);
                Box::new(move |_| c)
            }
            Brush::LinearGradient {
                p0,
                p1,
                color_stops,
                extend,
            } => {
                let stops = self.stops(color_stops);
                let d = [p1.x - p0.x, p1.y - p0.y];
                let len2 = d[0] * d[0] + d[1] * d[1];
                if len2 <= f32::EPSILON {
                    return;
                }
                Box::new(move |p| {
                    let t = ((p[0] - p0.x) * d[0] + (p[1] - p0.y) * d[1]) / len2;
                    line_color(&stops, extended(t, extend))
                })
            }
            Brush::RadialGradient {
                c0,
                r0,
                c1,
                r1,
                color_stops,
                extend,
            } => {
                let stops = self.stops(color_stops);
                Box::new(move |p| {
                    radial(p, [c0.x, c0.y], r0, [c1.x, c1.y], r1)
                        .map_or([0.0; 4], |t| line_color(&stops, extended(t, extend)))
                })
            }
            Brush::SweepGradient {
                c0,
                start_angle,
                end_angle,
                color_stops,
                extend,
            } => {
                let stops = self.stops(color_stops);
                Box::new(move |p| {
                    // Clockwise from the x axis, in degrees, as the brush's
                    // angles are.
                    let ccw = (p[1] - c0.y).atan2(p[0] - c0.x).to_degrees();
                    let angle = (360.0 - ccw).rem_euclid(360.0);
                    let span = end_angle - start_angle;
                    let t = if span.abs() <= f32::EPSILON {
                        if angle < start_angle { 0.0 } else { 1.0 }
                    } else {
                        (angle - start_angle) / span
                    };
                    line_color(&stops, extended(t, extend))
                })
            }
        };
        let w = self.width as usize;
        let clip = self.clips.last().expect("the base clip");
        let (layer, _) = self.layers.last_mut().expect("the base layer");
        for (i, (dst, &coverage)) in layer.iter_mut().zip(clip).enumerate() {
            if coverage <= 0.0 {
                continue;
            }
            let center = [(i % w) as f32 + 0.5, (i / w) as f32 + 0.5];
            let c = paint(apply(inverse, center));
            let src = [
                c[0] * coverage,
                c[1] * coverage,
                c[2] * coverage,
                c[3] * coverage,
            ];
            *dst = composite(CompositeMode::SrcOver, src, *dst);
        }
    }

    fn push_layer(&mut self, mode: CompositeMode) {
        let n = (self.width * self.height) as usize;
        self.layers.push((vec![[0.0; 4]; n], mode));
    }

    fn pop_layer(&mut self) {
        if let Some(mode) = self.layers.last().map(|(_, mode)| *mode) {
            self.pop_layer_with_mode(mode);
        }
    }

    fn pop_layer_with_mode(&mut self, mode: CompositeMode) {
        if self.layers.len() < 2 {
            return;
        }
        let (src, _) = self.layers.pop().expect("a layer");
        let (dst, _) = self.layers.last_mut().expect("the base layer");
        for (d, s) in dst.iter_mut().zip(src) {
            *d = composite(mode, s, *d);
        }
    }
}

/// `outer` after `inner`.
fn compose(outer: Transform, inner: Transform) -> Transform {
    Transform {
        xx: outer.xx * inner.xx + outer.xy * inner.yx,
        yx: outer.yx * inner.xx + outer.yy * inner.yx,
        xy: outer.xx * inner.xy + outer.xy * inner.yy,
        yy: outer.yx * inner.xy + outer.yy * inner.yy,
        dx: outer.xx * inner.dx + outer.xy * inner.dy + outer.dx,
        dy: outer.yx * inner.dx + outer.yy * inner.dy + outer.dy,
    }
}

fn apply(t: Transform, p: [f32; 2]) -> [f32; 2] {
    [
        t.xx * p[0] + t.xy * p[1] + t.dx,
        t.yx * p[0] + t.yy * p[1] + t.dy,
    ]
}

fn invert(t: Transform) -> Option<Transform> {
    let det = t.xx * t.yy - t.xy * t.yx;
    if det.abs() <= f32::EPSILON * 1e-3 {
        return None;
    }
    let (xx, yx, xy, yy) = (t.yy / det, -t.yx / det, -t.xy / det, t.xx / det);
    Some(Transform {
        xx,
        yx,
        xy,
        yy,
        dx: -(xx * t.dx + xy * t.dy),
        dy: -(yx * t.dx + yy * t.dy),
    })
}

/// Where a color line is at `t`, as its extend mode says beyond its ends.
fn extended(t: f32, extend: Extend) -> f32 {
    match extend {
        Extend::Repeat => t - t.floor(),
        Extend::Reflect => {
            let u = t.rem_euclid(2.0);
            if u > 1.0 { 2.0 - u } else { u }
        }
        // Pad: the ends' colors, as line_color gives them.
        _ => t,
    }
}

/// A color line's color at `t`: interpolated between the stops around it,
/// premultiplied, or the nearer end's past them.
fn line_color(stops: &[(f32, Rgba)], t: f32) -> Rgba {
    let (Some(first), Some(last)) = (stops.first(), stops.last()) else {
        return [0.0; 4];
    };
    if t <= first.0 {
        return first.1;
    }
    if t >= last.0 {
        return last.1;
    }
    let i = stops.partition_point(|s| s.0 <= t).max(1);
    let ((t0, a), (t1, b)) = (stops[i - 1], stops[i]);
    let f = if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 };
    [
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
        a[3] + (b[3] - a[3]) * f,
    ]
}

/// Where `p` is on a radial gradient's color line, from circle (c0, r0)
/// to (c1, r1): the largest t whose circle, c0 + t (c1 - c0) with radius
/// r0 + t (r1 - r0) ≥ 0, passes through it; None where none does.
fn radial(p: [f32; 2], c0: [f32; 2], r0: f32, c1: [f32; 2], r1: f32) -> Option<f32> {
    let cd = [c1[0] - c0[0], c1[1] - c0[1]];
    let pd = [p[0] - c0[0], p[1] - c0[1]];
    let dr = r1 - r0;
    // |pd - t cd| = r0 + t dr, squared: a t² - 2 b t + c = 0.
    let a = cd[0] * cd[0] + cd[1] * cd[1] - dr * dr;
    let b = pd[0] * cd[0] + pd[1] * cd[1] + r0 * dr;
    let c = pd[0] * pd[0] + pd[1] * pd[1] - r0 * r0;
    let radius_ok = |t: f32| r0 + t * dr >= 0.0;
    if a.abs() <= 1e-6 {
        if b.abs() <= 1e-6 {
            return None;
        }
        let t = c / (2.0 * b);
        return radius_ok(t).then_some(t);
    }
    let disc = b * b - a * c;
    if disc < 0.0 {
        return None;
    }
    let s = disc.sqrt();
    let (t1, t2) = ((b + s) / a, (b - s) / a);
    let (hi, lo) = if t1 > t2 { (t1, t2) } else { (t2, t1) };
    if radius_ok(hi) {
        Some(hi)
    } else if radius_ok(lo) {
        Some(lo)
    } else {
        None
    }
}

/// `src` composited onto `dst` (both premultiplied) as `mode` says: the
/// Porter-Duff operators, and the W3C's blend modes.
fn composite(mode: CompositeMode, s: Rgba, d: Rgba) -> Rgba {
    let (sa, da) = (s[3], d[3]);
    let porter_duff = |fs: f32, fd: f32| {
        [
            s[0] * fs + d[0] * fd,
            s[1] * fs + d[1] * fd,
            s[2] * fs + d[2] * fd,
            sa * fs + da * fd,
        ]
    };
    use CompositeMode as M;
    match mode {
        M::Clear => [0.0; 4],
        M::Src => s,
        M::Dest => d,
        M::SrcOver => porter_duff(1.0, 1.0 - sa),
        M::DestOver => porter_duff(1.0 - da, 1.0),
        M::SrcIn => porter_duff(da, 0.0),
        M::DestIn => porter_duff(0.0, sa),
        M::SrcOut => porter_duff(1.0 - da, 0.0),
        M::DestOut => porter_duff(0.0, 1.0 - sa),
        M::SrcAtop => porter_duff(da, 1.0 - sa),
        M::DestAtop => porter_duff(1.0 - da, sa),
        M::Xor => porter_duff(1.0 - da, 1.0 - sa),
        M::Plus => [
            (s[0] + d[0]).min(1.0),
            (s[1] + d[1]).min(1.0),
            (s[2] + d[2]).min(1.0),
            (sa + da).min(1.0),
        ],
        _ => blend(mode, s, d),
    }
}

/// A blend mode: the source's and backdrop's colors mixed by the mode's
/// function where both are, each as it is where only one is.
fn blend(mode: CompositeMode, s: Rgba, d: Rgba) -> Rgba {
    let straight = |c: Rgba| {
        if c[3] > 0.0 {
            [c[0] / c[3], c[1] / c[3], c[2] / c[3]]
        } else {
            [0.0; 3]
        }
    };
    let (cs, cb) = (straight(s), straight(d));
    let each = |f: fn(f32, f32) -> f32| [f(cs[0], cb[0]), f(cs[1], cb[1]), f(cs[2], cb[2])];
    fn hard_light(s: f32, b: f32) -> f32 {
        if s <= 0.5 {
            b * 2.0 * s
        } else {
            let s = 2.0 * s - 1.0;
            b + s - b * s
        }
    }
    use CompositeMode as M;
    let mixed = match mode {
        M::Multiply => each(|s, b| s * b),
        M::Screen => each(|s, b| b + s - b * s),
        M::Overlay => each(|s, b| hard_light(b, s)),
        M::Darken => each(f32::min),
        M::Lighten => each(f32::max),
        M::ColorDodge => each(|s, b| {
            if b <= 0.0 {
                0.0
            } else if s >= 1.0 {
                1.0
            } else {
                (b / (1.0 - s)).min(1.0)
            }
        }),
        M::ColorBurn => each(|s, b| {
            if b >= 1.0 {
                1.0
            } else if s <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - b) / s).min(1.0)
            }
        }),
        M::HardLight => each(hard_light),
        M::SoftLight => each(|s, b| {
            if s <= 0.5 {
                b - (1.0 - 2.0 * s) * b * (1.0 - b)
            } else {
                let d = if b <= 0.25 {
                    ((16.0 * b - 12.0) * b + 4.0) * b
                } else {
                    b.sqrt()
                };
                b + (2.0 * s - 1.0) * (d - b)
            }
        }),
        M::Difference => each(|s, b| (b - s).abs()),
        M::Exclusion => each(|s, b| b + s - 2.0 * b * s),
        M::HslHue => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        M::HslSaturation => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        M::HslColor => set_lum(cs, lum(cb)),
        M::HslLuminosity => set_lum(cb, lum(cs)),
        _ => cs,
    };
    let (sa, da) = (s[3], d[3]);
    let channel = |i: usize| s[i] * (1.0 - da) + d[i] * (1.0 - sa) + sa * da * mixed[i];
    [channel(0), channel(1), channel(2), sa + da - sa * da]
}

fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    let c = [c[0] + d, c[1] + d, c[2] + d];
    let l = lum(c);
    let (n, x) = (c[0].min(c[1]).min(c[2]), c[0].max(c[1]).max(c[2]));
    let mut out = c;
    for v in &mut out {
        if n < 0.0 {
            *v = l + (*v - l) * l / (l - n);
        }
        if x > 1.0 {
            *v = l + (*v - l) * (1.0 - l) / (x - l);
        }
    }
    out
}

fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let (n, x) = (c[0].min(c[1]).min(c[2]), c[0].max(c[1]).max(c[2]));
    if x <= n {
        return [0.0; 3];
    }
    [
        (c[0] - n) * s / (x - n),
        (c[1] - n) * s / (x - n),
        (c[2] - n) * s / (x - n),
    ]
}

// MARK: Coverage

/// How much of each pixel paths cover, by area, as font-rs finds it: each
/// line adds the signed area it puts to its right, a row at a time, into
/// an accumulation buffer whose running sums along each row are the
/// coverage. Overlaps that wind the same way add up to full coverage;
/// holes wound the other way cancel it.
struct Raster {
    width: usize,
    height: usize,
    /// Rows `width + 2` wide: lines at the right edge spill past it.
    acc: Vec<f32>,
}

impl Raster {
    fn new(width: u32, height: u32) -> Raster {
        let (width, height) = (width as usize, height as usize);
        Raster {
            width,
            height,
            acc: vec![0.0; (width + 2) * height],
        }
    }

    fn line(&mut self, a: [f32; 2], b: [f32; 2]) {
        if a[1] == b[1]
            || !(a[0].is_finite() && a[1].is_finite() && b[0].is_finite() && b[1].is_finite())
        {
            return;
        }
        let (dir, p0, p1) = if a[1] < b[1] {
            (1.0, a, b)
        } else {
            (-1.0, b, a)
        };
        let dxdy = (p1[0] - p0[0]) / (p1[1] - p0[1]);
        let (top, bottom) = (p0[1].max(0.0), p1[1].min(self.height as f32));
        if top >= bottom {
            return;
        }
        let w = self.width as f32;
        let stride = self.width + 2;
        let mut x = p0[0] + (top - p0[1]) * dxdy;
        let mut y = top;
        while y < bottom {
            let row = y.floor();
            let next = (row + 1.0).min(bottom);
            let x_next = x + dxdy * (next - y);
            // Beyond the left edge, a line covers all the row right of it;
            // beyond the right, none of it.
            let (x0, x1) = if x < x_next { (x, x_next) } else { (x_next, x) };
            let (x0, x1) = (x0.clamp(0.0, w), x1.clamp(0.0, w));
            let start = row as usize * stride;
            cover(
                &mut self.acc[start..start + stride],
                x0,
                x1,
                (next - y) * dir,
            );
            x = x_next;
            y = next;
        }
    }

    fn coverage(self) -> Vec<f32> {
        let stride = self.width + 2;
        let mut out = Vec::with_capacity(self.width * self.height);
        for row in self.acc.chunks_exact(stride) {
            let mut sum = 0.0f32;
            for &a in &row[..self.width] {
                sum += a;
                out.push(sum.abs().min(1.0));
            }
        }
        out
    }
}

/// Adds to `row` the area right of a line crossing it from x0 to x1
/// (x0 ≤ x1, both within the row) over a height of `d` (negative for one
/// going up): the pixels it passes through get the part of `d` right of
/// it in them, and the next the rest, so that the row's running sum is `d`
/// right of the line.
fn cover(row: &mut [f32], x0: f32, x1: f32, d: f32) {
    let x0i = x0.floor();
    let x1i = x1.ceil();
    let (i0, i1) = (x0i as usize, x1i as usize);
    if i1 <= i0 + 1 {
        let mid = 0.5 * (x0 + x1) - x0i;
        row[i0] += d * (1.0 - mid);
        row[i0 + 1] += d * mid;
        return;
    }
    let s = 1.0 / (x1 - x0);
    let f0 = x0 - x0i;
    let a0 = 0.5 * s * (1.0 - f0) * (1.0 - f0);
    let f1 = x1 - x1i + 1.0;
    let am = 0.5 * s * f1 * f1;
    row[i0] += d * a0;
    if i1 == i0 + 2 {
        row[i0 + 1] += d * (1.0 - a0 - am);
    } else {
        let a1 = s * (1.5 - f0);
        row[i0 + 1] += d * (a1 - a0);
        for v in &mut row[i0 + 2..i1 - 1] {
            *v += d * s;
        }
        let a2 = a1 + (i1 - i0 - 3) as f32 * s;
        row[i1 - 1] += d * (1.0 - a2 - am);
    }
    row[i1] += d * am;
}

/// Draws a glyph's outline (font units) into a raster, transformed to
/// pixels, its curves as lines close enough to them.
struct Pen<'r> {
    raster: &'r mut Raster,
    transform: Transform,
    start: [f32; 2],
    at: [f32; 2],
}

/// How far (pixels) the lines may stray from the curves they stand for.
const FLATNESS: f32 = 0.1;

impl<'r> Pen<'r> {
    fn new(raster: &'r mut Raster, transform: Transform) -> Pen<'r> {
        Pen {
            raster,
            transform,
            start: [0.0; 2],
            at: [0.0; 2],
        }
    }

    fn to(&mut self, p: [f32; 2]) {
        self.raster.line(self.at, p);
        self.at = p;
    }

    /// Lines along a curve: enough that each strays from it by no more
    /// than FLATNESS, by how far its control points bend it (`bend`).
    fn along(&mut self, bend: f32, at: impl Fn(f32) -> [f32; 2]) {
        let n = (bend / FLATNESS).sqrt().ceil().clamp(1.0, 64.0) as usize;
        for i in 1..=n {
            self.to(at(i as f32 / n as f32));
        }
    }
}

fn distance(a: [f32; 2], b: [f32; 2], c: [f32; 2]) -> f32 {
    let d = [a[0] - 2.0 * b[0] + c[0], a[1] - 2.0 * b[1] + c[1]];
    (d[0] * d[0] + d[1] * d[1]).sqrt()
}

impl PathSink for Pen<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.close();
        let p = apply(self.transform, [x, y]);
        self.start = p;
        self.at = p;
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let p = apply(self.transform, [x, y]);
        self.to(p);
    }

    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        let (p0, c, p) = (
            self.at,
            apply(self.transform, [cx, cy]),
            apply(self.transform, [x, y]),
        );
        self.along(distance(p0, c, p) / 4.0, |t| {
            let u = 1.0 - t;
            [
                u * u * p0[0] + 2.0 * u * t * c[0] + t * t * p[0],
                u * u * p0[1] + 2.0 * u * t * c[1] + t * t * p[1],
            ]
        });
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let p0 = self.at;
        let (c0, c1, p) = (
            apply(self.transform, [cx0, cy0]),
            apply(self.transform, [cx1, cy1]),
            apply(self.transform, [x, y]),
        );
        let bend = distance(p0, c0, c1).max(distance(c0, c1, p)) * 0.75;
        self.along(bend, |t| {
            let u = 1.0 - t;
            let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            [
                a * p0[0] + b * c0[0] + c * c1[0] + d * p[0],
                a * p0[1] + b * c0[1] + c * c1[1] + d * p[1],
            ]
        });
    }

    fn close(&mut self) {
        if self.at != self.start {
            let start = self.start;
            self.to(start);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    fn square(raster: &mut Raster, x0: f32, y0: f32, x1: f32, y1: f32) {
        let mut pen = Pen::new(raster, Transform::default());
        pen.move_to(x0, y0);
        pen.line_to(x1, y0);
        pen.line_to(x1, y1);
        pen.line_to(x0, y1);
        pen.close();
    }

    #[test]
    fn coverage_is_area() {
        let mut raster = Raster::new(8, 4);
        // Whole pixels 1 to 3 across, rows 1 and 2; half of column 5.
        square(&mut raster, 1.0, 1.0, 4.0, 3.0);
        square(&mut raster, 5.0, 1.0, 5.5, 3.0);
        let c = raster.coverage();
        let at = |x: usize, y: usize| c[y * 8 + x];
        assert_eq!(at(0, 1), 0.0);
        assert_eq!(at(1, 1), 1.0);
        assert_eq!(at(3, 2), 1.0);
        assert_eq!(at(4, 2), 0.0);
        assert!((at(5, 1) - 0.5).abs() < 1e-5, "{}", at(5, 1));
        assert_eq!(at(6, 1), 0.0);
        assert_eq!(at(2, 0), 0.0);
        assert_eq!(at(2, 3), 0.0);
        // A diagonal edge: a triangle covering half of a pixel.
        let mut raster = Raster::new(2, 1);
        let mut pen = Pen::new(&mut raster, Transform::default());
        pen.move_to(0.0, 0.0);
        pen.line_to(1.0, 1.0);
        pen.line_to(0.0, 1.0);
        pen.close();
        let c = raster.coverage();
        assert!((c[0] - 0.5).abs() < 1e-5 && c[1] == 0.0, "{c:?}");
    }

    #[test]
    fn paths_beyond_the_canvas_are_cut_off() {
        let mut raster = Raster::new(4, 4);
        square(&mut raster, -3.0, -3.0, 2.0, 9.0);
        let c = raster.coverage();
        assert_eq!(&c[0..4], &[1.0, 1.0, 0.0, 0.0]);
        assert_eq!(&c[12..16], &[1.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn porter_duff_and_blending() {
        let red = [1.0, 0.0, 0.0, 1.0];
        let half_blue = [0.0, 0.0, 0.5, 0.5];
        assert_eq!(composite(CompositeMode::SrcOver, red, half_blue), red);
        assert_eq!(
            composite(CompositeMode::SrcOver, half_blue, red),
            [0.5, 0.0, 0.5, 1.0]
        );
        assert_eq!(
            composite(CompositeMode::DestIn, half_blue, red),
            [0.5, 0.0, 0.0, 0.5]
        );
        assert_eq!(composite(CompositeMode::Clear, red, red), [0.0; 4]);
        let grey = [0.5, 0.5, 0.5, 1.0];
        assert_eq!(
            composite(CompositeMode::Multiply, grey, red),
            [0.5, 0.0, 0.0, 1.0]
        );
        assert_eq!(
            composite(CompositeMode::Screen, grey, red),
            [1.0, 0.5, 0.5, 1.0]
        );
        // A blend mode over nothing is the source as it is.
        assert_eq!(composite(CompositeMode::Multiply, grey, [0.0; 4]), grey);
    }

    #[test]
    fn gradients_find_where_on_their_color_lines_points_are() {
        let stops = [(0.0, [0.0, 0.0, 0.0, 1.0]), (1.0, [1.0, 1.0, 1.0, 1.0])];
        assert_eq!(line_color(&stops, 0.5), [0.5, 0.5, 0.5, 1.0]);
        assert_eq!(line_color(&stops, -1.0), stops[0].1);
        assert_eq!(extended(1.25, Extend::Repeat), 0.25);
        assert_eq!(extended(1.25, Extend::Reflect), 0.75);
        // Concentric circles: t is the distance out.
        let t = radial([3.0, 4.0], [0.0, 0.0], 0.0, [0.0, 0.0], 10.0).unwrap();
        assert!((t - 0.5).abs() < 1e-5, "{t}");
        // Circles of one size, moving along x, never reach (0, 5); those
        // shrinking past nothing never reach behind where they vanish.
        assert_eq!(radial([0.0, 5.0], [5.0, 0.0], 1.0, [10.0, 0.0], 1.0), None);
        assert_eq!(radial([30.0, 0.0], [0.0, 0.0], 2.0, [10.0, 0.0], 1.0), None);
    }

    #[test]
    fn transforms_compose_and_invert() {
        let scale = Transform {
            xx: 2.0,
            yx: 0.0,
            xy: 0.0,
            yy: -2.0,
            dx: 1.0,
            dy: 10.0,
        };
        let shift = Transform {
            dx: 3.0,
            ..Transform::default()
        };
        let t = compose(scale, shift);
        assert_eq!(apply(t, [1.0, 1.0]), [9.0, 8.0]);
        let back = apply(invert(t).unwrap(), [9.0, 8.0]);
        assert!((back[0] - 1.0).abs() < 1e-5 && (back[1] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn layers_clip_and_fill() {
        // Boxes filled with a palette color and the text's (the font is
        // only for its outlines, which boxes do not need).
        let font = skrifa::Font::new(crate::font::BUILT_IN[0], 0).unwrap();
        let palette = [Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        }];
        // 1 pixel to 100 units: an em of 1000 is 10 pixels.
        let at = Placing {
            scale: 0.01,
            origin: [0.0, 10.0],
        };
        let mut p = Painter::new(&font, &palette, 0xff00_ff00, 10, 12, at);
        p.push_clip_box(BoundingBox {
            x_min: 0.0,
            y_min: 0.0,
            x_max: 500.0,
            y_max: 500.0,
        });
        p.fill(Brush::Solid {
            palette_index: 0,
            alpha: 1.0,
        });
        p.pop_clip();
        // The text's color, over the right half.
        p.push_clip_box(BoundingBox {
            x_min: 500.0,
            y_min: 0.0,
            x_max: 1000.0,
            y_max: 500.0,
        });
        p.fill(Brush::Solid {
            palette_index: 0xFFFF,
            alpha: 1.0,
        });
        p.pop_clip();
        let painted = p.finish();
        assert!(painted.uses_foreground);
        let px = |x: u32, y: u32| painted.pixels[(y * 10 + x) as usize];
        assert_eq!(px(2, 7), 0xff00_00ff, "red, as RGBA bytes");
        assert_eq!(px(7, 7), 0xff00_ff00, "green");
        assert_eq!(px(2, 2), 0, "above the box");
    }

    /// A triangle anywhere on the canvas covers exactly its area, whichever
    /// way it winds.
    #[hegel::test(test_cases = 300, database = None)]
    fn coverage_adds_up_to_the_area(tc: TestCase) {
        let (w, h) = (16u32, 12u32);
        // Points in eighths of a pixel, on the canvas.
        let point = |tc: &TestCase| {
            [
                tc.draw(gs::integers::<u32>().max_value(w * 8)) as f32 / 8.0,
                tc.draw(gs::integers::<u32>().max_value(h * 8)) as f32 / 8.0,
            ]
        };
        let (a, b, c) = (point(&tc), point(&tc), point(&tc));
        let area = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0;
        let mut raster = Raster::new(w, h);
        let mut pen = Pen::new(&mut raster, Transform::default());
        pen.move_to(a[0], a[1]);
        pen.line_to(b[0], b[1]);
        pen.line_to(c[0], c[1]);
        pen.close();
        let covered: f32 = raster.coverage().iter().sum();
        assert!(
            (covered - area).abs() < 0.01,
            "{covered} for an area of {area}"
        );
    }

    /// Every way of compositing two colors makes a color: premultiplied,
    /// each channel within 0 and its alpha, and its alpha within 0 and 1.
    #[hegel::test(test_cases = 500, database = None)]
    fn compositing_makes_colors(tc: TestCase) {
        let color = |tc: &TestCase| {
            let a = tc.draw(gs::integers::<u32>().max_value(255));
            let mut c = [0.0; 4];
            for v in &mut c[..3] {
                *v = tc.draw(gs::integers::<u32>().max_value(a)) as f32 / 255.0;
            }
            c[3] = a as f32 / 255.0;
            c
        };
        let (s, d) = (color(&tc), color(&tc));
        use CompositeMode as M;
        let modes = [
            M::Clear,
            M::Src,
            M::Dest,
            M::SrcOver,
            M::DestOver,
            M::SrcIn,
            M::DestIn,
            M::SrcOut,
            M::DestOut,
            M::SrcAtop,
            M::DestAtop,
            M::Xor,
            M::Plus,
            M::Screen,
            M::Overlay,
            M::Darken,
            M::Lighten,
            M::ColorDodge,
            M::ColorBurn,
            M::HardLight,
            M::SoftLight,
            M::Difference,
            M::Exclusion,
            M::Multiply,
            M::HslHue,
            M::HslSaturation,
            M::HslColor,
            M::HslLuminosity,
        ];
        let e = 1e-4;
        for mode in modes {
            let r = composite(mode, s, d);
            assert!((-e..=1.0 + e).contains(&r[3]), "{mode:?}: {r:?}");
            for &v in &r[..3] {
                assert!(
                    v >= -e && v <= r[3] + e,
                    "{mode:?} of {s:?} onto {d:?}: {r:?}"
                );
            }
        }
    }
}
