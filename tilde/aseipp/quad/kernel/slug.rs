// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Glyph data for the Slug algorithm, which draws text (and other vector
//! shapes) from their curves on the GPU, at any size, with no rasterized
//! atlas: kernel/gui.slang's text shader is Eric Lengyel's reference
//! shader, and this builds the data it reads, as his notes describe
//! (<https://github.com/EricLengyel/Slug>; the patent is dedicated to the
//! public domain, and the shaders are MIT OR Apache-2.0, credit required).
//!
//! A shape is closed contours of quadratic Bézier curves in em space (y
//! up). Its data is in two buffers, which the shader reads by device
//! address where the reference reads textures:
//!
//! - **curves**: control points, two per texel (`[x1, y1, x2, y2]`). A
//!   curve is two consecutive texels: p1 and p2 in the first, p3 in the
//!   first half of the second. Consecutive curves of a contour share their
//!   endpoint, so a contour of n curves takes n + 1 texels.
//! - **bands**: at a shape's location, a header (count, offset) for each
//!   horizontal band, then one for each vertical band; then, at each
//!   header's offset from the location, the curves crossing that band, as
//!   indexes into **curves**. Horizontal bands list their curves by
//!   descending maximum x, vertical bands by descending maximum y, so the
//!   shader stops at the first curve wholly behind its pixel.
//!
//! The reference shader addresses texels of a 4096-wide texture by (x, y);
//! these buffers are flat, so locations are plain indexes.

/// A quadratic Bézier curve: p1, the control point p2, p3.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Curve {
    pub p1: [f32; 2],
    pub p2: [f32; 2],
    pub p3: [f32; 2],
}

impl Curve {
    fn min(&self, axis: usize) -> f32 {
        self.p1[axis].min(self.p2[axis]).min(self.p3[axis])
    }

    fn max(&self, axis: usize) -> f32 {
        self.p1[axis].max(self.p2[axis]).max(self.p3[axis])
    }

    /// A straight line along `axis`'s perpendicular: it can never cross
    /// a ray parallel to it.
    fn flat(&self, axis: usize) -> bool {
        self.p1[axis] == self.p2[axis] && self.p2[axis] == self.p3[axis]
    }
}

/// Outlines as closed contours of quadratic curves, from any source of
/// lines, quadratics and cubics: a font's [`skrifa::PathSink`], or code
/// drawing shapes (box drawing, in font/sprites.rs). Coordinates are scaled by
/// `scale` as they come in (to em units, from a font's units).
pub struct Outline {
    pub contours: Vec<Vec<Curve>>,
    scale: f32,
    /// How far a cubic's quadratics may stray from it, in output units.
    tolerance: f32,
    start: [f32; 2],
    at: [f32; 2],
}

impl Outline {
    pub fn new(scale: f32) -> Outline {
        Outline {
            contours: Vec::new(),
            scale,
            tolerance: 1.0 / 1024.0,
            start: [0.0; 2],
            at: [0.0; 2],
        }
    }

    fn point(&self, x: f32, y: f32) -> [f32; 2] {
        [x * self.scale, y * self.scale]
    }

    fn push(&mut self, curve: Curve) {
        // A curve that goes nowhere crosses nothing.
        if curve.p1 == curve.p3 && curve.p1 == curve.p2 {
            return;
        }
        match self.contours.last_mut() {
            Some(contour) => contour.push(curve),
            None => self.contours.push(vec![curve]),
        }
        self.at = curve.p3;
    }

    pub fn move_to_scaled(&mut self, p: [f32; 2]) {
        self.close_open();
        self.contours.push(Vec::new());
        self.start = p;
        self.at = p;
    }

    /// A line, as Lengyel recommends: the second endpoint doubled.
    pub fn line_to_scaled(&mut self, p: [f32; 2]) {
        let at = self.at;
        self.push(Curve {
            p1: at,
            p2: p,
            p3: p,
        });
    }

    pub fn quad_to_scaled(&mut self, c: [f32; 2], p: [f32; 2]) {
        let at = self.at;
        self.push(Curve {
            p1: at,
            p2: c,
            p3: p,
        });
    }

    /// A cubic, as quadratics: enough of them that each is within the
    /// tolerance of its piece of the cubic. Splitting a cubic into n
    /// pieces divides the error of approximating each by a quadratic by
    /// n³ (the error is √3/36 |p3 - 3c2 + 3c1 - p0| for one piece).
    pub fn cubic_to_scaled(&mut self, c1: [f32; 2], c2: [f32; 2], p: [f32; 2]) {
        let p0 = self.at;
        let d = [
            p[0] - 3.0 * c2[0] + 3.0 * c1[0] - p0[0],
            p[1] - 3.0 * c2[1] + 3.0 * c1[1] - p0[1],
        ];
        let error = 3f32.sqrt() / 36.0 * (d[0] * d[0] + d[1] * d[1]).sqrt();
        let n = (error / self.tolerance).cbrt().ceil().clamp(1.0, 64.0) as usize;
        let at = |t: f32| {
            let u = 1.0 - t;
            let (a, b, c, e) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            [
                a * p0[0] + b * c1[0] + c * c2[0] + e * p[0],
                a * p0[1] + b * c1[1] + c * c2[1] + e * p[1],
            ]
        };
        // The derivative, for each piece's control points.
        let tangent = |t: f32| {
            let u = 1.0 - t;
            let (a, b, c) = (3.0 * u * u, 6.0 * u * t, 3.0 * t * t);
            [
                a * (c1[0] - p0[0]) + b * (c2[0] - c1[0]) + c * (p[0] - c2[0]),
                a * (c1[1] - p0[1]) + b * (c2[1] - c1[1]) + c * (p[1] - c2[1]),
            ]
        };
        for i in 0..n {
            let (t0, t1) = (i as f32 / n as f32, (i + 1) as f32 / n as f32);
            let (q0, q3) = (at(t0), if i + 1 == n { p } else { at(t1) });
            // The piece's cubic control points, then the quadratic's one
            // control point: the mean of the two the cubic's tangents make.
            let h = (t1 - t0) / 3.0;
            let (d0, d1) = (tangent(t0), tangent(t1));
            let q1 = [q0[0] + d0[0] * h, q0[1] + d0[1] * h];
            let q2 = [q3[0] - d1[0] * h, q3[1] - d1[1] * h];
            let c = [
                (3.0 * (q1[0] + q2[0]) - q0[0] - q3[0]) / 4.0,
                (3.0 * (q1[1] + q2[1]) - q0[1] - q3[1]) / 4.0,
            ];
            self.quad_to_scaled(c, q3);
        }
    }

    /// Closes the open contour back to its start, if it is not there.
    pub fn close_open(&mut self) {
        if self.contours.last().is_some_and(|c| !c.is_empty()) && self.at != self.start {
            let start = self.start;
            self.line_to_scaled(start);
        }
        self.at = self.start;
    }

    pub fn finish(mut self) -> Vec<Vec<Curve>> {
        self.close_open();
        self.contours.retain(|c| !c.is_empty());
        self.contours
    }
}

impl skrifa::PathSink for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        let p = self.point(x, y);
        self.move_to_scaled(p);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let p = self.point(x, y);
        self.line_to_scaled(p);
    }

    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        let (c, p) = (self.point(cx, cy), self.point(x, y));
        self.quad_to_scaled(c, p);
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let (c1, c2, p) = (self.point(cx0, cy0), self.point(cx1, cy1), self.point(x, y));
        self.cubic_to_scaled(c1, c2, p);
    }

    fn close(&mut self) {
        self.close_open();
    }
}

// MARK: Synthetic styles

/// Slants contours as an oblique style does: each point right by `k`
/// times its height above the baseline.
pub fn slant(contours: &mut [Vec<Curve>], k: f32) {
    for c in contours.iter_mut().flatten() {
        for p in [&mut c.p1, &mut c.p2, &mut c.p3] {
            p[0] += p[1] * k;
        }
    }
}

/// Makes contours bolder, as FreeType's `FT_Outline_EmboldenXY` does:
/// every point, control points too, moves `by` away from the filled side
/// along the bisector of its two edges, so strokes grow by twice `by` and
/// the shape stays centered where it was. Which side is filled follows
/// from the winding of the whole shape (outer contours wind one way, holes
/// the other), so holes shrink as strokes grow.
pub fn embolden(contours: &mut [Vec<Curve>], by: f32) {
    let area: f32 = contours
        .iter()
        .flatten()
        .map(|c| cross(c.p1, c.p2) + cross(c.p2, c.p3))
        .sum();
    // Outward, from a direction of travel: right of it, where the fill
    // is on the left (counterclockwise outer contours, y up), else left.
    let out = |d: [f32; 2]| {
        if area > 0.0 {
            [d[1], -d[0]]
        } else {
            [-d[1], d[0]]
        }
    };
    for contour in contours.iter_mut() {
        // The contour as a polygon of its points, with which curve each is
        // and whether it is the curve's start or its control point (a line
        // has none: its control point is its end).
        let mut points: Vec<([f32; 2], usize, bool)> = Vec::new();
        for (i, c) in contour.iter().enumerate() {
            points.push((c.p1, i, true));
            if c.p2 != c.p3 {
                points.push((c.p2, i, false));
            }
        }
        let n = points.len();
        let moved: Vec<[f32; 2]> = (0..n)
            .map(|i| {
                let p = points[i].0;
                // The nearest points before and after that are elsewhere.
                let before = (1..n).map(|k| points[(i + n - k) % n].0).find(|&q| q != p);
                let after = (1..n).map(|k| points[(i + k) % n].0).find(|&q| q != p);
                let (Some(before), Some(after)) = (before, after) else {
                    return p;
                };
                let a = out(unit([p[0] - before[0], p[1] - before[1]]));
                let b = out(unit([after[0] - p[0], after[1] - p[1]]));
                // Along the bisector, as far as keeps both edges `by` out:
                // (a + b) by / (1 + a·b), which is by √(2 / (1 + a·b))
                // long. At a spike that is too far: no more than 4 `by`.
                let d = 1.0 + a[0] * b[0] + a[1] * b[1];
                let scale = by / d.max(0.125);
                [p[0] + (a[0] + b[0]) * scale, p[1] + (a[1] + b[1]) * scale]
            })
            .collect();
        let mut starts = vec![[0.0; 2]; contour.len()];
        let mut controls: Vec<Option<[f32; 2]>> = vec![None; contour.len()];
        for (&(_, curve, start), &q) in points.iter().zip(&moved) {
            if start {
                starts[curve] = q;
            } else {
                controls[curve] = Some(q);
            }
        }
        let len = contour.len();
        for (i, c) in contour.iter_mut().enumerate() {
            c.p1 = starts[i];
            c.p3 = starts[(i + 1) % len];
            c.p2 = controls[i].unwrap_or(c.p3);
        }
    }
}

fn cross(a: [f32; 2], b: [f32; 2]) -> f32 {
    a[0] * b[1] - a[1] * b[0]
}

fn unit(v: [f32; 2]) -> [f32; 2] {
    let l = (v[0] * v[0] + v[1] * v[1]).sqrt().max(f32::MIN_POSITIVE);
    [v[0] / l, v[1] / l]
}

/// Where a shape's data is, and what the shader needs to find its bands:
/// `Glyph` in kernel/gui.slang, less its placement.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    /// Its bounds in em space: x and y minimum, x and y maximum.
    pub bounds: [f32; 4],
    /// Band scale (x, y) and offset (x, y): the band an em-space point is
    /// in is its coordinate times the scale plus the offset.
    pub banding: [f32; 4],
    /// Its location in the band buffer.
    pub location: u32,
    /// The last vertical and horizontal band's index.
    pub band_max: [u16; 2],
}

/// The curve and band data of every shape added so far.
#[derive(Default)]
pub struct Atlas {
    pub curves: Vec<[f32; 4]>,
    pub bands: Vec<[u32; 2]>,
    /// Bumped whenever the data changes, so renderers know to upload it.
    pub generation: u64,
}

/// Bands overlap by this much (em), so a curve on a boundary is in both.
const BAND_EPSILON: f32 = 1.0 / 1024.0;

/// At most this many bands in each direction.
const MAX_BANDS: usize = 16;

impl Atlas {
    pub fn clear(&mut self) {
        self.curves.clear();
        self.bands.clear();
        self.generation += 1;
    }

    /// Adds a shape, or returns None for one with nothing to draw.
    pub fn add(&mut self, contours: &[Vec<Curve>]) -> Option<Shape> {
        let all: Vec<Curve> = contours.iter().flatten().copied().collect();
        if all.is_empty() {
            return None;
        }
        let bounds = [
            all.iter().map(|c| c.min(0)).fold(f32::INFINITY, f32::min),
            all.iter().map(|c| c.min(1)).fold(f32::INFINITY, f32::min),
            all.iter()
                .map(|c| c.max(0))
                .fold(f32::NEG_INFINITY, f32::max),
            all.iter()
                .map(|c| c.max(1))
                .fold(f32::NEG_INFINITY, f32::max),
        ];

        // The curves, each contour as one run of shared texels; `index`
        // is each curve's first texel.
        let mut index = Vec::with_capacity(all.len());
        for contour in contours {
            for (i, curve) in contour.iter().enumerate() {
                index.push(self.curves.len() as u32);
                let next = contour.get(i + 1);
                // The next curve starts where this one ends, so its first
                // texel is this one's second.
                self.curves
                    .push([curve.p1[0], curve.p1[1], curve.p2[0], curve.p2[1]]);
                if next.is_none_or(|n| n.p1 != curve.p3) {
                    self.curves.push([curve.p3[0], curve.p3[1], 0.0, 0.0]);
                }
            }
        }

        // Bands across y (horizontal, axis 1) and across x (vertical).
        let horizontal = bands(&all, &index, 1, bounds[1], bounds[3]);
        let vertical = bands(&all, &index, 0, bounds[0], bounds[2]);
        let location = self.bands.len() as u32;
        let headers = horizontal.lists.len() + vertical.lists.len();
        self.bands.resize(self.bands.len() + headers, [0, 0]);
        for (i, list) in horizontal.lists.iter().chain(&vertical.lists).enumerate() {
            let offset = self.bands.len() as u32 - location;
            self.bands[location as usize + i] = [list.len() as u32, offset];
            self.bands.extend(list.iter().map(|&curve| [curve, 0]));
        }
        self.generation += 1;
        Some(Shape {
            bounds,
            banding: [
                vertical.scale,
                horizontal.scale,
                vertical.offset,
                horizontal.offset,
            ],
            location,
            band_max: [
                (vertical.lists.len() - 1) as u16,
                (horizontal.lists.len() - 1) as u16,
            ],
        })
    }
}

struct Bands {
    /// Each band's curves, as their first texels.
    lists: Vec<Vec<u32>>,
    scale: f32,
    offset: f32,
}

/// Splits [lo, hi] along `axis` (0: x, so vertical bands; 1: y) into the
/// number of equal bands, up to [`MAX_BANDS`], that puts the fewest curves
/// in the fullest band, which bounds how many curves any pixel looks at.
fn bands(curves: &[Curve], index: &[u32], axis: usize, lo: f32, hi: f32) -> Bands {
    let across = 1 - axis;
    let span = (hi - lo).max(1e-6);
    let crossing: Vec<usize> = (0..curves.len())
        .filter(|&i| !curves[i].flat(axis))
        .collect();
    let fill = |n: usize| -> Vec<Vec<usize>> {
        let mut lists = vec![Vec::new(); n];
        for &i in &crossing {
            let c = &curves[i];
            let first = (((c.min(axis) - BAND_EPSILON - lo) / span * n as f32)
                .floor()
                .max(0.0)) as usize;
            let last =
                (((c.max(axis) + BAND_EPSILON - lo) / span * n as f32).floor() as usize).min(n - 1);
            for list in &mut lists[first.min(n - 1)..=last] {
                list.push(i);
            }
        }
        lists
    };
    let mut best = fill(1);
    let mut fullest = best[0].len();
    for n in 2..=MAX_BANDS {
        let lists = fill(n);
        let most = lists.iter().map(Vec::len).max().unwrap_or(0);
        if most < fullest {
            best = lists;
            fullest = most;
        }
    }
    let n = best.len();
    let lists = best
        .into_iter()
        .map(|mut list| {
            // Descending by the coordinate the band's rays run along.
            list.sort_by(|&a, &b| curves[b].max(across).total_cmp(&curves[a].max(across)));
            list.into_iter().map(|i| index[i]).collect()
        })
        .collect();
    let scale = n as f32 / span;
    Bands {
        lists,
        scale,
        offset: -lo * scale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    fn square(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<Curve> {
        let mut o = Outline::new(1.0);
        o.move_to_scaled([x0, y0]);
        o.line_to_scaled([x1, y0]);
        o.line_to_scaled([x1, y1]);
        o.line_to_scaled([x0, y1]);
        o.finish().remove(0)
    }

    /// Coverage at a point by the nonzero rule, the way the shader finds
    /// it but without antialiasing: winding along a ray to +x, from the
    /// horizontal band's curves alone.
    fn inside(atlas: &Atlas, shape: &Shape, x: f32, y: f32) -> bool {
        let band =
            ((y * shape.banding[1] + shape.banding[3]) as i64).clamp(0, shape.band_max[1] as i64);
        let [count, offset] = atlas.bands[(shape.location as i64 + band) as usize];
        let mut winding = 0i32;
        for k in 0..count {
            let curve = atlas.bands[(shape.location + offset + k) as usize][0] as usize;
            let [x1, y1, x2, y2] = atlas.curves[curve];
            let [x3, y3, _, _] = atlas.curves[curve + 1];
            // Sample the curve finely; count crossings of y right of x.
            let steps = 256;
            for s in 0..steps {
                let at = |t: f32| {
                    let u = 1.0 - t;
                    [
                        u * u * x1 + 2.0 * u * t * x2 + t * t * x3,
                        u * u * y1 + 2.0 * u * t * y2 + t * t * y3,
                    ]
                };
                let (a, b) = (
                    at(s as f32 / steps as f32),
                    at((s + 1) as f32 / steps as f32),
                );
                if (a[1] <= y) != (b[1] <= y) {
                    let cx = a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                    if cx > x {
                        winding += if b[1] > a[1] { 1 } else { -1 };
                    }
                }
            }
        }
        winding != 0
    }

    fn bounds(contours: &[Vec<Curve>]) -> [f32; 4] {
        Atlas::default().add(contours).unwrap().bounds
    }

    fn near(a: [f32; 4], b: [f32; 4]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
    }

    #[test]
    fn emboldening_grows_strokes_whichever_way_they_wind() {
        // Counterclockwise, as Outline draws it, and clockwise.
        let mut ccw = vec![square(0.0, 0.0, 1.0, 1.0)];
        embolden(&mut ccw, 0.1);
        assert!(
            near(bounds(&ccw), [-0.1, -0.1, 1.1, 1.1]),
            "{:?}",
            bounds(&ccw)
        );
        let mut cw = vec![square(0.0, 0.0, 1.0, 1.0)];
        for c in &mut cw[0] {
            std::mem::swap(&mut c.p1, &mut c.p3);
            c.p2 = c.p3;
        }
        cw[0].reverse();
        embolden(&mut cw, 0.1);
        assert!(
            near(bounds(&cw), [-0.1, -0.1, 1.1, 1.1]),
            "{:?}",
            bounds(&cw)
        );
        // A hole winds the other way, and shrinks.
        let mut ring = vec![square(0.0, 0.0, 1.0, 1.0), square(0.3, 0.3, 0.7, 0.7)];
        for c in &mut ring[1] {
            std::mem::swap(&mut c.p1, &mut c.p3);
            c.p2 = c.p3;
        }
        ring[1].reverse();
        embolden(&mut ring, 0.05);
        assert!(
            near(bounds(&ring[1..]), [0.35, 0.35, 0.65, 0.65]),
            "{:?}",
            bounds(&ring[1..])
        );
        // A curve's control point moves out with it.
        let mut o = Outline::new(1.0);
        o.move_to_scaled([0.0, 0.0]);
        o.quad_to_scaled([0.5, -1.0], [1.0, 0.0]);
        o.line_to_scaled([0.5, 1.0]);
        let mut bowl = o.finish();
        let before = bowl[0][0].p2;
        embolden(&mut bowl, 0.1);
        assert!(bowl[0][0].p2[1] < before[1] - 0.09, "{:?}", bowl[0][0]);
    }

    #[test]
    fn slanting_leans_right_above_the_baseline() {
        let mut s = vec![square(0.0, -0.5, 1.0, 1.0)];
        slant(&mut s, 0.25);
        assert!(
            near(bounds(&s), [-0.125, -0.5, 1.25, 1.0]),
            "{:?}",
            bounds(&s)
        );
    }

    #[test]
    fn a_square_is_inside_itself_and_nowhere_else() {
        let mut atlas = Atlas::default();
        let shape = atlas.add(&[square(0.1, 0.2, 0.6, 0.7)]).unwrap();
        assert_eq!(shape.bounds, [0.1, 0.2, 0.6, 0.7]);
        assert!(inside(&atlas, &shape, 0.3, 0.4));
        assert!(!inside(&atlas, &shape, 0.7, 0.4));
        assert!(!inside(&atlas, &shape, 0.05, 0.4));
    }

    #[test]
    fn contours_share_endpoints_and_flat_curves_skip_their_bands() {
        let mut atlas = Atlas::default();
        let shape = atlas.add(&[square(0.0, 0.0, 1.0, 1.0)]).unwrap();
        // Four curves, one contour: five texels.
        assert_eq!(atlas.curves.len(), 5);
        // Horizontal bands hold only the two vertical sides; vertical
        // bands only the two horizontal ones.
        let lists = |from: usize, n: usize| -> Vec<u32> {
            (from..from + n)
                .map(|b| atlas.bands[shape.location as usize + b][0])
                .collect()
        };
        let h = shape.band_max[1] as usize + 1;
        let v = shape.band_max[0] as usize + 1;
        assert!(lists(0, h).iter().all(|&n| n == 2));
        assert!(lists(h, v).iter().all(|&n| n == 2));
    }

    #[test]
    fn a_hole_by_the_nonzero_rule() {
        let mut atlas = Atlas::default();
        let mut inner = square(0.3, 0.3, 0.7, 0.7);
        // Wound the other way.
        inner.reverse();
        for c in &mut inner {
            std::mem::swap(&mut c.p1, &mut c.p3);
        }
        let shape = atlas.add(&[square(0.0, 0.0, 1.0, 1.0), inner]).unwrap();
        assert!(inside(&atlas, &shape, 0.1, 0.5));
        assert!(!inside(&atlas, &shape, 0.5, 0.5));
    }

    #[test]
    fn cubics_become_quadratics_close_to_them() {
        let (p0, c1, c2, p3) = ([0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]);
        let mut o = Outline::new(1.0);
        o.move_to_scaled(p0);
        o.cubic_to_scaled(c1, c2, p3);
        let contour = o.finish().remove(0);
        // All but the closing line are the cubic's quadratics.
        let quads = &contour[..contour.len() - 1];
        assert!(quads.len() > 1);
        let cubic: Vec<[f32; 2]> = (0..=2000)
            .map(|i| {
                let t = i as f32 / 2000.0;
                let u = 1.0 - t;
                let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                [
                    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
                    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
                ]
            })
            .collect();
        for q in quads {
            for i in 0..=50 {
                let t = i as f32 / 50.0;
                let u = 1.0 - t;
                let p = [
                    u * u * q.p1[0] + 2.0 * u * t * q.p2[0] + t * t * q.p3[0],
                    u * u * q.p1[1] + 2.0 * u * t * q.p2[1] + t * t * q.p3[1],
                ];
                let nearest = cubic
                    .iter()
                    .map(|c| ((c[0] - p[0]).powi(2) + (c[1] - p[1]).powi(2)).sqrt())
                    .fold(f32::INFINITY, f32::min);
                assert!(
                    nearest < 1.0 / 1024.0 + 1e-3,
                    "{p:?} is {nearest} from the cubic"
                );
            }
        }
    }

    #[test]
    fn bands_list_curves_by_descending_extent() {
        let mut atlas = Atlas::default();
        let shape = atlas
            .add(&[square(0.0, 0.0, 0.2, 1.0), square(0.5, 0.0, 0.9, 1.0)])
            .unwrap();
        let [count, offset] = atlas.bands[shape.location as usize];
        let xs: Vec<f32> = (0..count)
            .map(|k| {
                let c = atlas.bands[(shape.location + offset + k) as usize][0] as usize;
                atlas.curves[c][0]
                    .max(atlas.curves[c][2])
                    .max(atlas.curves[c + 1][0])
            })
            .collect();
        assert!(xs.windows(2).all(|w| w[0] >= w[1]), "{xs:?}");
    }

    /// Emboldening a rectangle, wound either way, grows it by as much on
    /// every side.
    #[hegel::test(test_cases = 300, database = None)]
    fn emboldening_grows_every_side_alike(tc: TestCase) {
        let at = |tc: &TestCase| tc.draw(gs::integers::<u32>().max_value(64)) as f32 / 64.0;
        let (x0, y0) = (at(&tc), at(&tc));
        let w = tc.draw(gs::integers::<u32>().min_value(1).max_value(64)) as f32 / 64.0;
        let h = tc.draw(gs::integers::<u32>().min_value(1).max_value(64)) as f32 / 64.0;
        let by = tc.draw(gs::integers::<u32>().min_value(1).max_value(16)) as f32 / 256.0;
        let mut shape = vec![square(x0, y0, x0 + w, y0 + h)];
        if tc.draw(gs::booleans()) {
            for c in &mut shape[0] {
                std::mem::swap(&mut c.p1, &mut c.p3);
                c.p2 = c.p3;
            }
            shape[0].reverse();
        }
        embolden(&mut shape, by);
        let b = bounds(&shape);
        let want = [x0 - by, y0 - by, x0 + w + by, y0 + h + by];
        assert!(
            b.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-4),
            "{b:?}, not {want:?}"
        );
    }
}
