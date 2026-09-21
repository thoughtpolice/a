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


def review(root, prefix):
    root = os.path.realpath(root)
    events, parents, pending = [], {}, {}
    errors, processes, executables = [], set(), set()
    counts = Counter()
    files = sorted(glob.glob(prefix + ".[0-9]*"))
    if not files:
        raise ValueError("no per-process trace files matched " + prefix)
    for filename in files:
        pid = int(filename.rsplit(".", 1)[1])
        for line in Path(filename).read_text().splitlines():
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
            events.append((float(stamp), pid, name, args, result))
            if name in ("fork", "vfork", "clone", "clone3") and re.fullmatch(r"[1-9][0-9]*", result):
                parents[int(result)] = pid
    events.sort()
    states = {}

    def state(pid):
        if pid not in states:
            parent = state(parents[pid]) if pid in parents else {"cwd": root, "active": False}
            states[pid] = dict(parent)
        return states[pid]

    def absolute(path, current):
        return os.path.normpath(path if path.startswith("/") else os.path.join(current["cwd"], path))

    def bootstrap(path):
        if path.startswith(root + "/cellar/bootstrap/"):
            return True
        relative = os.path.relpath(path, root).split("/")
        return len(relative) > 5 and relative[0] == "buck-out" and relative[2:5] == ["art", "depot-cellar", "bootstrap"]

    def allowed(path):
        relative = os.path.relpath(path, root).split("/")
        scratch = len(relative) > 4 and relative[0] == "buck-out" and relative[2:4] == ["tmp", "depot-cellar"]
        return bootstrap(path) or scratch or path == "/dev/null"

    for _, pid, name, args, result in events:
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
            path = absolute(ast.literal_eval(quoted[0]), current)
            if success and bootstrap(path):
                current["active"] = True
            if current["active"]:
                if not bootstrap(os.path.realpath(path)):
                    errors.append({"pid": pid, "error": "executable outside bootstrap", "path": path})
                executables.add(path)
        if not current["active"]:
            continue
        processes.add(pid)
        counts[name] += 1
        if name in ("open", "openat", "openat2", "creat") and success:
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
