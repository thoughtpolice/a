# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu -o pipefail
[[ ${BASH_VERSINFO[0]} == 5 && ${BASH_VERSINFO[1]} == 2 ]]
[[ $((1234567890123 + 17)) == 1234567890140 ]]
a=(zero 'one two' three); [[ ${a[1]} == 'one two' ]]
declare -A map=([alpha]='one two' [beta]=three)
declare -n ref=map; ref[gamma]=four
[[ ${map[gamma]} == four && ${#map[@]} == 3 ]]
unset -n ref
mapfile -t words < <(printf 'alpha\nbeta\ngamma\n')
[[ ${#words[@]} == 3 && ${words[2]} == gamma ]]
mapfile -d '' -t nulwords < <(printf 'first\0second\0')
[[ ${#nulwords[@]} == 2 && ${nulwords[1]} == second ]]
value='a b:c'; [[ ${value// /_} == a_b:c && ${value#*:} == c ]]
[[ AbCd =~ ^([A-Z][a-z]){2}$ && ${BASH_REMATCH[1]} == Cd ]]
[[ ${value^^} == 'A B:C' ]]
shopt -s extglob
case foobar in +(foo|bar)) :;; *) exit 1;; esac
sum=0; for ((i=0; i<5; i++)); do ((sum+=i)) || :; done
[[ $sum == 10 ]]
RANDOM=41; r1=$RANDOM; RANDOM=41; [[ $RANDOM == "$r1" ]]
[[ $(printf '%d %s %.2f' 1234567890123 text 1.25) == '1234567890123 text 1.25' ]]
# A pipeline error must be reflected with pipefail.
if (exit 17) | (exit 0); then exit 1; else [[ $? == 17 ]]; fi
printf 'shell semantics pass\n'
