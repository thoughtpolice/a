# filecheck

`filecheck` reimplements LLVM's
[FileCheck](https://llvm.org/docs/CommandGuide/FileCheck.html) in
standard-library Go, adds a [lit](https://llvm.org/docs/CommandGuide/lit.html)
style runner for `RUN:` test files, and ships Buck2 rules that drive both. It
exists so compiler and golden-output tests anywhere in the repository can be
written the way LLVM's are, and so `buck2 test` reports one result per check
rather than one per suite.

## Modes

```console
$ filecheck [OPTIONS] CHECK-FILE                    # FileCheck: input on stdin or --input-file
$ filecheck exec [OPTIONS] CHECK-FILE -- TOOL ARGS  # run TOOL, check its output
$ filecheck lit [OPTIONS] TEST-FILE...              # run the RUN: lines of each file
```

The first form takes FileCheck's options (`--check-prefix`,
`--check-prefixes`, `--comment-prefixes`, `--input-file`, `--match-full-lines`,
`--strict-whitespace`, `--ignore-case`, `--implicit-check-not`,
`--enable-var-scope`, `-D`, `--allow-empty`, `--allow-unused-prefixes`,
`--dump-input`, `--dump-input-filter`, `--dump-input-context`, `-v`, `-vv`) and
its directives: `CHECK`, `-NEXT`, `-SAME`, `-NOT`, `-DAG`, `-LABEL`, `-EMPTY`,
`-COUNT-N`, `{LITERAL}`, `COM:`, `{{regex}}`, `[[VAR:regex]]`, `[[VAR]]`,
numeric `[[#%fmt,VAR:]]` and `[[#expr]]` with `@LINE`, `+ - * /`, `min max add
sub mul div`, and `$` global variables. The match loop is a port of LLVM's, so
CHECK-NOT between CHECK-DAGs, CHECK-LABEL partitioning and CHECK-COUNT behave
the same, and the diagnostics and annotated input dump use LLVM's format. Exit
status is 0, 1 when a check fails, and 2 for a malformed check file or a usage
error.

Regular expressions are Go's RE2 syntax rather than POSIX ERE. Classes such
as `[[:alpha:]]` work. RE2 has no backreferences, so a reuse within one
directive like `[[R:%[a-z]+]] = add [[R]]` is emulated by matching the
definition's regex a second time and comparing the two captures. That covers
every idiom I have seen in LLVM's test suite, but a pattern that relied on
backtracking to pick a different candidate would not be found.

## lit-style test files

A test file carries its own commands. `%toy` below comes from the `tools`
attribute of the Buck target that owns the file:

```llvm
// RUN: %toy %s | FileCheck %s
// RUN: %toy --upper %s | FileCheck %s --check-prefix=UPPER
// REQUIRES: system-linux
//
// CHECK: 1: hello
// CHECK-NEXT: 2: world
// UPPER: [[#N:]]: HELLO
// UPPER-NEXT: [[#N+1]]: WORLD
```

Directives: `RUN:` (a trailing `\` continues onto the next `RUN:` line),
`REQUIRES:`, `UNSUPPORTED:`, `XFAIL:` (boolean expressions over features, or
`*`), `DEFINE:` and `REDEFINE: %{name} = value`, and `END.`. A `REDEFINE:`
affects only the `RUN:` lines after it. Substitutions: `%s`, `%S`, `%p`,
`%t`, `%T`, `%basename_t`, `%{pathsep}`, `%%`, `%(line)`, `%(line+N)`,
`%filecheck`, `%name` and `%{name}` for tools, `%{name}` for defines.
Features present everywhere: `filecheck`, `system-<os>`, `x86_64` or
`aarch64`, and `tool-<name>` for every tool.

An internal shell runs the RUN lines instead of `/bin/sh`, so a test behaves
the same on every host and never depends on which utilities happen to be
installed. It supports pipelines (with pipefail), `&&`, `||`, `;`, quoting,
`<`, `>`, `>>`, `2>`, `2>&1`, `&>`, and the builtins `FileCheck` and
`filecheck` (run in-process), `not`, `env`, `echo`, `cat`, `diff` (unified
output; `-u -b -w -i --strip-trailing-cr`), `mkdir -p`, `rm -rf`, `cd`,
`export`, `count N`, `true`, `false`, `:`. Anything else it looks up on `PATH`
or runs by path. Commands start in the project root, so `$(location)`-style
relative paths work; `%S` is the test's own directory.

## Buck2 rules

```starlark
shims.filecheck.lit(
    name = "tests",
    srcs = glob(["tests/*.mlir"]),
    data = glob(["tests/inputs/*"]),   # extra files RUN lines read
    tools = {"toy": ":toy"},           # %toy and %{toy}
    defines = {"flags": "-O2"},        # %{flags}
    features = ["fast-math"],          # for REQUIRES:/UNSUPPORTED:/XFAIL:
)

shims.filecheck.test(
    name = "version-check",
    dep = ":toy",
    args = ["--version"],
    check = "tests/version.check",
    # capture = "stderr" | "both", input = "stdin.txt", expect_exit = 1,
    # flags = ["--match-full-lines"], defines = {...}, data = [...]
)
```

`tools` and `dep` are target-configuration deps, so `buck2 test -m release
:tests` tests the release build of the tool. The `filecheck` binary is an
exec dep.

With the repository's internal test runner (the default), `filecheck.lit`
lists every file as a test case and reports every `RUN:` line as its own
result. `buck2 test` then names the exact line that failed and attaches its
script, exit status and captured output:

```
PASS  root//buck/tools/filecheck:self-tests - tests/basic.test:2
FAIL  root//buck/tools/filecheck:self-tests - tests/basic.test:3
SKIP  root//buck/tools/filecheck:self-tests - tests/basic.test:4   (not run: RUN: at line 3 failed)
FAIL  root//buck/tools/filecheck:self-tests - tests/basic.test
```

`UNSUPPORTED` files report as SKIP, `XFAIL` files as a single PASS, and an
`XFAIL` file that passes as a FAIL. The listing depends only on the declared
sources, and execution results are cacheable. `buck2 run :tests` runs every
file with lit-style output; `buck2 run :tests -- -v` also shows the output of
passing RUN lines.

The rule writes a JSON manifest (`buck2 build :tests[manifest]`) naming the
tools, defines, features and owning package. `filecheck lit --manifest` reads
it and, when `buck2 run` starts it somewhere else, changes to the project
root it derives from the manifest's location.

## Layout

`check.go`, `pattern.go`, `numeric.go` and `checker.go` are the checker, a
port of LLVM's reader, pattern parser, expression evaluator and match loop.
`diag.go` and `dump.go` print SourceMgr-style diagnostics and the input dump.
`shell.go` and `diff.go` are the internal shell and its diff builtin.
`features.go` and `lit.go` evaluate feature expressions and run test files.
`defs.bzl` holds the Buck2 rules, and `tests/` the self-hosted lit tests with
the `toy` fixture tool they drive.
