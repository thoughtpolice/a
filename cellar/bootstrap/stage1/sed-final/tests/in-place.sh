# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
sed=$1
chmod=$2
stat=$3
printf 'before\n' > input
"$chmod" 640 input
"$sed" -i.bak s/before/after/ input
[[ $(<input) == after && $(<input.bak) == before ]]
[[ $("$stat" -c %a input) == 640 ]]
printf 'passed\n' > passed
