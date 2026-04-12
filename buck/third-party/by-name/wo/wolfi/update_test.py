# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest

import update


OLD_HASH = "1" * 64
BAR_HASH = "2" * 64


def index_archive(records: list[dict[str, str]], member_name: str = "APKINDEX") -> bytes:
    contents = "".join(
        "".join(f"{key}:{value}\n" for key, value in record.items()) + "\n"
        for record in records
    ).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        signature = tarfile.TarInfo(".SIGN.RSA256.fixture")
        signature.size = 1
        signature.mtime = 0
        archive.addfile(signature, io.BytesIO(b"x"))
        member = tarfile.TarInfo(member_name)
        member.size = len(contents)
        member.mtime = 0
        archive.addfile(member, io.BytesIO(contents))
    return output.getvalue()


def split_gzip_index_archive(records: list[dict[str, str]]) -> bytes:
    """Build one tar stream split across concatenated gzip members."""
    contents = "".join(
        "".join(f"{key}:{value}\n" for key, value in record.items()) + "\n"
        for record in records
    ).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        signature = tarfile.TarInfo("SIGNATURE")
        signature.size = 3
        signature.mtime = 0
        archive.addfile(signature, io.BytesIO(b"sig"))
        member = tarfile.TarInfo("APKINDEX")
        member.size = len(contents)
        member.mtime = 0
        archive.addfile(member, io.BytesIO(contents))
    raw = output.getvalue()
    # A tar header plus the padded signature body. This is how APK-style
    # archives can cross a gzip-member boundary without ending the tar stream.
    boundary = 2 * tarfile.BLOCKSIZE
    return gzip.compress(raw[:boundary], mtime=0) + gzip.compress(
        raw[boundary:], mtime=0
    )


class FixtureServer:
    def __init__(self, responses: dict[str, bytes]) -> None:
        self.responses = responses
        self.requests: list[str] = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                fixture.requests.append(self.path)
                body = fixture.responses.get(self.path)
                if body is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.daemon = True

    def __enter__(self) -> "FixtureServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    @property
    def repository(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"


def build_text() -> str:
    return (
        "# header kept exactly\n"
        "FIRST = {\n"
        f'    "foo": ("1-r0", "{OLD_HASH}"),\n'
        "}\n\n"
        "# group boundary and comment stay put\n"
        "SECOND = {\n"
        f'    "bar": ("1-r0", "{BAR_HASH}"),\n'
        "}\n"
    )


def records(foo_payload: bytes) -> list[dict[str, str]]:
    return [
        {"P": "foo", "V": "2-r0", "S": "2", "t": "20"},
        {"P": "bar", "V": "1-r0", "S": "7", "t": "40"},
        {"P": "foo", "V": "1-r0", "S": "1", "t": "10"},
        {
            "P": "foo",
            "V": "3-r0",
            "S": str(len(foo_payload)),
            "t": "30",
        },
    ]


class UpdateTest(unittest.TestCase):
    def invoke(
        self,
        build_file: Path,
        repository: str,
        *extra: str,
    ) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        status = update.main(
            [
                "--build-file",
                str(build_file),
                "--repository",
                repository,
                "--timeout",
                "5",
                *extra,
            ],
            stdout=stdout,
            stderr=stderr,
        )
        return status, stdout.getvalue(), stderr.getvalue()

    def test_updates_newest_historical_record_and_preserves_text(self) -> None:
        payload = b"new foo package"
        archive = index_archive(records(payload))
        with tempfile.TemporaryDirectory() as temporary:
            build_file = Path(temporary) / "BUILD"
            build_file.write_text(build_text())
            with FixtureServer(
                {
                    "/APKINDEX.tar.gz": archive,
                    "/foo-3-r0.apk": payload,
                }
            ) as server:
                status, stdout, stderr = self.invoke(
                    build_file,
                    server.repository,
                    "--jobs",
                    "2",
                )

            expected = build_text().replace(
                f'"foo": ("1-r0", "{OLD_HASH}")',
                f'"foo": ("3-r0", "{hashlib.sha256(payload).hexdigest()}")',
            )
            self.assertEqual(status, 0)
            self.assertEqual(build_file.read_text(), expected)
            self.assertEqual(stderr, "")
            self.assertEqual(
                stdout,
                "Updated Wolfi package pins:\n"
                "  foo: 1-r0 -> 3-r0 "
                f"sha256={hashlib.sha256(payload).hexdigest()}\n"
                "Updated 1 pin(s).\n",
            )
            self.assertEqual(
                server.requests,
                ["/APKINDEX.tar.gz", "/foo-3-r0.apk"],
            )

    def test_check_reports_without_downloading_or_writing(self) -> None:
        payload = b"new foo package"
        original = build_text()
        with tempfile.TemporaryDirectory() as temporary:
            build_file = Path(temporary) / "BUILD"
            build_file.write_text(original)
            with FixtureServer(
                {"/APKINDEX.tar.gz": index_archive(records(payload))}
            ) as server:
                status, stdout, stderr = self.invoke(
                    build_file,
                    server.repository,
                    "--check",
                )

            self.assertEqual(status, 1)
            self.assertEqual(build_file.read_text(), original)
            self.assertEqual(stderr, "")
            self.assertEqual(server.requests, ["/APKINDEX.tar.gz"])
            self.assertEqual(
                stdout,
                "Wolfi package updates available:\n"
                "  foo: 1-r0 -> 3-r0\n"
                "Run without --check to update 1 pin(s).\n",
            )

    def test_reads_tar_split_across_concatenated_gzip_members(self) -> None:
        payload = b"new foo package"
        archive = split_gzip_index_archive(records(payload))
        with FixtureServer({"/APKINDEX.tar.gz": archive}) as server:
            index = update.fetch_index(
                server.repository,
                {"foo", "bar"},
                timeout=5,
            )

        self.assertEqual(index["foo"].version, "3-r0")
        self.assertEqual(index["foo"].size, len(payload))
        self.assertEqual(server.requests, ["/APKINDEX.tar.gz"])

    def test_malformed_pin_is_rejected_before_network_access(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            build_file = Path(temporary) / "BUILD"
            build_file.write_text('PINS = {\n    "foo": ("1-r0", "bad"),\n}\n')
            with self.assertRaisesRegex(update.UpdateError, "malformed Wolfi pin"):
                update.parse_build_file(build_file)

    def test_newest_publication_can_be_a_repository_rollback(self) -> None:
        index = update.parse_index(
            io.BytesIO(
                b"P:foo\nV:9-r0\nS:1\nt:10\n\n"
                b"P:foo\nV:8-r1\nS:1\nt:20\n\n"
            ),
            {"foo"},
        )
        self.assertEqual(index["foo"].version, "8-r1")
        self.assertEqual(index["foo"].timestamp, 20)

    def test_conflicting_versions_at_same_timestamp_are_rejected(self) -> None:
        archive = index_archive(
            [
                {"P": "foo", "V": "2-r0", "S": "1", "t": "20"},
                {"P": "foo", "V": "3-r0", "S": "1", "t": "20"},
                {"P": "bar", "V": "1-r0", "S": "1", "t": "1"},
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            build_file = Path(temporary) / "BUILD"
            build_file.write_text(build_text())
            with FixtureServer({"/APKINDEX.tar.gz": archive}) as server:
                status, stdout, stderr = self.invoke(build_file, server.repository)

            self.assertEqual(status, 2)
            self.assertEqual(stdout, "")
            self.assertIn("conflicting versions for 'foo'", stderr)
            self.assertEqual(server.requests, ["/APKINDEX.tar.gz"])

    def test_downloaded_size_must_match_index(self) -> None:
        payload = b"short"
        archive = index_archive(
            [
                {"P": "foo", "V": "2-r0", "S": "100", "t": "20"},
                {"P": "bar", "V": "1-r0", "S": "1", "t": "1"},
            ]
        )
        original = build_text()
        with tempfile.TemporaryDirectory() as temporary:
            build_file = Path(temporary) / "BUILD"
            build_file.write_text(original)
            with FixtureServer(
                {
                    "/APKINDEX.tar.gz": archive,
                    "/foo-2-r0.apk": payload,
                }
            ) as server:
                status, stdout, stderr = self.invoke(build_file, server.repository)

            self.assertEqual(status, 2)
            self.assertEqual(stdout, "")
            self.assertIn("downloaded size for 'foo' '2-r0' is 5", stderr)
            self.assertEqual(build_file.read_text(), original)

    def test_download_stops_when_it_exceeds_index_size(self) -> None:
        payload = b"too large"
        archive = index_archive(
            [
                {"P": "foo", "V": "2-r0", "S": "2", "t": "20"},
                {"P": "bar", "V": "1-r0", "S": "1", "t": "1"},
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            build_file = Path(temporary) / "BUILD"
            build_file.write_text(build_text())
            with FixtureServer(
                {
                    "/APKINDEX.tar.gz": archive,
                    "/foo-2-r0.apk": payload,
                }
            ) as server:
                status, stdout, stderr = self.invoke(build_file, server.repository)

        self.assertEqual(status, 2)
        self.assertEqual(stdout, "")
        self.assertIn("exceeds APKINDEX size 2", stderr)

    def test_plaintext_repository_is_loopback_only(self) -> None:
        self.assertEqual(
            update._repository("http://127.0.0.1:8080/path/"),
            "http://127.0.0.1:8080/path",
        )
        with self.assertRaisesRegex(
            argparse.ArgumentTypeError,
            "HTTPS URL",
        ):
            update._repository("http://packages.example.test/wolfi")

    def test_concurrent_edit_is_not_overwritten(self) -> None:
        payload = b"new foo package"
        original = build_text()
        concurrent = original + "# concurrent edit\n"
        archive = index_archive(records(payload))
        with tempfile.TemporaryDirectory() as temporary:
            build_file = Path(temporary) / "BUILD"
            build_file.write_text(original)

            class EditingFixture(FixtureServer):
                pass

            server = EditingFixture(
                {
                    "/APKINDEX.tar.gz": archive,
                    "/foo-3-r0.apk": payload,
                }
            )
            original_responses = server.responses

            # Replace the response mapping with a mapping that edits the BUILD
            # when the package body is requested, after the updater snapshot.
            class EditOnGet(dict[str, bytes]):
                def get(self, key: str, default: bytes | None = None) -> bytes | None:
                    if key == "/foo-3-r0.apk":
                        build_file.write_text(concurrent)
                    return super().get(key, default)

            server.responses = EditOnGet(original_responses)
            with server:
                status, stdout, stderr = self.invoke(build_file, server.repository)

            self.assertEqual(status, 2)
            self.assertEqual(stdout, "")
            self.assertIn("changed while Wolfi packages were being downloaded", stderr)
            self.assertEqual(build_file.read_text(), concurrent)


if __name__ == "__main__":
    unittest.main()
