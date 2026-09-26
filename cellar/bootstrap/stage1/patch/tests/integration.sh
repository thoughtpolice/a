# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu -o pipefail
trap 'printf "patch integration line %s failed (%s)\n" "$LINENO" "$?" >&2' ERR
patch=$1; diff=$2; cmp=$3
printf 'one\ntwo\nthree\n' > old
printf 'one\nTWO\nthree\nfour\n' > new
for format in -u -c ''; do
  printf 'one\ntwo\nthree\n' > sample
  status=0
  "$diff" $format --label sample --label sample old new > changes || status=$?
  [[ $status == 1 ]]
  "$patch" --batch --posix --input changes sample
  "$cmp" sample new
  "$patch" --batch --posix --reverse --input changes sample
  "$cmp" sample old
done
# Use one context-bearing hunk so rejection cannot partially apply an addition.
status=0
"$diff" -u --label sample --label sample old new > changes || status=$?
[[ $status == 1 ]]
printf 'unrelated text\n' > sample
status=0
"$patch" --batch --forward --input changes sample > rejected || status=$?
[[ $status == 1 && $(<sample) == 'unrelated text' && -s sample.rej ]]
printf '%s\n' '--- old' '+++ new' '@@ invalid hunk header' > malformed
status=0
"$patch" --batch --dry-run --input malformed > invalid 2>&1 || status=$?
[[ $status == 2 ]]
printf 'passed\n' > passed
