# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run a Python script from a source tree as __main__.

Third-party build scripts (code generators and the like) import helper
modules from the directory they live in, which Python puts first on
sys.path only for a script it is asked to run directly. This does the same
for the script named on the command line, so that one python_binary can run
any of them from a source archive, whose files Buck's Python rules can't
take as their own sources:

    $(exe root//buck/tools/run-script:run-script) $(location :src)/gen.py ARGS...
"""

import os
import runpy
import sys

if len(sys.argv) < 2:
    sys.exit("usage: run-script SCRIPT [ARGS...]")

script = sys.argv[1]
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
runpy.run_path(script, run_name="__main__")
