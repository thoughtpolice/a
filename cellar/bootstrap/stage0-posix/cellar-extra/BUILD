# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Cellar's own helpers, which upstream stage0-posix does not have. M2-Mesoplanet
# builds them as it builds mescc-tools-extra. They live apart from the upstream
# copies so that check-upstream.sh can compare those unchanged.

load("@cellar//bootstrap/stage0-posix/mescc-tools-extra:defs.bzl", "create_all")

create_all(glob(["*.c"]))
