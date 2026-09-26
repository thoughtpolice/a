# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "findutils test failed at line $LINENO" >&2' ERR
root=$PWD/$1
core=$PWD/$2
scripts=$PWD/$3
bash=$PWD/$4
export PATH="$root/bin:$core:$scripts"
mkdir -p data/sub
printf a > data/alpha
printf b > 'data/sub/beta words'
export BINDIR="$root/bin" LIBEXECDIR="$root/libexec"
export LOCALUSER='' NETPATHS='' PRUNEFS='' PRUNEPATHS='' PRUNEREGEX='^/nonexistent-bootstrap-prune$'
for format in modern old; do
 options=()
 if [[ $format == old ]]; then options+=(--old-format); fi
 "$bash" --noprofile --norc "$root/bin/updatedb" "${options[@]}" --localpaths="$PWD/data" --output="$PWD/$format.db" --changecwd="$PWD"
 [[ $(locate -d "$format.db" alpha) == "$PWD/data/alpha" ]]
 [[ $(locate -d "$format.db" -i ALPHA) == "$PWD/data/alpha" ]]
 [[ $(locate -d "$format.db" -r 'beta.*') == "$PWD/data/sub/beta words" ]]
 [[ $(locate -d "$format.db" -c "$PWD/data/") == 3 ]]
done
rm data/alpha
if locate -e -d modern.db alpha; then exit 1; fi
[[ $(locate -E -d modern.db alpha) == "$PWD/data/alpha" ]]
printf '\0LOCATE02\0\200' > corrupt.db
if locate -d corrupt.db anything > corrupt-output 2>corrupt-error; then exit 1; fi
[[ -s corrupt-error ]]
printf 'passed\n' > passed
