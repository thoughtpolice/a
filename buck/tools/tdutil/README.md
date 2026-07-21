# tdutil

`tdutil` is the repository's first-party Buck2 target determinator. It compares
the real Buck graphs at two arbitrary JJ revisions and prints the targets in the
head revision which may be affected.

The tool replaces the former Deno `quicktd` orchestrator and the downloaded
`supertd`/`btd` binary. Its design follows the two-snapshot protocol from
[`buck2-change-detector`](https://github.com/facebookincubator/buck2-change-detector).
The implementation is standard-library-only Go and is built with the
repository's hermetic Go toolchain as a statically linked executable.

## Usage

The common case needs no arguments:

```console
$ buck2 run root//buck/tools/tdutil:tdutil
```

That compares `fork_point(trunk() | @)` against `@` over `depot//...`. The fork
point's own changes are excluded, while all descendant changes through the
working copy are included. Target patterns can be supplied without spelling
the default revisions:

```console
$ buck2 run root//buck/tools/tdutil:tdutil -- depot//src/...
```

Any two single-valued JJ revsets work:

```console
$ TARGETS_FILE="$(mktemp "${TMPDIR:-/tmp}/tdutil-targets.XXXXXX")"
$ trap 'rm -f -- "$TARGETS_FILE"' EXIT
$ buck2 run root//buck/tools/tdutil:tdutil -- \
    --from 'trunk()' --to '@' \
    --universe depot//... \
    --output "$TARGETS_FILE"
$ buck2 test "@$TARGETS_FILE"
```

Text output is one sorted, fully qualified label per line. It goes to stdout by
default, including a final newline when non-empty. `--output` writes an at-file
directly. `--format json` emits revision metadata and root-cause information;
`--format json-lines` emits one reason record per target. Run with `--help` for
all options.

The command snapshots the current JJ working copy by default, so `@` includes
edits that have not yet been observed by another JJ command. Use
`--ignore-working-copy` only when stale working-copy state is intentional.

## Algorithm and correctness

1. Resolve both revsets to exactly one commit and compute their tree diff.
2. Materialize the base tree in a real temporary JJ workspace. The head tree
   is materialized the same way only when it is not the working-copy commit;
   the working copy itself is already that tree, so the head graph is queried
   in place. `--no-head-in-place` forces materialization anyway.
3. In parallel, run Buck's cell audit and its streaming target dump with target
   hashes, inputs, dependencies, package records, and Buck-reported import
   edges. The dump is parsed as it streams rather than accumulated in memory.
4. Seed impact from added/removed/hash-changed targets, changed inputs, BUILD
   and inherited PACKAGE files, transitive Buck-reported imports, and CI annotations.
5. Walk head-graph reverse dependencies (including `ci_deps`) and emit only
   targets which still exist at the head revision.

Cell-qualified Buck paths are mapped through `buck2 audit cell` separately in
each workspace; the tool never assumes that stripping `cell//` yields a JJ
path. Configuration changes select the whole requested head universe. New Buck
graph errors, malformed JSON, bad revsets, and changed packages with existing
graph errors fail closed instead of returning an incomplete target set.

Temporary workspaces live in the platform temporary directory rather than the
repository. Each checkout is created inside a race-safe private container. A
temporary base inside the source repository is rejected. Workspaces and their
containers are forgotten and removed even on errors; `--keep-workspaces`
retains them for diagnosis. A tdutil process killed outright cannot run that
cleanup, so each run also sweeps workspace registrations left by tdutil
processes which are provably dead. The repository's `.buckconfig.local`, when
present, is snapshotted once and installed mode 0600 in each private checkout
before its Buck daemon starts. Retained diagnostic workspaces therefore retain
that snapshot too. Extra Buck configuration must describe both graphs, so pass
it with `--config KEY=VALUE` or repeat `--buck-arg`.

A head queried in place reads the live working copy, including its live
`.buckconfig.local`. Edits made to the tree or that file while tdutil runs
land in the head graph, exactly as they would in any local build; pass
`--no-head-in-place` when even that must be pinned.

Graph collection dominates runtime. Base and head queries run concurrently,
and the detector avoids materialization entirely when the JJ tree diff is empty.
