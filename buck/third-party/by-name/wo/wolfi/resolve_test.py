# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

import resolve


def index(*records: dict[str, str]) -> resolve.Index:
    text = "".join(
        "".join(f"{key}:{value}\n" for key, value in record.items()) + "\n"
        for record in records
    )
    return resolve.parse_index(text.encode().splitlines(keepends=True))


def pkg(name: str, version: str, t: int, **fields: str) -> dict[str, str]:
    return {"P": name, "V": version, "S": "1", "t": str(t), **fields}


class VersionTest(unittest.TestCase):
    def test_ordering(self) -> None:
        ordered = [
            "1.0_rc1-r0",
            "1.0-r0",
            "1.0-r1",
            "1.0_git20260101-r0",
            "1.0_p1-r0",
            "1.0.1-r0",
            "1.0.1a-r0",
            "1.2-r0",
            "1.10-r0",
        ]
        keys = [resolve.version_key(version) for version in ordered]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(set(keys)), len(keys))

    def test_constraints(self) -> None:
        self.assertTrue(resolve.satisfies("2.44-r13", ">=", "2.44-r7"))
        self.assertFalse(resolve.satisfies("2.44-r7", ">=", "2.44-r13"))
        self.assertTrue(resolve.satisfies("23.1.4-r1", "=", "23.1.4-r1"))
        self.assertTrue(resolve.satisfies("23.1.4-r1", "~", "23.1"))
        self.assertFalse(resolve.satisfies("23.10.0-r0", "~", "23.1"))
        self.assertFalse(resolve.satisfies(None, ">=", "1"))
        self.assertTrue(resolve.satisfies(None, None, None))


class ResolverTest(unittest.TestCase):
    def test_so_dependency_and_order(self) -> None:
        repo = index(
            pkg("app", "1-r0", 1, D="so:libfoo.so.1"),
            pkg("libfoo", "1-r0", 1, p="so:libfoo.so.1=1"),
        )
        ordered = resolve.Resolver(repo, {}).resolve(["app"])
        self.assertEqual([record.name for record in ordered], ["libfoo", "app"])

    def test_newest_by_timestamp(self) -> None:
        repo = index(
            pkg("app", "2-r0", 1),
            # Published later, so it wins even though it sorts lower.
            pkg("app", "1-r1", 2),
        )
        ordered = resolve.Resolver(repo, {}).resolve(["app"])
        self.assertEqual(ordered[0].version, "1-r1")

    def test_pinned_and_origin_coherent(self) -> None:
        repo = index(
            pkg("libc", "2-r7", 1, o="libc"),
            pkg("libc", "2-r13", 2, o="libc"),
            pkg("libc-dev", "2-r7", 1, o="libc", D="libc>=2-r7"),
            pkg("libc-dev", "2-r13", 2, o="libc", D="libc>=2-r13"),
        )
        ordered = resolve.Resolver(repo, {"libc": "2-r7"}).resolve(["libc-dev"])
        versions = {record.name: record.version for record in ordered}
        self.assertEqual(versions, {"libc": "2-r7", "libc-dev": "2-r7"})

    def test_root_provider_beats_real_package(self) -> None:
        repo = index(
            pkg("glibc-dev", "1-r0", 1),
            pkg("glibc-2-dev", "2-r0", 1, p="glibc-dev=2-r0"),
            pkg("clang", "1-r0", 1, D="glibc-dev"),
        )
        ordered = resolve.Resolver(repo, {}).resolve(["clang", "glibc-2-dev"])
        self.assertEqual(sorted(record.name for record in ordered), ["clang", "glibc-2-dev"])

    def test_exact_constraint_takes_older_build(self) -> None:
        repo = index(
            pkg("lib", "1-r0", 1),
            pkg("lib", "1-r1", 2),
            pkg("app", "1-r0", 1, D="lib=1-r0"),
        )
        ordered = resolve.Resolver(repo, {}).resolve(["app"])
        self.assertEqual({record.name: record.version for record in ordered}["lib"], "1-r0")

    def test_root_names_exact_build(self) -> None:
        repo = index(pkg("tool", "1-r0", 1), pkg("tool", "2-r0", 2))
        ordered = resolve.Resolver(repo, {}).resolve([("tool", "1-r0")])
        self.assertEqual(ordered[0].version, "1-r0")
        with self.assertRaises(resolve.ResolveError):
            resolve.Resolver(repo, {}).resolve([("tool", "3-r0")])

    def test_conflict_is_avoided_then_reported(self) -> None:
        repo = index(
            pkg("glibc", "1-r0", 1, D="!musl"),
            pkg("musl", "1-r0", 1, p="so:libc.so=1"),
            pkg("glibc-compat", "1-r0", 1, p="so:libc.so=1"),
            pkg("app", "1-r0", 1, D="so:libc.so"),
        )
        ordered = resolve.Resolver(repo, {}).resolve(["glibc", "app"])
        self.assertIn("glibc-compat", [record.name for record in ordered])
        with self.assertRaises(resolve.ResolveError):
            resolve.Resolver(repo, {}).resolve(["glibc", "musl"])

    def test_unsatisfiable_pin_is_an_error(self) -> None:
        repo = index(
            pkg("libc", "2-r7", 1),
            pkg("libc", "2-r13", 2),
            pkg("tool", "1-r0", 1, D="libc>=2-r13"),
        )
        with self.assertRaisesRegex(resolve.ResolveError, "run :update first"):
            resolve.Resolver(repo, {"libc": "2-r7"}).resolve(["tool"])

    def test_read_lock_keeps_upper_case_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock.bzl"
            path.write_text(
                'SET = {\n    "libLLVM-23": ("23.1.4-r1", "' + "c" * 64 + '"),\n}\n'
            )
            self.assertEqual(resolve.read_lock(path), {("libLLVM-23", "23.1.4-r1"): "c" * 64})

    def test_render_skips_pinned(self) -> None:
        repo = index(pkg("a", "1-r0", 1, D="b"), pkg("b", "1-r0", 1))
        ordered = resolve.Resolver(repo, {"b": "1-r0"}).resolve(["a"])
        text = resolve.render(
            "SET",
            Path("roots.txt"),
            ordered,
            {"b"},
            {("a", "1-r0"): "a" * 64, ("b", "1-r0"): "b" * 64},
        )
        self.assertIn('    "a": ("1-r0", "' + "a" * 64 + '"),', text)
        self.assertNotIn('"b": (', text)
        self.assertIn('SET_CLOSURE = [\n    "b",\n    "a",\n]', text)


if __name__ == "__main__":
    unittest.main()
