# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
[ "$((1234567890123 + 17))" = 1234567890140 ]
value='a b:c'; [ "${value// /_}" = 'a_b:c' ]
[ "${value#*:}" = c ]
set -- {one,two,three}; [ "$#" = 3 ] && [ "$2" = two ]
array=(zero 'one two' three); [ "${array[1]}" = 'one two' ]
sum=0
for ((i=0; i<5; i++)); do sum=$((sum+i)); done
[ "$sum" = 10 ]
function check_local { local value=inside; [ "$value" = inside ]; }
check_local; [ "$value" = 'a b:c' ]
[[ alpha == a* && 17 -gt 2 ]]
shopt -s extglob
case foobar in +(foo|bar)) :;; *) exit 1;; esac
unset optional
[ "${optional:-fallback}" = fallback ]
result=$(printf '%d %s %.2f' 1234567890123 text 1.25)
[ "$result" = '1234567890123 text 1.25' ]
printf 'shell semantics pass\n'
