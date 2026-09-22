#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Review strace -ff -ttt -s 65535 -yy -e trace=%file,%process output.

This is a host-side validation tool, never an input to bootstrap actions. Buck,
its launcher, and test infrastructure are outside the audited process boundary.
The boundary begins when they execute a cellar bootstrap artifact or source seed;
all descendants remain inside it, including subsequent unsuccessful exec attempts.
Successful file opens use strace's resolved fd paths, so symlink escapes cannot
be hidden by a workspace-relative spelling. This supplements the configured graph
audit; it does not infer per-action input declarations from a syscall trace.
Resolved pipe descriptors, typed terminal devices and mktemp kernel entropy
are counted separately as
kernel communication channels, not source-file inputs or executable paths.
Both the standalone cellar root (bootstrap/, artifacts in cell "cellar") and
the parent repository root (cellar/bootstrap/, cell "depot-cellar") are
recognized. Other cells and sibling workspace directories remain outside
the bootstrap boundary. Buck's native sandbox mirrors project-relative paths
under buck-out/<isolation>/tmp/sandbox/.tmpXXXXXX/. One such prefix may be
removed before applying the same source, artifact, and scratch boundaries;
the sandbox directory itself is not an allowed source or executable tree.
"""

import argparse
import ast
from collections import Counter
import glob
import json
import os
from pathlib import Path
import re
import sys


STRING = r'"(?:[^"\\]|\\.)*"'
CALL = re.compile(r"^(\w+)\((.*)\)\s+= (.*)$")
BOOTSTRAP_CELLS = {"cellar", "depot-cellar"}


def review(root, prefix):
    root = os.path.realpath(root)
    events, parents, pending = [], {}, {}
    errors, processes, executables = [], set(), set()
    counts = Counter()
    kernel_channels = Counter()
    files = sorted(glob.glob(prefix + ".[0-9]*"))
    if not files:
        raise ValueError("no per-process trace files matched " + prefix)
    for filename in files:
        pid = int(filename.rsplit(".", 1)[1])
        for index, line in enumerate(Path(filename).read_text().splitlines()):
            stamp, _, call = line.partition(" ")
            if not re.fullmatch(r"[0-9]+\.[0-9]+", stamp):
                continue
            if call.endswith(" <unfinished ...>"):
                pending[pid] = call.removesuffix(" <unfinished ...>")
                continue
            if call.startswith("<... ") and " resumed>" in call:
                call = pending.pop(pid, "") + call.split(" resumed>", 1)[1]
            match = CALL.match(call)
            if not match:
                continue
            name, args, result = match.groups()
            events.append((float(stamp), pid, index, name, args, result))
            if name in ("fork", "vfork", "clone", "clone3") and re.fullmatch(r"[1-9][0-9]*", result):
                parents[int(result)] = pid
    # Timestamps have microsecond resolution, so one process can log several
    # calls with the same stamp. Its own file order breaks those ties.
    events.sort(key=lambda event: event[:3])
    states = {}

    def state(pid):
        if pid not in states:
            parent = state(parents[pid]) if pid in parents else {"cwd": root, "active": False}
            states[pid] = dict(parent)
        return states[pid]

    def absolute(path, current):
        return os.path.normpath(path if path.startswith("/") else os.path.join(current["cwd"], path))

    def project_relative(path):
        relative = os.path.relpath(path, root).split("/")
        # SymlinkFarm::build_sync mirrors project-relative inputs, outputs and
        # scratch under a tempfile::TempDir. Its outputs may be gone when this
        # offline review runs, so recognize the precise recorded layout rather
        # than depending on surviving symlinks. Unwrap at most once and retain
        # the existing cell/package checks below; arbitrary sandbox files and
        # nested/lookalike mirrors must not acquire bootstrap provenance.
        if (len(relative) > 5 and relative[0] == "buck-out"
                and relative[2:4] == ["tmp", "sandbox"]
                and re.fullmatch(r"\.tmp[A-Za-z0-9]{6}", relative[4])):
            relative = relative[5:]
        return relative

    def bootstrap(path):
        relative = project_relative(path)
        if relative[:1] == ["bootstrap"] and len(relative) > 1:
            return True
        if relative[:2] == ["cellar", "bootstrap"] and len(relative) > 2:
            return True
        if len(relative) <= 5 or relative[0] != "buck-out" or relative[2] != "art" or relative[3] not in BOOTSTRAP_CELLS:
            return False
        package = relative[4:]
        # Content-based output paths put the package immediately after its
        # cell. Older Buck layouts insert a configuration hash there.
        if re.fullmatch(r"[0-9a-f]{16}", package[0]):
            package = package[1:]
        return len(package) > 1 and package[0] == "bootstrap"

    def allowed(path):
        relative = project_relative(path)
        scratch = len(relative) > 4 and relative[0] == "buck-out" and relative[2] == "tmp" and relative[3] in BOOTSTRAP_CELLS
        return bootstrap(path) or scratch or path == "/dev/null"

    def exec_path(name, args, quoted, current):
        """Resolve the executed path, or None when strace did not resolve dirfd."""
        path = ast.literal_eval(quoted[0])
        if name == "execve" or path.startswith("/"):
            return absolute(path, current)
        dirfd = args.split(",", 1)[0].strip()
        if dirfd == "AT_FDCWD":
            base = current["cwd"]
        else:
            match = re.fullmatch(r"[0-9]+<(/[^<>]*)(?:<[^>]*>)?>", dirfd)
            if not match:
                return None
            base = match[1]
        # fexecve passes the file itself as dirfd with an empty path.
        if not path and "AT_EMPTY_PATH" in args.rsplit(",", 1)[-1]:
            return os.path.normpath(base)
        return os.path.normpath(os.path.join(base, path))

    for _, pid, _, name, args, result in events:
        current = state(pid)
        success = not result.startswith("-1 ")
        quoted = re.findall(STRING, args)
        if name == "chdir" and success:
            current["cwd"] = absolute(ast.literal_eval(quoted[0]), current)
        elif name == "fchdir" and success:
            match = re.search(r"<(/[^<>]*)>", args)
            if match:
                current["cwd"] = match[1]
            elif current["active"]:
                errors.append({"pid": pid, "error": "unresolved fchdir", "args": args})
        if name in ("execve", "execveat"):
            path = exec_path(name, args, quoted, current)
            if path is None:
                errors.append({"pid": pid, "error": "unresolved execveat dirfd", "args": args})
                continue
            if success and bootstrap(path):
                current["active"] = True
            if success:
                current["executable"] = os.path.realpath(path)
            if current["active"]:
                if not bootstrap(os.path.realpath(path)):
                    errors.append({"pid": pid, "error": "executable outside bootstrap", "path": path})
                executables.add(path)
        if not current["active"]:
            continue
        processes.add(pid)
        counts[name] += 1
        if name in ("open", "openat", "openat2", "creat") and success:
            # Process substitution duplicates an existing pipe through /dev/fd.
            # Terminal tests use kernel PTY devices. Require strace's resolved
            # descriptor type as well as the precise device/descriptor path;
            # these exceptions must never admit regular host files.
            opened = ast.literal_eval(quoted[0]) if quoted else ""
            pipe = re.fullmatch(r"[0-9]+<pipe:\[[0-9]+\]>", result)
            descriptor_path = re.fullmatch(r"/(?:dev/fd|proc/(?:self|[0-9]+)/fd)/[0-9]+", opened)
            terminal = re.fullmatch(
                r"[0-9]+<(?:/dev/(?:ptmx|pts/ptmx)<char 5:2(?: @/dev/pts/[0-9]+)?>"
                r"|/dev/tty<char 5:0>"
                r"|/dev/pts/[0-9]+<char (?:13[6-9]|14[0-3]):[0-9]+>)>", result,
            )
            # GNU mktemp uses kernel entropy to choose private temporary names.
            # This is neither a host source file nor a compiler random seed.
            # Require the actual bootstrap executable and the resolved device
            # type; compilers and ordinary files retain the strict boundary.
            entropy = (
                os.path.basename(current.get("executable", "")) == "mktemp"
                and bootstrap(current.get("executable", "/"))
                and opened == "/dev/urandom"
                and re.fullmatch(r"[0-9]+</dev/urandom<char 1:9>>", result)
            )
            if entropy:
                kernel_channels["mktemp_entropy"] += 1
                continue
            if pipe and descriptor_path:
                kernel_channels["pipe_descriptor"] += 1
                continue
            if terminal:
                kernel_channels["terminal_device"] += 1
                continue
            match = re.match(r"[0-9]+<(/[^<>]*)(?:<[^>]*>)?>", result)
            if not match:
                errors.append({"pid": pid, "error": "unresolved successful open", "result": result})
            elif not allowed(match[1]):
                errors.append({"pid": pid, "error": "file outside bootstrap", "path": match[1]})
        if name in ("fork", "vfork", "clone", "clone3") and re.fullmatch(r"[1-9][0-9]*", result):
            # A child may first run before the parent's fork return is logged.
            # The parent map above also supplies inheritance in that case.
            child = int(result)
            if child not in states:
                states[child] = dict(current)
    for pid in pending:
        if state(pid)["active"]:
            errors.append({"pid": pid, "error": "unfinished syscall in bootstrap trace"})
    if not processes or not counts["open"] + counts["openat"] + counts["openat2"]:
        errors.append({"error": "trace did not contain bootstrap processes and file opens"})
    return {
        "workspace": root,
        "trace_files": len(files),
        "bootstrap_processes": len(processes),
        "executables": sorted(executables),
        "syscalls": dict(sorted(counts.items())),
        "kernel_channels": dict(sorted(kernel_channels.items())),
        "errors": errors,
        "scope": "bootstrap executables and successful file opens; configured graph audited separately",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--trace-prefix", required=True)
    args = parser.parse_args()
    report = review(args.workspace, args.trace_prefix)
    json.dump(report, sys.stdout, indent=2)
    print()
    return bool(report["errors"])


if __name__ == "__main__":
    sys.exit(main())
