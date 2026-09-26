# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "coreutils test failed at line $LINENO" >&2' ERR
bin=$1
export PATH="$bin"
printf 'pear\napple\npear\nbanana\n' > words
[[ $(sort words | uniq) == $'apple\nbanana\npear' ]]
[[ $(sort words | uniq -c | tr -s ' ' | cut -c2-) == $'1 apple\n1 banana\n2 pear' ]]
[[ $(head -n2 words) == $'pear\napple' ]]
[[ $(tail -n2 words) == $'pear\nbanana' ]]
[[ $(tac words) == $'banana\npear\napple\npear' ]]
[[ $(wc -l < words | tr -d ' ') == 4 ]]
[[ $(cut -c1-2 words) == $'pe\nap\npe\nba' ]]
[[ $(tr a-z A-Z < words | head -n1) == PEAR ]]
printf '1 alpha\n2 beta\n' > first
printf '1 one\n2 two\n' > second
[[ $(join first second) == $'1 alpha one\n2 beta two' ]]
[[ $(paste -d: first second) == $'1 alpha:1 one\n2 beta:2 two' ]]
split -l2 words part
[[ $(cat partaa partab) == $(cat words) ]]
csplit -s words 3
[[ $(cat xx00 xx01) == $(cat words) ]]
printf 'abcdef\n' | fold -w3 > folded
[[ $(cat folded) == $'abc\ndef' ]]
printf 'a b c d\n' | fmt -w4 > formatted
[[ $(cat formatted) == $'a b\nc d' ]]
[[ $(printf 'a\tb\n' | expand -t4) == 'a   b' ]]
[[ $(printf '    a\n' | unexpand -t4) == $'\ta' ]]
printf 'one\ntwo\n' | tee saved > copied
[[ $(cat saved) == $(cat copied) ]]
printf 'a b\nb c\n' | tsort > topo
[[ $(cat topo) == $'a\nb\nc' ]]
printf 'passed\n' > passed
