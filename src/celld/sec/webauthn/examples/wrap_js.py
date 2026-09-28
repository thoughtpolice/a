# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Wrap a bundled script as a TypeScript module whose default export is its
text, so a Worker can serve it: `wrap_js.py BUNDLE OUT`."""

import json
import sys

HEADER = """// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The passkeys example's page script, bundled. Written by the build. */
"""


def main() -> None:
    bundle, out = sys.argv[1:]
    with open(bundle, encoding="utf-8") as f:
        script = f.read()
    with open(out, "w", encoding="utf-8") as f:
        f.write(HEADER)
        f.write(f"const script: string = {json.dumps(script)};\n")
        f.write("export default script;\n")


if __name__ == "__main__":
    main()
