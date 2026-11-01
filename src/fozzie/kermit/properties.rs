// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! Properties of kermit's guessing parsers and engine, checked over
//! generated inputs. Buck runs tests in the repository root, so hegel keeps
//! no example database there.

use crate::{Config, Kermit, Rng, reduce, text, tree};
use hegel::TestCase;
use hegel::generators::{self as gs, PrintableGenerator as _};

/// Bytes biased toward the ones the lexers care about: quotes, brackets,
/// tag punctuation, escapes, line breaks, and bytes that are not text.
fn structured_bytes() -> impl gs::PrintableGenerator<Vec<u8>> {
    let alphabet = b"\"'\\()[]<>{}/=b\n\t a1\x00\x7f\xff".to_vec();
    gs::vecs(gs::sampled_from(alphabet)).max_size(64)
}

/// The string lexer loses and invents nothing, so the ASCII mutator only
/// changes the chunk it picks.
#[hegel::test(test_cases = 500, database = None)]
fn the_string_lexer_round_trips(tc: TestCase) {
    let data = tc.draw(structured_bytes());
    assert_eq!(text::unlex(&text::lex(&data)), data);
}

/// The lexer gathers neighbouring raw bytes into one chunk.
#[hegel::test(test_cases = 500, database = None)]
fn raw_chunks_are_maximal(tc: TestCase) {
    let data = tc.draw(structured_bytes());
    let chunks = text::lex(&data);
    for pair in chunks.windows(2) {
        assert!(
            !matches!(pair, [text::Chunk::Raw(_), text::Chunk::Raw(_)]),
            "{chunks:?}"
        );
    }
}

/// Every block parses, and the guessed tree flattens back to it.
#[hegel::test(test_cases = 500, database = None)]
fn the_tree_parser_round_trips(tc: TestCase) {
    let data = tc.draw(structured_bytes());
    assert_eq!(tree::flatten(&tree::parse(&data)), data);
}

/// The default engine finishes and replays exactly for any input and seed.
#[hegel::test(test_cases = 200, database = None)]
fn the_engine_is_deterministic_on_any_input(tc: TestCase) {
    let input = tc.draw(gs::one_of(vec![
        gs::binary().max_size(512).boxed_printable(),
        structured_bytes().boxed_printable(),
    ]));
    let seed = tc.draw(gs::integers::<u64>());
    let run = || {
        let mut rng = Rng::new(seed);
        let mut kermit = Kermit::new(&Config::default(), &mut rng);
        (0..4)
            .map(|_| kermit.mutate(&mut rng, &input).data)
            .collect::<Vec<_>>()
    };
    assert_eq!(run(), run());
}

/// Reduction keeps the failure, never grows the input, and stops at a
/// fixed point. The failure here is having at least so many of some byte.
#[hegel::test(test_cases = 300, database = None)]
fn reduction_keeps_the_failure_and_ends(tc: TestCase) {
    let input = tc.draw(structured_bytes());
    let needle = tc.draw(gs::sampled_from(b"\"(<a1\n\xff".to_vec()));
    let count = |data: &[u8]| data.iter().filter(|&&byte| byte == needle).count();
    let wanted = tc.draw(gs::integers::<usize>().max_value(count(&input)));
    let fails = |data: &[u8]| Ok::<_, std::convert::Infallible>(count(data) >= wanted);
    let Ok(out) = reduce(input.clone(), fails);
    assert!(count(&out) >= wanted);
    assert!(out.len() <= input.len());
    let Ok(again) = reduce(out.clone(), fails);
    assert_eq!(again, out);
}
