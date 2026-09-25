# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "clang test failed at line $LINENO" >&2' ERR
tree=$1
musl=$2
libstdcxx=$3
runtime=$4
tests=$5
od=$6
clang=$tree/bin/clang
version=$("$clang" --version)
[[ $version == *'clang version 23.1.0'* ]]
[[ $version == *'Target: x86_64-unknown-linux-musl'* ]]
[[ $("$tree/bin/ld.lld" --version) == *'LLD 23.1.0'* ]]
# Clang finds its own resource headers; the C library and C++ library
# headers are explicit.
c=("$clang" -nostdlibinc -isystem "$musl" -O2 -pthread)
cxx=("$clang" --driver-mode=g++ -nostdlibinc -nostdinc++ -isystem "$libstdcxx" -isystem "$musl" -std=gnu++17 -O2 -pthread)
"${c[@]}" -c "$tests/helper.c" -o helper.o
"${c[@]}" -c "$tests/native.c" -o native-c.o
"${cxx[@]}" -c "$tests/native.cc" -o native-cxx.o
# LLD links static programs against musl and GCC 13's runtime and C++ library.
link=("$clang" -fuse-ld=lld -static -nostdlib "$runtime/crt1.o" "$runtime/crti.o" "$runtime/crtbeginT.o")
libc=("$runtime/libc.a" "$runtime/libgcc.a" "$runtime/libc.a" "$runtime/crtend.o" "$runtime/crtn.o")
"${link[@]}" native-c.o helper.o "${libc[@]}" -o native-c
"${link[@]}" native-cxx.o helper.o "$runtime/libstdc++.a" "${libc[@]}" -o native-cxx
[[ $(./native-c) == 'native C 4294967325' ]]
[[ $(./native-cxx) == 'native C++ 4294967299' ]]
# The AArch64 back end emits an AArch64 ELF object (e_machine 183).
printf 'int add(int a, int b) { return a + b; }\n' > add.c
"$clang" --target=aarch64-unknown-linux-musl -ffreestanding -nostdlibinc -O2 -c add.c -o add.o
[[ $("$od" -An -tx1 -j18 -N2 add.o) == ' b7 00' ]]
printf 'passed\n' > passed
