# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Resolve a set of Wolfi packages to a pinned, closed .bzl lock.

update.py refreshes pins that already exist. This tool decides which pins
should exist: given a list of root packages, it walks their dependencies
through the repository's APKINDEX, the way apk's solver would, and writes
every package the closure needs, with its version and sha256, as a .bzl
file that BUILD loads.

    buck2 run third-party//by-name/wo/wolfi:resolve -- \\
        --roots src/images/devcontainer/packages.txt \\
        --name DEVCONTAINER \\
        --out buck/third-party/by-name/wo/wolfi/devcontainer.bzl

Run it from the repository root, since relative paths resolve against the
working directory. Packages BUILD already pins stay at their pinned
version and keep their BUILD targets; the lock lists them in the closure
but declares only the ones it adds, so every Wolfi package keeps exactly
one target and one version, which the osv.dev check relies on. A package
built from the same origin as one already chosen takes that package's
version, so glibc-2.44-dev follows the pinned glibc-2.44 rather than the
newest build. Anything else takes the newest build.

The resolver is greedy, like the repository it reads: Wolfi rebuilds
everything against the newest libraries, so a dependency's newest
provider satisfies it nearly always. Every version constraint and
conflict is checked over the finished set, and one that fails is an
error naming the packages involved, not a silent pick. Rerun the
resolver after update.py bumps BUILD, since a bump there can change
which packages the closure needs.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import gzip
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile
from typing import Iterable, TextIO

import update


DEFAULT_PINNED = Path("buck/third-party/by-name/wo/wolfi/BUILD")

_DEP_RE = re.compile(r"^(?P<name>[^<>=~!]+)(?:(?P<op>>=|<=|=|>|<|~)(?P<version>.+))?$")
_VERSION_RE = re.compile(
    r"^(?P<numbers>\d+(?:\.\d+)*)(?P<letter>[a-z]?)"
    r"(?P<suffixes>(?:_(?:alpha|beta|pre|rc|cvs|svn|git|hg|p)\d*)*)"
    r"(?:~[0-9a-f]+)?(?:-r(?P<release>\d+))?$"
)
_SUFFIX_RE = re.compile(r"_(alpha|beta|pre|rc|cvs|svn|git|hg|p)(\d*)")
# apk orders pre-release suffixes below a bare version and the rest above it.
_SUFFIX_RANK = {
    "alpha": -4, "beta": -3, "pre": -2, "rc": -1,
    "cvs": 1, "svn": 2, "git": 3, "hg": 4, "p": 5,
}


class ResolveError(Exception):
    """A user-actionable resolution failure."""


def version_key(version: str) -> tuple:
    """An ordering key for apk version strings."""
    match = _VERSION_RE.fullmatch(version)
    if match is None:
        raise ResolveError(f"unsupported apk version {version!r}")
    numbers = tuple(int(part) for part in match.group("numbers").split("."))
    suffixes = tuple(
        (_SUFFIX_RANK[kind], int(number or 0))
        for kind, number in _SUFFIX_RE.findall(match.group("suffixes"))
    )
    # A bare version sorts between the pre-release and post-release
    # suffixes, which a (0, 0) sentinel encodes.
    return (numbers, match.group("letter"), suffixes + ((0, 0),), int(match.group("release") or 0))


def satisfies(version: str | None, op: str | None, wanted: str | None) -> bool:
    if op is None:
        return True
    if version is None:
        return False
    if op == "~":
        return version == wanted or version.startswith(wanted + ".") or version.startswith(wanted + "-")
    have, want = version_key(version), version_key(wanted)
    return {
        "=": have == want,
        ">=": have >= want,
        "<=": have <= want,
        ">": have > want,
        "<": have < want,
    }[op]


@dataclasses.dataclass(frozen=True)
class Dependency:
    name: str
    op: str | None
    version: str | None
    conflict: bool

    @classmethod
    def parse(cls, token: str) -> "Dependency":
        conflict = token.startswith("!")
        match = _DEP_RE.fullmatch(token.removeprefix("!"))
        if match is None:
            raise ResolveError(f"unsupported dependency {token!r}")
        return cls(match.group("name"), match.group("op"), match.group("version"), conflict)

    def __str__(self) -> str:
        text = self.name + (f"{self.op}{self.version}" if self.op else "")
        return "!" + text if self.conflict else text


@dataclasses.dataclass(frozen=True)
class Record:
    name: str
    version: str
    size: int
    timestamp: int
    origin: str
    priority: int
    depends: tuple[Dependency, ...]
    # Every name this record answers to: its own at its version, and each
    # provides entry, at its version if it gives one.
    provides: dict[str, str | None]

    def answers(self, dependency: Dependency) -> bool:
        if dependency.name not in self.provides:
            return False
        return satisfies(self.provides[dependency.name], dependency.op, dependency.version)


@dataclasses.dataclass
class Index:
    by_name: dict[str, list[Record]]
    # The package names any build of which provides a name.
    providers: dict[str, set[str]]

    def newest(self, name: str) -> Record:
        return max(self.by_name[name], key=lambda record: record.timestamp)

    def build(self, name: str, version: str) -> Record | None:
        for record in self.by_name.get(name, ()):
            if record.version == version:
                return record
        return None


def _record(fields: dict[str, str]) -> Record:
    name, version = fields["P"], fields["V"]
    provides: dict[str, str | None] = {name: version}
    for token in fields.get("p", "").split():
        provided, _, provided_version = token.partition("=")
        provides.setdefault(provided, provided_version or None)
    return Record(
        name=name,
        version=version,
        size=int(fields["S"]),
        timestamp=int(fields["t"]),
        origin=fields.get("o", name),
        priority=int(fields.get("k", "0") or 0),
        depends=tuple(Dependency.parse(token) for token in fields.get("D", "").split()),
        provides=provides,
    )


def parse_index(lines: Iterable[bytes]) -> Index:
    by_name: dict[str, list[Record]] = {}
    providers: dict[str, set[str]] = {}
    fields: dict[str, str] = {}

    def finish() -> None:
        if not fields:
            return
        missing = [key for key in "PVSt" if key not in fields]
        if missing:
            raise ResolveError(f"APKINDEX record {fields.get('P')!r} lacks {', '.join(missing)}")
        record = _record(fields)
        by_name.setdefault(record.name, []).append(record)
        for provided in record.provides:
            providers.setdefault(provided, set()).add(record.name)
        fields.clear()

    for raw in lines:
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            finish()
            continue
        key, _, value = line.partition(":")
        fields[key] = value
    finish()
    return Index(by_name, providers)


def fetch_index(repository: str, timeout: float) -> Index:
    url = repository + "/APKINDEX.tar.gz"
    response = update._open_url(url, timeout)
    with response, gzip.GzipFile(fileobj=response, mode="rb") as stream:
        with tarfile.open(fileobj=stream, mode="r|") as archive:
            for member in archive:
                if member.name == "APKINDEX" and member.isfile():
                    extracted = archive.extractfile(member)
                    assert extracted is not None
                    return parse_index(extracted)
    raise ResolveError(f"{url} has no APKINDEX member")


def read_roots(path: Path) -> list[tuple[str, str | None]]:
    """Root packages, each `name` or `name=version` for an exact build."""
    roots = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            name, _, version = line.partition("=")
            roots.append((name, version or None))
    if not roots:
        raise ResolveError(f"{path}: lists no packages")
    if len({name for name, _ in roots}) != len(roots):
        raise ResolveError(f"{path}: lists a package twice")
    return roots


class Resolver:
    def __init__(self, index: Index, pinned: dict[str, str]):
        self.index = index
        self.pinned = pinned
        self.selected: dict[str, Record] = {}
        # Who first pulled each package in, for error messages.
        self.reason: dict[str, str] = {}

    def _origins(self) -> dict[str, str]:
        chosen = {}
        for name, version in self.pinned.items():
            record = self.index.build(name, version)
            if record is not None:
                chosen.setdefault(record.origin, version)
        for record in self.selected.values():
            chosen.setdefault(record.origin, record.version)
        return chosen

    def choose(self, name: str) -> Record:
        """The build of `name` to install, before any constraint is checked."""
        if name not in self.index.by_name:
            raise ResolveError(f"Wolfi has no package {name!r}")
        if name in self.pinned:
            record = self.index.build(name, self.pinned[name])
            if record is None:
                raise ResolveError(
                    f"BUILD pins {name} {self.pinned[name]}, which APKINDEX no longer lists"
                )
            return record
        newest = self.index.newest(name)
        coherent = self._origins().get(newest.origin)
        if coherent is not None:
            record = self.index.build(name, coherent)
            if record is not None:
                return record
        return newest

    def _conflicts(self, record: Record) -> bool:
        for other in self.selected.values():
            for dependency in other.depends:
                if dependency.conflict and record.answers(dependency):
                    return True
            for dependency in record.depends:
                if dependency.conflict and other.answers(dependency):
                    return True
        return False

    def _add(self, record: Record, reason: str) -> None:
        self.selected[record.name] = record
        self.reason[record.name] = reason

    def _satisfy(self, dependency: Dependency, wanted_by: str) -> Record | None:
        for record in self.selected.values():
            if record.answers(dependency):
                return None
        names = set(self.index.providers.get(dependency.name, ()))
        if not names:
            raise ResolveError(f"nothing in Wolfi provides {dependency} (needed by {wanted_by})")

        def preference(name: str) -> tuple:
            record = self.choose(name)
            return (
                name not in self.pinned,
                # A real package of that name before a virtual provider.
                name != dependency.name,
                -record.priority,
                name,
            )

        for name in sorted(names, key=preference):
            if name in self.selected:
                # Selected at a build that doesn't satisfy the constraint;
                # the final check reports it.
                continue
            record = self.choose(name)
            if record.answers(dependency) and not self._conflicts(record):
                return record
            if name in self.pinned:
                continue
            # An exact constraint such as libLLVM-23=23.1.4-r1 can name an
            # older build than the one choose() prefers.
            for older in sorted(self.index.by_name[name], key=lambda r: -r.timestamp):
                if older.answers(dependency) and not self._conflicts(older):
                    return older
        hint = ""
        if names & self.pinned.keys():
            hint = "; BUILD pins some of them, so run :update first if a pin is stale"
        raise ResolveError(
            f"no provider of {dependency} (needed by {wanted_by}) fits: "
            f"candidates were {', '.join(sorted(names))}{hint}"
        )

    def resolve(self, roots: list[str | tuple[str, str | None]]) -> list[Record]:
        # Seed every root first, so a root that provides a virtual name
        # (glibc-2.44-dev provides glibc-dev) wins over the package of that
        # name when another root depends on it.
        queue = []
        for root in roots:
            name, version = (root, None) if isinstance(root, str) else root
            if version is None:
                record = self.choose(name)
            else:
                if name in self.pinned and self.pinned[name] != version:
                    raise ResolveError(
                        f"the roots want {name} {version}, but BUILD pins {self.pinned[name]}"
                    )
                record = self.index.build(name, version)
                if record is None:
                    raise ResolveError(f"APKINDEX has no build {name} {version}")
            self._add(record, "a root")
            queue.append(record)
        while queue:
            record = queue.pop(0)
            for dependency in record.depends:
                if dependency.conflict:
                    continue
                chosen = self._satisfy(dependency, record.name)
                if chosen is not None:
                    self._add(chosen, record.name)
                    queue.append(chosen)
        self._check()
        return self._ordered()

    def _check(self) -> None:
        problems = []
        for record in self.selected.values():
            for dependency in record.depends:
                answered = [other for other in self.selected.values() if other.answers(dependency)]
                if dependency.conflict and answered:
                    problems.append(
                        f"{record.name} {record.version} conflicts with "
                        + ", ".join(f"{other.name} {other.version}" for other in answered)
                    )
                elif not dependency.conflict and not answered:
                    problems.append(f"{record.name} {record.version} needs {dependency}, which nothing chosen satisfies")
        if problems:
            raise ResolveError(
                "the resolved set is inconsistent; if BUILD pins are involved, "
                "run :update first:\n  - " + "\n  - ".join(sorted(problems))
            )

    def _ordered(self) -> list[Record]:
        """Dependencies before their dependents, ties by name."""
        edges: dict[str, set[str]] = {name: set() for name in self.selected}
        for record in self.selected.values():
            for dependency in record.depends:
                if dependency.conflict:
                    continue
                for other in self.selected.values():
                    if other.name != record.name and other.answers(dependency):
                        edges[record.name].add(other.name)
        ordered: list[Record] = []
        done: set[str] = set()
        visiting: set[str] = set()

        def visit(name: str) -> None:
            if name in done or name in visiting:
                # A dependency cycle; break it where it closes.
                return
            visiting.add(name)
            for dependency in sorted(edges[name]):
                visit(dependency)
            visiting.discard(name)
            done.add(name)
            ordered.append(self.selected[name])

        for name in sorted(self.selected):
            visit(name)
        return ordered


# update.PIN_RE's names are lower-case, as BUILD's are, but Wolfi has names
# such as libLLVM-23 too.
_LOCK_PIN_RE = re.compile(r'^    "(?P<name>[A-Za-z0-9][A-Za-z0-9+_.-]*)": \("(?P<version>[^"]+)", "(?P<sha256>[0-9a-f]{64})"\),$')


def read_lock(path: Path) -> dict[tuple[str, str], str]:
    """The hashes an existing lock already records, keyed by (name, version)."""
    if not path.exists():
        return {}
    hashes = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _LOCK_PIN_RE.fullmatch(line)
        if match:
            hashes[(match.group("name"), match.group("version"))] = match.group("sha256")
    return hashes


def render(name: str, roots_path: Path, ordered: list[Record], pinned: set[str],
           hashes: dict[tuple[str, str], str]) -> str:
    lines = [
        "# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp",
        "# SPDX-License-Identifier: Apache-2.0",
        "",
        f"# @generated by resolve.py from {roots_path.as_posix()}; do not edit.",
        "# Regenerate it with the command in resolve.py's docstring.",
        "",
        f"# The Wolfi packages {name}_CLOSURE needs that BUILD doesn't already",
        "# pin: {package: (version, sha256 of the .apk)}.",
        f"{name} = {{",
    ]
    for record in sorted(ordered, key=lambda record: record.name):
        if record.name in pinned:
            continue
        sha256 = hashes[(record.name, record.version)]
        lines.append(f'    "{record.name}": ("{record.version}", "{sha256}"),')
    lines += [
        "}",
        "",
        "# Every package to install, BUILD's pins included, with each package",
        "# after the ones it depends on.",
        f"{name}_CLOSURE = [",
    ]
    lines += [f'    "{record.name}",' for record in ordered]
    lines += ["]", ""]
    return "\n".join(lines)


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--roots", required=True, type=Path,
                        help="file listing root packages, one per line, # comments")
    parser.add_argument("--name", required=True,
                        help="Starlark name of the generated pin dict, e.g. DEVCONTAINER")
    parser.add_argument("--out", required=True, type=Path, help="the .bzl lock to write")
    parser.add_argument("--pinned", type=Path, default=DEFAULT_PINNED,
                        help=f"BUILD file whose pins stay fixed (default: {DEFAULT_PINNED})")
    parser.add_argument("--repository", default=update.DEFAULT_REPOSITORY)
    parser.add_argument("--jobs", type=int, default=update.DEFAULT_JOBS)
    parser.add_argument("--timeout", type=float, default=update.DEFAULT_TIMEOUT)
    return parser


def run(args: argparse.Namespace, stdout: TextIO) -> int:
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", args.name):
        raise ResolveError(f"--name must be an upper-case Starlark identifier, got {args.name!r}")
    roots = read_roots(args.roots)
    pinned_document = update.parse_build_file(args.pinned)
    pinned = {pin.name: pin.version for pin in pinned_document.pins.values()}
    index = fetch_index(args.repository, args.timeout)
    ordered = Resolver(index, pinned).resolve(roots)

    hashes = read_lock(args.out)
    hashes.update({(pin.name, pin.version): pin.sha256 for pin in pinned_document.pins.values()})
    missing = [record for record in ordered if (record.name, record.version) not in hashes]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {
            pool.submit(
                update.hash_package,
                args.repository,
                update.IndexRecord(record.name, record.version, record.size, record.timestamp),
                args.timeout,
            ): record
            for record in missing
        }
        for future in concurrent.futures.as_completed(futures):
            record = futures[future]
            hashes[(record.name, record.version)] = future.result()

    text = render(args.name, args.roots, ordered, set(pinned), hashes)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=args.out.parent, delete=False,
                                     encoding="utf-8") as staged:
        staged.write(text)
    os.replace(staged.name, args.out)
    added = sum(1 for record in ordered if record.name not in pinned)
    print(
        f"Resolved {len(roots)} root(s) to {len(ordered)} package(s), "
        f"{added} beyond BUILD's pins; hashed {len(missing)}. Wrote {args.out}.",
        file=stdout,
    )
    return 0


def main(argv: list[str] | None = None, stdout: TextIO = sys.stdout,
         stderr: TextIO = sys.stderr) -> int:
    args = make_parser().parse_args(argv)
    try:
        return run(args, stdout)
    except (ResolveError, update.UpdateError) as error:
        print(f"ERROR: {error}", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
