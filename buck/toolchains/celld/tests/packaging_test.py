# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Checks the Buck-to-celld deployment boundary without a fleet or an engine.

Buck supplies the pinned CLI and three packaged fixture directories. Positive
tests parse the emitted configuration and exercise real non-container dry runs.
Negative tests copy a fixture and ask the upstream parser to reject unsupported
configuration. A valid container project is never deployed: celld builds/pulls
images even with --dry-run. CELLD_DOCKER additionally points at a missing path
inside each temporary directory, so a parser regression cannot invoke Docker.
"""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class PackagingTest(unittest.TestCase):
    """Protect supported bindings, packaging layout, and loud upstream gaps."""

    @staticmethod
    def config(project):
        """Read the exact JSON configuration emitted by celld.project."""
        return json.loads((project / "wrangler.jsonc").read_text())

    def deploy(self, project):
        """Run a bounded dry run, disabling image tooling even on error paths."""
        with tempfile.TemporaryDirectory(prefix="celld-no-docker-") as temporary:
            env = os.environ.copy()
            env["CELLD_DOCKER"] = str(Path(temporary) / "docker-is-disabled")
            return subprocess.run(
                [str(CELLD), "deploy", str(project), "--dry-run", "--json"],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

    def assert_rejected(self, field, value, diagnostic):
        """Mutate one valid non-container config and inspect the CLI refusal."""
        with tempfile.TemporaryDirectory(prefix="celld-config-test-") as temporary:
            project = Path(temporary) / "project"
            shutil.copytree(BINDINGS, project)
            config = self.config(project)
            config[field] = value
            (project / "wrangler.jsonc").write_text(json.dumps(config))
            result = self.deploy(project)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(diagnostic, result.stderr)
            self.assertNotIn("docker-is-disabled", result.stderr)

    def test_binding_configuration(self):
        """New loader bindings coexist with the original platform families."""
        config = self.config(BINDINGS)
        self.assertEqual(config["worker_loaders"], [
            {"binding": "LOADER"}, {"binding": "OTHER_LOADER"},
        ])
        self.assertEqual(config["containers"], [])
        self.assertEqual(config["migrations"], [
            {"tag": "v1", "new_sqlite_classes": ["Counter"]},
        ])
        self.assertEqual(config["d1_databases"], [{
            "binding": "DATABASE", "database_name": "toolchain-database",
            "database_id": "toolchain-database-v1",
        }])
        self.assertEqual(config["workflows"], [{
            "binding": "FLOW", "name": "toolchain-flow",
            "class_name": "ExampleWorkflow", "script_name": "celld-toolchain-test",
        }])
        self.assertEqual(config["queues"]["consumers"][0]["max_concurrency"], 1)
        self.assertEqual(config["assets"]["run_worker_first"], ["/api/*"])
        self.assertTrue((BINDINGS / "assets" / "index.html").is_file())
        self.assertIn("cloudflare:workers", (BINDINGS / "index.js").read_text())

    def test_binding_dry_run(self):
        """The pinned upstream CLI recognizes both loaders and all bindings."""
        result = self.deploy(BINDINGS)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertIs(report["dry_run"], True)
        self.assertEqual(report["worker"], "celld-toolchain-test")
        self.assertRegex(report["version"], r"^[0-9a-f]+$")
        for binding in ["COUNTER", "OPERATIONS", "DATABASE", "CACHE", "JOBS",
                        "FLOW", "ARTIFACTS", "MODE", "ASSETS", "LOADER", "OTHER_LOADER"]:
            self.assertIn("env." + binding + " ", result.stderr)

    def test_minimal_dry_run(self):
        """A plain Worker still needs no class, loader, container, or assets."""
        config = self.config(MINIMAL)
        self.assertEqual(config["worker_loaders"], [])
        self.assertEqual(config["containers"], [])
        self.assertNotIn("assets", config)
        result = self.deploy(MINIMAL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["worker"], "celld-minimal-test")

    def test_container_packaging_only(self):
        """Container declarations and Docker build context survive packaging."""
        config = self.config(CONTAINER)
        self.assertEqual(config["containers"], [{
            "class_name": "Counter", "image": "container/Dockerfile",
            "name": "toolchain-container", "instance_type": "dev",
            "max_instances": 2, "runtime": "runsc",
        }])
        self.assertIn("FROM scratch", (CONTAINER / "container" / "Dockerfile").read_text())

    def test_invalid_container_configuration(self):
        """Container schema errors fail before any image resolution begins."""
        cases = [
            ({"class_name": "Missing"}, "is not a Durable Object class"),
            ({"image": ""}, ".image` must be a string"),
            ({"max_instances": -1}, "must be a non-negative integer"),
            ({"runtime": ""}, "must be a non-empty string"),
            ({"instance_type": "imaginary"}, "is not an instance type"),
            ({"unsupported": True}, "declares `unsupported`"),
        ]
        for patch, diagnostic in cases:
            with self.subTest(patch=patch):
                container = {"class_name": "Counter", "image": "example.invalid/not-pulled:latest"}
                container.update(patch)
                self.assert_rejected("containers", [container], diagnostic)

    def test_runtime_loader_options_are_not_deployment_options(self):
        """Limits/tails belong to code; experimental APIs remain unavailable."""
        cases = [
            ("limits", {}, "sets `limits`; set limits in WorkerCode or getEntrypoint()"),
            ("tails", [], "sets `tails`; set tails in WorkerCode"),
            ("allowExperimental", True, "sets `allowExperimental`, which celld does not support"),
        ]
        for key, value, diagnostic in cases:
            with self.subTest(key=key):
                self.assert_rejected("worker_loaders", [{"binding": "LOADER", key: value}],
                                     diagnostic)

    def test_workflow_create_options_are_not_deployment_options(self):
        """Retention/location belong to create(); schedules are unavailable."""
        for key in ["retention", "locationHint", "schedules"]:
            with self.subTest(key=key):
                workflows = copy.deepcopy(self.config(BINDINGS)["workflows"])
                workflows[0][key] = {}
                self.assert_rejected("workflows", workflows, "does not support these workflow keys: " + key)

    def test_workers_ai_is_unavailable(self):
        """0.5.0 refuses the removed AI deployment binding."""
        self.assert_rejected("ai", {"binding": "AI"}, "does not support these config keys: ai")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("usage: packaging_test.py CELLD BINDINGS MINIMAL CONTAINER")
    CELLD, BINDINGS, MINIMAL, CONTAINER = (Path(value).resolve() for value in sys.argv[1:])
    unittest.main(argv=[sys.argv[0]])
