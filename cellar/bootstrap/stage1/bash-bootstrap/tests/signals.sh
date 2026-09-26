# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
seen=no
trap 'seen=yes' USR1
kill -USR1 $$
[ "$seen" = yes ]
(exit 7) & child=$!
if wait "$child"; then exit 1; else [ "$?" = 7 ]; fi
set -m
(exit 0) & child=$!
wait "$child"
set +m
[ "$(kill -l TERM)" = 15 ]
printf 'signal traps, jobs and wait pass\n'
