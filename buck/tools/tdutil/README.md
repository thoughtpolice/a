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

That compares `fork_point(trunk() | @)` against `@` over the whole of the
repository's root cell — `depot//...` here. The fork point's own changes are
excluded, while all descendant changes through the working copy are included.
Target patterns can be supplied without spelling the default revisions:

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
directly. `--format json` emits revision metadata, rule types, and root-cause
information. Each target record has this stable shape:

```json
{
  "target": "depot//app:test",
  "rule_type": "prelude//rules.bzl:rust_test",
  "depth": 1,
  "reason": "input `app/lib.rs` changed",
  "affected_dep": "depot//app:lib"
}
```

Roots have depth zero and a null `affected_dep`. `--format json-lines` emits one
such record per target. Run with `--help` for all options.

## Quick mode

`--quick` answers "what should I test before pushing?" at interactive speed by
consulting only the working-copy graph — no temporary workspaces, one Buck
query against the repository's own warm daemon:

```console
$ buck2 run root//buck/tools/tdutil:tdutil -- --quick
```

The base revset still chooses which diff is analyzed, but its graph is never
built, so the head revision must match the working-copy tree. Quick
mode seeds from changed inputs, BUILD and PACKAGE files, transitive
Buck-reported imports, CI annotations, and configuration files, and it
propagates through the same reverse-dependency, `ci_deps`, and
`ci_srcs_must_match` machinery with the same fail-closed universe checks as
the full protocol. Without a base graph it cannot see
dependents of targets that were removed, and it cannot compare target hashes,
so a macro edit selects every package importing the macro instead of only the
targets whose definitions actually changed. CI keeps the two-snapshot
protocol; quick mode is for the inner development loop.

## Base snapshot caching

The base endpoint of the two-snapshot protocol is deterministic for a given
commit, universe, configuration, and buck2 build, so it can be captured once
and reused:

```console
$ buck2 run root//buck/tools/tdutil:tdutil -- --snapshot-to base.json
$ buck2 run root//buck/tools/tdutil:tdutil -- --base-snapshot base.json
```

`--snapshot-to` collects the head revision's graph — in place when it matches
the working-copy tree, in a temporary workspace otherwise — and writes a
self-describing document: a schema number, the tdutil version, the exact buck2
version, the host platform, the commit, the universe patterns, the Buck
configuration arguments, a digest of `.buckconfig.local`, and the whole graph
in workspace-independent form.

The platform is recorded because Starlark reads `host_info()` at load time —
toolchain, platform, and OCI definitions all branch on it — so the
unconfigured graph differs between hosts even though
`--show-unconfigured-target-hash` is otherwise host-independent. Without it a
document collected on one platform would satisfy every other check and stand
in for a base it does not describe.

The recorded tdutil version is a monotonic counter rather than a semantic
version, because a document's contents depend on tdutil's own behavior — which
attributes it asks buck2 for, how it derives repository paths — and none of
that is otherwise observable in the document. Increment `tdutilVersion`
whenever a change would make an older snapshot describe the graph differently
than a fresh collection would. Doing so invalidates every existing snapshot,
which costs one cold collection and is always the safe direction.

The document is written gzip-compressed and is streamed in both directions
rather than buffered whole: a graph dump is the largest artifact tdutil
handles, and this shape of JSON — every label sharing a long prefix with its
neighbours — compresses by better than ten to one. Documents written before
compression are plain JSON and are still read, because the encoding is
detected rather than assumed.

`--base-snapshot` reuses such a document as the base endpoint when every
recorded input matches the requested comparison; any mismatch is reported and
the run falls back to full collection, so a stale or missing snapshot can
slow a run down but never change its answer. With a matching snapshot the
full protocol applies unchanged — deleted-target dependents and hash
comparison behave exactly as with a materialized base.

`--snapshot-to` is a standalone capture: it collects a graph and exits. A run
which is already determining targets has collected the head graph anyway, so
`--snapshot-head-to` records that graph instead of collecting a second one:

```console
$ buck2 run root//buck/tools/tdutil:tdutil -- \
    --base-snapshot base.json --snapshot-head-to next.json
```

Refreshing a snapshot that way costs only the serialization. The determined
targets are the run's deliverable and a snapshot is only a cache, so a capture
which cannot be written is reported on stderr and the run continues; this is
the same bargain `--base-snapshot` makes in the other direction, where a
snapshot may cost time but never correctness. One case is declined rather than
written: a head graph collected over fewer patterns than were requested —
which happens when a universe pattern exists at the base revision but not at
head — since `--base-snapshot` treats a document's universe as proof that
capture queried all of it.

In CI the snapshots ride the GitHub Actions cache: pushes to the main branch
record the trunk graph the determination run already collected, keyed by
commit, and pull-request runs restore the snapshot for their base commit,
skipping base materialization and its cold daemon whenever the cache hits.

The command snapshots the current JJ working copy by default, so `@` includes
edits that have not yet been observed by another JJ command. Use
`--ignore-working-copy` only when stale working-copy state is intentional.

## Snapshot caches

`--base-snapshot` and `--snapshot-head-to` name exact files. `--cache` instead
names a place to keep them and lets tdutil work out the rest:

```console
$ buck2 run root//buck/tools/tdutil:tdutil -- --cache ~/.cache/tdutil --cache-write
```

Keys are derived rather than supplied. A snapshot's contents depend on the
buck2 version, the universe patterns, the Buck configuration arguments, the
`.buckconfig.local` digest, and the host platform — exactly what a reader
checks before reusing a document — so those are hashed into the key and the
object lands at
`<prefix>/v<schema>-<tdutilVersion>/<identity>/<commit>.json.gz`. Nothing about
the cache needs naming, and no caller has to rediscover which facts make a
snapshot valid. Every field is written length-prefixed when hashed, so
`-c x=1` and `-cx=1` cannot collide into a key that stays permanently cold.

A fetched document is still validated against that identity. A key is evidence,
not proof, and the fallback is the same one every other snapshot failure takes.

Reads are automatic; writes are opt-in behind `--cache-write`. The asymmetry is
real rather than cautious: on the GitHub Actions cache a write from a
pull-request run is scoped to that pull request's ref and nobody else will ever
read it, and an object store has no ref scoping at all, so a developer writing
from a local branch would store graphs keyed by working-copy commits that
change on every `jj` snapshot and that no later run will request.

`--cache-write` stores two things. The head graph the run collected is the
obvious one. The other is the base graph, when the cache missed and the run had
to collect it anyway — and that one is what makes repeated local runs pay off,
because the base revset `fork_point(trunk() | @)` is stable across runs while
`@` is not. Without it the second run misses exactly as the first did; with it
the second run skips base materialization and its cold daemon entirely. Both
are declined when the graph covers fewer patterns than were requested, for the
same reason `--snapshot-head-to` declines: `--base-snapshot` treats a
document's universe as proof that capture queried all of it.

### Backends

A location containing `://` is a URL dispatched on its scheme; anything else is
a local directory, so the common local case needs no `file://` ceremony.

`s3://BUCKET/PREFIX` speaks S3 with hand-rolled SigV4, since every Go tool here
is built from the standard library alone. It uses two verbs — `GET` and `PUT` —
so the bucket policy it needs is `s3:GetObject` and `s3:PutObject` and nothing
else. With no `ListBucket` and no `DeleteObject` it is structurally incapable of
removing anything.

`AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL` points that same implementation at
GCS's XML API, R2, MinIO, or any other S3-compatible store. Addressing follows
the endpoint: virtual-host style for AWS, where path-style is on its way out for
new buckets, and path-style everywhere else, which is what MinIO requires.

Credentials come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_SESSION_TOKEN`, and from nowhere else. That covers CI, where
`aws-actions/configure-aws-credentials` exports precisely those, and local use
via `aws configure export-credentials --format env`. The region is
`AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`.

Retention belongs to whoever owns the storage. A bucket wants a lifecycle
expiration rule. A cache directory has no such service behind it, so it prunes
objects past `--cache-max-age` (default 14 days) on write, sweeping the whole
tree rather than one directory so that identities retired wholesale by a buck2
upgrade are collected too.

### When it goes wrong

A location that cannot work is fatal: an unknown scheme, a malformed URL,
absent credentials. These are deterministic properties of the invocation which
no retry can fix, and reporting them as warnings would leave a run quietly
paying full collection forever with nothing to say why.

Everything else is a warning and a fallback to full collection — a miss, a
refusal, a timeout, a truncated body, a document whose recorded inputs do not
match. Writes never fail a run at all, which is the bargain the local capture
already makes. A cold cache is reported only under `--verbose`, because a cache
nobody has written to yet is an ordinary first run rather than a fault;
anything else is reported unconditionally, because it is one. `--verbose` also
prints the derived key, which is the only way to answer "why did it miss?" once
tdutil owns the key.

Each operation is bounded by `--cache-timeout` (default 60s), retries twice on
connection errors and 5xx within that bound, and never retries a 4xx. The bound
is not arbitrary: falling back costs one base collection, so waiting longer for
a download than the fallback would take is never the better trade.

## Configuration

tdutil reads the repository's conventions from buckconfig rather than assuming
this repository's. Every key is optional; the defaults below are what an
unconfigured repository gets.

```ini
[tdutil]
# Repository-relative paths, comma separated, whose modification reconfigures
# the whole graph and so selects every target. Buck's own well-known names —
# .buckroot, *.buckconfig, *.bcfg, *.buckargs, .buckconfig.d/, buckconfigs/ —
# are always recognized; this is for whatever else a repository keeps its build
# modes or argument files in. Default: none.
global_config_paths = buck/mode

# Names of the CI metadata attributes and label. Default: as written here.
ci_srcs_attribute = ci_srcs
ci_srcs_must_match_attribute = ci_srcs_must_match
ci_deps_attribute = ci_deps
ci_hint_rule = ci_hint
skip_upstream_label = ci:dangerously_skip_upstream
```

The section is read from the cell rooted at the repository root, which is also
the cell whose name supplies the default universe: with no `--universe`, tdutil
determines over all of `<root cell>//...`.

Build file names are not configured here — they come from each cell's own
`buildfile.name` / `buildfile.name_v2`, resolved with buck2's precedence
(`name_v2` verbatim, otherwise each `name` entry preceded by its `.v2` sibling,
otherwise `BUCK.v2, BUCK`) and per cell, so a repository whose vendored cell
spells its build files differently is still read correctly. `PACKAGE` files are
`PACKAGE` and `BUCK_TREE`, which buck2 does not make configurable.

Getting these wrong under-selects silently — a build file tdutil does not
recognize is a file whose package never gets dirtied — so they are folded into
the snapshot cache identity. A document collected under different conventions
is rejected rather than reused.

## Algorithm and correctness

0. Read the cell layout and the `[tdutil]` section from the invoking working
   copy. Both endpoints are interpreted through it, which is sound because a
   diff that changes buckconfig is itself a global configuration change.
1. Resolve both revsets to exactly one commit and compute their tree diff.
2. Materialize the base tree in a real temporary JJ workspace. The head tree
   is materialized the same way only when its tree differs from the working
   copy; when they match — including a colocated CI checkout whose working
   copy is an empty commit atop the pinned head — the head graph is queried
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
path. Configuration changes select the whole requested head universe.
Malformed JSON, bad revsets, and Buck graph errors all fail closed instead of
returning an incomplete target set; see below.

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

## Graph errors

tdutil collects without `--keep-going`, so a package which fails to load aborts
the query and the run. There is no policy and no partial graph: buck2 reports
the error, tdutil reports buck2, and the caller falls back to whatever it does
when no target list arrives — for CI, testing the universe outright, which is a
superset of any selection and is what surfaces the breakage.

That holds at either endpoint, and whether or not the diff touched the broken
package. A predecessor which does not parse is as fatal as a head which does
not, because the comparison needs both. This is stricter than it used to be:
earlier versions tolerated a pre-existing breakage the diff steered clear of,
and could name every head target when only the predecessor was broken. Both
now fail, which costs a full test run until the package is fixed.

The upside is that nothing reads buck2's diagnostic prose. Recognizing an
expected endpoint diagnostic used to mean matching buck2's exact wording,
including its underline art, which pinned tdutil to a buck2 version with no
signal on drift beyond a confusing refusal. Absent packages are now handled
before the query instead: `planUniverse` stats each pattern's package directory
at both endpoints and only queries it where it exists, so adding or removing a
package is ordinary rather than an error to be excused.
