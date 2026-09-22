# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
. "$1/private.sh"
test "$TREE_VALUE" = 'declared tree'
printf '%s\n' "$TREE_VALUE" > "$2"
