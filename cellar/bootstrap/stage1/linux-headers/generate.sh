# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Write version.h, the asm-generic wrappers and the system call headers,
# which `make headers` generates before it installs anything, laid out as in
# the kernel's object tree.
set -euo pipefail
src=$1
arch=$2
PATH=$3

# The top Makefile's filechk_version.h.
field() {
    sed -n "s/^$1 = //p" "$src/Makefile"
}
version=$(field VERSION)
patchlevel=$(field PATCHLEVEL)
sublevel=$(field SUBLEVEL)
patchlevel=${patchlevel:-0}
sublevel=${sublevel:-0}
if [ "$sublevel" -gt 255 ]; then
    code=$((version * 65536 + patchlevel * 256 + 255))
else
    code=$((version * 65536 + patchlevel * 256 + sublevel))
fi
mkdir -p include/generated/uapi/linux
{
    echo "#define LINUX_VERSION_CODE $code"
    echo '#define KERNEL_VERSION(a,b,c) (((a) << 16) + ((b) << 8) + ((c) > 255 ? 255 : (c)))'
    echo "#define LINUX_VERSION_MAJOR $version"
    echo "#define LINUX_VERSION_PATCHLEVEL $patchlevel"
    echo "#define LINUX_VERSION_SUBLEVEL $sublevel"
} > include/generated/uapi/linux/version.h

# scripts/Makefile.asm-headers for the uapi-asm-generic target. Every
# mandatory header the architecture neither ships nor generates becomes a
# wrapper around its asm-generic version.
asm=arch/$arch/include/uapi/asm
out=arch/$arch/include/generated/uapi/asm
mkdir -p "$out"
kbuild() {
    if [ -f "$1" ]; then
        sed -n "s/^$2[[:space:]]*+=[[:space:]]*//p" "$1"
    fi
}
mandatory=$(kbuild "$src/include/uapi/asm-generic/Kbuild" mandatory-y)
generated=" $(kbuild "$src/$asm/Kbuild" generated-y | tr '\n' ' ') "
generic=$(kbuild "$src/$asm/Kbuild" generic-y)
for header in $mandatory; do
    case $generated in
    *" $header "*) ;;
    *) [ -f "$src/$asm/$header" ] || generic="$generic $header" ;;
    esac
done
for header in $generic; do
    if [ ! -f "$src/include/uapi/asm-generic/$header" ]; then
        echo "no asm-generic/$header to wrap" >&2
        exit 1
    fi
    echo "#include <asm-generic/$header>" > "$out/$header"
done

# The architecture's archheaders target.
case $arch in
x86)
    # arch/x86/entry/syscalls/Makefile, uapisyshdr-y.
    syscalls=$src/arch/x86/entry/syscalls
    syshdr=("$BASH" "$src/scripts/syscallhdr.sh" --emit-nr)
    "${syshdr[@]}" --abis i386 "$syscalls/syscall_32.tbl" "$out/unistd_32.h"
    "${syshdr[@]}" --abis common,64 "$syscalls/syscall_64.tbl" "$out/unistd_64.h"
    "${syshdr[@]}" --abis common,x32 --offset __X32_SYSCALL_BIT "$syscalls/syscall_64.tbl" "$out/unistd_x32.h"
    ;;
*)
    echo "no archheaders rules for $arch" >&2
    exit 1
    ;;
esac
