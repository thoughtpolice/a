# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Import an OCI layout into Docker and wait for a readiness log line."""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path


def run(
    command: list[str],
    *,
    check: bool = True,
    timeout: float = 30.0,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        if result.stdout:
            print(result.stdout, file=sys.stderr, end="")
        raise subprocess.CalledProcessError(result.returncode, command)
    return result


def cleanup(container: str, tag: str) -> None:
    for command in (
        ["docker", "rm", "--force", container],
        ["docker", "image", "rm", tag],
    ):
        try:
            subprocess.run(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=5.0,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skopeo", required=True)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--ready-log", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=15.0)
    parser.add_argument("container_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    suffix = uuid.uuid4().hex[:12]
    tag = f"buck2-oci-smoke-{suffix}:latest"
    container = f"buck2-oci-smoke-{suffix}"
    container_args = list(args.container_args)
    if container_args[:1] == ["--"]:
        container_args.pop(0)

    def terminate(signum: int, _frame: object) -> None:
        # Buck sends SIGTERM before forcibly killing a timed-out test. Clean up
        # the detached container while there is still a grace period.
        cleanup(container, tag)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGTERM, terminate)

    try:
        copied = run([
            args.skopeo,
            "copy",
            "--insecure-policy",
            f"oci:{args.image}:latest",
            f"docker-daemon:{tag}",
        ])
        if copied.stdout:
            print(copied.stdout, end="")

        started = run([
            "docker",
            "run",
            "--detach",
            "--name",
            container,
            tag,
        ] + container_args)
        print(f"container_smoke: started {started.stdout.strip()}")

        deadline = time.monotonic() + args.timeout_seconds
        last_logs = ""
        while time.monotonic() < deadline:
            logs = run(["docker", "logs", container], check=False)
            last_logs = logs.stdout
            if args.ready_log in last_logs:
                # Catch services that log readiness just before a late bind or
                # initialization failure takes the process down.
                time.sleep(0.25)
                running = run([
                    "docker",
                    "inspect",
                    "--format",
                    "{{.State.Running}}",
                    container,
                ])
                if running.stdout.strip() != "true":
                    print(last_logs, file=sys.stderr, end="")
                    print(
                        "container_smoke: readiness was logged, but the container exited",
                        file=sys.stderr,
                    )
                    return 1
                print(last_logs, end="")
                print(
                    f"container_smoke: ready ({args.ready_log!r}) and still running"
                )
                return 0

            running = run([
                "docker",
                "inspect",
                "--format",
                "{{.State.Running}}",
                container,
            ], check=False)
            if running.returncode != 0 or running.stdout.strip() != "true":
                print(last_logs, file=sys.stderr, end="")
                print(
                    "container_smoke: container exited before readiness",
                    file=sys.stderr,
                )
                return 1
            time.sleep(0.1)

        print(last_logs, file=sys.stderr, end="")
        print(
            f"container_smoke: timed out after {args.timeout_seconds:g}s waiting "
            f"for {args.ready_log!r}",
            file=sys.stderr,
        )
        return 1
    finally:
        cleanup(container, tag)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        FileNotFoundError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as error:
        print(f"container_smoke: error: {error}", file=sys.stderr)
        sys.exit(1)
