#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Regression checks for the host-side trace auditor's trust boundary."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("audit_trace", Path(__file__).with_name("audit-trace.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class TraceBoundary(unittest.TestCase):
    def test_kernel_terminals_and_pipe_descriptors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefix = root / "trace"
            trace = Path(str(prefix) + ".100")
            trace.write_text(
                f'1.000 execve("{root}/cellar/bootstrap/seed", [], []) = 0\n'
                '1.001 open("/dev/ptmx", O_RDWR) = 3</dev/ptmx<char 5:2 @/dev/pts/0>>\n'
                '1.002 open("/dev/pts/0", O_RDWR) = 4</dev/pts/0<char 136:0>>\n'
                '1.003 open("/dev/tty", O_RDWR) = 5</dev/tty<char 5:0>>\n'
                '1.004 openat(AT_FDCWD, "/dev/fd/63", O_RDONLY) = 6<pipe:[123]>\n'
            )
            report = audit.review(root, str(prefix))
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["kernel_channels"], {"pipe_descriptor": 1, "terminal_device": 3})
            with trace.open("a") as stream:
                stream.write(
                    '1.005 open("/dev/fd/62", O_RDONLY) = 7</usr/include/stdio.h>\n'
                    '1.006 open("/dev/pts/1", O_RDONLY) = 8</dev/pts/1>\n'
                    '1.007 open("/dev/pts/2", O_RDONLY) = 9</dev/pts/2<char 1:1>>\n'
                    '1.008 open("unrelated", O_RDONLY) = 10<pipe:[456]>\n'
                    '1.009 execve("/dev/fd/63", [], []) = -1 ENOENT\n'
                )
            report = audit.review(root, str(prefix))
            self.assertEqual([e["error"] for e in report["errors"]], [
                "file outside bootstrap", "file outside bootstrap", "file outside bootstrap",
                "unresolved successful open", "executable outside bootstrap",
            ])

    def test_entropy_is_limited_to_mktemp_and_the_typed_kernel_device(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefix = root / "trace"
            trace = Path(str(prefix) + ".100")
            trace.write_text(
                f'1.000 execve("{root}/cellar/bootstrap/mktemp", [], []) = 0\n'
                '1.001 open("/dev/urandom", O_RDONLY) = 3</dev/urandom<char 1:9>>\n'
            )
            report = audit.review(root, str(prefix))
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["kernel_channels"], {"mktemp_entropy": 1})
            with trace.open("a") as stream:
                stream.write(
                    '1.002 open("/dev/urandom", O_RDONLY) = 3</dev/urandom>\n'
                    '1.003 open("/dev/urandom", O_RDONLY) = 3</dev/urandom<char 1:8>>\n'
                    f'1.004 execve("{root}/cellar/bootstrap/gcc", [], []) = 0\n'
                    '1.005 open("/dev/urandom", O_RDONLY) = 3</dev/urandom<char 1:9>>\n'
                )
            report = audit.review(root, str(prefix))
            self.assertEqual(len(report["errors"]), 3)
            self.assertTrue(all(e["error"] == "file outside bootstrap" for e in report["errors"]))

    def test_bootstrap_children_and_resolved_opens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "buck-out/audit/art/depot-cellar/bootstrap/tool"
            prefix = root / "trace"
            Path(str(prefix) + ".100").write_text(
                '1.000 execve("/usr/bin/buck2", [], []) = 0\n'
                '1.001 open("/etc/ld.so.cache", O_RDONLY) = 3</etc/ld.so.cache>\n'
                f'1.002 execve("{artifact}", [], []) = 0\n'
                '1.003 fork() = 101\n'
            )
            Path(str(prefix) + ".101").write_text(
                f'1.004 open("input", O_RDONLY) = 3<{root}/cellar/bootstrap/input>\n'
                f'1.005 open("temp", O_RDWR) = 4<{root}/buck-out/audit/tmp/depot-cellar/action/temp>\n'
                '1.006 open("/dev/null", O_WRONLY) = 5</dev/null<char 1:3>>\n'
                '1.007 open("missing", O_RDONLY) = -1 ENOENT (No such file or directory)\n'
            )
            report = audit.review(root, str(prefix))
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["bootstrap_processes"], 2)
            with Path(str(prefix) + ".101").open("a") as child:
                child.write(
                    '1.008 open("apparently-local-symlink", O_RDONLY) = 6</usr/include/stdio.h>\n'
                    '1.009 execve("/usr/bin/cc", [], []) = -1 ENOENT (No such file or directory)\n'
                )
            report = audit.review(root, str(prefix))
            self.assertEqual([e["error"] for e in report["errors"]], [
                "file outside bootstrap", "executable outside bootstrap",
            ])

    def test_split_fork_and_child_runs_before_parent_return(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefix = root / "trace"
            Path(str(prefix) + ".10").write_text(
                f'1.000 execve("{root}/cellar/bootstrap/seed", [], []) = 0\n'
                '1.001 fork( <unfinished ...>\n'
                '1.003 <... fork resumed>) = 11\n'
            )
            Path(str(prefix) + ".11").write_text(
                '1.002 open("/usr/lib/libc.a", O_RDONLY) = 3</usr/lib/libc.a>\n'
            )
            report = audit.review(root, str(prefix))
            self.assertEqual(report["errors"][0]["path"], "/usr/lib/libc.a")


if __name__ == "__main__":
    unittest.main()
