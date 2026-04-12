# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Refresh pinned Wolfi APK versions and hashes from APKINDEX.

The repository's HTTPS transport authenticates the index and package bodies;
this tool does not independently verify the APKINDEX signature. Historical
records are ordered by publication timestamp, so an intentional repository
rollback is followed just like a rebuild.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import gzip
import hashlib
import math
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import tempfile
from typing import BinaryIO, TextIO
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BUILD_FILE = Path("buck/third-party/by-name/wo/wolfi/BUILD")
DEFAULT_REPOSITORY = "https://packages.wolfi.dev/os/x86_64"
DEFAULT_JOBS = 8
DEFAULT_TIMEOUT = 60.0
CHUNK_SIZE = 1024 * 1024
MAX_INDEX_MEMBER_SIZE = 256 * 1024 * 1024

_NAME = r"[a-z0-9][a-z0-9+_.-]*"
_VERSION = r"[A-Za-z0-9][A-Za-z0-9+_.~-]*"
PIN_CANDIDATE_RE = re.compile(r'^[ \t]+"[^"\r\n]+"[ \t]*:')
PIN_RE = re.compile(
    rf'^(?P<before>[ \t]+)"(?P<name>{_NAME})": \("'
    rf'(?P<version>{_VERSION})(?P<between>", ")'
    r'(?P<sha256>[0-9a-f]{64})(?P<after>"\),)(?P<newline>\r?\n)?$'
)


class UpdateError(Exception):
    """A user-actionable updater failure."""


@dataclasses.dataclass(frozen=True)
class Pin:
    name: str
    version: str
    sha256: str
    line_index: int


@dataclasses.dataclass(frozen=True)
class BuildDocument:
    original: bytes
    lines: tuple[str, ...]
    pins: dict[str, Pin]


@dataclasses.dataclass(frozen=True)
class IndexRecord:
    name: str
    version: str
    size: int
    timestamp: int


@dataclasses.dataclass(frozen=True)
class Update:
    pin: Pin
    record: IndexRecord
    sha256: str | None = None


def parse_build_file(path: Path) -> BuildDocument:
    try:
        original = path.read_bytes()
    except OSError as error:
        raise UpdateError(f"read {path}: {error}") from error
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError as error:
        raise UpdateError(f"{path} is not valid UTF-8: {error}") from error

    lines = tuple(text.splitlines(keepends=True))
    pins: dict[str, Pin] = {}
    for line_index, line in enumerate(lines):
        if not PIN_CANDIDATE_RE.match(line):
            continue
        match = PIN_RE.fullmatch(line)
        if match is None:
            raise UpdateError(
                f"{path}:{line_index + 1}: malformed Wolfi pin; expected "
                '    "package": ("version", "64-digit-lowercase-sha256"),'
            )
        name = match.group("name")
        if name in pins:
            previous = pins[name]
            raise UpdateError(
                f"{path}:{line_index + 1}: duplicate pin {name!r} "
                f"(first declared on line {previous.line_index + 1})"
            )
        pins[name] = Pin(
            name=name,
            version=match.group("version"),
            sha256=match.group("sha256"),
            line_index=line_index,
        )
    if not pins:
        raise UpdateError(f"{path}: found no Wolfi pins")
    return BuildDocument(original=original, lines=lines, pins=pins)


def _finish_record(
    fields: dict[str, str],
    wanted: set[str],
    newest: dict[str, IndexRecord],
) -> None:
    name = fields.get("P")
    if name not in wanted:
        return

    missing = [field for field in ("V", "S", "t") if field not in fields]
    if missing:
        raise UpdateError(
            f"APKINDEX record for {name!r} is missing {', '.join(missing)}"
        )
    version = fields["V"]
    if not re.fullmatch(_VERSION, version):
        raise UpdateError(
            f"APKINDEX record for {name!r} has invalid version {version!r}"
        )
    try:
        size = int(fields["S"], 10)
    except ValueError as error:
        raise UpdateError(
            f"APKINDEX record for {name!r} has invalid size {fields['S']!r}"
        ) from error
    if size < 0 or str(size) != fields["S"]:
        raise UpdateError(
            f"APKINDEX record for {name!r} has invalid size {fields['S']!r}"
        )
    try:
        timestamp = int(fields["t"], 10)
    except ValueError as error:
        raise UpdateError(
            f"APKINDEX record for {name!r} has invalid timestamp {fields['t']!r}"
        ) from error
    if timestamp < 0 or str(timestamp) != fields["t"]:
        raise UpdateError(
            f"APKINDEX record for {name!r} has invalid timestamp "
            f"{fields['t']!r}"
        )

    candidate = IndexRecord(
        name=name,
        version=version,
        size=size,
        timestamp=timestamp,
    )
    current = newest.get(name)
    # Wolfi's index retains history. Publication time, rather than lexical or
    # approximate semver ordering, identifies the repository's current build
    # and deliberately follows a published rollback.
    if current is None or candidate.timestamp > current.timestamp:
        newest[name] = candidate
        return
    if candidate.timestamp != current.timestamp:
        return
    if candidate.version != current.version:
        versions = sorted((current.version, candidate.version))
        raise UpdateError(
            f"APKINDEX has conflicting versions for {name!r} at timestamp "
            f"{timestamp}: {versions[0]!r} and {versions[1]!r}"
        )
    if candidate.size != current.size:
        sizes = sorted((current.size, candidate.size))
        raise UpdateError(
            f"APKINDEX has conflicting sizes for {name!r} version "
            f"{candidate.version!r} at timestamp {timestamp}: "
            f"{sizes[0]} and {sizes[1]}"
        )


def parse_index(stream: BinaryIO, wanted: set[str]) -> dict[str, IndexRecord]:
    newest: dict[str, IndexRecord] = {}
    fields: dict[str, str] = {}
    for line_number, raw_line in enumerate(stream, 1):
        try:
            line = raw_line.decode("utf-8").rstrip("\r\n")
        except UnicodeDecodeError as error:
            raise UpdateError(
                f"APKINDEX:{line_number}: invalid UTF-8: {error}"
            ) from error
        if not line:
            if fields:
                _finish_record(fields, wanted, newest)
                fields = {}
            continue
        key, separator, value = line.partition(":")
        if not separator or len(key) != 1:
            raise UpdateError(f"APKINDEX:{line_number}: malformed field {line!r}")
        if key in {"P", "V", "S", "t"}:
            if key in fields:
                raise UpdateError(
                    f"APKINDEX:{line_number}: duplicate {key!r} field"
                )
            fields[key] = value
    if fields:
        _finish_record(fields, wanted, newest)

    missing = sorted(wanted - newest.keys())
    if missing:
        raise UpdateError(
            "APKINDEX does not contain pinned package(s): " + ", ".join(missing)
        )
    return newest


def _request(url: str) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        headers={"User-Agent": "depot-wolfi-updater/1"},
    )


def _open_url(url: str, timeout: float):
    try:
        response = urllib.request.urlopen(_request(url), timeout=timeout)
    except (OSError, urllib.error.URLError) as error:
        raise UpdateError(f"fetch {url}: {error}") from error
    original = urllib.parse.urlsplit(url)
    final = urllib.parse.urlsplit(response.geturl())
    if original.scheme == "https" and final.scheme != "https":
        response.close()
        raise UpdateError(f"fetch {url}: refused redirect to non-HTTPS URL")
    return response


def fetch_index(
    repository: str,
    wanted: set[str],
    timeout: float,
) -> dict[str, IndexRecord]:
    url = repository + "/APKINDEX.tar.gz"
    response = _open_url(url, timeout)

    found = False
    try:
        with response:
            # APK repositories may concatenate gzip streams (the signature is
            # commonly its own stream). gzip.GzipFile handles that framing;
            # tarfile's r|gz streaming mode stops after the first gzip stream.
            with gzip.GzipFile(fileobj=response, mode="rb") as decompressed:
                with tarfile.open(fileobj=decompressed, mode="r|") as archive:
                    result: dict[str, IndexRecord] | None = None
                    for member in archive:
                        if member.name != "APKINDEX":
                            continue
                        if found:
                            raise UpdateError(
                                "APKINDEX.tar.gz contains more than one exact "
                                "APKINDEX member"
                            )
                        if not member.isfile():
                            raise UpdateError(
                                "APKINDEX.tar.gz member APKINDEX is not a regular file"
                            )
                        if member.size <= 0 or member.size > MAX_INDEX_MEMBER_SIZE:
                            raise UpdateError(
                                "APKINDEX.tar.gz member APKINDEX has unreasonable "
                                f"size {member.size}"
                            )
                        found = True
                        extracted = archive.extractfile(member)
                        if extracted is None:
                            raise UpdateError(
                                "could not read APKINDEX member from APKINDEX.tar.gz"
                            )
                        result = parse_index(extracted, wanted)
    except (OSError, tarfile.TarError, UnicodeError) as error:
        raise UpdateError(f"read {url}: {error}") from error
    if not found or result is None:
        raise UpdateError("APKINDEX.tar.gz does not contain an exact APKINDEX member")
    return result


def _package_url(repository: str, record: IndexRecord) -> str:
    filename = f"{record.name}-{record.version}.apk"
    return repository + "/" + urllib.parse.quote(filename, safe="+._-~")


def hash_package(
    repository: str,
    record: IndexRecord,
    timeout: float,
) -> str:
    url = _package_url(repository, record)
    response = _open_url(url, timeout)

    digest = hashlib.sha256()
    size = 0
    try:
        with response:
            while chunk := response.read(CHUNK_SIZE):
                size += len(chunk)
                if size > record.size:
                    raise UpdateError(
                        f"downloaded size for {record.name!r} "
                        f"{record.version!r} exceeds APKINDEX size "
                        f"{record.size}"
                    )
                digest.update(chunk)
    except OSError as error:
        raise UpdateError(f"read {url}: {error}") from error
    if size != record.size:
        raise UpdateError(
            f"downloaded size for {record.name!r} {record.version!r} is "
            f"{size}, APKINDEX says {record.size}"
        )
    return digest.hexdigest()


def find_updates(
    document: BuildDocument,
    index: dict[str, IndexRecord],
) -> list[Update]:
    return [
        Update(pin=pin, record=index[name])
        for name, pin in sorted(document.pins.items())
        if index[name].version != pin.version
    ]


def hash_updates(
    repository: str,
    updates: list[Update],
    jobs: int,
    timeout: float,
) -> list[Update]:
    if not updates:
        return []
    workers = min(jobs, len(updates))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            update.pin.name: executor.submit(
                hash_package,
                repository,
                update.record,
                timeout,
            )
            for update in updates
        }
        hashes: dict[str, str] = {}
        failures: list[str] = []
        for name in sorted(futures):
            try:
                hashes[name] = futures[name].result()
            except UpdateError as error:
                failures.append(str(error))
            except Exception as error:  # Defensive boundary around worker threads.
                failures.append(f"hash {name!r}: {error}")
    if failures:
        raise UpdateError("failed to hash package update(s):\n  - " + "\n  - ".join(failures))
    return [dataclasses.replace(update, sha256=hashes[update.pin.name]) for update in updates]


def render_build(document: BuildDocument, updates: list[Update]) -> bytes:
    by_name = {update.pin.name: update for update in updates}
    lines = list(document.lines)
    for name, update in sorted(by_name.items()):
        if update.sha256 is None:
            raise UpdateError(f"internal error: update for {name!r} has no SHA-256")
        line = lines[update.pin.line_index]
        match = PIN_RE.fullmatch(line)
        if match is None:
            raise UpdateError(
                f"internal error: pin line for {name!r} no longer parses"
            )
        lines[update.pin.line_index] = "".join(
            (
                match.group("before"),
                f'"{name}": ("',
                update.record.version,
                match.group("between"),
                update.sha256,
                match.group("after"),
                match.group("newline") or "",
            )
        )
    return "".join(lines).encode("utf-8")


def atomic_rewrite(path: Path, original: bytes, replacement: bytes) -> None:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError as error:
        raise UpdateError(f"stat {path}: {error}") from error

    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            dir=path.parent,
            prefix=f".{path.name}.wolfi-update-",
        )
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as output:
            output.write(replacement)
            output.flush()
            os.fsync(output.fileno())

        try:
            current = path.read_bytes()
        except OSError as error:
            raise UpdateError(f"re-read {path}: {error}") from error
        if current != original:
            raise UpdateError(
                f"{path} changed while Wolfi packages were being downloaded; "
                "refusing to overwrite it"
            )
        os.replace(temporary_path, path)
        temporary_path = None
        try:
            directory = os.open(path.parent, os.O_RDONLY)
        except OSError:
            directory = -1
        if directory >= 0:
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    except UpdateError:
        raise
    except OSError as error:
        raise UpdateError(f"atomically replace {path}: {error}") from error
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def _repository(value: str) -> str:
    normalized = value.rstrip("/")
    parsed = urllib.parse.urlsplit(normalized)
    loopback_http = parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "::1",
        "localhost",
    }
    if (
        (parsed.scheme != "https" and not loopback_http)
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
    ):
        raise argparse.ArgumentTypeError(
            "repository must be an absolute HTTPS URL without query or fragment "
            "(HTTP is allowed only for loopback tests)"
        )
    return normalized


def _positive_int(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if parsed <= 0 or not math.isfinite(parsed):
        raise argparse.ArgumentTypeError("must be a finite positive number")
    return parsed


def discover_build_file() -> Path:
    """Find the repository-relative pin file when invoked below the root."""
    current = Path.cwd().resolve()
    for root in (current, *current.parents):
        candidate = root / DEFAULT_BUILD_FILE
        if candidate.is_file():
            return candidate
    return DEFAULT_BUILD_FILE


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Update pinned Wolfi APK versions and SHA-256 hashes.",
    )
    parser.add_argument(
        "--build-file",
        type=Path,
        default=discover_build_file(),
        help=f"pin file to update (default: {DEFAULT_BUILD_FILE})",
    )
    parser.add_argument(
        "--repository",
        type=_repository,
        default=DEFAULT_REPOSITORY,
        help=f"Wolfi architecture repository (default: {DEFAULT_REPOSITORY})",
    )
    parser.add_argument(
        "--jobs",
        type=_positive_int,
        default=DEFAULT_JOBS,
        help=f"concurrent APK downloads (default: {DEFAULT_JOBS})",
    )
    parser.add_argument(
        "--timeout",
        type=_positive_float,
        default=DEFAULT_TIMEOUT,
        help=f"timeout in seconds for each HTTP operation (default: {DEFAULT_TIMEOUT:g})",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="report version updates and exit 1 without downloading APKs or writing",
    )
    return parser


def run(args: argparse.Namespace, stdout: TextIO) -> int:
    document = parse_build_file(args.build_file)
    index = fetch_index(args.repository, set(document.pins), args.timeout)
    updates = find_updates(document, index)
    if not updates:
        print(f"Wolfi pins are current ({len(document.pins)} packages).", file=stdout)
        return 0

    if args.check:
        print("Wolfi package updates available:", file=stdout)
        for update in updates:
            print(
                f"  {update.pin.name}: {update.pin.version} -> "
                f"{update.record.version}",
                file=stdout,
            )
        print(f"Run without --check to update {len(updates)} pin(s).", file=stdout)
        return 1

    updates = hash_updates(args.repository, updates, args.jobs, args.timeout)
    replacement = render_build(document, updates)
    atomic_rewrite(args.build_file, document.original, replacement)
    print("Updated Wolfi package pins:", file=stdout)
    for update in updates:
        print(
            f"  {update.pin.name}: {update.pin.version} -> "
            f"{update.record.version} sha256={update.sha256}",
            file=stdout,
        )
    print(f"Updated {len(updates)} pin(s).", file=stdout)
    return 0


def main(
    argv: list[str] | None = None,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    args = make_parser().parse_args(argv)
    try:
        return run(args, stdout)
    except UpdateError as error:
        print(f"ERROR: {error}", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
