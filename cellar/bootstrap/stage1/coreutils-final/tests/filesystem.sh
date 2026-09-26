# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "coreutils test failed at line $LINENO" >&2' ERR
bin=$1
export PATH="$bin"
mkdir -p tree/a tree/b
printf 'payload\n' > tree/a/file
chmod 640 tree/a/file
cp -p tree/a/file tree/b/copy
[[ $(stat -c %a tree/b/copy) == 640 ]]
[[ $(cat tree/b/copy) == payload ]]
ln tree/a/file tree/hard
ln -s a/file tree/sym
[[ $(stat -c %h tree/a/file) == 2 ]]
[[ $(readlink tree/sym) == a/file ]]
[[ $(readlink -f tree/sym) == "$PWD/tree/a/file" ]]
cp -a tree duplicate
[[ $(stat -c %h duplicate/a/file) == 2 ]]
[[ $(readlink duplicate/sym) == a/file ]]
mv duplicate moved
install -D -m 751 tree/a/file installed/deep/file
[[ $(stat -c %a installed/deep/file) == 751 ]]
[[ $(ls -1 tree/a) == file ]]
[[ $(du -s tree | cut -f2) == tree ]]
[[ $(stat -f -c %T .) != UNKNOWN ]]
mkdir empty
rmdir empty
link tree/a/file another
unlink another
mkfifo fifo
[[ -p fifo ]]
mktemp -d ./private.XXXXXX > temp-name
[[ -d $(cat temp-name) ]]
rm -r moved tree installed fifo
[[ ! -e tree && ! -e moved ]]
printf 'passed\n' > passed
