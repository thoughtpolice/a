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

pub fn mutate(
    base: &[u8],
    splice: &[u8],
    dictionary: &[Vec<u8>],
    max_input: usize,
    rng: &mut Rng,
) -> Vec<u8> {
    let mut output = base.to_vec();
    let rounds = 1 + rng.below(4);
    for _ in 0..rounds {
        match rng.below(8) {
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
    output
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
            let value = decode_quoted(
                trimmed
                    .split_once('=')
                    .map_or(trimmed, |(_, value)| value.trim()),
            )
            .with_context(|| format!("{}:{line_number}", path.display()))?;
            if !value.is_empty() && value.len() <= max_input && known.insert(value.clone()) {
                entries.push(value);
            }
        }
    }
    Ok(entries)
}

pub fn comparison_tokens(arg1: u64, arg2: u64, width: u8) -> [Vec<u8>; 2] {
    let width = usize::from(width);
    [
        arg1.to_le_bytes()[..width].to_vec(),
        arg2.to_le_bytes()[..width].to_vec(),
    ]
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
    output.extend_from_slice(&other[right..other.len().min(right + max_input - output.len())]);
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
            let a = mutate(b"abcdef", b"uvwxyz", &[b"token".to_vec()], 12, &mut first);
            let b = mutate(b"abcdef", b"uvwxyz", &[b"token".to_vec()], 12, &mut second);
            assert_eq!(a, b);
            assert!(a.len() <= 12);
        }
    }

    #[test]
    fn parses_libfuzzer_dictionary_escapes() {
        assert_eq!(decode_quoted(r#""a\x00\\\"\n""#).unwrap(), b"a\0\\\"\n");
    }
}
