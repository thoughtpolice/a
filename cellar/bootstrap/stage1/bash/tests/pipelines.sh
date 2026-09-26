# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu -o pipefail
[[ $(printf 'alpha\nbeta\n' | while read -r word; do printf '<%s>' "$word"; done) == '<alpha><beta>' ]]
read -r first second <<'INPUT'
one two
INPUT
[[ $first:$second == one:two ]]
# Exercise both the pipe and temporary-file paths without another utility.
for length in 4096 20000 65536 200000; do
  printf -v input '%*s' "$length" ''
  IFS= read -r actual <<INPUT
$input
INPUT
  [[ ${#actual} == "$length" && $actual == "$input" ]]
done
printf 'descriptor\n' > data
exec {fd}<data
read -r -u "$fd" line; exec {fd}<&-
[[ $line == descriptor ]]
value=$(printf 'substitution\n'); [[ $value == substitution ]]
coproc C { while IFS= read -r line; do printf '<%s>\n' "$line"; done; }
pid=$C_PID; out=${C[0]}; in=${C[1]}
printf 'coprocess\n' >&"$in"; IFS= read -r -u "$out" answer
[[ $answer == '<coprocess>' ]]; exec {in}>&-; wait "$pid"
printf 'pipelines and redirection pass\n'
