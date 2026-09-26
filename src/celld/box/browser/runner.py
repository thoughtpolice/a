# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Own the entire local browser test lifetime, including failed driver startup."""

import argparse
from pathlib import Path
import platform
import re
import secrets
import signal
import subprocess
import sys
import tempfile

from harness import Runtime, _clean_environment, _stop


def redact(text, token):
    """Never print the control secret or a websocket bearer capability."""
    return re.sub(r"/sessions/[a-f0-9]{64}", "/sessions/[redacted]", text.replace(token, "[redacted]"))


def interrupted(_number, _frame):
    raise KeyboardInterrupt


def read_tail(path, limit):
    """Read at most limit bytes, rather than loading a possibly huge log."""
    with path.open("rb") as stream:
        stream.seek(0, 2)
        stream.seek(max(0, stream.tell() - limit))
        return stream.read(limit).decode("utf-8", errors="replace")


def cleanup(driver, builder, runtime):
    """Every owned resource gets its bounded cleanup even if another fails."""
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM)}
    errors = []
    try:
        for operation in (lambda: _stop(driver, 5), lambda: _stop(builder, 5), runtime.close):
            try:
                operation()
            except Exception as error:
                errors.append(error)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    if errors:
        raise ExceptionGroup("browser runner cleanup failed", errors)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--celld", required=True, type=Path)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--deno", required=True)
    parser.add_argument("--driver", required=True, type=Path)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    token = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory(prefix="celld-browser-") as directory:
        root = Path(directory)
        runtime = Runtime(args.celld, args.project, root, {"BROWSER_FIXTURE_TOKEN": token})
        driver = None
        builder = None
        try:
            # Cold browser downloads can exceed the shared runtime's 60s boot
            # deadline. Warm celld's own image cache first, bounded to ten minutes.
            # No deployment: dry-run builds locally and validates the project.
            env = _clean_environment()
            env["CELLD_CONTAINER_PLATFORM"] = "linux/arm64" if platform.machine() in ("aarch64", "arm64") else "linux/amd64"
            builder = subprocess.Popen(
                [str(args.celld), "deploy", str(runtime.directory), "--dry-run", "--json"],
                stdin=subprocess.DEVNULL, stdout=runtime.log, stderr=subprocess.STDOUT, env=env,
            )
            if builder.wait(timeout=600) != 0:
                raise RuntimeError("browser fixture image build failed")
            runtime.start()
            env = _clean_environment()
            # Do not inherit environment beyond the local driver requirements.
            env = {key: value for key, value in env.items() if key in ("PATH", "TMPDIR", "NO_COLOR")}
            env.update({
                "DENO_DIR": str(root / "deno"),
                "DENO_NO_UPDATE_CHECK": "1",
                "CELLD_BROWSER_ENDPOINT": runtime.origin,
                "CELLD_BROWSER_TOKEN": token,
            })
            # Capture output so even assertion diagnostics cannot disclose bearer
            # URLs. A file avoids pipe deadlock and unbounded in-memory buffering.
            with (root / "driver.log").open("w+") as output:
                driver = subprocess.Popen(
                    [args.deno, "test", "--no-config", "--no-prompt",
                     "--allow-net=127.0.0.1",
                     "--allow-env=CELLD_BROWSER_ENDPOINT,CELLD_BROWSER_TOKEN", str(args.driver)],
                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, env=env,
                )
                code = driver.wait(timeout=300)
                output.seek(0)
                print(redact(output.read(1_048_576), token), end="", flush=True)
                if code != 0:
                    raise RuntimeError(f"browser driver exited {code}")
            return 0
        except (Exception, KeyboardInterrupt) as error:
            print(f"browser test failed: {redact(str(error), token)}", file=sys.stderr)
            print(redact(read_tail(runtime.log_path, 65_536), token), file=sys.stderr)
            return 1
        finally:
            # Includes exceptions, SIGINT/SIGTERM, and a stalled test driver.
            cleanup(driver, builder, runtime)


if __name__ == "__main__":
    sys.exit(main())
