# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "findutils test failed at line $LINENO" >&2' ERR
root=$PWD/$1
core=$PWD/$2
scripts=$PWD/$3
bash=$PWD/$4
export PATH="$root/bin:$core:$scripts"
printf '%s\0' 'two words' $'line\nbreak' "quote\"single'" > arguments
xargs -0 -n1 "$core/printf" '%s\0' < arguments > result
mapfile -d '' -t items < result
[[ ${#items[@]} == 3 && ${items[0]} == 'two words' && ${items[1]} == $'line\nbreak' && ${items[2]} == "quote\"single'" ]]
[[ $(printf 'one two three\n' | xargs -n2) == $'one two\nthree' ]]
[[ $(printf 'a\nb\n' | xargs -I{} "$core/printf" '<%s>' '{}') == '<a><b>' ]]
xargs -r "$core/false" < /dev/null
if printf 'a\n' | xargs "$core/false"; then exit 1; else [[ $? == 123 ]]; fi
if printf 'a\n' | xargs nonexistent-bootstrap-command 2> missing; then exit 1; else [[ $? == 127 ]]; fi
seq 1 12 | xargs -n1 -P2 "$bash" --noprofile --norc -c 'printf "%s\n" "$1"' worker | sort -n > parallel
[[ $(cat parallel) == $(seq 1 12) ]]
printf 'passed\n' > passed
