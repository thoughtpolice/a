#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Make the smallest CPython that runs the prelude's bootstrap scripts.

Run by the interpreter of a python-build-standalone install, with that
install's prefix and an output directory:

    make_runtime.py PREFIX OUT

Every action that runs a bootstrap script takes the interpreter as an
input, and so all of the files it needs to start: a whole install is
thousands of files, which a remote worker lays out for every such action.
This keeps three: the interpreter, libpython (which, in these builds, has
every extension module linked in, and which keeps all of its names, since
a bootstrap script may look it up through sysconfig), and the standard
library compiled into `pythonXY.zip`, which CPython puts on sys.path by
itself and whose presence tells it where its prefix is. GUI toolkits, the test suite and
the bundled pip are left out. The lib-dynload directory is kept, empty
but for a placeholder, since CPython warns at every start without it.

Paths and timestamps inside the zip are fixed, so a given install always
makes the same runtime.
"""

import os
import py_compile
import shutil
import sys
import tempfile
import zipfile

# Parts of the standard library the bootstrap scripts never use.
SKIP = {
    "__pycache__",
    "ensurepip",
    "idlelib",
    "site-packages",
    "test",
    "tkinter",
    "turtledemo",
}

ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def main() -> None:
    prefix, out = sys.argv[1:3]
    version = f"{sys.version_info.major}.{sys.version_info.minor}"
    stdlib = os.path.join(prefix, "lib", f"python{version}")

    os.makedirs(os.path.join(out, "bin"))
    shutil.copy2(
        os.path.join(prefix, "bin", f"python{version}"),
        os.path.join(out, "bin", "python3"),
    )
    lib = os.path.join(out, "lib")
    dynload = os.path.join(lib, f"python{version}", "lib-dynload")
    os.makedirs(dynload)
    # Some tools drop an empty directory; one with a file stays.
    open(os.path.join(dynload, ".keep"), "w").close()
    # The interpreter loads $ORIGIN/../lib/libpythonX.Y.so.1.0. The other
    # names are kept as the install has them, the unversioned symlink among
    # them: the prelude's gather_libpython_symbols finds libpython by the
    # name sysconfig gives (LDLIBRARY), and runs nm on it.
    for name in sorted(os.listdir(os.path.join(prefix, "lib"))):
        if not name.startswith("libpython"):
            continue
        source = os.path.join(prefix, "lib", name)
        if os.path.islink(source):
            os.symlink(os.readlink(source), os.path.join(lib, name))
        else:
            shutil.copy2(source, os.path.join(lib, name))

    archive = os.path.join(lib, f"python{version.replace('.', '')}.zip")
    with (
        tempfile.TemporaryDirectory() as scratch,
        zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zip,
    ):
        for root, dirs, files in os.walk(stdlib):
            dirs[:] = sorted(
                d for d in dirs if d not in SKIP and not d.startswith("config-")
            )
            for name in sorted(files):
                if not name.endswith(".py"):
                    continue
                source = os.path.join(root, name)
                path = os.path.relpath(source, stdlib)
                # Compiled ahead, without the sources: importing from the
                # zip then never compiles, and an unchecked hash ties the
                # bytecode to nothing that varies between machines.
                compiled = py_compile.compile(
                    source,
                    cfile=os.path.join(scratch, "module.pyc"),
                    dfile=path,
                    doraise=True,
                    invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
                )
                info = zipfile.ZipInfo(path + "c", ZIP_DATE)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                with open(compiled, "rb") as f:
                    zip.writestr(info, f.read())


if __name__ == "__main__":
    main()
