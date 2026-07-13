#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Standard-library tests for the tdutil Python integrations."""

import contextlib
import importlib.machinery
import importlib.util
import io
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True


REPOSITORY = Path(__file__).resolve().parents[2]
if len(sys.argv) == 3 and all(Path(argument).is_file() for argument in sys.argv[1:]):
    PRE_COMMIT_PATH = Path(sys.argv[1]).resolve()
    HELPER_PATH = Path(sys.argv[2]).resolve()
    del sys.argv[1:3]
else:
    PRE_COMMIT_PATH = REPOSITORY / ".claude/hooks/pre-commit-test.py"
    HELPER_PATH = (
        REPOSITORY
        / ".claude/skills/buck2-target-determination/scripts/tdutil_helper.py"
    )


def load_module(name, path):
    """Load a repository script whose filename is not an importable module name."""
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pre_commit = load_module("tdutil_pre_commit", PRE_COMMIT_PATH)
helper = load_module("tdutil_helper", HELPER_PATH)


class TempFileSecurityTests(unittest.TestCase):
    modules = (
        (pre_commit, "tdutil-pre-commit-"),
        (helper, "tdutil-helper-"),
    )

    def test_mkstemp_files_are_unique_private_regular_files(self):
        for module, _ in self.modules:
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as tmp:
                with mock.patch.object(module.tempfile, "tempdir", tmp):
                    paths = [module.create_targets_file() for _ in range(2)]
                try:
                    self.assertNotEqual(paths[0], paths[1])
                    for path in paths:
                        metadata = os.lstat(path)
                        self.assertTrue(stat.S_ISREG(metadata.st_mode))
                        self.assertFalse(Path(path).is_symlink())
                        if os.name == "posix":
                            self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
                finally:
                    for path in paths:
                        module.remove_targets_file(path)

    @unittest.skipUnless(os.name == "posix", "symlink regression is POSIX-specific")
    def test_legacy_pid_symlink_cannot_redirect_output(self):
        for module, legacy_prefix in self.modules:
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                sentinel = directory / "sentinel"
                sentinel.write_text("do not overwrite", encoding="utf-8")
                legacy_path = directory / f"{legacy_prefix}{os.getpid()}.txt"
                legacy_path.symlink_to(sentinel)

                with mock.patch.object(module.tempfile, "tempdir", tmp):
                    generated = module.create_targets_file()
                try:
                    self.assertNotEqual(Path(generated), legacy_path)
                    self.assertEqual(
                        sentinel.read_text(encoding="utf-8"),
                        "do not overwrite",
                    )
                    self.assertTrue(legacy_path.is_symlink())
                finally:
                    module.remove_targets_file(generated)


class PreCommitTests(unittest.TestCase):
    target_path = "/tmp/tdutil test/targets file.txt"

    def run_main(self, *, commands, target_count):
        stderr = io.StringIO()
        count_behavior = (
            {"side_effect": target_count}
            if isinstance(target_count, BaseException)
            else {"return_value": target_count}
        )
        with (
            mock.patch.object(pre_commit, "validate_tool_input", return_value=True),
            mock.patch.object(
                pre_commit, "create_targets_file", return_value=self.target_path
            ),
            mock.patch.object(
                pre_commit, "run_command", side_effect=commands
            ) as run,
            mock.patch.object(pre_commit.os.path, "exists", return_value=True),
            mock.patch.object(pre_commit, "count_lines", **count_behavior),
            mock.patch.object(pre_commit, "remove_targets_file") as remove,
            contextlib.redirect_stderr(stderr),
        ):
            result = pre_commit.main()
        return result, stderr.getvalue(), run, remove

    def test_no_targets_cleans_up(self):
        result, _, run, remove = self.run_main(
            commands=[subprocess.CompletedProcess([], 0)],
            target_count=0,
        )
        self.assertEqual(result, 0)
        self.assertEqual(
            run.call_args_list[0].args[0],
            [
                "buck2",
                "run",
                "root//buck/tools/tdutil:tdutil",
                "--",
                "--output",
                self.target_path,
                "--from",
                "@-",
                "--to",
                "@",
                "--universe",
                "depot//...",
            ],
        )
        remove.assert_called_once_with(self.target_path)

    def test_failed_tests_retain_file_with_exact_recovery_commands(self):
        result, stderr, _, remove = self.run_main(
            commands=[
                subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 1),
            ],
            target_count=2,
        )
        self.assertEqual(result, 2)
        remove.assert_not_called()
        self.assertIn(
            "To rerun tests: buck2 test --skip-incompatible-targets "
            f"{shlex.quote(f'@{self.target_path}')}",
            stderr,
        )
        self.assertIn(
            f"To remove the target file: rm -f -- {shlex.quote(self.target_path)}",
            stderr,
        )

    def test_determination_error_cleans_up_and_quotes_command(self):
        command = ["buck2", "run", "target with spaces"]
        result, stderr, _, remove = self.run_main(
            commands=[subprocess.CalledProcessError(9, command)],
            target_count=0,
        )
        self.assertEqual(result, 2)
        remove.assert_called_once_with(self.target_path)
        self.assertIn(f"Command: {shlex.join(command)}", stderr)

    def test_unexpected_test_launch_error_cleans_up(self):
        result, stderr, _, remove = self.run_main(
            commands=[subprocess.CompletedProcess([], 0), FileNotFoundError("buck2")],
            target_count=2,
        )
        self.assertEqual(result, 2)
        remove.assert_called_once_with(self.target_path)
        self.assertNotIn("retained at", stderr)

    def test_target_file_read_error_blocks_and_cleans_up(self):
        result, stderr, _, remove = self.run_main(
            commands=[subprocess.CompletedProcess([], 0)],
            target_count=PermissionError("target file is unreadable"),
        )
        self.assertEqual(result, 2)
        remove.assert_called_once_with(self.target_path)
        self.assertIn("UNEXPECTED ERROR", stderr)


class HelperTests(unittest.TestCase):
    target_path = "/tmp/tdutil test/helper targets.txt"

    def run_main(self, args, *, commands, target_count=2):
        stdout = io.StringIO()
        stderr = io.StringIO()
        count_behavior = (
            {"side_effect": target_count}
            if isinstance(target_count, BaseException)
            else {"return_value": target_count}
        )
        with (
            mock.patch.object(helper, "create_targets_file", return_value=self.target_path),
            mock.patch.object(helper, "run_command", side_effect=commands) as run,
            mock.patch.object(helper, "count_targets", **count_behavior),
            mock.patch.object(helper, "remove_targets_file") as remove,
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            result = helper.main(args)
        return result, stdout.getvalue(), stderr.getvalue(), run, remove

    def test_no_action_retains_file_and_quotes_hints(self):
        result, stdout, _, run, remove = self.run_main(
            ["--pattern", "current", "--preview", "0"],
            commands=[""],
        )
        self.assertEqual(result, 0)
        self.assertEqual(
            run.call_args_list[0].args[0],
            [
                "buck2",
                "run",
                "root//buck/tools/tdutil:tdutil",
                "--",
                "--output",
                self.target_path,
                "--from",
                "@-",
                "--to",
                "@",
                "--universe",
                "depot//src/...",
            ],
        )
        remove.assert_not_called()
        self.assertIn(
            f"buck2 build {shlex.quote(f'@{self.target_path}')}",
            stdout,
        )
        self.assertIn(f"TARGETS={shlex.quote(self.target_path)}", stdout)
        self.assertIn(
            f"Remove it when finished: rm -f -- {shlex.quote(self.target_path)}",
            stdout,
        )

    def test_successful_automated_test_also_retains_file(self):
        result, stdout, _, run, remove = self.run_main(
            ["--pattern", "current", "--preview", "0", "--test"],
            commands=["", ""],
        )
        self.assertEqual(result, 0)
        remove.assert_not_called()
        self.assertEqual(
            run.call_args_list[-1].args[0],
            ["buck2", "test", f"@{self.target_path}"],
        )
        self.assertIn(
            f"Remove it when finished: rm -f -- {shlex.quote(self.target_path)}",
            stdout,
        )

    def test_failed_automated_test_retains_file(self):
        failure = subprocess.CalledProcessError(7, ["buck2", "test"])
        result, _, stderr, _, remove = self.run_main(
            ["--pattern", "current", "--preview", "0", "--test"],
            commands=["", failure],
        )
        self.assertEqual(result, 7)
        remove.assert_not_called()
        self.assertIn(
            f"Remove it when finished: rm -f -- {shlex.quote(self.target_path)}",
            stderr,
        )

    def test_missing_test_command_retains_file_with_cleanup_hint(self):
        result, _, stderr, _, remove = self.run_main(
            ["--pattern", "current", "--preview", "0", "--test"],
            commands=["", FileNotFoundError("buck2")],
        )
        self.assertEqual(result, 1)
        remove.assert_not_called()
        self.assertIn(
            f"Remove it when finished: rm -f -- {shlex.quote(self.target_path)}",
            stderr,
        )

    def test_unexpected_post_determination_error_retains_file_with_cleanup_hint(self):
        result, _, stderr, _, remove = self.run_main(
            ["--pattern", "current", "--preview", "0", "--test"],
            commands=["", RuntimeError("unexpected test failure")],
        )
        self.assertEqual(result, 1)
        remove.assert_not_called()
        self.assertIn("Unexpected error: unexpected test failure", stderr)
        self.assertIn(
            f"Remove it when finished: rm -f -- {shlex.quote(self.target_path)}",
            stderr,
        )

    def test_no_targets_cleans_up(self):
        result, _, _, _, remove = self.run_main(
            ["--pattern", "current", "--preview", "0"],
            commands=[""],
            target_count=0,
        )
        self.assertEqual(result, 0)
        remove.assert_called_once_with(self.target_path)

    def test_determination_failure_cleans_up(self):
        failure = subprocess.CalledProcessError(4, ["buck2", "run"])
        result, _, _, _, remove = self.run_main(
            ["--pattern", "current", "--preview", "0"],
            commands=[failure],
        )
        self.assertEqual(result, 4)
        remove.assert_called_once_with(self.target_path)

    def test_target_file_read_error_fails_and_cleans_up(self):
        result, _, stderr, _, remove = self.run_main(
            ["--pattern", "current", "--preview", "0"],
            commands=[""],
            target_count=PermissionError("target file is unreadable"),
        )
        self.assertEqual(result, 1)
        remove.assert_called_once_with(self.target_path)
        self.assertIn("Unexpected error: target file is unreadable", stderr)


if __name__ == "__main__":
    unittest.main()
