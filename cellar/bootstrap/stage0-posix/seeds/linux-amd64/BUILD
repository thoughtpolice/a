load(
    "@cellar//bootstrap/stage0-posix:defs.bzl",
    "export_file",
    "filegroup",
    "stage0_answer_test",
)
load(
    "@cellar//bootstrap/stage0-posix:stage0.bzl",
    "hex0",
    "hex1",
    "hex2_0",
    "catm",
    "M0",
    "cc",
    "M2",
    "blood_elf",
    "M1_0",
    "hex2_1",
    "M1",
    "hex2",
)

# SHA-256 sums for all stage0 seeds
export_file(name="answers")

# Main rule that builds all binaries
filegroup(
    name="bins",
    srcs=[
        ":M1",
        ":hex2",
        ":M2-Mesoplanet",
        ":blood-elf",
        ":get_machine",
        ":M2-Planet",
    ],
)

# Phase 0a: build hex0 from bootstrap binary
hex0(
    name="hex0",
    bin="hex0-seed",
    src="hex0.hex0",
)

# Phase 1: build hex1 from hex0
hex0(
    name="hex1",
    bin=":hex0",
    src="hex1.hex0",
)

# Phase 2a: build hex2 from hex1
hex1(
    name="hex2-0",
    bin=":hex1",
    src="hex2.hex1",
)

# Phase 2b: build catm from hex2
hex2_0(
    name="catm",
    bin=":hex2-0",
    src="catm.hex2",
)

# Phase 3: build M0 from hex2
catm(
    name="M0.hex2",
    bin=":catm",
    inputs=[
        "ELF.hex2",
        "M0.hex2",
    ],
)

hex2_0(
    name="M0",
    bin=":hex2-0",
    src=":M0.hex2",
)

# Phase 4: build cc_amd64 from M0
M0(name="cc.hex2", bin=":M0", src="cc.M1")

catm(
    name="cc-0.hex2",
    bin=":catm",
    inputs=[
        "ELF.hex2",
        ":cc.hex2",
    ],
)

hex2_0(
    name="cc",
    bin=":hex2-0",
    src=":cc-0.hex2",
)

# Phase 5: build M2-Planet from cc
catm(
    name="M2-0.c",
    bin=":catm",
    inputs=[
        "bootstrap.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc.h",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_globals.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_reader.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_strings.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_types.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_emit.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_core.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_macro.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc.c",
    ],
)

cc(
    name="M2-0.M1",
    bin=":cc",
    src=":M2-0.c",
)

catm(
    name="M2-0-0.M1",
    bin=":catm",
    inputs=[
        "defs.M1",
        "libc-core.M1",
        ":M2-0.M1",
    ],
)

M0(
    name="M2-0.hex2",
    bin=":M0",
    src=":M2-0-0.M1",
)

catm(
    name="M2-0-0.hex2",
    bin=":catm",
    inputs=[
        "ELF.hex2",
        ":M2-0.hex2",
    ],
)

hex2_0(
    name="M2",
    bin=":hex2-0",
    src=":M2-0-0.hex2",
)

# Phase 6: build blood-elf0 from C sources
# This is the last stage where the binaries will not have debug info
# and the last piece built that isn't part of the output binaries
M2(
    name="blood-elf-0.M1",
    bin=":M2",
    arch="amd64",
    bootstrap=True,
    srcs=[
        "bootstrap.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:stringify.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:blood-elf.c",
    ],
)

catm(
    name="blood-elf-0-0.M1",
    bin=":catm",
    inputs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-core.M1",
        ":blood-elf-0.M1",
    ],
)

M0(
    name="blood-elf-0.hex2",
    bin=":M0",
    src=":blood-elf-0-0.M1",
)

catm(
    name="blood-elf-0-0.hex2",
    bin=":catm",
    inputs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64.hex2",
        ":blood-elf-0.hex2",
    ],
)

hex2_0(
    name="blood-elf-0",
    bin=":hex2-0",
    src=":blood-elf-0-0.hex2",
)

# Phase 7: build M1-0 from C sources
M2(
    name="M1-macro-0.M1",
    bin=":M2",
    arch="amd64",
    bootstrap=True,
    debug=True,
    srcs=[
        "bootstrap.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:stringify.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:M1-macro.c",
    ],
)

blood_elf(
    name="M1-macro-0-footer.M1",
    bin=":blood-elf-0",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":M1-macro-0.M1",
    ],
)

catm(
    name="M1-macro-0-0.M1",
    bin=":catm",
    inputs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-core.M1",
        ":M1-macro-0.M1",
        ":M1-macro-0-footer.M1",
    ],
)

M0(
    name="M1-macro-0.hex2",
    bin=":M0",
    src=":M1-macro-0-0.M1",
)

catm(
    name="M1-macro-0-0.hex2",
    bin=":catm",
    inputs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":M1-macro-0.hex2",
    ],
)

hex2_0(
    name="M1-0",
    bin=":hex2-0",
    src=":M1-macro-0-0.hex2",
)

# Phase 8: build hex2-1 from C sources
# This is the last stage where catm will need to be used and the last stage where
# M0 is used, as we will being using it's much more powerful and cross-platform
# version with a bunch of extra goodies.

M2(
    name="hex2_linker-1.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/sys/stat.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2.h",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2_linker.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2_word.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2.c",
    ],
)

blood_elf(
    name="hex2_linker-1-footer.M1",
    bin=":blood-elf-0",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":hex2_linker-1.M1",
    ],
)

M1_0(
    name="hex2_linker-1.hex2",
    bin=":M1-0",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-core.M1",
        ":hex2_linker-1.M1",
        ":hex2_linker-1-footer.M1",
    ],
)

catm(
    name="hex2_linker-1-0.hex2",
    bin=":catm",
    inputs=[
        "ELF.hex2",
        ":hex2_linker-1.hex2",
    ],
)

hex2_0(
    name="hex2-1",
    bin=":hex2-0",
    src=":hex2_linker-1-0.hex2",
)

# Phase 9: build M1 from C sources
M2(
    name="M1-macro-1.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:string.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:stringify.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:M1-macro.c",
    ],
)

blood_elf(
    name="M1-macro-1-footer.M1",
    bin=":blood-elf-0",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":M1-macro-1.M1",
    ],
)

M1_0(
    name="M1-macro-1.hex2",
    bin=":M1-0",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-full.M1",
        ":M1-macro-1.M1",
        ":M1-macro-1-footer.M1",
    ],
)

hex2_1(
    name="M1",
    bin=":hex2-1",
    arch="amd64",
    little_endian=True,
    base_address="0x00600000",
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":M1-macro-1.hex2",
    ],
)

# Phase 10: build hex2 from C sources
M2(
    name="hex2_linker-2.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/sys/stat.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2.h",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2_linker.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2_word.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:hex2.c",
    ],
)

blood_elf(
    name="hex2_linker-2-footer.M1",
    bin=":blood-elf-0",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":hex2_linker-2.M1",
    ],
)

M1(
    name="hex2_linker-2.hex2",
    bin=":M1",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-full.M1",
        ":hex2_linker-2.M1",
        ":hex2_linker-2-footer.M1",
    ],
)

hex2_1(
    name="hex2",
    bin=":hex2-1",
    arch="amd64",
    little_endian=True,
    base_address="0x00600000",
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":hex2_linker-2.hex2",
    ],
)

# Phase 11: build kaem from C sources
M2(
    name="kaem.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:string.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:Kaem/kaem.h",
        "cellar//bootstrap/stage0-posix/mescc-tools:Kaem/variable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:Kaem/kaem_globals.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:Kaem/kaem.c",
    ],
)

blood_elf(
    name="kaem-footer.M1",
    bin=":blood-elf-0",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":kaem.M1",
    ],
)

M1(
    name="kaem.hex2",
    bin=":M1",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-full.M1",
        ":kaem.M1",
        ":kaem-footer.M1",
    ],
)

hex2(
    name="kaem",
    bin=":hex2",
    arch="amd64",
    little_endian=True,
    base_address="0x00600000",
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":kaem.hex2",
    ],
)

# Phase 12: build M2-Mesoplanet from M2-Planet
M2(
    name="M2-Mesoplanet-1.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/sys/stat.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:string.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc.h",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc_globals.c",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc_env.c",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc_reader.c",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc_spawn.c",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc_core.c",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc_macro.c",
        "cellar//bootstrap/stage0-posix/m2-mesoplanet:cc.c",
    ],
)

blood_elf(
    name="M2-Mesoplanet-1-footer.M1",
    bin=":blood-elf-0",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":M2-Mesoplanet-1.M1",
    ],
)

M1(
    name="M2-Mesoplanet-1.hex2",
    bin=":M1",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-full.M1",
        ":M2-Mesoplanet-1.M1",
        ":M2-Mesoplanet-1-footer.M1",
    ],
)

hex2(
    name="M2-Mesoplanet",
    bin=":hex2",
    arch="amd64",
    little_endian=True,
    base_address="0x00600000",
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":M2-Mesoplanet-1.hex2",
    ],
)

# Phase 13: build final blood-elf from C sources
M2(
    name="blood-elf-1.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:stringify.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:blood-elf.c",
    ],
)

blood_elf(
    name="blood-elf-1-footer.M1",
    bin=":blood-elf-0",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":blood-elf-1.M1",
    ],
)

M1(
    name="blood-elf-1.hex2",
    bin=":M1",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-full.M1",
        ":blood-elf-1.M1",
        ":blood-elf-1-footer.M1",
    ],
)

hex2(
    name="blood-elf",
    bin=":hex2",
    arch="amd64",
    little_endian=True,
    base_address="0x00600000",
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":blood-elf-1.hex2",
    ],
)

# Now we have our shipping debuggable blood-elf, the rest will be down hill from
# here as we have ALL of the core pieces of compiling and assembling debuggable
# programs in a debuggable form with corresponding C source code.

# Phase 14: build get_machine from C sources

M2(
    name="get_machine.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/mescc-tools:get_machine.c",
    ],
)

blood_elf(
    name="get_machine-footer.M1",
    bin=":blood-elf",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":get_machine.M1",
    ],
)

M1(
    name="get_machine.hex2",
    bin=":M1",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-full.M1",
        ":get_machine.M1",
        ":get_machine-footer.M1",
    ],
)

hex2(
    name="get_machine",
    bin=":hex2",
    arch="amd64",
    little_endian=True,
    base_address="0x00600000",
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":get_machine.hex2",
    ],
)

# Phase 15: build M2-Planet from M2-Planet

M2(
    name="M2-1.M1",
    bin=":M2",
    arch="amd64",
    debug=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:sys/types.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stddef.h",
        "cellar//bootstrap/stage0-posix/m2-libc:sys/utsname.h",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/unistd.c",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/linux/fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:fcntl.c",
        "cellar//bootstrap/stage0-posix/m2-libc:ctype.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdlib.c",
        "cellar//bootstrap/stage0-posix/m2-libc:stdarg.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.h",
        "cellar//bootstrap/stage0-posix/m2-libc:stdio.c",
        "cellar//bootstrap/stage0-posix/m2-libc:bootstrappable.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc.h",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_globals.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_reader.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_strings.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_types.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_emit.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_core.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc_macro.c",
        "cellar//bootstrap/stage0-posix/m2-planet:cc.c",
    ],
)

blood_elf(
    name="M2-1-footer.M1",
    bin=":blood-elf",
    sixtyfour=True,
    little_endian=True,
    srcs=[
        ":M2-1.M1",
    ],
)

M1(
    name="M2-1.hex2",
    bin=":M1",
    arch="amd64",
    little_endian=True,
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/amd64_defs.M1",
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/libc-full.M1",
        ":M2-1.M1",
        ":M2-1-footer.M1",
    ],
)

hex2(
    name="M2-Planet",
    bin=":hex2",
    arch="amd64",
    little_endian=True,
    base_address="0x00600000",
    srcs=[
        "cellar//bootstrap/stage0-posix/m2-libc:amd64/ELF-amd64-debug.hex2",
        ":M2-1.hex2",
    ],
)

filegroup(
    name="amd64-files",
    srcs={
        "answers": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:answers",
        "AMD64/bin/blood-elf": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:blood-elf",
        "AMD64/bin/catm": "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
        "AMD64/bin/chmod": "cellar//bootstrap/stage0-posix/mescc-tools-extra:chmod",
        "AMD64/bin/cp": "cellar//bootstrap/stage0-posix/mescc-tools-extra:cp",
        "AMD64/bin/get_machine": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:get_machine",
        "AMD64/bin/hex2": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:hex2",
        "AMD64/bin/kaem": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:kaem",
        "AMD64/bin/M1": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:M1",
        "AMD64/bin/M2-Mesoplanet": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:M2-Mesoplanet",
        "AMD64/bin/M2-Planet": "cellar//bootstrap/stage0-posix/seeds/linux-amd64:M2-Planet",
        "AMD64/bin/match": "cellar//bootstrap/stage0-posix/mescc-tools-extra:match",
        "AMD64/bin/mkdir": "cellar//bootstrap/stage0-posix/mescc-tools-extra:mkdir",
        "AMD64/bin/replace": "cellar//bootstrap/stage0-posix/mescc-tools-extra:replace",
        "AMD64/bin/rm": "cellar//bootstrap/stage0-posix/mescc-tools-extra:rm",
        "AMD64/bin/sha256sum": "cellar//bootstrap/stage0-posix/mescc-tools-extra:sha256sum",
        "AMD64/bin/ungz": "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
        "AMD64/bin/unbz2": "cellar//bootstrap/stage0-posix/mescc-tools-extra:unbz2",
        "AMD64/bin/unxz": "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
        "AMD64/bin/untar": "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
    },
)

stage0_answer_test(
    name="check",
    command="cellar//bootstrap/stage0-posix/mescc-tools-extra:sha256sum",
    chdirexec="cellar//bootstrap/stage0-posix/mescc-tools-extra:chdirexec",
    input=":amd64-files",
    args=["--check", "answers"],
)
