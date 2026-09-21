#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check explicit bootstrap imports; complements audit.bxl's configured closure.

This is validation tooling, not a build action or a compiler bootstrap input.
Buck's automatic prelude injection is reported by the BXL audit separately.
"""

from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parent
errors = []
count = 0
for source in sorted(root.rglob("*")):
    if source.suffix not in (".bzl", ".bxl") and source.name not in ("BUILD", "BUCK"):
        continue
    count += 1
    for module in re.findall(r'''\bload\(\s*["']([^"']+)["']''', source.read_text()):
        if not module.startswith((":", "@cellar//", "cellar//")):
            errors.append(f"{source.relative_to(root)}: external import {module}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"All explicit imports in {count} bootstrap Starlark files stay in cellar.")
