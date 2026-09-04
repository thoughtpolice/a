#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Unpack a verified release artifact and make the resulting CLI executable.

set -euo pipefail

gzip -dc -- "$1" > "$2"
chmod +x -- "$2"
