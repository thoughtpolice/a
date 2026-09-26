# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "tblgen test failed at line $LINENO" >&2' ERR
min=$1
full=$2
source=$3
vt=$4
for tool in "$min" "$full"; do
 version=$("$tool" --version)
 [[ $version == *'LLVM version 23.1.0'* ]]
 [[ $version == *'Optimized build.'* ]]
done
# The full generator reproduces the value type table that the build took
# from the minimal one.
"$full" -gen-vt -I "$source/llvm/include" "$source/llvm/include/llvm/CodeGen/ValueTypes.td" -o vt.inc
[[ $(< vt.inc) == "$(< "$vt")" ]]
"$full" -gen-intrinsic-enums -I "$source/llvm/include" "$source/llvm/include/llvm/IR/Intrinsics.td" -o enums.inc
enums=$(< enums.inc)
[[ $enums == *'    abs = 1, '* && $enums == *'    memcpy, '* ]]
printf 'def Point : Missing;\n' > missing.td
if "$full" missing.td -o missing.inc 2> missing.err; then exit 1; fi
[[ $(< missing.err) == *"Couldn't find class 'Missing'"* ]]
printf 'passed\n' > passed
