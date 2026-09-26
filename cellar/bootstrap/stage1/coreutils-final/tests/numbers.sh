# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "coreutils test failed at line $LINENO" >&2' ERR
bin=$1
export PATH="$bin"
[[ $(seq -s, 0.5 0.5 2) == 0.5,1.0,1.5,2.0 ]]
[[ $(expr 9223372036854775806 + 1) == 9223372036854775807 ]]
[[ $(expr abc123 : 'abc\([0-9]*\)') == 123 ]]
[[ $(factor 1234567890) == '1234567890: 2 3 3 5 3607 3803' ]]
[[ $("$bin/printf" '%020d %.3f' 42 1.25) == '00000000000000000042 1.250' ]]
"$bin/test" 9223372036854775807 -gt 2147483647
"$bin/[" 4 -eq 4 ']'
"$bin/true"
if "$bin/false"; then exit 1; fi
if expr 9223372036854775807 + 1 > overflow 2>&1; then exit 1; fi
printf '12345678' > small
dd if=small of=sparse bs=1 count=8 seek=4294967296 2>dd-log
[[ $(stat -c %s sparse) == 4294967304 ]]
[[ $(tail -c8 sparse) == 12345678 ]]
rm sparse
printf 'passed\n' > passed
