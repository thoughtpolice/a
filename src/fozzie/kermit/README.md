<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: MIT -->

# Kermit

Kermit is a Rust port of the mutation engine of [radamsa], Aki Helin's
black-box fuzzer. Given a sample input it produces an interestingly
different one, without knowing the format. It guesses at structure
instead: lines, decimal numbers, quoted strings, bracketed trees and UTF-8,
with plain byte edits as the fallback.

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
| `nop` | do nothing |

Pattern `od` mutates once, `nd` possibly many times, and `bu` several times
in one block. The defaults are radamsa's. Like radamsa, kermit leaves the
tree mutators out of the default list.

## Differences from radamsa

- Kermit has not ported the XML mutator `xp` yet, so the default list
  leaves it out.
- `fn` fuses the block with itself, as radamsa does for the last block of
  a stream, rather than with the next block.
- Inputs are whole buffers rather than streams, and kermit has no output
  modes, TCP or UDP clients, or pcapng support.
- `bi` and `ui` also grow an empty input, so an empty seed still produces
  new inputs.
- Kermit's random streams differ from radamsa's, so a seed produces
  different outputs than the same seed does under radamsa.

Kermit is MIT-licensed, like radamsa. See [LICENSE](LICENSE).
