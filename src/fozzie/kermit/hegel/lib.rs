// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! Hegel generators of kermit mutations.
//!
//! [`mutations`] draws an input as one of a few seeds followed by a list of
//! edits, each a kermit mutation of one block. Every decision kermit makes
//! is a Hegel choice, and a zero choice is the simplest one. When a property
//! fails on a mutated input, Hegel therefore shrinks it toward a seed: it
//! drops edits, then moves each one left toward the first mutator, the first
//! block and the smallest change.
//!
//! ```no_run
//! use hegel::TestCase;
//!
//! #[hegel::test]
//! fn sizes_parse(tc: TestCase) {
//!     let input = tc.draw(kermit_hegel::mutations([b"width=640\nheight=480\n"]));
//!     let _ = std::str::from_utf8(&input);
//! }
//! ```

use hegel::PrettyPrinter;
use hegel::TestCase;
use hegel::generators::{self as gs, Generator, PrintableGenerator};
use kermit::{Config, Kermit, Mutator, Rng, Source, generate};
use std::cell::RefCell;
use std::sync::LazyLock;

/// How many edits [`mutations`] makes at most, unless
/// [`Mutations::max_edits`] says otherwise.
pub const DEFAULT_MAX_EDITS: usize = 8;

/// How long an edit lets an input grow, unless [`Mutations::max_size`] says
/// otherwise. It matches fozzie's default input limit.
pub const DEFAULT_MAX_SIZE: usize = 1 << 16;

static MUTATIONS_LABEL: LazyLock<u64> = LazyLock::new(|| gs::label_from_name("kermit.mutations"));
static EDIT_LABEL: LazyLock<u64> = LazyLock::new(|| gs::label_from_name("kermit.edit"));

/// A kermit [`Source`] whose draws are Hegel choices.
///
/// [`mutations`] covers the usual case. This source lets a test drive the
/// rest of kermit, such as [`Kermit::mutate`] with its patterns, or
/// [`generate::random`].
pub struct HegelSource<'a> {
    tc: &'a TestCase,
}

impl<'a> HegelSource<'a> {
    pub fn new(tc: &'a TestCase) -> Self {
        Self { tc }
    }
}

impl Source for HegelSource<'_> {
    fn below(&mut self, upper: usize) -> usize {
        if upper <= 1 {
            0
        } else {
            self.tc
                .draw_silent(gs::integers::<usize>().max_value(upper - 1))
        }
    }
}

/// Draws a mutated input from `seeds`, which must not be empty.
///
/// It picks a seed, the first when shrunk. With two or more seeds it
/// splices a second one in a quarter of the time, as kermit's `jump`
/// generator does. It then makes up to [`DEFAULT_MAX_EDITS`] edits with
/// [`Kermit::edit`]. The failing example prints the input as a byte string,
/// with a comment naming the seeds and the mutators that changed it.
pub fn mutations<I>(seeds: I) -> Mutations
where
    I: IntoIterator,
    I::Item: AsRef<[u8]>,
{
    let seeds: Vec<Vec<u8>> = seeds
        .into_iter()
        .map(|seed| seed.as_ref().to_vec())
        .collect();
    assert!(!seeds.is_empty(), "kermit_hegel::mutations needs a seed");
    Mutations {
        seeds,
        config: Config::default(),
        max_edits: DEFAULT_MAX_EDITS,
        max_size: DEFAULT_MAX_SIZE,
    }
}

/// The generator [`mutations`] returns.
pub struct Mutations {
    seeds: Vec<Vec<u8>>,
    config: Config,
    max_edits: usize,
    max_size: usize,
}

impl Mutations {
    /// Sets the mutators the edits draw from. A zero draw picks the first
    /// mutator in the list, so a list that starts with gentle mutators
    /// shrinks toward them. The patterns in the list go unused.
    pub fn config(mut self, config: Config) -> Self {
        self.config = config;
        self
    }

    /// Sets the most edits one input gets.
    pub fn max_edits(mut self, edits: usize) -> Self {
        self.max_edits = edits;
        self
    }

    /// Truncates the input to `bytes` after each edit. Some mutators repeat
    /// a line or a block up to a thousand times, so a few edits could
    /// otherwise make an input too large to test quickly.
    pub fn max_size(mut self, bytes: usize) -> Self {
        self.max_size = bytes;
        self
    }
}

impl Generator<Vec<u8>> for Mutations {
    fn label(&self) -> u64 {
        *MUTATIONS_LABEL
    }

    fn do_draw(&self, tc: &TestCase) -> Vec<u8> {
        self.do_draw_and_print(tc, &mut PrettyPrinter::noop())
    }
}

impl PrintableGenerator<Vec<u8>> for Mutations {
    fn do_draw_and_print(&self, tc: &TestCase, printer: &mut PrettyPrinter) -> Vec<u8> {
        let mut source = HegelSource::new(tc);
        let first = source.below(self.seeds.len());
        let mut data = self.seeds[first].clone();
        let mut spliced = None;
        if self.seeds.len() > 1 && source.chance(1, 4) {
            let second = source.below(self.seeds.len());
            data = generate::jump(&mut source, &data, &self.seeds[second]);
            spliced = Some(second);
        }
        // Kermit::new draws starting scores, which edits ignore, so a fixed
        // stream saves the choices.
        let kermit = Kermit::new(&self.config, &mut Rng::new(0));
        let state = RefCell::new((kermit, data));
        let edit = Edit {
            state: &state,
            max_size: self.max_size,
        };
        let applied = tc.draw_silent(gs::vecs(edit).max_size(self.max_edits));
        let (_, data) = state.into_inner();
        if printer.should_print() {
            printer.text(&format!("b\"{}\"", data.escape_ascii()));
            printer.comment(&describe(first, spliced, &applied));
        }
        data
    }
}

/// One edit of the input in `state`, which yields the mutator that changed
/// it. The edits of one input run in order on the same engine, so the
/// mutators that remember earlier blocks see the earlier edits.
struct Edit<'a> {
    state: &'a RefCell<(Kermit, Vec<u8>)>,
    max_size: usize,
}

impl Generator<Option<Mutator>> for Edit<'_> {
    fn label(&self) -> u64 {
        *EDIT_LABEL
    }

    fn do_draw(&self, tc: &TestCase) -> Option<Mutator> {
        let (kermit, data) = &mut *self.state.borrow_mut();
        let applied = kermit.edit(&mut HegelSource::new(tc), data);
        data.truncate(self.max_size);
        applied
    }
}

/// Names the seeds and mutators behind an input, such as `seed 0 spliced
/// with seed 1, then num, bd`.
fn describe(first: usize, spliced: Option<usize>, applied: &[Option<Mutator>]) -> String {
    let mut out = format!("seed {first}");
    if let Some(second) = spliced {
        out.push_str(&format!(" spliced with seed {second}"));
    }
    let names: Vec<&str> = applied.iter().flatten().map(|m| m.name()).collect();
    if names.is_empty() {
        out.push_str(", unedited");
    } else {
        out.push_str(", then ");
        out.push_str(&names.join(", "));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::{Hegel, Settings};
    use std::sync::{Arc, Mutex};

    /// The shrunk input of the first failure of `fails`, as Hegel's own
    /// tests find minimal examples.
    fn minimal(
        generator: Mutations,
        fails: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
    ) -> Vec<u8> {
        let found = Arc::new(Mutex::new(None));
        let record = Arc::clone(&found);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Hegel::new(move |tc: TestCase| {
                let input = tc.draw_silent(&generator);
                if fails(&input) {
                    *record.lock().unwrap() = Some(input);
                    panic!("found");
                }
            })
            .settings(
                Settings::new()
                    .test_cases(500)
                    .database(None)
                    .derandomize(true)
                    .report_multiple_failures(false),
            )
            .run();
        }));
        assert!(outcome.is_err(), "no input failed");
        found.lock().unwrap().take().expect("a failing input")
    }

    #[test]
    fn the_simplest_input_is_the_first_seed() {
        assert_eq!(minimal(mutations([b"a", b"b"]), |_| true), b"a");
        assert_eq!(
            minimal(mutations([b"a", b"b"]), |input| input == b"b"),
            b"b"
        );
    }

    /// A planted overflow: sizes past 65535 wrap. The shrunk input is the
    /// first seed with only the width changed, by one `num` edit.
    #[test]
    fn failures_shrink_to_the_seed_and_one_edit() {
        let size = |line: &[u8], key: &str| {
            let value = line.strip_prefix(key.as_bytes())?.strip_prefix(b"=")?;
            std::str::from_utf8(value).ok()?.parse::<u64>().ok()
        };
        let overflows = move |input: &[u8]| {
            input.split(|&byte| byte == b'\n').any(|line| {
                ["width", "height"]
                    .iter()
                    .any(|key| size(line, key).is_some_and(|value| value > 0xffff))
            })
        };
        let seeds: [&[u8]; 2] = [b"width=640\nheight=480\n", b"{\"a\": [1, 2]}"];
        let shrunk = minimal(mutations(seeds), overflows);
        let lines: Vec<&[u8]> = shrunk.split(|&byte| byte == b'\n').collect();
        assert!(
            matches!(lines[..], [width, b"height=480", b""] if size(width, "width") > Some(0xffff)),
            "{}",
            shrunk.escape_ascii()
        );
    }

    #[hegel::test(test_cases = 100, database = None)]
    fn edits_respect_the_size_limit(tc: TestCase) {
        let config = Config::parse("lr,sr,br", "od").unwrap();
        let input = tc.draw(mutations([b"a\nb\n"]).config(config).max_size(64));
        assert!(input.len() <= 64);
    }

    /// Driven by Hegel, kermit's own engine still changes every input it
    /// mutates once.
    #[hegel::test(test_cases = 100, database = None)]
    fn the_source_drives_the_whole_engine(tc: TestCase) {
        let config = Config::parse(kermit::DEFAULT_MUTATORS, "od").unwrap();
        let mut source = HegelSource::new(&tc);
        let mut kermit = Kermit::new(&config, &mut source);
        let mutation = kermit.mutate(&mut source, b"HAL 9000\n");
        assert_ne!(mutation.data, b"HAL 9000\n");
    }

    #[test]
    fn descriptions_name_seeds_and_mutators() {
        assert_eq!(describe(0, None, &[]), "seed 0, unedited");
        assert_eq!(
            describe(
                1,
                Some(0),
                &[Some(Mutator::Number), None, Some(Mutator::ByteDrop)]
            ),
            "seed 1 spliced with seed 0, then num, bd"
        );
    }
}
