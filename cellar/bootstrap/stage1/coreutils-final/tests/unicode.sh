# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "coreutils test failed at line $LINENO" >&2' ERR
bin=$1
export PATH="$bin"
export LC_ALL=C.UTF-8
printf 'é界\n' > unicode
[[ $(wc -m < unicode | tr -d ' ') == 3 ]]
[[ $(wc -c < unicode | tr -d ' ') == 6 ]]
[[ $(wc -L < unicode | tr -d ' ') == 3 ]]
[[ $("$bin/printf" '\u00e9\u754c') == é界 ]]
[[ $(expr é界 : '..') == 5 ]]
printf 'passed\n' > passed
