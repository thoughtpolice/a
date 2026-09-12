# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Turn compiled cart bytecode into a C array, for guests that carry one."""

import pathlib
import sys


def main():
    source, output, symbol = sys.argv[1:]
    data = pathlib.Path(source).read_bytes()
    rows = [
        "    " + " ".join(f"0x{byte:02x}," for byte in data[at:at + 12])
        for at in range(0, len(data), 12)
    ]
    pathlib.Path(output).write_text(
        "// SPDX-FileCopyrightText: © 2026 Austin Seipp\n"
        "// SPDX-License-Identifier: Apache-2.0\n\n"
        f"// Generated from {pathlib.Path(source).name}.\n\n"
        f"static const unsigned char {symbol}[] = {{\n" + "\n".join(rows) + "\n};\n"
    )


if __name__ == "__main__":
    main()
