# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The build steps Slang's CMake build performs itself, for build.bzl's
rules: the same on every host, with no shell.

    step.py run --out DIR [--cwd DIR] [--scratch NAME PATH]... [--unchanged NAME]...
        -- COMMAND... [&& COMMAND...]

add_custom_command(): runs each command in turn from the working directory
(the current one by default), stopping at the first that fails. In the
commands, $OUT stands for the output directory, made first, $SCRATCH for a
scratch directory, and $ROOT for the directory step.py started in, which
the rules put before every path so that the paths still hold after the
working directory changes. Each --scratch copies PATH, a file or directory,
to $SCRATCH/NAME, writable; each --unchanged NAME then fails the step if
the command changed that copy.

    step.py configure TEMPLATE OUTPUT NAME=VALUE...

configure_file(... @ONLY): TEMPLATE with each @NAME@ replaced by VALUE. An
@NAME@ without a value is an error, rather than CMake's empty string, so
that a template that grows a variable is noticed.

    step.py install DIR [--file PATH SOURCE]... [--symlink PATH TARGET]...

install(): DIR, holding a copy of each SOURCE at PATH and a symbolic link
to TARGET (relative to the link) at each symlink PATH.
"""

import argparse
import filecmp
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile


def make_writable(path):
    for dirpath, dirnames, filenames in os.walk(path):
        for name in dirnames + filenames:
            target = os.path.join(dirpath, name)
            os.chmod(target, os.stat(target).st_mode | stat.S_IWUSR)
    os.chmod(path, os.stat(path).st_mode | stat.S_IWUSR)


def differences(left, right):
    """The paths, relative to `left`, at which the trees `left` and `right`
    differ."""
    if os.path.isfile(left) or os.path.isfile(right):
        same = os.path.isfile(left) and os.path.isfile(right) and filecmp.cmp(left, right, shallow=False)
        return [] if same else ["."]
    found = []
    comparison = filecmp.dircmp(left, right)
    found += comparison.left_only + comparison.right_only + comparison.common_funny
    for name in comparison.common_files:
        if not filecmp.cmp(os.path.join(left, name), os.path.join(right, name), shallow=False):
            found.append(name)
    for name in comparison.common_dirs:
        found += [os.path.join(name, d) for d in differences(os.path.join(left, name), os.path.join(right, name))]
    return sorted(found)


def run(argv):
    parser = argparse.ArgumentParser(prog="step.py run")
    parser.add_argument("--out", required=True)
    parser.add_argument("--cwd")
    parser.add_argument("--scratch", nargs=2, action="append", default=[], metavar=("NAME", "PATH"))
    parser.add_argument("--unchanged", action="append", default=[])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    commands = [[]]
    for arg in command:
        if arg == "&&":
            commands.append([])
        else:
            commands[-1].append(arg)
    if not all(commands):
        parser.error("an empty command")

    root = os.getcwd()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    with tempfile.TemporaryDirectory() as scratch:
        variables = {"ROOT": root, "OUT": out, "SCRATCH": scratch}

        def expand(arg):
            return re.sub(r"\$(ROOT|OUT|SCRATCH)\b", lambda m: variables[m.group(1)], arg)

        originals = {}
        for name, path in args.scratch:
            source = expand(path)
            copy = os.path.join(scratch, name)
            if os.path.isdir(source):
                shutil.copytree(source, copy, symlinks=False)
            else:
                shutil.copyfile(source, copy)
            make_writable(copy)
            originals[name] = source

        cwd = expand(args.cwd) if args.cwd else root
        for argv in commands:
            result = subprocess.run([expand(arg) for arg in argv], cwd=cwd)
            if result.returncode != 0:
                return result.returncode

        failed = False
        for name in args.unchanged:
            changed = differences(os.path.join(scratch, name), originals[name])
            for path in changed:
                print("step.py: the command changed {}".format(os.path.normpath(os.path.join(name, path))), file=sys.stderr)
            failed = failed or bool(changed)
        return 1 if failed else 0


def configure(argv):
    if len(argv) < 2:
        sys.exit("usage: step.py configure TEMPLATE OUTPUT NAME=VALUE...")
    template, output = argv[:2]
    values = dict(arg.split("=", 1) for arg in argv[2:])

    def substitute(match):
        name = match.group(1)
        if name not in values:
            sys.exit("step.py: {} uses @{}@, which has no value".format(template, name))
        return values[name]

    # Line endings stay as the template has them, as configure_file()
    # leaves them.
    with open(template, encoding="utf-8", newline="") as f:
        text = re.sub(r"@([A-Za-z_][A-Za-z0-9_]*)@", substitute, f.read())
    with open(output, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return 0


def install(argv):
    parser = argparse.ArgumentParser(prog="step.py install")
    parser.add_argument("dir")
    parser.add_argument("--file", nargs=2, action="append", default=[], metavar=("PATH", "SOURCE"))
    parser.add_argument("--symlink", nargs=2, action="append", default=[], metavar=("PATH", "TARGET"))
    args = parser.parse_args(argv)

    for path, source in args.file:
        destination = os.path.join(args.dir, path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copy2(source, destination)
    for path, target in args.symlink:
        destination = os.path.join(args.dir, path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        os.symlink(target, destination)
    return 0


STEPS = {
    "configure": configure,
    "install": install,
    "run": run,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in STEPS:
        sys.exit("usage: step.py {} ...".format("|".join(sorted(STEPS))))
    sys.exit(STEPS[sys.argv[1]](sys.argv[2:]))
