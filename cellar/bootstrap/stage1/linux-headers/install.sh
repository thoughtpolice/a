# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Install into the current directory as the headers target's two
# scripts/Makefile.headersinst passes do, for include/uapi and the
# architecture's uapi directory. Each header passes through
# headers_install.sh, which runs scripts/unifdef from the object tree, as in
# the kernel build.
set -euo pipefail
shopt -s nullglob
src=$(cd "$1" && pwd)
generated=$(cd "$2" && pwd)
objtree=$(cd "$3" && pwd)
headers_install=$(cd "${4%/*}" && pwd)/${4##*/}
arch=$5
PATH=$(cd "$6" && pwd)
shift 6
directories="$*"
bash=$(cd "${BASH%/*}" && pwd)/${BASH##*/}
dst=$PWD

# Every header in the subdirectories of a directory, as headersinst finds
# src-headers and gen-headers.
subdirectory_headers() {
    if [ -d "$1" ]; then
        (
            cd "$1"
            for directory in */; do
                find "${directory%/}" -name '*.h'
            done
        ) | sort
    fi
}

# include/uapi/Kbuild leaves out the headers of features the architecture
# lacks. Any other Kbuild rule is new and must be read before it is trusted.
no_export_headers() {
    local obj=$1
    if [ "$obj" = include/uapi ]; then
        local expected=$'linux/a.out.h\nlinux/kvm.h\nlinux/kvm_para.h'
        if [ "$(sed -n 's/.*no-export-headers += //p' "$src/$obj/Kbuild")" != "$expected" ]; then
            echo "$obj/Kbuild changed" >&2
            exit 1
        fi
        [ -f "$src/arch/$arch/include/uapi/asm/a.out.h" ] || echo linux/a.out.h
        [ -f "$src/arch/$arch/include/uapi/asm/kvm.h" ] || echo linux/kvm.h
        [ -f "$src/arch/$arch/include/uapi/asm/kvm_para.h" ] ||
            [ -f "$generated/arch/$arch/include/generated/uapi/asm/kvm_para.h" ] ||
            echo linux/kvm_para.h
    elif [ -f "$src/$obj/Kbuild" ]; then
        echo "$obj/Kbuild is not handled" >&2
        exit 1
    fi
}

install_header() {
    mkdir -p "$dst/${2%/*}"
    "$bash" "$headers_install" "$1" "$dst/$2"
}

cd "$objtree"
for obj in include/uapi "arch/$arch/include/uapi"; do
    gen=$generated/${obj//include\//include/generated/}
    excluded=" $(no_export_headers "$obj" | tr '\n' ' ') "
    src_headers=$(subdirectory_headers "$src/$obj")
    gen_headers=$(subdirectory_headers "$gen")
    installed=" "
    for header in $src_headers; do
        case $excluded in *" $header "*) continue ;; esac
        install_header "$src/$obj/$header" "$header"
        installed="$installed$header "
    done
    for header in $gen_headers; do
        case $excluded in *" $header "*) continue ;; esac
        case $installed in
        *" $header "*)
            echo "duplicated header export: $header" >&2
            continue
            ;;
        esac
        install_header "$gen/$header" "$header"
    done
done
# Installations merge exactly these directories with the C library's.
cd "$dst"
installed=$(echo *)
if [ "$installed" != "$directories" ]; then
    echo "installed directories changed: $installed" >&2
    exit 1
fi
