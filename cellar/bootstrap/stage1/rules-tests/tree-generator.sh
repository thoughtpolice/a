# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
. "$1/private.sh"
test "$TREE_VALUE" = 'declared tree'
# The test passes no output; the generator writes the value to its output.
if test $# -gt 1; then
    printf '%s\n' "$TREE_VALUE" > "$2"
fi
