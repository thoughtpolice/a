// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Animation (docs/animation.md): how progress goes over time (easings, as
//! Anime.js names them), when an animation moves (timing), effects drawn
//! over text (the sheen), and drawing a rectangle of cells with an effect
//! on the CPU, for terminals that show images. Scheme's tweens
//! (core/anim.sls) and the window's renderer both time things here, and
//! kernel/render/gui.slang draws effects as [`shade`] does.

pub mod raster;

use std::f64::consts::PI;

// MARK: Easings

/// The curves `in-`, `out-`, `in-out-` and `out-in-` take.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Curve {
    Quad,
    Cubic,
    Quart,
    Quint,
    Sine,
    Expo,
    Circ,
    Back,
    Elastic,
    Bounce,
}

const CURVES: [(&str, Curve); 10] = [
    ("quad", Curve::Quad),
    ("cubic", Curve::Cubic),
    ("quart", Curve::Quart),
    ("quint", Curve::Quint),
    ("sine", Curve::Sine),
    ("expo", Curve::Expo),
    ("circ", Curve::Circ),
    ("back", Curve::Back),
    ("elastic", Curve::Elastic),
    ("bounce", Curve::Bounce),
];

impl Curve {
    /// The curve going in (starting slowly), from 0 to 1.
    fn ease_in(self, t: f64) -> f64 {
        match self {
            Curve::Quad => t * t,
            Curve::Cubic => t * t * t,
            Curve::Quart => t.powi(4),
            Curve::Quint => t.powi(5),
            Curve::Sine => 1.0 - (t * PI / 2.0).cos(),
            Curve::Expo => {
                if t <= 0.0 {
                    0.0
                } else {
                    2f64.powf(10.0 * t - 10.0)
                }
            }
            Curve::Circ => 1.0 - (1.0 - t * t).max(0.0).sqrt(),
            Curve::Back => {
                let c1 = 1.70158;
                (c1 + 1.0) * t * t * t - c1 * t * t
            }
            Curve::Elastic => {
                if t <= 0.0 || t >= 1.0 {
                    t
                } else {
                    -(2f64.powf(10.0 * t - 10.0)) * ((t * 10.0 - 10.75) * (2.0 * PI / 3.0)).sin()
                }
            }
            Curve::Bounce => 1.0 - bounce_out(1.0 - t),
        }
    }
}

fn bounce_out(t: f64) -> f64 {
    let (n, d) = (7.5625, 2.75);
    if t < 1.0 / d {
        n * t * t
    } else if t < 2.0 / d {
        let t = t - 1.5 / d;
        n * t * t + 0.75
    } else if t < 2.5 / d {
        let t = t - 2.25 / d;
        n * t * t + 0.9375
    } else {
        let t = t - 2.625 / d;
        n * t * t + 0.984375
    }
}

/// How an animation's progress goes, from 0 to 1, as its time does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Easing {
    Linear,
    In(Curve),
    Out(Curve),
    InOut(Curve),
    OutIn(Curve),
    CubicBezier(f64, f64, f64, f64),
    Steps(u32),
    /// mass, stiffness, damping, velocity; its own length (settling), in
    /// seconds, over which the animation's time is spread.
    Spring {
        mass: f64,
        stiffness: f64,
        damping: f64,
        velocity: f64,
        settles: f64,
    },
}

/// The names Scheme gives easings: "linear", then each curve's in-, out-,
/// in-out- and out-in- kinds, then the ones that take arguments.
pub fn easing_names() -> Vec<String> {
    let mut names = vec!["linear".to_string()];
    for (name, _) in CURVES {
        for kind in ["in", "out", "in-out", "out-in"] {
            names.push(format!("{kind}-{name}"));
        }
    }
    names.extend(["cubic-bezier", "steps", "spring"].map(String::from));
    names
}

impl Easing {
    /// The easing named `name` (one of [`easing_names`]), given `args`
    /// where it takes them; None for no such easing.
    pub fn named(name: &str, args: [f64; 4]) -> Option<Easing> {
        match name {
            "linear" => return Some(Easing::Linear),
            "cubic-bezier" => {
                let [x1, y1, x2, y2] = args;
                return Some(Easing::CubicBezier(
                    x1.clamp(0.0, 1.0),
                    y1,
                    x2.clamp(0.0, 1.0),
                    y2,
                ));
            }
            "steps" => return Some(Easing::Steps(args[0].max(1.0) as u32)),
            "spring" => {
                let [mass, stiffness, damping, velocity] = args;
                return Some(Easing::spring(mass, stiffness, damping, velocity));
            }
            _ => {}
        }
        let (kind, curve) = name.rsplit_once('-')?;
        let curve = CURVES.iter().find(|(n, _)| *n == curve)?.1;
        match kind {
            "in" => Some(Easing::In(curve)),
            "out" => Some(Easing::Out(curve)),
            "in-out" => Some(Easing::InOut(curve)),
            "out-in" => Some(Easing::OutIn(curve)),
            _ => None,
        }
    }

    /// The easing at `index` in [`easing_names`], given `args` where it
    /// takes them; None past the end.
    pub fn indexed(index: usize, args: [f64; 4]) -> Option<Easing> {
        let curves = 4 * CURVES.len();
        match index {
            0 => Some(Easing::Linear),
            i if i <= curves => {
                let curve = CURVES[(i - 1) / 4].1;
                Some(match (i - 1) % 4 {
                    0 => Easing::In(curve),
                    1 => Easing::Out(curve),
                    2 => Easing::InOut(curve),
                    _ => Easing::OutIn(curve),
                })
            }
            i => Easing::named(
                ["cubic-bezier", "steps", "spring"].get(i - 1 - curves)?,
                args,
            ),
        }
    }

    /// A spring, as Anime.js has them: a damped oscillator, run until it
    /// settles; mass, stiffness and damping are made at least a little
    /// positive.
    pub fn spring(mass: f64, stiffness: f64, damping: f64, velocity: f64) -> Easing {
        let (mass, stiffness, damping) = (mass.max(0.01), stiffness.max(0.01), damping.max(0.01));
        let mut spring = Easing::Spring {
            mass,
            stiffness,
            damping,
            velocity,
            settles: 1.0,
        };
        // Where it stays within a thousandth of 1, in sixtieths of a second.
        let at = spring_at(mass, stiffness, damping, velocity);
        let mut settled = 0;
        let mut s = 0.0;
        while settled < 16 && s < 30.0 {
            s += 1.0 / 60.0;
            if (at(s) - 1.0).abs() < 0.001 {
                settled += 1;
            } else {
                settled = 0;
            }
        }
        if let Easing::Spring { settles, .. } = &mut spring {
            *settles = s;
        }
        spring
    }

    /// Progress at time `t` (0 to 1): from 0 at 0 to 1 at 1, though some
    /// (back, elastic, springs) go past them on the way.
    pub fn ease(&self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match *self {
            Easing::Linear => t,
            Easing::In(c) => c.ease_in(t),
            Easing::Out(c) => 1.0 - c.ease_in(1.0 - t),
            Easing::InOut(c) => {
                if t < 0.5 {
                    c.ease_in(t * 2.0) / 2.0
                } else {
                    1.0 - c.ease_in(2.0 - t * 2.0) / 2.0
                }
            }
            Easing::OutIn(c) => {
                if t < 0.5 {
                    (1.0 - c.ease_in(1.0 - t * 2.0)) / 2.0
                } else {
                    (c.ease_in(t * 2.0 - 1.0) + 1.0) / 2.0
                }
            }
            Easing::CubicBezier(x1, y1, x2, y2) => cubic_bezier(x1, y1, x2, y2, t),
            Easing::Steps(n) => {
                let n = f64::from(n);
                ((t * n).floor() / n).min(1.0)
            }
            Easing::Spring {
                mass,
                stiffness,
                damping,
                velocity,
                settles,
            } => {
                if t <= 0.0 || t >= 1.0 {
                    t
                } else {
                    spring_at(mass, stiffness, damping, velocity)(t * settles)
                }
            }
        }
    }
}

/// A spring's position at `s` seconds, from 0 toward 1.
fn spring_at(mass: f64, stiffness: f64, damping: f64, velocity: f64) -> impl Fn(f64) -> f64 {
    let w0 = (stiffness / mass).sqrt();
    let zeta = damping / (2.0 * (stiffness * mass).sqrt());
    let wd = w0 * (1.0 - zeta * zeta).sqrt();
    move |s: f64| {
        let rest = if zeta < 1.0 {
            let b = (zeta * w0 - velocity) / wd;
            (-s * zeta * w0).exp() * ((wd * s).cos() + b * (wd * s).sin())
        } else {
            let b = w0 - velocity;
            (1.0 + b * s) * (-s * w0).exp()
        };
        1.0 - rest
    }
}

/// CSS's cubic-bezier: y where x is `t`, x found by Newton's method, then
/// by halving where that fails.
fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, t: f64) -> f64 {
    let at = |a: f64, b: f64, s: f64| {
        let u = 1.0 - s;
        3.0 * u * u * s * a + 3.0 * u * s * s * b + s * s * s
    };
    let slope = |a: f64, b: f64, s: f64| {
        let u = 1.0 - s;
        3.0 * u * u * a + 6.0 * u * s * (b - a) + 3.0 * s * s * (1.0 - b)
    };
    let mut s = t;
    for _ in 0..8 {
        let dx = at(x1, x2, s) - t;
        let d = slope(x1, x2, s);
        if dx.abs() < 1e-7 {
            return at(y1, y2, s);
        }
        if d.abs() < 1e-6 {
            break;
        }
        s = (s - dx / d).clamp(0.0, 1.0);
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    s = t;
    for _ in 0..40 {
        let x = at(x1, x2, s);
        if (x - t).abs() < 1e-7 {
            break;
        }
        if x < t {
            lo = s;
        } else {
            hi = s;
        }
        s = (lo + hi) / 2.0;
    }
    at(y1, y2, s)
}

// MARK: Timing

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Normal,
    Reverse,
    /// Forwards, then backwards, and so on.
    Alternate,
}

/// When an animation moves: its iterations, each `duration` long, after
/// `delay`, and `end_delay` after each; `iterations` of them, or None for
/// ever. All in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Timing {
    pub duration: f64,
    pub delay: f64,
    pub end_delay: f64,
    pub iterations: Option<u32>,
    pub direction: Direction,
    pub easing: Easing,
}

impl Timing {
    /// A timing as Scheme gives one: duration, delay, end-delay,
    /// iterations (0 for ever), direction (0 normal, 1 reverse, 2
    /// alternate), the easing's index in [`easing_names`], and its four
    /// arguments.
    pub fn from_numbers(n: &[f64]) -> Option<Timing> {
        let n: [f64; 10] = n.get(..10)?.try_into().ok()?;
        let easing = Easing::indexed(n[5] as usize, [n[6], n[7], n[8], n[9]])?;
        Some(Timing {
            duration: n[0].max(0.0),
            delay: n[1].max(0.0),
            end_delay: n[2].max(0.0),
            iterations: (n[3] >= 1.0).then_some(n[3] as u32),
            direction: match n[4] as u32 {
                1 => Direction::Reverse,
                2 => Direction::Alternate,
                _ => Direction::Normal,
            },
            easing,
        })
    }

    /// Where it is at `elapsed` milliseconds: the iteration, and how far
    /// into it (0 to 1) before easing; and whether it is done.
    fn position(&self, elapsed: f64) -> (u32, f64, bool) {
        let t = elapsed - self.delay;
        if t < 0.0 {
            return (0, 0.0, false);
        }
        let length = self.duration + self.end_delay;
        if length <= 0.0 {
            let last = self.iterations.map_or(0, |n| n - 1);
            return (last, 1.0, self.iterations.is_some());
        }
        let iteration = (t / length).floor();
        if let Some(n) = self.iterations
            && iteration >= f64::from(n)
        {
            return (n - 1, 1.0, true);
        }
        let into = t - iteration * length;
        let raw = if self.duration <= 0.0 {
            1.0
        } else {
            (into / self.duration).min(1.0)
        };
        (iteration as u32, raw, false)
    }

    /// The animation's progress at `elapsed` milliseconds after it began,
    /// eased: 0 to 1 (or past, for easings that overshoot).
    pub fn progress(&self, elapsed: f64) -> f64 {
        let (iteration, raw, _) = self.position(elapsed);
        let backwards = match self.direction {
            Direction::Normal => false,
            Direction::Reverse => true,
            Direction::Alternate => iteration % 2 == 1,
        };
        self.easing.ease(if backwards { 1.0 - raw } else { raw })
    }

    /// Milliseconds from `elapsed` until its progress next changes: 0
    /// while it moves, the time to its next iteration while it waits, None
    /// once it is done (or, endless, if it never changes).
    pub fn next_change(&self, elapsed: f64) -> Option<f64> {
        let t = elapsed - self.delay;
        if t < 0.0 {
            return Some(-t);
        }
        let (_, raw, done) = self.position(elapsed);
        if done {
            return None;
        }
        if raw < 1.0 {
            return Some(0.0);
        }
        let length = self.duration + self.end_delay;
        // Endless, and over as it begins: it never changes again.
        if length <= 0.0 {
            return None;
        }
        Some(length - (t % length))
    }
}

// MARK: Effects

/// The kinds of effect, by the numbers Scheme and the shaders know them.
pub const SHEEN: u32 = 1;

/// An effect's kind and parameters, and the color it brings: for a sheen,
/// its angle (degrees from across, positive down), its band's half-width
/// and how strong it is at its middle (0 to 1), and the light's color.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Effect {
    pub kind: u32,
    pub params: [f32; 4],
    /// 0xRRGGBB, sRGB-encoded.
    pub color: u32,
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl Effect {
    /// How much of the effect's color is mixed into ink at `point`, at
    /// `progress`, in a rectangle `extent` in size: both in cell widths
    /// (across, and down), so that angles mean the same however cells are
    /// shaped. gui.slang's `effectAmount` is this.
    pub fn amount(&self, progress: f32, point: [f32; 2], extent: [f32; 2]) -> f32 {
        self.amounts(progress, extent)(point)
    }

    /// [`Effect::amount`] at each point of one rectangle at one progress,
    /// with what is the same for all of them worked out once.
    pub fn amounts(&self, progress: f32, extent: [f32; 2]) -> impl Fn([f32; 2]) -> f32 + use<> {
        let [cos, sin, width, intensity] = self.sheen();
        let along = move |x: f32, y: f32| x * cos + y * sin;
        let corners = [
            along(0.0, 0.0),
            along(extent[0], 0.0),
            along(0.0, extent[1]),
            along(extent[0], extent[1]),
        ];
        let first = corners.iter().copied().fold(f32::INFINITY, f32::min);
        let last = corners.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        // The band starts off one side and ends off the other.
        let middle = (first - width) + (last - first + 2.0 * width) * progress;
        let sheen = self.kind == SHEEN;
        move |point: [f32; 2]| {
            if !sheen {
                return 0.0;
            }
            let away = (along(point[0], point[1]) - middle).abs();
            intensity * (1.0 - smoothstep(0.0, width, away))
        }
    }

    /// A sheen's shape, as it is drawn: its angle's cosine and sine, its
    /// half-width and its intensity.
    fn sheen(&self) -> [f32; 4] {
        let [angle, width, intensity, _] = self.params;
        let (sin, cos) = angle.to_radians().sin_cos();
        [cos, sin, width.max(0.01), intensity.clamp(0.0, 1.0)]
    }

    /// Ink `ink` (0xRRGGBB, sRGB) at `point`, with the effect: mixed
    /// toward its color by [`Effect::amount`].
    pub fn shade(&self, progress: f32, point: [f32; 2], extent: [f32; 2], ink: u32) -> u32 {
        mix(ink, self.color, self.amount(progress, point, extent))
    }
}

/// An effect placed over a rectangle of cells, with its timing, as a
/// window has it: `elapsed` milliseconds into its timing when it arrived.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    /// Column, row, columns and rows.
    pub cells: [f32; 4],
    pub effect: Effect,
    pub timing: Timing,
    pub elapsed: f64,
}

/// How many bytes gui.slang's Effect is.
pub const EFFECT_BYTES: usize = 48;

impl Placed {
    /// One as core/gui.sls gives it: column, row, columns, rows, kind,
    /// color, the kind's four parameters, elapsed, and the timing's ten
    /// numbers ([`Timing::from_numbers`]).
    pub fn from_numbers(n: &[f64]) -> Option<Placed> {
        if n.len() < 21 {
            return None;
        }
        Some(Placed {
            cells: [n[0] as f32, n[1] as f32, n[2] as f32, n[3] as f32],
            effect: Effect {
                kind: n[4] as u32,
                params: [n[6] as f32, n[7] as f32, n[8] as f32, n[9] as f32],
                color: n[5] as u32,
            },
            elapsed: n[10],
            timing: Timing::from_numbers(&n[11..21])?,
        })
    }

    /// Its progress `since` milliseconds after it arrived.
    pub fn progress(&self, since: f64) -> f32 {
        self.timing.progress(self.elapsed + since) as f32
    }

    /// Milliseconds from `since` until its progress next changes; None
    /// once it is done.
    pub fn next_change(&self, since: f64) -> Option<f64> {
        self.timing.next_change(self.elapsed + since)
    }

    /// As gui.slang's Effect: its cells (column, row, columns, rows); its
    /// shape (a sheen's angle's cosine and sine, its half-width and its
    /// intensity); its progress; its kind; its color, 0xRRGGBB; padding.
    pub fn gpu_bytes(&self, progress: f32) -> [u8; EFFECT_BYTES] {
        let [cos, sin, width, intensity] = self.effect.sheen();
        let mut out = [0u8; EFFECT_BYTES];
        let shape = [cos, sin, width, intensity, progress];
        for (i, f) in self.cells.iter().chain(&shape).enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&f.to_ne_bytes());
        }
        out[36..40].copy_from_slice(&self.effect.kind.to_ne_bytes());
        out[40..44].copy_from_slice(&self.effect.color.to_ne_bytes());
        out
    }
}

/// a, mixed toward b by `t` (0 to 1), channel by channel.
pub fn mix(a: u32, b: u32, t: f32) -> u32 {
    let t = t.clamp(0.0, 1.0);
    [16, 8, 0].iter().fold(0, |out, &shift| {
        let x = ((a >> shift) & 0xff) as f32;
        let y = ((b >> shift) & 0xff) as f32;
        out | (((x + (y - x) * t).round() as u32).min(255) << shift)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_easing() -> Vec<Easing> {
        let mut all: Vec<Easing> = easing_names()
            .iter()
            .filter_map(|n| Easing::named(n, [0.25, 0.1, 0.25, 1.0]))
            .collect();
        all.push(Easing::spring(1.0, 100.0, 10.0, 0.0));
        all.push(Easing::Steps(4));
        all
    }

    #[test]
    fn every_name_is_an_easing() {
        for name in easing_names() {
            assert!(
                Easing::named(&name, [1.0, 100.0, 10.0, 0.0]).is_some(),
                "{name}"
            );
        }
        assert!(Easing::named("in-wobble", [0.0; 4]).is_none());
    }

    /// Scheme names easings by index: each is the easing of that name.
    #[test]
    fn each_index_is_its_name() {
        let names = easing_names();
        let args = [1.0, 100.0, 10.0, 0.0];
        for (i, name) in names.iter().enumerate() {
            assert_eq!(
                Easing::indexed(i, args),
                Easing::named(name, args),
                "{name}"
            );
        }
        assert!(Easing::indexed(names.len(), args).is_none());
    }

    #[test]
    fn easings_go_from_0_to_1() {
        for e in every_easing() {
            assert!(e.ease(0.0).abs() < 1e-9, "{e:?} at 0");
            assert!((e.ease(1.0) - 1.0).abs() < 1e-9, "{e:?} at 1");
        }
    }

    #[test]
    fn known_values() {
        let ease = |n: &str, t| Easing::named(n, [0.0; 4]).unwrap().ease(t);
        assert!((ease("in-quad", 0.5) - 0.25).abs() < 1e-12);
        assert!((ease("out-quad", 0.5) - 0.75).abs() < 1e-12);
        assert!((ease("in-out-cubic", 0.25) - 0.0625).abs() < 1e-12);
        assert!((ease("in-out-sine", 0.5) - 0.5).abs() < 1e-12);
        // CSS's ease: cubic-bezier(0.25, 0.1, 0.25, 1) at half way.
        let css = Easing::named("cubic-bezier", [0.25, 0.1, 0.25, 1.0]).unwrap();
        assert!((css.ease(0.5) - 0.8024).abs() < 1e-3);
        assert_eq!(Easing::Steps(4).ease(0.3), 0.25);
    }

    #[test]
    fn timing_iterates_waits_and_ends() {
        let t = Timing {
            duration: 100.0,
            delay: 50.0,
            end_delay: 200.0,
            iterations: Some(2),
            direction: Direction::Alternate,
            easing: Easing::Linear,
        };
        assert_eq!(t.progress(0.0), 0.0);
        assert_eq!(t.next_change(0.0), Some(50.0));
        assert_eq!(t.progress(100.0), 0.5);
        assert_eq!(t.next_change(100.0), Some(0.0));
        // Waiting after the first: done with it, the second 150 ms away.
        assert_eq!(t.progress(200.0), 1.0);
        assert_eq!(t.next_change(200.0), Some(150.0));
        // The second goes back.
        assert_eq!(t.progress(375.0), 0.75);
        assert_eq!(t.progress(10_000.0), 0.0);
        assert_eq!(t.next_change(10_000.0), None);
        // For ever: never done.
        let forever = Timing {
            iterations: None,
            ..t
        };
        assert!(forever.next_change(1_000_000.0).is_some());
        // For ever, but over as each begins: it never changes again.
        let instant = Timing {
            duration: 0.0,
            end_delay: 0.0,
            ..forever
        };
        assert_eq!(instant.progress(60.0), 1.0);
        assert_eq!(instant.next_change(60.0), None);
    }

    #[test]
    fn timings_from_scheme() {
        let names = easing_names();
        let i = names.iter().position(|n| n == "out-cubic").unwrap() as f64;
        let t = Timing::from_numbers(&[300.0, 10.0, 0.0, 0.0, 2.0, i, 0.0, 0.0, 0.0, 0.0]).unwrap();
        assert_eq!(t.iterations, None);
        assert_eq!(t.direction, Direction::Alternate);
        assert_eq!(t.easing, Easing::Out(Curve::Cubic));
        assert!(Timing::from_numbers(&[1.0; 3]).is_none());
    }

    #[test]
    fn a_sheen_crosses_from_one_side_to_the_other() {
        let e = Effect {
            kind: SHEEN,
            params: [0.0, 2.0, 1.0, 0.0],
            color: 0xffffff,
        };
        let extent = [20.0, 6.0];
        // Before and after: nowhere.
        assert_eq!(e.amount(0.0, [0.0, 3.0], extent), 0.0);
        assert_eq!(e.amount(1.0, [20.0, 3.0], extent), 0.0);
        // Half way: at the middle, full; at the sides, none.
        assert!((e.amount(0.5, [10.0, 3.0], extent) - 1.0).abs() < 1e-6);
        assert_eq!(e.amount(0.5, [0.0, 3.0], extent), 0.0);
        assert_eq!(e.shade(0.5, [10.0, 3.0], extent, 0x000000), 0xffffff);
        assert_eq!(e.shade(0.5, [1.0, 3.0], extent, 0x123456), 0x123456);
    }

    /// Progress at `ms` milliseconds, for any timing: the easing's value
    /// at some point, and never moving once done.
    #[hegel::test(test_cases = 300, database = None)]
    fn timings_settle(tc: hegel::TestCase) {
        use hegel::generators as gs;
        let names = easing_names();
        let pick = tc.draw(gs::integers::<usize>().max_value(names.len() - 1));
        let easing = Easing::named(&names[pick], [0.3, 0.2, 0.7, 0.9]).unwrap();
        let ms = |tc: &hegel::TestCase| f64::from(tc.draw(gs::integers::<u32>().max_value(5000)));
        let t = Timing {
            duration: ms(&tc),
            delay: ms(&tc),
            end_delay: ms(&tc),
            iterations: Some(tc.draw(gs::integers::<u32>().min_value(1).max_value(4))),
            direction: [Direction::Normal, Direction::Reverse, Direction::Alternate]
                [tc.draw(gs::integers::<usize>().max_value(2))],
            easing,
        };
        let at = ms(&tc) * 4.0;
        let p = t.progress(at);
        assert!(p.is_finite());
        match t.next_change(at) {
            None => assert_eq!(t.progress(at + 1e6), p),
            Some(wait) if wait > 0.0 => assert_eq!(t.progress(at + wait * 0.5), p),
            Some(_) => {}
        }
    }
}
