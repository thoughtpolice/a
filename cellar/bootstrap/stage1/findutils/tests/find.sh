# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "findutils test failed at line $LINENO" >&2' ERR
root=$PWD/$1
core=$PWD/$2
scripts=$PWD/$3
bash=$PWD/$4
export PATH="$root/bin:$core:$scripts"
mkdir -p tree/sub tree/prune copied
printf 'one' > tree/a.txt
printf 'two' > 'tree/sub/two words.txt'
printf three > tree/prune/ignored
ln -s a.txt tree/link
[[ $(find tree -type f -name '*.txt' -print | sort) == $'tree/a.txt\ntree/sub/two words.txt' ]]
[[ $(find tree -regextype posix-extended -regex '.*/(a|two words)\.txt' -print | sort) == $'tree/a.txt\ntree/sub/two words.txt' ]]
[[ $(find tree -path tree/prune -prune -o -type f -print | sort) == $'tree/a.txt\ntree/sub/two words.txt' ]]
[[ $(find -L tree -name link -type f -print) == tree/link ]]
[[ $(find tree -iname 'A.TXT' -print) == tree/a.txt ]]
[[ $(find tree -size 3c -type f -printf '%f|%s\n' | sort) == $'a.txt|3\ntwo words.txt|3' ]]
find tree -type f -name '*.txt' -exec cp -t copied '{}' +
[[ $(cat copied/a.txt) == one && $(cat 'copied/two words.txt') == two ]]
find tree -type f -name '*.txt' -execdir "$core/printf" '%s\n' '{}' \; | sort > execdir
[[ $(cat execdir) == $'./a.txt\n./two words.txt' ]]
find tree/prune -depth -delete
[[ ! -e tree/prune ]]
if find tree -definitely-invalid > invalid 2>&1; then exit 1; fi
printf 'passed\n' > passed
