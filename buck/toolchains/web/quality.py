# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Native quality actions over explicit authored files.

The native CLI owns JS/TS correctness and Svelte template/module diagnostics.
Deno's configured lint policy is an optional adapter, including Deno-specific
rules. Components cannot be handed to Deno; rune JS/TS modules can.
"""

import os
import subprocess
from collections.abc import Iterable, Sequence

CODE_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
DECLARATION_EXTENSIONS = (".d.ts", ".d.mts", ".d.cts")
Command = str | os.PathLike[str] | Sequence[str]


def _command(command: Command) -> list[str]:
    # Executable paths are never shell-split; spaces in Buck artifact paths work.
    return [os.fspath(command)] if isinstance(command, (str, os.PathLike)) else list(command)


def _files(paths: Iterable[str | os.PathLike[str]], *, lint: bool) -> list[str]:
    result = []
    seen = set()
    for path in paths:
        path = os.fspath(path)
        if not path.endswith(CODE_EXTENSIONS + (".svelte",)):
            continue
        if lint and path.endswith(DECLARATION_EXTENSIONS):
            continue
        key = os.path.normpath(path)
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def lint(native: Command, deno: Command | None = None,
         config: str | os.PathLike[str] | None = None,
         paths: Iterable[str | os.PathLike[str]] = (), *, deno_lint: bool = False) -> int:
    """Run native lint, plus Deno's policy when explicitly enabled.

    Input must be authored unit sources, not check projections/runtime output.
    Declarations and data do not participate. When enabled, both policies run
    even if the first fails, so native errors do not hide Deno diagnostics.
    """
    if deno_lint and (deno is None or config is None):
        raise ValueError("Deno lint requires a Deno executable and config")
    files = _files(paths, lint=True)
    if not files:
        print("web: no lintable sources")
        return 0
    native_status = subprocess.run(_command(native) + ["lint", "--", *files]).returncode
    deno_files = [path for path in files if path.endswith(CODE_EXTENSIONS)]
    deno_status = 0
    if deno_lint and deno_files:
        env = dict(os.environ)
        env["DENO_NO_UPDATE_CHECK"] = "1"
        env.setdefault("NO_COLOR", "1")
        deno_status = subprocess.run(
            _command(deno) + ["lint", "--config", os.fspath(config), *deno_files],
            env=env,
        ).returncode
    return native_status or deno_status


def format(native: Command, paths: Iterable[str | os.PathLike[str]], *,
           check: bool = False, write: bool = False) -> int:
    """Format JS/TS (including declarations) and Svelte, skipping data.

    With neither flag, the native CLI prints JSON containing formatted source.
    Check writes nothing and fails on changes/errors. Write updates explicit
    input files only; a caller must not use write on read-only Buck artifacts.
    """
    if check and write:
        raise ValueError("format check and write are mutually exclusive")
    files = _files(paths, lint=False)
    if not files:
        print("web: no formattable sources")
        return 0
    mode = ["--check"] if check else ["--write"] if write else []
    return subprocess.run(_command(native) + ["format", *mode, "--", *files]).returncode
