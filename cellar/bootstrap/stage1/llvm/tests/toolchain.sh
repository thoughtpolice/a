# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "toolchain test failed at line $LINENO" >&2' ERR
tree=$(cd "$1" && pwd -P)
tests=$2
runtimes=$3
od=$4
grep=$5
musl_headers=$6
linux_headers=$7
cmp=$8
clang=$tree/bin/clang
cxx=$tree/bin/clang++
[[ $("$clang" --version) == *'clang version 23.1.0'* ]]
[[ $("$clang" --version) == *'Target: x86_64-unknown-linux-musl'* ]]
[[ $("$tree/bin/ld.lld" --version) == *'LLD 23.1.0'* ]]
[[ $("$tree/bin/llvm-ar" --version) == *'LLVM version 23.1.0'* ]]
[[ $("$tree/bin/llvm-ranlib" --version) == *'LLVM version 23.1.0'* ]]
# The configuration file beside Clang names the installation as the sysroot
# and selects its runtimes, LLD and static linking.
"$clang" -O2 -c "$tests/helper.c" -o helper.o
"$clang" -O2 -pthread "$tests/native.c" helper.o -o native-c
"$cxx" -O2 -pthread "$tests/native.cc" helper.o -o native-cxx
"$cxx" -std=c++23 -O2 "$runtimes" -o runtimes
[[ $(./native-c) == 'native C 4294967325' ]]
[[ $(./native-cxx) == 'native C++ 4294967299' ]]
[[ $(./runtimes) == 'runtimes a/c 555555555 1.5e+300' ]]
# <unwind.h> is Clang's, and libunwind's own interface steps from a function
# back into main. musl has no unwind tables, so the walk ends there.
printf '%s\n' \
    '#define UNW_LOCAL_ONLY' \
    '#include <libunwind.h>' \
    '#include <unwind.h>' \
    '__attribute__((noinline)) static int walk(void)' \
    '{' \
    '    unw_context_t context;' \
    '    unw_cursor_t cursor;' \
    '    if (unw_getcontext(&context) || unw_init_local(&cursor, &context))' \
    '        return 1;' \
    '    return unw_step(&cursor) > 0 ? 0 : 1;' \
    '}' \
    'int main(void)' \
    '{' \
    '    volatile int result = walk();' \
    '    return result || sizeof(_Unwind_Ptr) != sizeof(void *);' \
    '}' > walk.c
"$clang" -O2 walk.c -o walk
./walk
# llvm-ar and llvm-ranlib make a library the driver links.
printf 'int seven(void) { return 7; }\n' > seven.c
printf 'int seven(void);\nint main(void) { return seven() - 7; }\n' > main.c
"$clang" -O2 -c seven.c -o seven.o
"$tree/bin/llvm-ar" rc libseven.a seven.o
"$tree/bin/llvm-ranlib" libseven.a
"$clang" main.c -L. -lseven -o seven
./seven
# Every absolute path the driver gives the compiler and the linker lies in
# the installation.
"$cxx" -### -O2 -pthread "$tests/native.cc" -o native-cxx 2> commands
while read -r -a words; do
    for word in "${words[@]}"; do
        word=${word#\"}
        word=${word%\"}
        case $word in
        -fdebug-compilation-dir=* | -fcoverage-compilation-dir=*) continue ;;
        -*=*) word=${word#*=} ;;
        -?/*) word=${word#-?} ;;
        esac
        case $word in
        /*) [[ $word == "$tree"/* ]] ;;
        esac
    done
done < commands
# Nothing GCC compiled reaches the toolchain or the programs it links.
for program in "$clang" "$tree/bin/ld.lld" "$tree/bin/llvm-ar" native-c native-cxx runtimes; do
    if "$grep" -a -q 'GCC: (GNU)' "$program"; then
        echo "$program holds GCC-compiled code" >&2
        exit 1
    fi
    "$grep" -a -q 'clang version 23.1.0' "$program"
done
# musl's and the kernel's headers share directories such as scsi. Every one
# of them lies in the installation unchanged, so neither shadows the other.
shopt -s globstar nullglob
for headers in "$musl_headers" "$linux_headers"; do
    installed=0
    for header in "$headers"/**/*.h; do
        "$cmp" -s "$header" "$tree/include/${header#"$headers"/}"
        installed=$((installed + 1))
    done
    [[ $installed -gt 0 ]]
done
# The AArch64 back end emits an AArch64 ELF object (e_machine 183).
printf 'int add(int a, int b) { return a + b; }\n' > add.c
"$clang" --target=aarch64-unknown-linux-musl -ffreestanding -nostdlibinc -O2 -c add.c -o add.o
[[ $("$od" -An -tx1 -j18 -N2 add.o) == ' b7 00' ]]
printf 'passed\n' > passed
