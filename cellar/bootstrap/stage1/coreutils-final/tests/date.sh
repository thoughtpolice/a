# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "coreutils test failed at line $LINENO" >&2' ERR
bin=$1
export PATH="$bin"
[[ $(date -d '@0' '+%Y-%m-%dT%H:%M:%S%z') == 1970-01-01T00:00:00+0000 ]]
[[ $(date -d '2000-02-28 12:34:56 UTC +1 day' '+%F %T') == '2000-02-29 12:34:56' ]]
[[ $(date -d '2000-03-01 00:00:00 UTC -1 day' '+%F') == 2000-02-29 ]]
[[ $(date -d '2040-01-01 UTC' +%s) == 2208988800 ]]
[[ $(date -d '@1.123456789' '+%s.%N') == 1.123456789 ]]
if date -d invalid-date > rejected 2>&1; then exit 1; fi
touch -d '2000-01-01 00:00:00 UTC' stamp
[[ $(stat -c %Y stamp) == 946684800 ]]
[[ $(date -r stamp '+%F') == 2000-01-01 ]]
printf 'passed\n' > passed
