# absh: A/B testing for shell scripts

> [!NOTE]
> This is a fork of [absh](https://github.com/stepancheg/absh) by Stepan Koltsov,
> taken at `045b9e7` and kept under its original MIT license (see `LICENSE`).
> It differs from upstream only in building with Buck2, allocating with
> mimalloc, and using current dependencies: `std` replaces `atty`, `once_cell`
> and `dirs`, and `rand` and `wait4` are on their latest releases.

```sh
$ absh \
  -a "test a" \
  -b "test b" \
  -A "warmup for a" \
  -B "warmup for b"
```

It continuously run `B`, `b`, `A`, `a`; ignores the numbers of the first iteration,
and then after third iteration it prints averages, and 95% confidence interval of B average/A average.

```
A: n=421 mean=61.181 std=1.701 se=0.083 min=57.687 max=66.103 med=61.218
B: n=421 mean=59.891 std=1.824 se=0.089 min=56.441 max=65.669 med=59.496
A: distr=[        ▁▁   ▃▃▃▅▂▅▆▃▄▇▆▃▅▂▁▂▅▃▁▄▄▆▇▅▄█▃▃▄▂▃▁▁ ▂ ▁  ▁        ]
B: distr=[   ▁▁▁▁▄▅▄▇▅▇█▂▃▅▃▅▃▁▁▂▃▃▂▅▂▃▅▆▂▅▃▅▁▁▃ ▂▁▁▁▁                 ]
B/A: 0.979 0.975..0.983 (95% conf)
```

## How to run

```sh
buck2 run //src/absh -- -a 'test a' -b 'test b'
```

## absh --help

<!-- absh-help:start -->
```
A/B testing for shell scripts.
In scripts, `@ABSH_P` placeholder is replaced with
the current experiment name (`a`, `b`...).

Usage: absh [OPTIONS] -a <SCRIPT>

Options:
  -a <SCRIPT>               A variant shell script
  -b <SCRIPT>               B variant shell script
  -c <SCRIPT>               C variant shell script
  -d <SCRIPT>               D variant shell script
  -w, --warmup <SCRIPT>     Warmup script to run before each test
  -A, --a-warmup <SCRIPT>   A variant warmup shell script, used unless `--warmup` is specified
  -B, --b-warmup <SCRIPT>   B variant warmup shell script, used unless `--warmup` is specified
  -C, --c-warmup <SCRIPT>   C variant warmup shell script, used unless `--warmup` is specified
  -D, --d-warmup <SCRIPT>   D variant warmup shell script, used unless `--warmup` is specified
  -r                        Randomise test execution order
  -i                        Ignore the results of the first iteration
  -n <ITERATIONS>           Stop after n successful iterations (run forever if not specified)
  -m, --mem                 Also measure max resident set size
      --max-time <SECONDS>  Test is considered failed if it takes longer than this many seconds
  -h, --help                Print help
```
<!-- absh-help:end -->
