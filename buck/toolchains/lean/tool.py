#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Action helper for the Lean toolchain.

Every Lean action runs through here, so that the `lean`, `leanir`, `leanc`
and `leanchecker` invocations live in one place and the setup files they
read are written at execution time, from the artifacts Buck hands over.

Subcommands:
  toolchain  check the Lean on PATH against the pinned version, and write
             the C include and link flags of its runtime
  deps       parse the import headers of a library's sources
  elab       elaborate one module into .olean/.ilean (and C, when the
             module is compiled in one step)
  ir         generate IR and C for a module elaborated with
             compiler.postponeCompile
  check      replay modules through the kernel with leanchecker

Imports are passed as NAME=DIR[,DIR...]. Each directory belongs to one
module and holds some of NAME.olean, NAME.olean.server, NAME.olean.private,
NAME.ir.sig and NAME.ir; whichever of those exist go into the setup file's
importArts, in the positions Lean expects. A module compiled from a
non-module file only has NAME.olean, and an importer that does not need IR
is never handed the directory holding it.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

OLEAN_LEVELS = [".olean", ".olean.server", ".olean.private"]
IR_LEVELS = [".ir.sig", ".ir"]


def fail(msg: str):
    print("lean toolchain: " + msg, file=sys.stderr)
    sys.exit(1)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, **kwargs)
    except FileNotFoundError:
        fail("'{}' is not on PATH; enter the Nix shell (buck/etc/nix)".format(cmd[0]))


def lean_version() -> str:
    out = run(["lean", "--version"], capture_output=True, text=True, check=True).stdout
    m = re.match(r"Lean \(version ([^,]+),", out)
    if not m:
        fail("cannot parse 'lean --version' output: {!r}".format(out))
    return m.group(1)


def import_arts(imports: list[str]) -> dict:
    """Build importArts from NAME=DIR[,DIR...] arguments."""
    arts = {}
    for spec in imports:
        name, _, dirs = spec.partition("=")
        found = {}
        for d in dirs.split(","):
            for suffix in OLEAN_LEVELS + IR_LEVELS:
                path = os.path.join(d, name + suffix)
                if os.path.exists(path):
                    found[suffix] = os.path.abspath(path)
        if ".olean" not in found:
            fail("no {}.olean in {}".format(name, dirs))

        # Positional: [olean, server?, private?] then [ir.sig, ir?]. Lean reads
        # a missing tail as "this level does not exist".
        oleans = []
        for suffix in OLEAN_LEVELS:
            if suffix not in found:
                break
            oleans.append(found[suffix])
        entry = [oleans]
        irs = []
        for suffix in IR_LEVELS:
            if suffix not in found:
                break
            irs.append(found[suffix])
        if irs:
            entry.append(irs)
        arts[name] = entry
    return arts


def write_setup(tmp: str, args, arts: dict, options: dict) -> str:
    setup = {
        "name": args.module,
        "package": args.package,
        "isModule": False,
        "importArts": arts,
        "dynlibs": [],
        "plugins": [],
        "options": options,
    }
    path = os.path.join(tmp, "setup.json")
    with open(path, "w") as f:
        json.dump(setup, f)
    return path


def report(proc: subprocess.CompletedProcess, what: str):
    """Pass Lean's messages through and fail the action if Lean failed.

    Lean prints its diagnostics on stdout; Buck shows an action's stderr on
    failure, so they move there.
    """
    if proc.stdout:
        sys.stderr.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        fail("{} failed with exit code {}".format(what, proc.returncode))


# MARK: toolchain


def cmd_toolchain(args):
    with open(args.nix_expr) as f:
        m = re.search(r'^\s*version = "([^"]+)";', f.read(), re.MULTILINE)
    if not m:
        fail("no version in {}".format(args.nix_expr))
    pinned = m.group(1)
    found = lean_version()
    if found != pinned:
        fail(
            "the lean on PATH is {}, but {} builds {}. Reload the Nix shell "
            "(direnv reload), then restart Buck (buck2 kill) so its actions "
            "see the new PATH.".format(found, args.nix_expr, pinned)
        )

    cflags = run(["leanc", "--print-cflags"], capture_output=True, text=True, check=True).stdout.split()
    ldflags = run(["leanc", "--print-ldflags"], capture_output=True, text=True, check=True).stdout.split()

    # --print-ldflags repeats the cflags first.
    if ldflags[: len(cflags)] != cflags:
        fail("unexpected 'leanc --print-ldflags' output: {}".format(ldflags))
    ldflags = ldflags[len(cflags) :]

    include = []
    codegen = []
    i = 0
    while i < len(cflags):
        if cflags[i] == "-I":
            include += cflags[i : i + 2]
            i += 2
        else:
            codegen.append(cflags[i])
            i += 1
    if codegen != args.expect_cflags:
        fail(
            "leanc compiles generated C with {} but LEAN_C_FLAGS in "
            "buck/toolchains/lean/defs.bzl says {}; update it".format(codegen, args.expect_cflags)
        )

    # The Nix ld wrapper adds a runpath for -L directories but not for shared
    # objects named by absolute path (gmp, openssl), and lld bypasses the
    # wrapper altogether.
    rpaths = []
    for i, flag in enumerate(ldflags):
        if flag.startswith("/") and ".so" in os.path.basename(flag):
            rpaths.append(os.path.dirname(flag))
        elif flag.startswith("-L") and flag != "-L":
            rpaths.append(flag[2:])
        elif flag == "-L":
            rpaths.append(ldflags[i + 1])
    libdir = os.path.join(run(["lean", "--print-prefix"], capture_output=True, text=True, check=True).stdout.strip(), "lib", "lean")
    for d in dict.fromkeys(rpaths):
        if d != libdir:
            ldflags.append("-Wl,-rpath," + d)

    with open(args.cflags_out, "w") as f:
        f.write(" ".join(include) + "\n")
    with open(args.ldflags_out, "w") as f:
        f.write(" ".join(ldflags) + "\n")


# MARK: deps


def cmd_deps(args):
    modules = []
    files = []
    for spec in args.module:
        name, _, src = spec.partition("=")
        modules.append(name)
        files.append(src)

    proc = run(
        ["lean", "--deps-json", "--stdin"],
        input="\n".join(files) + "\n",
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        report(proc, "lean --deps-json")
    headers = json.loads(proc.stdout)["imports"]
    if len(headers) != len(files):
        fail("lean --deps-json returned {} headers for {} files".format(len(headers), len(files)))

    graph = {}
    errors = []
    for name, src, header in zip(modules, files, headers):
        if header.get("errors"):
            errors += ["{}: {}".format(src, e) for e in header["errors"]]
            continue
        result = header["result"]
        graph[name] = {
            "isModule": result["isModule"],
            "imports": [
                {
                    "module": i["module"],
                    "meta": i["isMeta"],
                    "all": i["importAll"],
                }
                for i in result["imports"]
            ],
        }
    if errors:
        fail("cannot parse imports:\n  " + "\n  ".join(errors))

    with open(args.out, "w") as f:
        json.dump(graph, f, indent=1, sort_keys=True)
        f.write("\n")


# MARK: elab


def cmd_elab(args):
    options = json.loads(args.options)
    if args.postpone:
        options["compiler.postponeCompile"] = True

    os.makedirs(args.elab_out, exist_ok=True)
    for d in args.empty_dirs:
        os.makedirs(d, exist_ok=True)
    if args.c_out:
        os.makedirs(os.path.dirname(args.c_out) or ".", exist_ok=True)

    cmd = ["lean", args.src]
    with tempfile.TemporaryDirectory() as tmp:
        cmd += ["--setup", write_setup(tmp, args, import_arts(args.imports), options)]
        cmd += [
            "-o",
            os.path.join(args.elab_out, args.module + ".olean"),
            "-i",
            os.path.join(args.elab_out, args.module + ".ilean"),
        ]
        if args.c_out:
            cmd += ["-c", args.c_out]
        if not args.allow_sorry:
            cmd += ["-E", "hasSorry"]
        cmd += args.lean_flags
        report(run(cmd, capture_output=True, text=True), "lean " + args.module)


# MARK: ir


def cmd_ir(args):
    for d in [args.ir_out, args.sig_out, os.path.dirname(args.c_out) or "."]:
        os.makedirs(d, exist_ok=True)

    # leanir imports the module itself with `import all`, which needs every
    # level of its own olean, and only the .ir.sig of what it imports.
    arts = import_arts(args.imports)
    arts.update(import_arts(["{}={}".format(args.module, args.self_dir)]))

    with tempfile.TemporaryDirectory() as tmp:
        setup = write_setup(tmp, args, arts, json.loads(args.options))
        ir = os.path.join(args.ir_out, args.module + ".ir")
        cmd = ["leanir", setup, ir, args.c_out]
        report(run(cmd, capture_output=True, text=True), "leanir " + args.module)

    # leanir writes NAME.ir.sig beside NAME.ir. The signature is all that
    # an importer's leanir reads, so it gets a directory of its own, and a
    # change to code that keeps the signature reruns nothing downstream.
    os.replace(ir + ".sig", os.path.join(args.sig_out, args.module + ".ir.sig"))


# MARK: check


def cmd_check(args):
    """Replay modules through the kernel.

    leanchecker finds modules on LEAN_PATH by walking it and turning file
    paths back into module names with realpath, so a tree of symlinks into
    buck-out does not work. Hard links (or copies across filesystems) do.
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "lib")
        for spec in args.imports:
            name, _, dirs = spec.partition("=")
            dest_dir = os.path.join(root, *name.split(".")[:-1])
            os.makedirs(dest_dir, exist_ok=True)
            leaf = name.split(".")[-1]
            for d in dirs.split(","):
                for suffix in OLEAN_LEVELS + IR_LEVELS:
                    src = os.path.join(d, name + suffix)
                    if not os.path.exists(src):
                        continue
                    dest = os.path.join(dest_dir, leaf + suffix)
                    try:
                        os.link(src, dest)
                    except OSError:
                        shutil.copyfile(src, dest)

        env = dict(os.environ, LEAN_PATH=root)
        proc = run(["leanchecker"] + args.modules, env=env, capture_output=True, text=True)
        report(proc, "leanchecker")
        print("leanchecker: {} module(s) replayed".format(len(args.modules)))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("toolchain")
    p.add_argument("--nix-expr", required=True)
    p.add_argument("--expect-cflag", dest="expect_cflags", action="append", default=[])
    p.add_argument("--cflags-out", required=True)
    p.add_argument("--ldflags-out", required=True)
    p.set_defaults(func=cmd_toolchain)

    p = sub.add_parser("deps")
    p.add_argument("--module", action="append", default=[], help="NAME=SRC")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_deps)

    for name, func in [("elab", cmd_elab), ("ir", cmd_ir)]:
        p = sub.add_parser(name)
        p.add_argument("--module", required=True)
        p.add_argument("--package", required=True)
        p.add_argument("--options", default="{}")
        p.add_argument("--import", dest="imports", action="append", default=[], help="NAME=DIR[,DIR...]")
        p.add_argument("--c-out")
        p.set_defaults(func=func)
    elab = sub.choices["elab"]
    elab.add_argument("--src", required=True)
    elab.add_argument("--elab-out", required=True)
    elab.add_argument("--empty-dir", dest="empty_dirs", action="append", default=[], help="an IR directory this module leaves empty")
    elab.add_argument("--postpone", action="store_true")
    elab.add_argument("--allow-sorry", action="store_true")
    elab.add_argument("--lean-flag", dest="lean_flags", action="append", default=[])
    ir = sub.choices["ir"]
    ir.add_argument("--self-dir", required=True)
    ir.add_argument("--ir-out", required=True)
    ir.add_argument("--sig-out", required=True)

    p = sub.add_parser("check")
    p.add_argument("--import", dest="imports", action="append", default=[], help="NAME=DIR[,DIR...]")
    p.add_argument("modules", nargs="+")
    p.set_defaults(func=cmd_check)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
