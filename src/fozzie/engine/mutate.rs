// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use anyhow::{Context, Result, bail};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;

pub const MAX_DICTIONARY_ENTRIES: usize = 8_192;
const MAX_DICTIONARY_BYTES: usize = 16 * 1024 * 1024;
const MAX_DICTIONARY_LINE_BYTES: usize = 1024 * 1024;

/// The byte mutators, in the order `mutate_bytes` selects them.
const BYTE_MUTATORS: [&str; 8] = [
    "flip_bit",
    "set_byte",
    "arithmetic",
    "insert_bytes",
    "delete_bytes",
    "copy_block",
    "splice",
    "insert_dictionary",
];

/// The index of kermit's jump generator, which splices the base and splice
/// inputs before kermit mutates the result.
const KERMIT_JUMP: usize = BYTE_MUTATORS.len();

/// The index of the first of kermit's mutators, which follow in
/// `kermit::Mutator::ALL` order.
const KERMIT_MUTATORS: usize = KERMIT_JUMP + 1;

pub const MUTATOR_COUNT: usize = KERMIT_MUTATORS + kermit::Mutator::ALL.len();
const _: () = assert!(MUTATOR_COUNT <= 64, "a MutatorSet holds 64 mutators");

/// One in this many kermit mutations starts from a jump between two corpus
/// inputs, the share radamsa's default generator priorities give jumps.
const KERMIT_JUMP_ODDS: usize = 6;

/// The name of the mutator a `MutatorSet` index stands for. Kermit's carry
/// a `kermit:` prefix, as in `kermit:num`.
pub fn mutator_name(index: usize) -> String {
    match index {
        _ if index < KERMIT_JUMP => BYTE_MUTATORS[index].to_owned(),
        KERMIT_JUMP => "kermit:jump".to_owned(),
        _ => format!(
            "kermit:{}",
            kermit::Mutator::ALL[index - KERMIT_MUTATORS].name()
        ),
    }
}

/// The mutators one `mutate` call selected, as a bitmask over the indices
/// `mutator_name` names. A byte mutator that fell back to another (a full
/// input, an empty dictionary) is still reported as itself: the report is
/// about the strategy chosen, and the fallback is part of that strategy.
/// Kermit reports only the mutators that changed its input.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MutatorSet(u64);

impl MutatorSet {
    fn insert(&mut self, index: usize) {
        self.0 |= 1 << index;
    }

    pub fn contains(self, index: usize) -> bool {
        self.0 & (1 << index) != 0
    }

    pub fn iter(self) -> impl Iterator<Item = usize> {
        (0..MUTATOR_COUNT).filter(move |index| self.contains(*index))
    }
}

/// Which mutation engines a campaign uses.
#[derive(Clone, Copy, Debug, Eq, PartialEq, clap::ValueEnum)]
pub enum Strategy {
    /// Fozzie's byte mutators.
    Bytes,
    /// Kermit, the port of radamsa's structure-guessing mutators.
    Kermit,
    /// Each input picks one of the two at random.
    Both,
}

impl Strategy {
    pub fn name(self) -> &'static str {
        match self {
            Strategy::Bytes => "bytes",
            Strategy::Kermit => "kermit",
            Strategy::Both => "both",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9e37_79b9_7f4a_7c15
        } else {
            seed
        })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value
    }

    pub fn below(&mut self, upper: usize) -> usize {
        if upper <= 1 {
            0
        } else {
            (self.next_u64() as usize) % upper
        }
    }
}

/// Kermit draws from the worker's generator, so the campaign seed still
/// fixes a one-worker campaign's inputs.
impl kermit::Source for Rng {
    fn below(&mut self, upper: usize) -> usize {
        Rng::below(self, upper)
    }
}

/// One worker's mutators. Kermit's scores adapt to the inputs it mutates,
/// so each worker keeps its own engine.
pub struct Mutators {
    strategy: Strategy,
    kermit: Option<kermit::Kermit>,
    /// How many dictionary entries kermit has been given so far.
    synced: usize,
}

impl Mutators {
    /// A `Bytes` strategy draws nothing here, so its inputs match those of
    /// a campaign without kermit.
    pub fn new(strategy: Strategy, config: &kermit::Config, rng: &mut Rng) -> Self {
        let kermit = (strategy != Strategy::Bytes).then(|| kermit::Kermit::new(config, rng));
        Self {
            strategy,
            kermit,
            synced: 0,
        }
    }

    /// Mutates `base`, perhaps splicing in `splice`, to at most `max_input`
    /// bytes. `dictionary` may only have grown since the last call.
    pub fn mutate(
        &mut self,
        base: &[u8],
        splice: &[u8],
        dictionary: &[Vec<u8>],
        max_input: usize,
        rng: &mut Rng,
    ) -> (Vec<u8>, MutatorSet) {
        let engine = match (&mut self.kermit, self.strategy) {
            (Some(engine), Strategy::Kermit) => engine,
            (Some(engine), Strategy::Both) if rng.below(2) == 1 => engine,
            _ => return mutate_bytes(base, splice, dictionary, max_input, rng),
        };
        engine
            .dictionary_mut()
            .extend_from_slice(&dictionary[self.synced..]);
        self.synced = dictionary.len();
        let mut applied = MutatorSet::default();
        let jumped;
        let base = if rng.below(KERMIT_JUMP_ODDS) == 0 {
            applied.insert(KERMIT_JUMP);
            jumped = kermit::generate::jump(rng, base, splice);
            &jumped
        } else {
            base
        };
        let mutation = engine.mutate(rng, base);
        for mutator in mutation.applied.iter() {
            let position = kermit::Mutator::ALL
                .iter()
                .position(|&known| known == mutator)
                .expect("kermit reports its own mutators");
            applied.insert(KERMIT_MUTATORS + position);
        }
        let mut output = mutation.data;
        output.truncate(max_input);
        (output, applied)
    }
}

fn mutate_bytes(
    base: &[u8],
    splice: &[u8],
    dictionary: &[Vec<u8>],
    max_input: usize,
    rng: &mut Rng,
) -> (Vec<u8>, MutatorSet) {
    let mut output = base.to_vec();
    let mut applied = MutatorSet::default();
    let rounds = 1 + rng.below(4);
    for _ in 0..rounds {
        let choice = rng.below(BYTE_MUTATORS.len());
        applied.insert(choice);
        match choice {
            0 => flip_bit(&mut output, max_input, rng),
            1 => set_byte(&mut output, max_input, rng),
            2 => arithmetic(&mut output, max_input, rng),
            3 => insert_bytes(&mut output, max_input, rng),
            4 => delete_bytes(&mut output, rng),
            5 => copy_block(&mut output, max_input, rng),
            6 => splice_with(&mut output, splice, max_input, rng),
            _ => insert_dictionary(&mut output, dictionary, max_input, rng),
        }
    }
    output.truncate(max_input);
    (output, applied)
}

pub fn load_dictionaries(paths: &[PathBuf], max_input: usize) -> Result<Vec<Vec<u8>>> {
    load_dictionaries_with_limits(
        paths,
        max_input,
        MAX_DICTIONARY_ENTRIES,
        MAX_DICTIONARY_BYTES,
    )
}

fn load_dictionaries_with_limits(
    paths: &[PathBuf],
    max_input: usize,
    entry_limit: usize,
    byte_limit: usize,
) -> Result<Vec<Vec<u8>>> {
    let mut entries = Vec::new();
    let mut known = HashSet::new();
    let mut bytes_read = 0;
    let mut line = Vec::new();
    for path in paths {
        let file = fs::File::open(path)
            .with_context(|| format!("reading dictionary {}", path.display()))?;
        let mut reader = BufReader::new(file);
        for line_number in 1_usize.. {
            if entries.len() == entry_limit || bytes_read == byte_limit {
                eprintln!("fozzie: dictionary import limit reached; remaining data is skipped");
                return Ok(entries);
            }
            line.clear();
            let remaining = byte_limit - bytes_read;
            let count = reader
                .by_ref()
                .take(remaining.min(MAX_DICTIONARY_LINE_BYTES) as u64 + 1)
                .read_until(b'\n', &mut line)
                .with_context(|| format!("{}:{line_number}: reading dictionary", path.display()))?;
            if count == 0 {
                break;
            }
            if count > remaining {
                eprintln!(
                    "fozzie: dictionary import byte limit reached; remaining data is skipped"
                );
                return Ok(entries);
            }
            if count > MAX_DICTIONARY_LINE_BYTES {
                bail!(
                    "{}:{line_number}: dictionary line exceeds 1 MiB",
                    path.display()
                );
            }
            bytes_read += count;
            let text = std::str::from_utf8(&line).with_context(|| {
                format!("{}:{line_number}: dictionary is not UTF-8", path.display())
            })?;
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let value = parse_dictionary_entry(trimmed)
                .with_context(|| format!("{}:{line_number}", path.display()))?;
            if !value.is_empty() && value.len() <= max_input && known.insert(value.clone()) {
                entries.push(value);
            }
        }
    }
    Ok(entries)
}

fn ensure_byte(output: &mut Vec<u8>, max_input: usize, rng: &mut Rng) -> Option<usize> {
    if output.is_empty() {
        if max_input == 0 {
            return None;
        }
        output.push(rng.next_u64() as u8);
    }
    Some(rng.below(output.len()))
}

fn flip_bit(output: &mut Vec<u8>, max_input: usize, rng: &mut Rng) {
    if let Some(index) = ensure_byte(output, max_input, rng) {
        output[index] ^= 1 << rng.below(8);
    }
}

fn set_byte(output: &mut Vec<u8>, max_input: usize, rng: &mut Rng) {
    if let Some(index) = ensure_byte(output, max_input, rng) {
        output[index] = rng.next_u64() as u8;
    }
}

fn arithmetic(output: &mut Vec<u8>, max_input: usize, rng: &mut Rng) {
    if let Some(index) = ensure_byte(output, max_input, rng) {
        let delta = 1 + rng.below(35) as u8;
        output[index] = if rng.below(2) == 0 {
            output[index].wrapping_add(delta)
        } else {
            output[index].wrapping_sub(delta)
        };
    }
}

fn insert_bytes(output: &mut Vec<u8>, max_input: usize, rng: &mut Rng) {
    if output.len() >= max_input {
        set_byte(output, max_input, rng);
        return;
    }
    let amount = (1 + rng.below(16)).min(max_input - output.len());
    let at = rng.below(output.len() + 1);
    let bytes = (0..amount)
        .map(|_| rng.next_u64() as u8)
        .collect::<Vec<_>>();
    output.splice(at..at, bytes);
}

fn delete_bytes(output: &mut Vec<u8>, rng: &mut Rng) {
    if output.is_empty() {
        return;
    }
    let begin = rng.below(output.len());
    let amount = 1 + rng.below((output.len() - begin).min(32));
    output.drain(begin..begin + amount);
}

fn copy_block(output: &mut Vec<u8>, max_input: usize, rng: &mut Rng) {
    if output.is_empty() || output.len() >= max_input {
        return;
    }
    let begin = rng.below(output.len());
    let amount = (1 + rng.below((output.len() - begin).min(32))).min(max_input - output.len());
    let block = output[begin..begin + amount].to_vec();
    let at = rng.below(output.len() + 1);
    output.splice(at..at, block);
}

fn splice_with(output: &mut Vec<u8>, other: &[u8], max_input: usize, rng: &mut Rng) {
    if other.is_empty() || max_input == 0 {
        return;
    }
    let left = rng.below(output.len() + 1);
    let right = rng.below(other.len());
    output.truncate(left);
    let available = max_input.saturating_sub(output.len());
    let amount = (other.len() - right).min(available);
    output.extend_from_slice(&other[right..right + amount]);
}

fn insert_dictionary(
    output: &mut Vec<u8>,
    dictionary: &[Vec<u8>],
    max_input: usize,
    rng: &mut Rng,
) {
    if dictionary.is_empty() {
        set_byte(output, max_input, rng);
        return;
    }
    let token = &dictionary[rng.below(dictionary.len())];
    if token.len() > max_input {
        return;
    }
    let at = rng.below(output.len().min(max_input - token.len()) + 1);
    let replace = token.len().min(output.len().saturating_sub(at));
    output.splice(at..at + replace, token.iter().copied());
}

fn parse_dictionary_entry(value: &str) -> Result<Vec<u8>> {
    // An unnamed entry starts with its opening quote, so any `=` belongs to
    // the payload. Named entries use the first `=` as their separator.
    let quoted = if value.starts_with('"') {
        value
    } else if let Some((_, quoted)) = value.split_once('=') {
        quoted.trim()
    } else {
        value
    };
    decode_quoted(quoted)
}

fn decode_quoted(value: &str) -> Result<Vec<u8>> {
    if value.len() < 2 || !value.starts_with('"') || !value.ends_with('"') {
        bail!("dictionary entries must be quoted");
    }
    let bytes = value.as_bytes();
    let mut result = Vec::new();
    let mut index = 1;
    while index + 1 < bytes.len() {
        if bytes[index] != b'\\' {
            result.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        if index + 1 >= bytes.len() {
            bail!("trailing dictionary escape");
        }
        match bytes[index] {
            b'\\' | b'"' => result.push(bytes[index]),
            b'n' => result.push(b'\n'),
            b'r' => result.push(b'\r'),
            b't' => result.push(b'\t'),
            b'x' => {
                if index + 2 >= bytes.len() - 1 {
                    bail!("short hexadecimal dictionary escape");
                }
                let text = std::str::from_utf8(&bytes[index + 1..index + 3])?;
                result.push(
                    u8::from_str_radix(text, 16)
                        .context("invalid hexadecimal dictionary escape")?,
                );
                index += 2;
            }
            other => bail!("unsupported dictionary escape \\{}", char::from(other)),
        }
        index += 1;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_limits_preserve_order_and_deduplicate_across_files() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        fs::write(&first, b"\"one\"\n\"one\"\n").unwrap();
        fs::write(
            &second,
            b"\"one\"\n\"two\"\n\"three\"\nthis tail must not be parsed",
        )
        .unwrap();
        assert_eq!(
            load_dictionaries_with_limits(&[first, second], 10, 3, 1024).unwrap(),
            [b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]
        );
    }

    #[test]
    fn dictionary_byte_budget_includes_comments_and_duplicate_entries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dictionary");
        fs::write(&path, b"# comment\n\"one\"\n\"one\"\n\"two\"\n").unwrap();
        assert_eq!(
            load_dictionaries_with_limits(&[path], 10, 100, 24).unwrap(),
            [b"one".to_vec()]
        );
    }

    #[test]
    fn oversized_dictionary_lines_fail_with_their_location() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dictionary");
        fs::write(&path, vec![b'#'; MAX_DICTIONARY_LINE_BYTES + 1]).unwrap();
        let error = load_dictionaries(&[path], 10).unwrap_err().to_string();
        assert!(error.contains("dictionary:1:"), "{error}");
        assert!(error.contains("exceeds 1 MiB"), "{error}");
    }

    #[test]
    fn mutation_is_deterministic_and_bounded() {
        let mut first = Rng::new(42);
        let mut second = Rng::new(42);
        for _ in 0..100 {
            let (a, applied_a) =
                mutate_bytes(b"abcdef", b"uvwxyz", &[b"token".to_vec()], 12, &mut first);
            let (b, applied_b) =
                mutate_bytes(b"abcdef", b"uvwxyz", &[b"token".to_vec()], 12, &mut second);
            assert_eq!(a, b);
            assert_eq!(applied_a, applied_b);
            assert!(a.len() <= 12);
        }
    }

    #[test]
    fn reports_the_selected_mutators_deterministically() {
        let mut first = Rng::new(7);
        let mut second = Rng::new(7);
        let mut seen = MutatorSet::default();
        for _ in 0..100 {
            let (_, a) = mutate_bytes(b"abcdef", b"uvwxyz", &[b"token".to_vec()], 32, &mut first);
            let (_, b) = mutate_bytes(b"abcdef", b"uvwxyz", &[b"token".to_vec()], 32, &mut second);
            assert_eq!(a, b);
            assert!(a.iter().next().is_some());
            assert!(a.iter().count() <= 4);
            seen.0 |= a.0;
        }
        assert_eq!(seen.iter().count(), BYTE_MUTATORS.len());
    }

    #[test]
    fn the_bytes_strategy_draws_as_before() {
        let config = kermit::Config::default();
        let mut first = Rng::new(3);
        let mut second = Rng::new(3);
        let mut mutators = Mutators::new(Strategy::Bytes, &config, &mut first);
        for _ in 0..100 {
            assert_eq!(
                mutators.mutate(b"abcdef", b"uvwxyz", &[], 32, &mut first),
                mutate_bytes(b"abcdef", b"uvwxyz", &[], 32, &mut second)
            );
        }
    }

    #[test]
    fn kermit_is_deterministic_bounded_and_named() {
        let config = kermit::Config::default();
        let sample = b"GET /index.html HTTP/1.1\nContent-Length: 12\n\n{\"a\": [1, 2]}\n";
        let run = |seed| {
            let mut rng = Rng::new(seed);
            let mut mutators = Mutators::new(Strategy::Kermit, &config, &mut rng);
            (0..200)
                .map(|_| mutators.mutate(sample, b"other input 42\n", &[], 64, &mut rng))
                .collect::<Vec<_>>()
        };
        let outputs = run(9);
        assert_eq!(outputs, run(9));
        let mut seen = MutatorSet::default();
        for (output, applied) in &outputs {
            assert!(output.len() <= 64);
            assert!(applied.iter().all(|index| index >= KERMIT_JUMP));
            seen.0 |= applied.0;
        }
        assert!(seen.contains(KERMIT_JUMP));
        let names: Vec<String> = seen.iter().map(mutator_name).collect();
        assert!(names.len() > 5, "{names:?}");
        assert!(names.iter().all(|name| name.starts_with("kermit:")));
    }

    #[test]
    fn both_strategies_take_turns() {
        let config = kermit::Config::default();
        let mut rng = Rng::new(5);
        let mut mutators = Mutators::new(Strategy::Both, &config, &mut rng);
        let mut seen = MutatorSet::default();
        for _ in 0..100 {
            seen.0 |= mutators
                .mutate(b"line one\nline 2\n", b"", &[], 64, &mut rng)
                .1
                .0;
        }
        assert!(seen.iter().any(|index| index < KERMIT_JUMP));
        assert!(seen.iter().any(|index| index > KERMIT_JUMP));
    }

    #[test]
    fn kermit_receives_dictionary_growth() {
        let config = kermit::Config::parse("di", "od").unwrap();
        let mut rng = Rng::new(1);
        let mut mutators = Mutators::new(Strategy::Kermit, &config, &mut rng);
        let mut dictionary = vec![b"FIRST".to_vec()];
        mutators.mutate(b"abc", b"", &dictionary, 64, &mut rng);
        dictionary.push(b"SECOND".to_vec());
        let found = (0..100).any(|_| {
            let (output, _) = mutators.mutate(b"abc", b"", &dictionary, 64, &mut rng);
            output.windows(6).any(|window| window == b"SECOND")
        });
        assert!(found);
        assert_eq!(mutators.synced, 2);
    }

    #[test]
    fn names_every_mutator() {
        assert_eq!(mutator_name(0), "flip_bit");
        assert_eq!(mutator_name(KERMIT_JUMP), "kermit:jump");
        assert_eq!(mutator_name(KERMIT_MUTATORS), "kermit:ab");
        assert_eq!(mutator_name(MUTATOR_COUNT - 1), "kermit:nop");
    }

    #[test]
    fn parses_libfuzzer_dictionary_escapes() {
        assert_eq!(decode_quoted(r#""a\x00\\\"\n""#).unwrap(), b"a\0\\\"\n");
    }

    #[test]
    fn parses_equals_in_raw_and_named_dictionary_entries() {
        assert_eq!(
            parse_dictionary_entry(r#""key=value""#).unwrap(),
            b"key=value"
        );
        assert_eq!(
            parse_dictionary_entry(r#"keyword = "left=right""#).unwrap(),
            b"left=right"
        );
    }

    #[test]
    fn splice_handles_unbounded_max_input_without_overflow() {
        let mut output = b"x".to_vec();
        let mut rng = Rng::new(1);
        splice_with(&mut output, b"abcd", usize::MAX, &mut rng);
        assert_eq!(output, b"xbcd");
    }
}
