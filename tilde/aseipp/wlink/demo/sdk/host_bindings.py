# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Give wasm2c's generated HAL declarations readable SDK names.

The WIT component controls the ABI; wasm2c controls C names and prototypes.
Read its annotated declarations instead of maintaining another name mangler
or a second copy of the HAL signatures in the native implementation.
"""

import re
import sys
from pathlib import Path


def unescape(name):
    return re.sub(r"\\([0-9A-Fa-f]{2})", lambda m: chr(int(m[1], 16)), name)


def generate(header):
    aliases = {}
    context = None

    def alias(name, symbol):
        if name in aliases and aliases[name] != symbol:
            raise ValueError(f"ambiguous HAL binding: {name}")
        aliases[name] = symbol

    for match in re.finditer(r"/\* (import|export): (.*?) \*/\n([^\n]+);", header):
        kind, annotation, declaration = match.groups()
        names = [unescape(n) for n in re.findall(r"'([^']*)'", annotation)]
        symbol = re.search(r"\b(w2c_\w+)\(", declaration)
        if not symbol:
            continue
        if kind == "import":
            module, function = names
            if not module.startswith("console:hal/raw@"):
                raise ValueError(f"unexpected console import: {module}")
            ctx = re.search(r"\(struct (\w+)\*", declaration)
            if not ctx or (context is not None and context != ctx[1]):
                raise ValueError("console host requires one HAL import context")
            context = ctx[1]
            alias("console_hal_" + function.replace("-", "_"), symbol[1])
        elif names[0] in ("game:memory", "platform:memory"):
            alias("console_" + names[0].replace(":", "_"), symbol[1])
        elif "-" in names[0] and ":" not in names[0]:
            alias("console_" + names[0].replace("-", "_"), symbol[1])
        elif names[0].startswith("wlink:import:console:hal/raw@"):
            function, helper = names[0].split("#", 1)[1].rsplit(":", 1)
            alias("console_hal_" + function.replace("-", "_") + "_" + helper.replace("-", "_"), symbol[1])

    if context is None:
        raise ValueError("no annotated wasm2c HAL declarations found")
    lines = [
        "// Generated from wasm2c declarations of the linked WIT components.",
        "#ifndef CONSOLE_HAL_HOST_H",
        "#define CONSOLE_HAL_HOST_H",
        '#include "linked.h"',
        f"#define console_hal_context {context}",
        "typedef struct console_hal_context console_hal_t;",
    ]
    lines += [f"#define {name} {symbol}" for name, symbol in sorted(aliases.items())]
    return "\n".join(lines + ["#endif", ""])


if __name__ == "__main__":
    Path(sys.argv[2]).write_text(generate(Path(sys.argv[1]).read_text()))
