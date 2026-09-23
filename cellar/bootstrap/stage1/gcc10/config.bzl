# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

def mkconfig(guard, includes, defines = [], header = None, after = ""):
    """Reproduce gcc/mkconfig.sh for one configuration header."""
    lines = ["#ifndef " + guard, "#define " + guard]
    if guard == "GCC_CONFIG_H":
        lines += [
            "#ifdef GENERATOR_FILE",
            "#error config.h is for the host, not build, machine.",
            "#endif",
        ]
    for name, value in defines:
        lines += [
            "#ifndef " + name,
            "# define " + name + (" " + value if value else ""),
            "#endif",
        ]
    if header:
        lines.append('#include "' + header + '"')
    if includes:
        lines.append("#ifdef IN_GCC")
        lines += ['# include "' + name + '"' for name in includes]
        lines.append("#endif")
    return "\n".join(lines) + "\n" + after + "#endif /* " + guard + " */\n"
