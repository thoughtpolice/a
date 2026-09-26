# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Copy every file of each header tree into the current directory. The trees
# share directories, such as scsi, but no file, since one would then shadow
# the other.
set -euo pipefail
shopt -s globstar nullglob dotglob
mkdir=$1
cp=$2
shift 2
for tree in "$@"; do
    for path in "$tree"/**/*; do
        name=${path#"$tree"/}
        if [[ -d $path ]]; then
            "$mkdir" -p "$name"
        elif [[ -e $name ]]; then
            echo "$name lies in more than one tree" >&2
            exit 1
        else
            "$cp" "$path" "$name"
        fi
    done
done
