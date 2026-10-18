# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run one of QEMU's build scripts as __main__.

QEMU's generators (qapi-gen.py, tracetool.py, decodetree.py, ...) import
their helper packages from the directory they live in, which Python puts
first on sys.path only for a script it is asked to run directly. This does
the same for a script named on the command line, so one python_binary can
run them all from the source archive.
"""

import os
import runpy
import sys

script = sys.argv[1]
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
runpy.run_path(script, run_name="__main__")
