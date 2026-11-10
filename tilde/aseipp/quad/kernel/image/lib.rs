// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Images in the GUI's frames: PNGs the editor sends ("image"), placed
//! over rectangles of cells ("images"), as kernel/render/gui.slang's image
//! pipeline draws them.
//!
//! An image fits its rectangle, keeping its shape and never growing past
//! its own size, centered across it and at its top; only its first `shown`
//! rows of cells are drawn, so that what the editor draws over the rest (a
//! popup, say) is not hidden. Its pixels are scaled here, once for each
//! size it is drawn at, with a box filter in linear light, so that the
//! shader reads one pixel for each it draws; the frame's pixels are one
//! buffer of all the placed images', made again only when what is placed
//! changes ([`Images::generation`]).

use std::collections::HashMap;

/// The size of an image pipeline instance (kernel/render/gui.slang's `Picture`):
/// its rectangle in pixels (four f32s), where its pixels start in the
/// frame's and how many make a row (u32s), padded.
pub const PICTURE_BYTES: usize = 32;

/// An image, decoded: RGBA, sRGB-encoded, alpha not premultiplied.
pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Where an image is placed: over `rows` by `cols` cells from (`row`,
/// `col`), of which the first `shown` rows are drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub key: String,
    pub row: u32,
    pub col: u32,
    pub rows: u32,
    pub cols: u32,
    pub shown: u32,
}

impl Placement {
    /// Placements from the editor's keys and their geometry: five u32s
    /// each (row, column, rows, columns, rows shown).
    pub fn parse(keys: Vec<String>, geometry: &[u8]) -> Result<Vec<Placement>, String> {
        if geometry.len() != keys.len() * 20 {
            return Err("images: five u32s of geometry for each key".into());
        }
        Ok(keys
            .into_iter()
            .zip(geometry.chunks_exact(20))
            .map(|(key, g)| {
                let at = |i: usize| u32::from_ne_bytes(g[i * 4..i * 4 + 4].try_into().unwrap());
                Placement {
                    key,
                    row: at(0),
                    col: at(1),
                    rows: at(2),
                    cols: at(3),
                    shown: at(4),
                }
            })
            .collect())
    }
}

/// The images a window has been sent, and the pixels of those it draws.
#[derive(Default)]
pub struct Images {
    decoded: HashMap<String, Decoded>,
    /// Scaled pixels, by key and size: the sizes drawn in the last frame.
    scaled: HashMap<(String, u32, u32), Vec<u32>>,
    /// The scaled images in `pixels`, in order.
    packed: Vec<(String, u32, u32)>,
    /// The frame's pixels: each is 0xAABBGGRR (RGBA bytes, little-endian),
    /// sRGB-encoded, alpha not premultiplied.
    pub pixels: Vec<u32>,
    /// Changes whenever `pixels` does.
    pub generation: u64,
}

impl Images {
    /// Decodes a PNG, to be placed by `key`.
    pub fn add(&mut self, key: String, png: &[u8]) -> Result<(), String> {
        let decoded = decode(png).map_err(|e| format!("image {key}: {e}"))?;
        self.decoded.insert(key, decoded);
        Ok(())
    }

    /// The instances drawing `placements` in cells `cell` pixels in size,
    /// [`PICTURE_BYTES`] each; `pixels` holds what they draw.
    pub fn layout(&mut self, placements: &[Placement], cell: [f32; 2]) -> Vec<u8> {
        let [cw, ch] = cell;
        let mut fitted = Vec::new();
        for p in placements {
            let Some(image) = self.decoded.get(&p.key) else {
                continue;
            };
            let (room_w, room_h) = (p.cols as f32 * cw, p.rows as f32 * ch);
            let scale = (room_w / image.width as f32)
                .min(room_h / image.height as f32)
                .min(1.0);
            let w = ((image.width as f32 * scale).round() as u32).max(1);
            let h = ((image.height as f32 * scale).round() as u32).max(1);
            let x = (p.col as f32 * cw + (room_w - w as f32) / 2.0).floor();
            let y = p.row as f32 * ch;
            let shown = (h as f32).min(p.shown as f32 * ch).floor();
            if shown >= 1.0 {
                fitted.push((p.key.clone(), w, h, [x, y, w as f32, shown]));
            }
        }

        let wanted: Vec<(String, u32, u32)> = fitted
            .iter()
            .map(|(k, w, h, _)| (k.clone(), *w, *h))
            .collect();
        if wanted != self.packed {
            self.scaled.retain(|k, _| wanted.contains(k));
            for (key, w, h) in &wanted {
                if !self.scaled.contains_key(&(key.clone(), *w, *h)) {
                    let image = &self.decoded[key];
                    self.scaled
                        .insert((key.clone(), *w, *h), scale_to(image, *w, *h));
                }
            }
            self.pixels.clear();
            for k in &wanted {
                self.pixels.extend_from_slice(&self.scaled[k]);
            }
            self.packed = wanted;
            self.generation += 1;
        }

        let mut out = Vec::with_capacity(fitted.len() * PICTURE_BYTES);
        let mut offset = 0u32;
        for (_, w, h, rect) in &fitted {
            for v in rect {
                out.extend_from_slice(&v.to_ne_bytes());
            }
            for v in [offset, *w, 0, 0] {
                out.extend_from_slice(&v.to_ne_bytes());
            }
            offset += w * h;
        }
        out
    }
}

pub fn decode(png: &[u8]) -> Result<Decoded, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    // Palettes, low bit depths and transparency become RGB(A), 16 bits 8.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader.output_buffer_size().ok_or("too large to decode")?;
    let mut buf = vec![0; size];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());
    let (width, height) = (info.width, info.height);
    let n = (width * height) as usize;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => buf
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("a palette left unexpanded".into()),
    };
    if rgba.len() != n * 4 {
        return Err("decoded to the wrong size".into());
    }
    Ok(Decoded {
        width,
        height,
        rgba,
    })
}

/// `rgba` (`width` by `height`, RGBA bytes) as a PNG, compressed: for
/// images kept, as tests' golden images are.
pub fn encode(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if rgba.len() != (width * height * 4) as usize {
        return Err(format!(
            "{} bytes are not {width} by {height} RGBA pixels",
            rgba.len()
        ));
    }
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::High);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(png)
}

fn to_linear(v: u8) -> f32 {
    let v = f32::from(v) / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn to_srgb(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let e = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        v.powf(1.0 / 2.4) * 1.055 - 0.055
    };
    (e * 255.0).round() as u8
}

/// `image` scaled to `w` by `h` (no larger than it): each pixel the
/// average of those its box covers, weighted by how much it covers them,
/// in linear light with premultiplied alpha.
pub fn scale_to(image: &Decoded, w: u32, h: u32) -> Vec<u32> {
    let pack = |p: [u8; 4]| u32::from_le_bytes(p);
    if (w, h) == (image.width, image.height) {
        return image
            .rgba
            .chunks_exact(4)
            .map(|p| pack([p[0], p[1], p[2], p[3]]))
            .collect();
    }
    let linear: Vec<f32> = (0..=255u8).map(to_linear).collect();
    let (iw, ih) = (image.width as usize, image.height as usize);
    // Each output row's or column's source span and the weights of the
    // source rows or columns in it.
    let spans = |out: u32, len: usize| -> Vec<(usize, Vec<f32>)> {
        let step = len as f64 / f64::from(out);
        (0..out)
            .map(|i| {
                let (a, b) = (f64::from(i) * step, f64::from(i + 1) * step);
                let first = a.floor() as usize;
                let last = (b.ceil() as usize).min(len);
                let weights = (first..last)
                    .map(|s| ((b.min(s as f64 + 1.0) - a.max(s as f64)) / step) as f32)
                    .collect();
                (first, weights)
            })
            .collect()
    };
    let (xs, ys) = (spans(w, iw), spans(h, ih));
    // Columns first: each source row, narrowed to w premultiplied pixels.
    let mut narrow = vec![[0f32; 4]; w as usize * ih];
    for y in 0..ih {
        let row = &image.rgba[y * iw * 4..(y + 1) * iw * 4];
        for (x, (first, weights)) in xs.iter().enumerate() {
            let mut acc = [0f32; 4];
            for (i, wt) in weights.iter().enumerate() {
                let p = &row[(first + i) * 4..(first + i) * 4 + 4];
                let a = f32::from(p[3]) / 255.0;
                acc[0] += linear[p[0] as usize] * a * wt;
                acc[1] += linear[p[1] as usize] * a * wt;
                acc[2] += linear[p[2] as usize] * a * wt;
                acc[3] += a * wt;
            }
            narrow[y * w as usize + x] = acc;
        }
    }
    let mut out = Vec::with_capacity((w * h) as usize);
    for (first, weights) in &ys {
        for x in 0..w as usize {
            let mut acc = [0f32; 4];
            for (i, wt) in weights.iter().enumerate() {
                let p = narrow[(first + i) * w as usize + x];
                for c in 0..4 {
                    acc[c] += p[c] * wt;
                }
            }
            let a = acc[3];
            let un = |v: f32| if a > 0.0 { to_srgb(v / a) } else { 0 };
            out.push(pack([
                un(acc[0]),
                un(acc[1]),
                un(acc[2]),
                (a.clamp(0.0, 1.0) * 255.0).round() as u8,
            ]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    fn png_of(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut e = png::Encoder::new(&mut out, width, height);
        e.set_color(png::ColorType::Rgba);
        e.set_depth(png::BitDepth::Eight);
        let mut w = e.write_header().unwrap();
        w.write_image_data(rgba).unwrap();
        w.finish().unwrap();
        out
    }

    fn placement(rows: u32, cols: u32, shown: u32) -> Placement {
        Placement {
            key: "k".into(),
            row: 1,
            col: 2,
            rows,
            cols,
            shown,
        }
    }

    fn picture(out: &[u8], i: usize) -> ([f32; 4], [u32; 2]) {
        let at = |j: usize| out[i * PICTURE_BYTES + j * 4..][..4].try_into().unwrap();
        (
            [0, 1, 2, 3].map(|j| f32::from_ne_bytes(at(j))),
            [4, 5].map(|j| u32::from_ne_bytes(at(j))),
        )
    }

    #[test]
    fn an_image_fits_its_cells_centered_never_growing() {
        let mut images = Images::default();
        images
            .add("k".into(), &png_of(40, 20, &[255; 40 * 20 * 4]))
            .unwrap();
        // 10x20 cells: 10 by 4 cells is 100x80 pixels, more than the image.
        let out = images.layout(&[placement(4, 10, 4)], [10.0, 20.0]);
        assert_eq!(picture(&out, 0), ([20.0 + 30.0, 20.0, 40.0, 20.0], [0, 40]));
        // 2 by 1 cells is 20x20: half size, and centered in neither.
        let out = images.layout(&[placement(1, 2, 1)], [10.0, 20.0]);
        assert_eq!(picture(&out, 0), ([20.0, 20.0, 20.0, 10.0], [0, 20]));
    }

    #[test]
    fn only_the_shown_rows_are_drawn() {
        let mut images = Images::default();
        images
            .add("k".into(), &png_of(10, 100, &[255; 10 * 100 * 4]))
            .unwrap();
        let out = images.layout(&[placement(10, 1, 2)], [10.0, 10.0]);
        assert_eq!(picture(&out, 0).0, [20.0, 10.0, 10.0, 20.0]);
        assert!(
            images
                .layout(&[placement(10, 1, 0)], [10.0, 10.0])
                .is_empty()
        );
    }

    #[test]
    fn pixels_are_made_again_only_when_what_is_placed_changes() {
        let mut images = Images::default();
        images.add("k".into(), &png_of(4, 4, &[255; 64])).unwrap();
        images.layout(&[placement(1, 1, 1)], [4.0, 4.0]);
        let generation = images.generation;
        images.layout(&[placement(1, 1, 1)], [4.0, 4.0]);
        assert_eq!(images.generation, generation);
        images.layout(&[placement(1, 1, 1)], [2.0, 2.0]);
        assert_ne!(images.generation, generation);
        assert_eq!(images.pixels.len(), 4);
    }

    #[test]
    fn scaling_down_averages_in_linear_light() {
        // Black and white columns, halved: each pixel is their mean in
        // linear light, which is 188 encoded, not 128.
        let rgba: Vec<u8> = (0..4)
            .flat_map(|i| {
                if i % 2 == 0 {
                    [0, 0, 0, 255]
                } else {
                    [255, 255, 255, 255]
                }
            })
            .collect();
        let image = decode(&png_of(2, 2, &rgba)).unwrap();
        let out = scale_to(&image, 1, 1);
        assert_eq!(out[0].to_le_bytes(), [188, 188, 188, 255]);
    }

    #[test]
    fn transparent_pixels_do_not_darken_their_neighbors() {
        let rgba = [255, 0, 0, 255, 0, 0, 0, 0];
        let image = decode(&png_of(2, 1, &rgba)).unwrap();
        let out = scale_to(&image, 1, 1);
        assert_eq!(out[0].to_le_bytes(), [255, 0, 0, 128]);
    }

    /// An image of one color, scaled to any smaller size, is that color
    /// still, every pixel of it.
    #[hegel::test(test_cases = 200, database = None)]
    fn one_color_scales_to_itself(tc: TestCase) {
        let w = tc.draw(gs::integers::<u32>().min_value(1).max_value(40));
        let h = tc.draw(gs::integers::<u32>().min_value(1).max_value(40));
        let to_w = tc.draw(gs::integers::<u32>().min_value(1).max_value(w));
        let to_h = tc.draw(gs::integers::<u32>().min_value(1).max_value(h));
        let rgba: Vec<u8> = (0..4).map(|_| tc.draw(gs::integers::<u8>())).collect();
        let image = Decoded {
            width: w,
            height: h,
            rgba: rgba
                .iter()
                .copied()
                .cycle()
                .take((w * h * 4) as usize)
                .collect(),
        };
        let scaled = scale_to(&image, to_w, to_h);
        assert_eq!(scaled.len(), (to_w * to_h) as usize);
        for p in scaled {
            let got = p.to_le_bytes();
            if rgba[3] == 0 {
                assert_eq!(got[3], 0);
                continue;
            }
            for c in 0..4 {
                assert!(got[c].abs_diff(rgba[c]) <= 1, "{got:?}, not {rgba:?}");
            }
        }
    }
}
