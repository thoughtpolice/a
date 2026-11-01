<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: MIT -->

# Kermit

Kermit is a Rust port of the mutation engine of [radamsa], Aki Helin's
black-box fuzzer. Given a sample input it produces an interestingly
different one, without knowing the format. It guesses at structure
instead: lines, decimal numbers, quoted strings, bracketed trees, XML-ish
tags and UTF-8, with plain byte edits as the fallback.

[radamsa]: https://gitlab.com/akihe/radamsa

```rust
let mut rng = kermit::Rng::new(seed);
let mut engine = kermit::Kermit::new(&kermit::Config::default(), &mut rng);
let mutation = engine.mutate(&mut rng, b"HAL 9000\n");
```

Each call picks a pattern and a block of the input of up to 4 KiB. It then
tries mutators in a weighted random order until one changes the block. A
mutator's weight is its priority times a score from 2 to 10 that it adjusts
itself. The line mutators gain on text and lose on binary data, so the mix
adapts to the input over a run. Mutator and pattern lists use radamsa's
syntax, such as `num=5,ld,bd=0`, where priority 0 disables an entry.

All randomness flows through the `Source` trait, and a zero draw always
picks the simplest outcome. A property-testing engine such as Hegel can
therefore drive the mutators with its own choices and shrink a failing
mutation toward the unmutated seed.

## Mutators

| Name | Mutation |
| --- | --- |
| `bd` `bf` `bi` `br` `bp` `bei` `bed` `ber` | drop, flip a bit of, insert, repeat, permute, increment, decrement or randomize bytes |
| `sr` `sd` | repeat or delete a byte sequence |
| `ld` `lds` `lr2` `li` `lr` `ls` `lp` | delete, delete many, duplicate, copy, repeat, swap or permute lines |
| `lis` `lrs` | insert or replace a line with one remembered from earlier inputs |
| `num` | rewrite a decimal number as a nearby, boundary or distant value, with boundaries up to 2^128 + 1 |
| `ab` | put format strings, shell metacharacters, escapes or long runs into text and quoted strings |
| `uw` `ui` | make a byte an overlong UTF-8 sequence, or insert troublesome code points |
| `ft` `fn` `fo` | splice the block onto itself, across its halves, or with a block remembered from an earlier input, at points where the two share context |
| `td` `tr2` `ts1` `ts2` `tr` | delete, duplicate, swap or recursively repeat bracketed nodes |
| `xp` | swap, duplicate, nest, repeat or insert XML-ish elements, using tags and attributes seen in earlier inputs |
| `nop` | do nothing |

Pattern `od` mutates once, `nd` possibly many times, and `bu` several times
in one block. The defaults are radamsa's. Like radamsa, kermit leaves the
tree mutators out of the default list.

## Beyond radamsa

Kermit adds mutators that radamsa lacks. They run by default at priority
1.

| Name | Mutation |
| --- | --- |
| `wi` `wa` | write an interesting value into, or add or subtract up to 35 from, a 1, 2, 4 or 8 byte integer in either byte order, as AFL does |
| `lf` | find a field whose value is the length of what follows it, or of the block, and make it lie |
| `sz` | truncate or extend the block to 2^k - 1, 2^k or 2^k + 1 bytes |
| `ec` | re-encode a run of text with percent or double-percent encoding, HTML entities, `\u` `\x` or octal escapes, fullwidth forms, swapped case, UTF-16LE or overlong UTF-8 |
| `jv` | replace a JSON string, number or literal with an edge case such as `9007199254740993`, `1e309`, `-0`, a lone surrogate escape, a value of another type, deep nesting or a long string |
| `di` `dr` | insert a dictionary token, or overwrite bytes with one |

The integer mutators score up on binary data and down on text, the
reverse of the line mutators. `jv` scores up on blocks that start like
JSON. `di` and `dr` draw from tokens given with `Config::dictionary` or
added during a run through `Kermit::dictionary_mut`, and do nothing
without them.

## Command line

`root//src/fozzie/kermit/cli:kermit` is a command line in the style of
radamsa's. It takes radamsa's flags, plus `-D` for a dictionary:

```sh
buck2 run root//src/fozzie/kermit/cli:kermit -- -s 7 -n 100 -o 'out-%03n.%s' samples/*.json
```

Paths name sample files, and `-` or no paths at all reads standard input.
`-o` takes `-` for standard output, a path pattern, `:PORT` to serve each
output to one TCP client, or `ADDRESS:PORT` to send each one to a TCP
server, with a `/udp` suffix for UDP. A path pattern can use `%n` for the
output's number, `%0Nn` for the number padded to N digits, `%s` for the
sample's suffix, `%p` for the first sample's suffix, `%h` for the
output's checksum, and `%%` for a percent sign.

The generators of `-g` pick each sample. `file` reads one of the given
files, `jump` splices two of them where they share context, `stdin`
reads standard input, and `random` makes random bytes. `-l` lists every
mutator, pattern and generator.

A seed makes a run repeatable, and `-S N` repeats a run from output N
without writing the outputs before it. A uniqueness filter drops outputs
already written. `-M` logs the seed and then one JSON line per output
with its generator, sources, pattern, mutators, checksum and
destination. `-D` reads an AFL or libFuzzer dictionary for `di` and
`dr`.

## Differences from radamsa

- `xp` repeats an element at most 1025 times rather than 16385. When its
  chosen operation changes nothing it inserts a tag instead of drawing
  again.
- The tree mutators and `xp` see brackets and tags nested more than 512
  deep as plain bytes, and `tr` and `xp` nest at most 512 levels deeper
  in one call. Their recursive walks then fit a thread's stack, where
  radamsa's Lisp runtime has no stack to exhaust.
- `fn` fuses the block with itself, as radamsa does for the last block of
  a stream, rather than with the next block.
- Kermit reads each sample whole rather than as a stream, and has no
  pcapng generator.
- `-M` writes JSON lines rather than radamsa's own record format.
- `-H` offers BLAKE3, the default, SHA-1 and SHA-256 rather than radamsa's
  stream hash. The checksum covers the output as written, after
  `--output-template` and `-T`, so `%h` names a file by its own hash.
- `-T` truncates outputs. radamsa parses the flag but ignores it.
- `-o` also takes IPv6 addresses such as `[::1]:80`.
- A path pattern with an unknown `%` escape is an error, not a warning.
- After 10000 duplicate outputs in a row kermit stops with an error,
  where radamsa would keep trying forever.
- `nd` and `bu` stop adding mutations once an output has outgrown its
  input by 1 MiB, or by `Config::growth_limit`. radamsa has no limit, and
  a burst of line repeats, each up to 1023 copies, can exhaust memory.
- `bi` and `ui` also grow an empty input, so an empty seed still produces
  new inputs.
- Kermit's random streams differ from radamsa's, so a seed produces
  different outputs than the same seed does under radamsa.

Kermit is MIT-licensed, like radamsa. See [LICENSE](LICENSE).
