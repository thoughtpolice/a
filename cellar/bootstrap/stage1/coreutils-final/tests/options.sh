# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "coreutils test failed at line $LINENO" >&2' ERR
bin=$1
export PATH="$bin"
printf 'a\nb\n' > input
# GNU argument permutation, long options and -- must work with musl.
[[ $(cat input --number) == $'     1\ta\n     2\tb' ]]
[[ $(head input --lines=1) == a ]]
printf literal > ./-n
[[ $(cat -- -n) == literal ]]
[[ $(basename /a/b.txt .txt) == b ]]
[[ $(dirname /a/b.txt) == /a ]]
[[ $(env -i PATH="$bin" TEST=works printenv TEST) == works ]]
[[ $(pwd -P) == "$PWD" ]]
if cat missing-file > missing 2>&1; then exit 1; fi
if head --unknown-option input > invalid 2>&1; then exit 1; fi
printf '0\n' > random
shuf --random-source=random -i1-3 > shuffled
[[ $(sort -n shuffled) == $'1\n2\n3' ]]
printf 'passed\n' > passed
