#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""tailwind.css compiles the declared candidates with the web toolchain's compiler."""

from pathlib import Path
import sys

css = Path(sys.argv[1]).read_text(encoding="utf-8")
missing = [selector for selector in (".underline", ".text-center") if selector not in css]
if missing:
    sys.exit(f"compiled CSS lacks utilities used by declared srcs: {missing}")
