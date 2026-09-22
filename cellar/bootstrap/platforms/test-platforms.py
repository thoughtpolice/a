#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Exercise real Buck configuration resolution without running remote actions."""

import argparse
import json
import pathlib
import re
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[2]
SEED = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:hex2-0"
EXECUTOR = "cellar//bootstrap/platforms:execution"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--buck", default="buck2")
    parser.add_argument("--isolation-dir", default="platform-audit")
    args = parser.parse_args()
    buck = str(pathlib.Path(args.buck).resolve()) if "/" in args.buck else args.buck
    results = []

    # Buck runs this test from its project root. When that is a parent project
    # that includes cellar as a cell, the same guarantees must hold there.
    projects = [ROOT]
    if pathlib.Path.cwd().resolve() != ROOT:
        projects.append(pathlib.Path.cwd().resolve())
    for project in projects:
        audit(buck, args.isolation_dir, project, project != ROOT, results)
    print(json.dumps({"checks": results, "count": len(results), "errors": []}, indent=2))


def audit(buck, isolation_dir, project, parent, results):
    prefix = "parent: " if parent else ""

    def run(command):
        return subprocess.run(
            [buck, "--isolation-dir", isolation_dir, *command],
            cwd=project, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False,
        )

    def check(condition, description, result):
        if not condition:
            raise AssertionError(prefix + description + "\n" + result.stdout + result.stderr)
        results.append(prefix + description)

    for host, arch in [("linux", "x8664"), ("linux", "aarch64"),
                       ("macos", "aarch64"), ("macos", "x8664"),
                       ("windows", "x8664"), ("windows", "aarch64")]:
        host_args = ["--fake-host", host, "--fake-arch", arch]
        native = host == "linux" and arch == "x8664"
        local = run(["cquery", *host_args, SEED])
        if native:
            local_native = local
        check(
            (local.returncode == 0 and SEED in local.stdout) if native else
            (local.returncode != 0 and "No compatible execution platform" in local.stderr),
            f"{host}/{arch}: local {'accepted' if native else 'rejected'}", local,
        )
        remote = run(["cquery", "@cellar//bootstrap/platforms/remote", *host_args, SEED])
        check(remote.returncode == 0 and SEED in remote.stdout,
              f"{host}/{arch}: remote graph accepted", remote)
        check("platforms:default" in remote.stdout,
              f"{host}/{arch}: target remains native Linux", remote)
        provider = run(["audit", "providers", "@cellar//bootstrap/platforms/remote",
                        *host_args, EXECUTOR])
        check(provider.returncode == 0 and "Remote(" in provider.stdout
              and "Local(" not in provider.stdout and "Hybrid(" not in provider.stdout
              and '"OSFamily": "Linux"' in provider.stdout
              and '"Arch": "x86_64"' in provider.stdout
              and "path_separator: Unix" in provider.stdout,
              f"{host}/{arch}: remote-only Linux executor and Unix paths", provider)

    graph = run(["cquery", "--fake-host", "linux", "--fake-arch", "x8664",
                 "--json", "deps(" + SEED + ")"])
    check(graph.returncode == 0, "native execution dependency graph resolves", graph)
    configurations = {label.split(" (", 1)[1] for label in json.loads(graph.stdout)}
    check(len(configurations) == 1 and "platforms:default#" in next(iter(configurations)),
          "native target and execution dependencies share one configuration", graph)

    for platform in ["linux-aarch64", "macos-x86_64", "windows-x86_64"]:
        query = run(["cquery", "@cellar//bootstrap/platforms/remote",
                     "--target-platforms", "cellar//bootstrap/platforms/tests:" + platform,
                     SEED])
        check(SEED not in query.stdout and "incompatible" in query.stderr.lower(),
              platform + ": incompatible target rejected", query)

    sandbox = run(["audit", "providers", "@cellar//bootstrap/platforms/sandbox",
                   "--fake-host", "linux", "--fake-arch", "x8664", EXECUTOR])
    check(sandbox.returncode == 0 and "sandbox_mode: Native" in sandbox.stdout,
          "native Linux executor preserves Landlock selection", sandbox)
    check('"/dev/ptmx",' in sandbox.stdout and '"/dev/pts",' in sandbox.stdout,
          "native Linux executor grants the pseudo-terminal devices", sandbox)
    check(re.search(r'read: Some\(\s*\[\s*"/proc/self",\s*\],\s*\)', sandbox.stdout) is not None,
          "native Linux executor reads no host system paths", sandbox)
    host = run(["audit", "providers", "@cellar//bootstrap/platforms/sandbox",
                "--fake-host", "linux", "--fake-arch", "x8664",
                "cellar//bootstrap/platforms:host-tests"])
    check(host.returncode == 0 and "read: None" in host.stdout,
          "host test executor keeps the default system paths", host)
    properties = run(["audit", "providers", "@cellar//bootstrap/platforms/remote",
                      "-c", 'bootstrap.remote_properties={"container-image":"bootstrap-test"}',
                      EXECUTOR])
    check(properties.returncode == 0 and '"container-image": "bootstrap-test"' in properties.stdout,
          "remote worker properties can be configured", properties)
    seed = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:hex0-seed"
    seed_copy = run([
        "aquery", "@cellar//bootstrap/platforms/remote",
        "--fake-host", "windows", "--fake-arch", "x8664",
        "all_actions(" + seed + ")", "-a", "category",
    ])
    check(seed_copy.returncode == 0 and
          list(json.loads(seed_copy.stdout).values()) == [{"category": "copy"}],
          "Windows clients copy the seed into a generated artifact", seed_copy)
    seed_runner = run([
        "audit", "providers", "@cellar//bootstrap/platforms/remote",
        "--fake-host", "windows", "--fake-arch", "x8664",
        "--provider", "RunInfo", seed,
    ])
    check(seed_runner.returncode == 0 and "RunInfo(" in seed_runner.stdout
          and "hex0-seed" in seed_runner.stdout,
          "the copied seed exposes its executable command", seed_runner)
    # These providers must remain RE-compatible even when the client's OS
    # cannot execute their Linux ELF commands. No remote action is run here.
    for target, provider_name in [
        ("cellar//bootstrap/stage0-posix/seeds/linux-amd64:check", "InternalRunnerTestInfo"),
        ("cellar//bootstrap/mes:hello-test", "ExternalRunnerTestInfo"),
        ("cellar//bootstrap/mes:mes-fixed-point", "ExternalRunnerTestInfo"),
    ]:
        test_provider = run([
            "audit", "providers", "@cellar//bootstrap/platforms/remote",
            "--fake-host", "windows", "--fake-arch", "aarch64",
            "--provider", provider_name, target,
        ])
        check(test_provider.returncode == 0 and provider_name in test_provider.stdout
              and "run_from_project_root=True" in test_provider.stdout
              and "use_project_relative_paths=True" in test_provider.stdout,
              target + ": test commands support remote execution", test_provider)

    if parent:
        # The parent's build modes are modifiers, which its configuration
        # constructor leaves out of cellar's platforms.
        release = run(["cquery", "--fake-host", "linux", "--fake-arch", "x8664",
                       "--modifier", "release", SEED])
        check(release.returncode == 0 and release.stdout == local_native.stdout,
              "build modes leave the configuration unchanged", release)


if __name__ == "__main__":
    main()
