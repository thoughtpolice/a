# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu -o pipefail
trap 'printf "diffutils integration line %s failed (%s)\n" "$LINENO" "$?" >&2' ERR
diff=$1; cmp=$2; diff3=$3; sdiff=$4
status=0
"$diff" -u --label base --label left source/base source/left > changes || status=$?
[[ $status == 1 ]]; "$cmp" changes source/unified
"$diff" source/base source/base
status=0; "$cmp" source/base source/left >/dev/null || status=$?; [[ $status == 1 ]]
"$diff3" -m source/left source/base source/right > merged
"$cmp" merged source/merged
status=0
printf 'r\n' | "$sdiff" -o selected source/base source/left > side || status=$?
[[ $status == 1 ]]; "$cmp" selected source/left
printf 'stamp old\nvalue\n' > stamp1
printf 'stamp new\nvalue\n' > stamp2
"$diff" -I '^stamp' stamp1 stamp2
printf '\000\001\377binary' > binary1
printf '\000\001\377binary' > binary2
"$cmp" binary1 binary2
printf 'aab\n' > regex1; printf 'abab\n' > regex2
"$diff" -I '^\(a\|ab\)+$' regex1 regex2
printf 'abbbab\n' > regex1; printf 'aabab\n' > regex2
"$diff" -I '^\(ab*\)+$' regex1 regex2
printf 'aabx\n' > regex2
status=0; "$diff" -I '^\(ab*\)+$' regex1 regex2 > regex-diff || status=$?
[[ $status == 1 ]]
printf 'passed\n' > passed
