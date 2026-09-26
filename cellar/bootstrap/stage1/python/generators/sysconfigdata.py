# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Writes the _sysconfigdata module sysconfig reads, as "python -m sysconfig
# --generate-posix-vars" writes it from the Makefile and pyconfig.h. The
# arguments are pyconfig.h, the Makefile's variables as NAME=VALUE, numbers
# becoming integers as sysconfig's Makefile parser makes them, and the
# output. pyconfig.h is parsed and the module printed by sysconfig's own
# functions.

import sys
import sysconfig
from sysconfig.__main__ import _print_config_dict

config_h, *assignments, output = sys.argv[1:]
variables = {}
for assignment in assignments:
    name, _, value = assignment.partition("=")
    try:
        variables[name] = int(value)
    except ValueError:
        variables[name] = value
with open(config_h, encoding="utf-8") as file:
    sysconfig.parse_config_h(file, variables)
with open(output, "w", encoding="utf8") as file:
    file.write("# system configuration generated and used by the sysconfig module\n")
    file.write("build_time_vars = ")
    _print_config_dict(variables, stream=file)
