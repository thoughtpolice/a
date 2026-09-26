# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
result=$(printf 'alpha\nbeta\n' | while read word; do printf '<%s>' "$word"; done)
[ "$result" = '<alpha><beta>' ]
read first second <<'INPUT'
one two
INPUT
[ "$first:$second" = one:two ]
result=$(value=inner; printf '%s' "$value")
[ "$result" = inner ]
(printf 'x\ny\n' | { read a; read b; [ "$a$b" = xy ]; })
f() { printf '%s' "$1"; }
[ "$(f 'quoted argument')" = 'quoted argument' ]
printf 'pipelines and redirection pass\n'
