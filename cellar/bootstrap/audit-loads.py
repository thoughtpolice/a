#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check explicit cellar imports; complements audit.bxl's configured closure.

This is validation tooling, not a build action or a compiler bootstrap input.
Buck's automatic imports are checked by the BXL audit as well.
"""

from pathlib import Path
import os
import re
import sys

root = Path(__file__).resolve().parent.parent
errors = []
count = 0
sources = []
for directory, children, files in os.walk(root):
    children[:] = [name for name in children if name != "buck-out"]
    sources.extend(Path(directory) / name for name in files)
for source in sorted(sources):
    if source.suffix not in (".bzl", ".bxl") and source.name not in ("BUILD", "BUCK", "PACKAGE"):
        continue
    count += 1
    for module in re.findall(r'''\bload\(\s*["']([^"']+)["']''', source.read_text()):
        if not module.startswith((":", "@cellar//")):
            errors.append(f"{source.relative_to(root)}: external import {module}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"All explicit imports in {count} cellar Starlark files stay in cellar.")
