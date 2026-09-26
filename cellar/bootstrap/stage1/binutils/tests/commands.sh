# Native binutils acceptance tests.
# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
kind=$1
object=$2
program=$3
debug=$4
compressed_debug() {
    readelf -S -W "$1" > sections
    while read -r line; do
        case $line in *" .debug_"*" C "*) return 0;; esac
    done < sections
    return 1
}
case $kind in
archive)
    ar crsD library.a "$object"
    ar crsD duplicate.a "$object"
    bytecmp library.a duplicate.a
    test "$(ar t library.a)" = a_native_object_name_longer_than_fifteen.o
    case "$(nm -s library.a)" in *"bootstrap_sum in a_native_object_name_longer_than_fifteen.o"*) ;; *) exit 11;; esac
    ar x library.a
    bytecmp "$object" a_native_object_name_longer_than_fifteen.o
    ranlib -D duplicate.a
    bytecmp library.a duplicate.a
    ar dD duplicate.a a_native_object_name_longer_than_fifteen.o
    test -z "$(ar t duplicate.a)"
    printf 'CREATE mri.a\nADDMOD %s\nSAVE\nEND\n' "$object" | ar -M
    ar p mri.a > extracted.o
    bytecmp "$object" extracted.o
    ar crsDT thin.a "$object"
    case "$(nm thin.a)" in *" T bootstrap_sum"*) ;; *) exit 12;; esac
    ;;
inspect)
    out=$(readelf -hlSsr "$program")
    case "$out" in *ELF64*"EXEC (Executable file)"*"Advanced Micro Devices X86-64"*) ;; *) exit 21;; esac
    case "$out" in *INTERP*|*NEEDED*) exit 22;; esac
    case "$out" in *bootstrap_sum*) ;; *) exit 23;; esac
    case "$(objdump -d "$object")" in *"<bootstrap_sum>:"*lea*) ;; *) exit 24;; esac
    case "$(objdump -r "$object")" in *"R_X86_64_64"*external_value*) ;; *) exit 28;; esac
    case "$(nm --defined-only "$program")" in *" T bootstrap_sum"*) ;; *) exit 25;; esac
    case "$(size -A "$program")" in *".text"*".data"*"Total"*) ;; *) exit 26;; esac
    case "$(strings "$debug")" in *bootstrap-readable-string*) ;; *) exit 27;; esac
    test "$(c++filt _ZN3Foo3barEi)" = 'Foo::bar(int)'
    ;;
debug)
    case "$(addr2line -f -e "$debug" 0)" in known_function*bootstrap-fixture.c:41) ;; *) exit 31;; esac
    case "$(readelf --debug-dump=decodedline "$debug")" in *bootstrap-fixture.c*41*42*) ;; *) exit 32;; esac
    objcopy --compress-debug-sections=zlib "$debug" compressed.o
    case "$(addr2line -e compressed.o 0)" in *bootstrap-fixture.c:41) ;; *) exit 33;; esac
    objcopy --decompress-debug-sections compressed.o decompressed.o
    case "$(addr2line -e decompressed.o 0)" in *bootstrap-fixture.c:41) ;; *) exit 34;; esac
    # The assembler and linker both compress debug sections by default.
    compressed_debug "$debug" || exit 35
    ld -r -o relinked.o decompressed.o
    compressed_debug relinked.o || exit 36
    case "$(addr2line -e relinked.o 0)" in *bootstrap-fixture.c:41) ;; *) exit 37;; esac
    ;;
transform)
    objcopy --redefine-sym known_function=renamed_function "$debug" renamed.o
    case "$(nm renamed.o)" in *" T renamed_function"*) ;; *) exit 41;; esac
    objcopy --only-section=.rodata -O binary "$debug" payload
    test "$(strings payload)" = bootstrap-readable-string
    strip --strip-all -o stripped "$program"
    ./stripped
    case "$(readelf -S stripped)" in *.symtab*) exit 42;; esac
    objcopy "$program" edited
    elfedit --input-mach=x86-64 --output-osabi=GNU edited
    case "$(readelf -h edited)" in *"UNIX - GNU"*) ;; *) exit 43;; esac
    elfedit --input-osabi=GNU --output-osabi=none edited
    ./edited
    ;;
diagnostics)
    printf 'not an ELF file\n' > malformed
    if readelf -h malformed; then exit 51; fi
    if objdump -d malformed; then exit 52; fi
    if objcopy malformed output; then exit 53; fi
    if ar t malformed; then exit 54; fi
    if elfedit --output-osabi=GNU malformed; then exit 55; fi
    ;;
*) exit 90;;
esac
printf 'ok\n' > result
