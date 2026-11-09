// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Box drawing, blocks and the undercurl: shapes made to fill their cells
//! exactly and join their neighbors, as terminals draw them.

use super::*;

/// Characters drawn to fit their cells, and the undercurl.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) enum Sprite {
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
    pub(super) fn of(text: &str) -> Option<Sprite> {
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
    pub(super) fn draw(&self, m: &Metrics) -> Vec<Vec<Curve>> {
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
pub(super) fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<Curve> {
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
pub(super) fn ring_quarter(
    c: [f32; 2],
    r0: f32,
    r1: f32,
    from: [f32; 2],
    to: [f32; 2],
) -> Vec<Curve> {
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

pub(super) fn counterclockwise(mut contour: Vec<Curve>) -> Vec<Curve> {
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
}
