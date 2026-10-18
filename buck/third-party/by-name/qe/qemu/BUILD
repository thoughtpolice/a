# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")
load(":build.bzl", "QEMU_CFLAGS", "archive_files", "decoder", "partition", "qemu_library", "selected", "unconditional")
load(":defs.bzl", "qemu")
load(
    ":sources.bzl",
    "BASE_ARCH",
    "DECODETREE",
    "DEVICES",
    "GDB_XML",
    "QAPI_MODULES",
    "SOURCES",
    "SYMBOLS",
    "TARGET_CONFIG",
    "TRACE_EVENTS_SUBDIRS",
)

# QEMU's riscv64, aarch64 and x86_64 system emulators, built from the release
# tarball with QEMU's own meson build replaced by this file:
#
#   buck2 run third-party//by-name/qe/qemu:qemu-system-aarch64 -- -M virt ...
#
# runs one from :qemu, the install tree, so that it finds the firmware and
# option ROMs QEMU ships in share/qemu. x86_64 has no i440fx "pc" machine and
# so no default: pass -M q35 or -M microvm. defs.bzl has rules for running an
# emulator as a test.
#
# The configuration, which QEMU's configure and meson would compute, is in
# three places: config-host.h.in for the host and the features built in,
# devices/ for each target's machines and devices, and sources.bzl for the
# sources that selects, which sources.py writes and a test keeps current.
# Each of QEMU's libraries becomes a cxx_library compiled with the flags
# meson.build gives it.

VERSION = pkg.version()

TARGETS = [
    "aarch64",
    "riscv64",
    "x86_64",
]

ARCHES = sorted({BASE_ARCH[t]: True for t in TARGETS}.keys())

# MARK: Configuration

# Kconfig symbols that meson passes minikconf from the host configuration,
# for the features this build has.
HOST_KCONFIG = [
    "CONFIG_FDT=y",
    "CONFIG_IVSHMEM=y",
    "CONFIG_LINUX=y",
    "CONFIG_PIXMAN=y",
    "CONFIG_TPM=y",
]

# The accelerators each target is built with, and the target's own symbols.
TARGET_KCONFIG = {
    "aarch64": [
        "CONFIG_TCG=y",
        "CONFIG_AARCH64=y",
    ],
    "riscv64": [
        "CONFIG_TCG=y",
        "CONFIG_RISCV64=y",
    ],
    "x86_64": [
        "CONFIG_TCG=y",
        "CONFIG_KVM=y",
        "CONFIG_X86_64=y",
    ],
}

[
    shims.genrule(
        name = "{}-config-devices.mak".format(target),
        srcs = ["devices/{}-softmmu.mak".format(target)],
        out = "config-devices.mak",
        cmd = " ".join([
            "$(exe :run-script)",
            "$(location :src)/scripts/minikconf.py",
            "--allnoconfig",
            "config-devices.mak",
            "$TMP/config-devices.mak.d",
            "$SRCS",
            "$(location :src)/Kconfig",
        ] + HOST_KCONFIG + TARGET_KCONFIG[target] + [
            "CONFIG_TARGET_BIG_ENDIAN=n",
            "> $OUT",
        ]),
    )
    for target in TARGETS
]

# sources.bzl is what meson would compute from QEMU's meson.build files and
# the targets' devices: sources.py writes it from the source tree and the
# minikconf output above. This fails when either has moved on; to update
# sources.bzl after a version bump or a change to devices/ or sources.py, run
#
#   cp $(buck2 build --show-simple-output third-party//by-name/qe/qemu:sources.bzl-new) \
#       buck/third-party/by-name/qe/qemu/sources.bzl
shims.genrule(
    name = "sources.bzl-new",
    srcs = ["sources.py"],
    out = "sources.bzl",
    cmd = " ".join([
        "$(exe :run-script)",
        "$SRCS",
        "$(location :src)",
    ] + [
        " ".join([
            "--target",
            target,
            "$(location :{}-config-devices.mak)".format(target),
        ] + TARGET_KCONFIG[target])
        for target in TARGETS
    ] + ["> $OUT"]),
)

shims.export_file(
    name = "sources.bzl-checked-in",
    src = "sources.bzl",
)

shims.command_test(
    name = "sources-up-to-date",
    cmd = [
        "diff",
        "-u",
        "$(location :sources.bzl-checked-in)",
        "$(location :sources.bzl-new)",
    ],
)

# MARK: Sources

_SYMBOLS = {t: {s: True for s in SYMBOLS[t]} for t in TARGETS}

# Sources a target's executable is built from directly, besides its source
# sets: meson.build's configs/targets/<target>.c, or the stub of the targets
# without one, and main.c.
_TARGET_INFO = {
    "aarch64": "configs/targets/aarch64-softmmu.c",
    "riscv64": "configs/targets/riscv64-softmmu.c",
    "x86_64": "target-info-stub.c",
}

# The release tarball, unlike a git archive, carries the keycodemapdb
# subproject the keymap tables are generated from. The firmware sources under
# roms/ are most of its size and are never built here.
shims.http_archive(
    name = "src",
    excludes = [
        "^roms/",
        "^tests/",
    ],
    sha256 = "731b5681e4bb18be313231579b8efd0296c5b015fa36dc533874b639ba838016",
    strip_prefix = "qemu-{}".format(VERSION),
    sub_targets = archive_files(_TARGET_INFO.values() + ["system/main.c"]) + [
        "linux-headers/asm-x86",
        "pc-bios",
    ],
    type = "tar.xz",
    urls = [
        "https://download.qemu.org/qemu-{}.tar.xz".format(VERSION),
    ],
)

# Runs a script from the source tree: $(exe :run-script) $(location :src)/...
shims.python_binary(
    name = "run-script",
    main = "run-script.py",
)

# MARK: Generated headers

VERSION_PARTS = VERSION.split(".")

shims.genrule(
    name = "config-host.h",
    srcs = ["config-host.h.in"],
    out = "config-host.h",
    cmd = " ".join([
        "sed",
        "-e 's/@VERSION@/{}/g'".format(VERSION),
        "-e 's/@VERSION_MAJOR@/{}/g'".format(VERSION_PARTS[0]),
        "-e 's/@VERSION_MINOR@/{}/g'".format(VERSION_PARTS[1]),
        "-e 's/@VERSION_MICRO@/{}/g'".format(VERSION_PARTS[2]),
        "$SRCS > $OUT && ! grep '@[A-Z_]*@' $OUT",
    ]),
)

# scripts/qemu-version.sh, for a release with no --with-pkgversion.
shims.write_file(
    name = "qemu-version.h",
    contents = [
        "#define QEMU_PKGVERSION \"\"",
        "#define QEMU_FULL_VERSION \"{}\"".format(VERSION),
        "",
    ],
)

[
    shims.write_file(
        name = "{}-softmmu-config-target.h".format(t),
        contents = ["#define {} {}".format(k, v) for k, v in sorted(TARGET_CONFIG[t].items())] + [""],
    )
    for t in TARGETS
]

[
    shims.write_file(
        name = "{}-softmmu-config-devices.h".format(t),
        contents = ["#define {} 1".format(d) for d in DEVICES[t]] + [""],
    )
    for t in TARGETS
]

shims.genrule(
    name = "config-poison.h",
    srcs = [":{}-softmmu-config-{}.h".format(t, kind) for t in TARGETS for kind in [
        "target",
        "devices",
    ]],
    out = "config-poison.h",
    cmd = "sh $(location :src)/scripts/make-config-poison.sh $SRCS > $OUT",
)

HX = {
    "hmp-commands-info.h": "hmp-commands-info.hx",
    "hmp-commands.h": "hmp-commands.hx",
    "qemu-options.def": "qemu-options.hx",
}

[
    shims.genrule(
        name = out,
        out = out,
        cmd = "sh $(location :src)/scripts/hxtool -h $(location :src)/{} > $OUT".format(hx),
    )
    for out, hx in HX.items()
]

# The outputs of qapi-gen.py for the schema's modules, as qapi/meson.build
# lists them for a build with the system emulators.
QAPI_OUTPUTS = [
    "qapi-builtin-types.c",
    "qapi-builtin-types.h",
    "qapi-builtin-visit.c",
    "qapi-builtin-visit.h",
    "qapi-commands.c",
    "qapi-commands.h",
    "qapi-emit-events.c",
    "qapi-emit-events.h",
    "qapi-events.c",
    "qapi-events.h",
    "qapi-init-commands.c",
    "qapi-init-commands.h",
    "qapi-introspect.c",
    "qapi-introspect.h",
    "qapi-types.c",
    "qapi-types.h",
    "qapi-visit.c",
    "qapi-visit.h",
] + [
    "qapi-{}-{}.{}".format(kind, module, ext)
    for module in QAPI_MODULES
    for kind in [
        "commands",
        "events",
        "types",
        "visit",
    ]
    for ext in [
        "c",
        "h",
    ]
] + [
    "qapi-commands-{}.trace-events".format(module)
    for module in QAPI_MODULES
]

shims.genrule(
    name = "qapi",
    outs = {f: [f] for f in QAPI_OUTPUTS},
    cmd = "$(exe :run-script) $(location :src)/scripts/qapi-gen.py -o $OUT -b $(location :src)/qapi/qapi-schema.json",
)

# trace/meson.build's groups: the trace-events of the source root, of each
# directory meson.build lists, and the ones qapi-gen.py writes.
TRACE_GROUPS = {"root": "$(location :src)/trace-events"} | {
    d.replace("/", "_").replace("-", "_"): "$(location :src)/{}/trace-events".format(d)
    for d in TRACE_EVENTS_SUBDIRS
} | {
    "qapi_commands_{}_trace_events".format(m.replace("-", "_")): "$(location :qapi[qapi-commands-{}.trace-events])".format(m)
    for m in QAPI_MODULES
}

[
    shims.genrule(
        name = "trace-" + group,
        outs = {
            "c": ["trace-{}.c".format(group)],
            "h": ["trace-{}.h".format(group)],
        },
        cmd = " && ".join([
            "$(exe :run-script) $(location :src)/scripts/tracetool.py --backend=log --group={} --format={} {} $OUT/trace-{}.{}".format(group, fmt, events, group, fmt)
            for fmt in [
                "c",
                "h",
            ]
        ]),
    )
    for group, events in TRACE_GROUPS.items()
]

# ui/meson.build's keymap tables.
KEYMAPS = [
    ("atset1", "linux"),
    ("linux", "qcode"),
    ("linux", "atset1"),
    ("linux", "atset2"),
    ("linux", "atset3"),
    ("qcode", "linux"),
    ("linux", "qnum"),
    ("linux", "sun"),
    ("qnum", "linux"),
    ("usb", "linux"),
    ("win32", "linux"),
    ("x11", "linux"),
    ("xorgkbd", "linux"),
    ("xorgxquartz", "linux"),
    ("xorgxwin", "linux"),
    ("osx", "linux"),
]

shims.genrule(
    name = "keymaps",
    outs = {
        "input-keymap-{}-to-{}.c.inc".format(a, b): ["input-keymap-{}-to-{}.c.inc".format(a, b)]
        for a, b in KEYMAPS
    },
    cmd = " && ".join([
        " ".join([
            "$(exe :run-script)",
            "$(location :src)/subprojects/keycodemapdb/tools/keymap-gen",
            "code-map --lang glib2 --varname qemu_input_map_{}_to_{}".format(a, b),
            "$(location :src)/subprojects/keycodemapdb/data/keymaps.csv",
            a,
            b,
            "> $OUT/input-keymap-{}-to-{}.c.inc".format(a, b),
        ])
        for a, b in KEYMAPS
    ]),
)

# No block driver is a module here, so the table of modules is empty.
shims.genrule(
    name = "module_block.h",
    out = "module_block.h",
    cmd = "$(exe :run-script) $(location :src)/scripts/modules/module_block.py $OUT",
)

# The headers every QEMU source sees under the build root, as meson.build's
# genh. linux-headers/asm is the link configure makes to the host's
# asm-<arch> headers.
shims.copy_files(
    name = "genh",
    srcs = {
        "block/module_block.h": ":module_block.h",
        "config-host.h": ":config-host.h",
        "config-poison.h": ":config-poison.h",
        "linux-headers/asm": ":src[linux-headers/asm-x86]",
        "qemu-version.h": ":qemu-version.h",
    } | {
        out: ":" + out
        for out in HX.keys()
    } | {
        "qapi/" + f: ":qapi[{}]".format(f)
        for f in QAPI_OUTPUTS
        if f.endswith(".h")
    } | {
        "trace/trace-{}.h".format(group): ":trace-{}[h]".format(group)
        for group in TRACE_GROUPS.keys()
    } | {
        "ui/input-keymap-{}-to-{}.c.inc".format(a, b): ":keymaps[input-keymap-{}-to-{}.c.inc]".format(a, b)
        for a, b in KEYMAPS
    } | {
        "{}-softmmu-config-{}.h".format(t, kind): ":{}-softmmu-config-{}.h".format(t, kind)
        for t in TARGETS
        for kind in [
            "target",
            "devices",
        ]
    },
)

# MARK: Generated sources

shims.genrule(
    name = "block-gen.c",
    out = "block-gen.c",
    cmd = " ".join(["$(exe :run-script) $(location :src)/scripts/block-coroutine-wrapper.py $OUT"] + [
        "$(location :src)/" + h
        for h in [
            "include/block/block-io.h",
            "include/block/dirty-bitmap.h",
            "include/block/block_int-io.h",
            "include/block/block-global-state.h",
            "include/system/block-backend-global-state.h",
            "include/system/block-backend-io.h",
            "block/coroutines.h",
        ]
    ]),
)

shims.genrule(
    name = "gdbstub-xml.c",
    out = "gdbstub-xml.c",
    cmd = " ".join(["$(exe :run-script) $(location :src)/scripts/feature_to_c.py"] + [
        "$(location :src)/gdbstub/gdb-xml/" + f
        for f in sorted({f: True for t in TARGETS for f in GDB_XML[t]}.keys())
    ] + ["> $OUT"]),
)

# decodetree.py's decoders, each architecture's in one directory: meson puts
# them in the private directory of the library that includes them, which is
# always on that library's include path.
[
    shims.genrule(
        name = decoder(path),
        out = decoder(path) + ".c.inc",
        cmd = "$(exe :run-script) $(location :src)/scripts/decodetree.py $(location :src)/{} {} -o $OUT".format(
            path,
            " ".join(args),
        ),
    )
    for path, args in DECODETREE.items()
]

[
    shims.copy_files(
        name = "decode-" + arch,
        srcs = {
            decoder(path) + ".c.inc": ":" + decoder(path)
            for path in DECODETREE.keys()
            if path.split("/")[1] == arch
        },
    )
    for arch in ARCHES
]

# MARK: Libraries

# The include path of meson.build's add_project_arguments: the build root
# (the generated headers), the source root and include/, the host's headers
# and its TCG backend, and the kernel headers QEMU carries. meson also puts
# the directory of each generated header a library uses on its path, which a
# few sources rely on to include QAPI headers by bare name.
shims.cxx_library(
    name = "config",
    exported_deps = [
        "third-party//by-name/dt/dtc:libfdt",
        "third-party//by-name/gl/glib:glib",
        "third-party//by-name/li/libslirp:libslirp",
        "third-party//by-name/pi/pixman:pixman",
        "third-party//by-name/zl/zlib:libz",
    ],
    exported_preprocessor_flags = [
        "-D_GNU_SOURCE",
        "-D_FILE_OFFSET_BITS=64",
        "-D_LARGEFILE_SOURCE",
        "-isystem",
        "$(location :src)/linux-headers",
        "-isystem",
        "$(location :genh)/linux-headers",
        "-iquote",
        "$(location :genh)",
        "-I$(location :genh)/qapi",
        "-iquote",
        "$(location :src)",
        "-iquote",
        "$(location :src)/include",
        "-iquote",
        "$(location :src)/host/include/x86_64",
        "-iquote",
        "$(location :src)/host/include/generic",
        "-iquote",
        "$(location :src)/tcg/x86_64",
    ],
)

# libqemuutil: util_ss with the trace and QAPI sources, and stub_ss. The
# stubs only stand in for what the rest of QEMU leaves undefined, so this is
# the one library linked as an archive rather than whole.
qemu_library(
    name = "util",
    srcs = unconditional("util") + unconditional("stub") + [
        ":trace-{}[c]".format(group)
        for group in TRACE_GROUPS.keys()
    ] + [
        ":qapi[{}]".format(f)
        for f in QAPI_OUTPUTS
        if f.endswith(".c")
    ],
    link_whole = False,
)

# The libraries meson.build builds once and links whole into every emulator.
# ui, migration and event_loop_base are file lists there, not source sets.
COMMON_LIBRARIES = [
    "audio",
    "authz",
    "block",
    "blockdev",
    "chardev",
    "crypto",
    "event_loop_base",
    "hwcore",
    "io",
    "migration",
    "qmp",
    "qom",
    "ui",
]

[
    qemu_library(
        name = name,
        srcs = unconditional(name),
        deps = [":util"],
    )
    for name in COMMON_LIBRARIES
]

# libsystem and the common library hold the sources every system emulator
# shares, each compiled once, but which of them an emulator links depends on
# its devices. So each becomes one library per set of targets that link the
# same sources.
SHARED_SETS = {
    "common": [],
    "system": [
        "-DCONFIG_SOFTMMU",
        "-DCOMPILING_SYSTEM_VS_USER",
    ],
}

_SHARED = {name: partition(
    SOURCES[name],
    TARGETS,
    _SYMBOLS,
) for name in SHARED_SETS}

[
    qemu_library(
        name = "{}-{}".format(name, ts),
        srcs = srcs,
        flags = SHARED_SETS[name],
        deps = [":util"],
    )
    for name in SHARED_SETS
    for ts, srcs in _SHARED[name].items()
]

_SHARED_LIBRARIES = {
    target: [
        ":{}-{}".format(name, ts)
        for name in SHARED_SETS
        for ts in _SHARED[name].keys()
        if target in ts.split("+")
    ]
    for target in TARGETS
}

# include_directories('target/<arch>'), and the architecture's decoders.
_TARGET_INCLUDE = {
    arch: [
        "-I$(location :src)/target/" + arch,
        "-I$(location :decode-{})".format(arch),
    ]
    for arch in ARCHES
}

# Per base architecture: the sources meson.build compiles once for all of an
# architecture's targets, in the libraries it calls common_<arch>,
# system_<arch> and stubs_<arch>. CPU_DEFS_H keeps them from the per-target
# definitions in cpu.h.
ARCH_SETS = {
    "target_common_arch": ["-DCPU_DEFS_H"],
    "target_common_system_arch": [
        "-DCPU_DEFS_H",
        "-DCOMPILING_SYSTEM_VS_USER",
        "-DCONFIG_SOFTMMU",
    ],
    "target_stubs_arch": [
        "-DCPU_DEFS_H",
        "-DCOMPILING_SYSTEM_VS_USER",
        "-DCONFIG_SOFTMMU",
    ],
}

# meson.build filters these by the merged configuration of the
# architecture's targets.
_ARCH_SYMBOLS = {
    arch: {
        s: True
        for t in TARGETS
        if BASE_ARCH[t] == arch
        for s in SYMBOLS[t]
    }
    for arch in ARCHES
}

[
    qemu_library(
        name = "{}-{}".format(
            kind.replace("_", "-"),
            arch,
        ),
        srcs = selected(
            SOURCES.get(
                "{}/{}".format(kind, arch),
                [],
            ),
            _ARCH_SYMBOLS[arch],
        ),
        flags = flags + _TARGET_INCLUDE[arch],
        # The stubs stand in for the AArch64 code a 32-bit Arm emulator lacks,
        # so they are an archive: qemu-system-aarch64 takes nothing from it.
        link_whole = kind != "target_stubs_arch",
        deps = [":util"],
    )
    for kind, flags in ARCH_SETS.items()
    for arch in ARCHES
]

# Per target: the sources meson.build compiles into libqemu-<target>, with
# the target's configuration headers.
PER_TARGET_SETS = [
    "hw_arch",
    "target_arch",
    "target_system_arch",
]

_TARGET_FLAGS = {
    target: [
        "-DCOMPILING_PER_TARGET",
        "-DCONFIG_TARGET=\"{}-softmmu-config-target.h\"".format(target),
        "-DCONFIG_DEVICES=\"{}-softmmu-config-devices.h\"".format(target),
    ] + _TARGET_INCLUDE[BASE_ARCH[target]]
    for target in TARGETS
}

[
    qemu_library(
        name = "{}-softmmu".format(target),
        srcs = [_TARGET_INFO[target]] + selected(
            SOURCES["specific"],
            _SYMBOLS[target],
        ) + [
            f
            for kind in PER_TARGET_SETS
            for f in selected(
                SOURCES.get(
                    "{}/{}".format(
                        kind,
                        BASE_ARCH[target],
                    ),
                    [],
                ),
                _SYMBOLS[target],
            )
        ],
        flags = _TARGET_FLAGS[target],
        deps = [":util"],
    )
    for target in TARGETS
]

# MARK: Emulators

[
    shims.cxx_binary(
        name = "qemu-system-{}-bin".format(target),
        srcs = [":src[system/main.c]"],
        compiler_flags = QEMU_CFLAGS,
        # Static, so the emulators still run once copied into :qemu.
        link_style = "static",
        linker_flags = ["-lm"],
        preprocessor_flags = _TARGET_FLAGS[target],
        deps = [
            ":config",
            ":{}-softmmu".format(target),
        ] + [
            ":" + name
            for name in COMMON_LIBRARIES
        ] + _SHARED_LIBRARIES[target] + [
            ":{}-{}".format(
                kind.replace("_", "-"),
                BASE_ARCH[target],
            )
            for kind in ARCH_SETS
        ] + [
            ":util",
        ],
    )
    for target in TARGETS
]

# The emulators as installed: bin/ beside share/qemu, where QEMU, built
# relocatable, looks for its firmware, option ROMs and VNC keymaps. Those come
# prebuilt in the release's pc-bios/; meson installs them from there too.
shims.copy_files(
    name = "qemu",
    srcs = {
        "bin/qemu-system-" + target: ":qemu-system-{}-bin".format(target)
        for target in TARGETS
    } | {
        "share/qemu": ":src[pc-bios]",
    },
    visibility = ["PUBLIC"],
)

# What to `buck2 run`, or name with $(exe ...): the installed emulators.
[
    shims.command(
        name = "qemu-system-" + target,
        cmd = ["$(location :qemu)/bin/qemu-system-" + target],
        visibility = ["PUBLIC"],
    )
    for target in TARGETS
]

# MARK: Tests

[
    shims.command_test(
        name = "test-version-" + target,
        script = "test \"`$(exe :qemu-system-{}) -version | head -1`\" = \"QEMU emulator version {}\"".format(target, VERSION),
    )
    for target in TARGETS
]

# The machines and devices devices/ asks for, as the emulators report them.
EXPECTED = {
    "aarch64": {
        "devices": [
            "pcie-root-port",
            "ramfb",
            "tpm-tis-device",
            "virtio-blk-device",
            "virtio-net-device",
        ],
        "machines": ["virt"],
    },
    "riscv64": {
        "devices": [
            "pcie-root-port",
            "ramfb",
            "tpm-tis-device",
            "virtio-blk-device",
            "virtio-net-device",
        ],
        "machines": ["virt"],
    },
    "x86_64": {
        "devices": [
            "VGA",
            "isa-debug-exit",
            "isa-debugcon",
            "pcie-root-port",
            "tpm-crb",
            "tpm-tis",
            "virtio-vga",
        ],
        "machines": [
            "microvm",
            "q35",
        ],
    },
}

VIRTIO_PCI_DEVICES = [
    "virtio-balloon-pci",
    "virtio-blk-pci",
    "virtio-gpu-pci",
    "virtio-keyboard-pci",
    "virtio-net-pci",
    "virtio-rng-pci",
    "virtio-scsi-pci",
    "virtio-serial-pci",
    "virtio-tablet-pci",
]

[
    shims.command_test(
        name = "test-devices-" + target,
        script = "\n".join([
            "qemu=$(exe :qemu-system-{})".format(target),
            "devices=`$qemu -device help`",
            "machines=`$qemu -machine help`",
        ] + [
            "grep -q 'name \"{}\"' <<<\"$devices\" || {{ echo 'no {} device' >&2; exit 1; }}".format(d, d)
            for d in EXPECTED[target]["devices"] + VIRTIO_PCI_DEVICES
        ] + [
            "grep -q '^{} ' <<<\"$machines\" || {{ echo 'no {} machine' >&2; exit 1; }}".format(m, m)
            for m in EXPECTED[target]["machines"]
        ]),
    )
    for target in TARGETS
]

# The bare-metal programs under tests/, assembled and linked with the
# toolchain's clang for each guest architecture: an ELF for the machines
# that load one with -kernel, a flat image for the x86 ones, whose -bios
# takes only that. ld.lld is the one clang finds in its own directory or on
# the PATH, as Ubuntu's PATH has only ld.lld-<version>; clang can't run it
# for every guest itself, since it links an i386 ELF through gcc.
GUESTS = {
    "aarch64": (
        "aarch64-unknown-elf",
        ["-Ttext=0x40200000"],
        "elf",
    ),
    "riscv64": (
        "riscv64-unknown-elf -march=rv64gc",
        ["-Ttext=0x80000000"],
        "elf",
    ),
    "x86_64": (
        "i386-unknown-elf",
        [
            "--image-base=0",
            "-Ttext=0",
            "--oformat=binary",
        ],
        "bin",
    ),
}

[
    shims.genrule(
        name = "guest-{}.{}".format(target, suffix),
        srcs = ["tests/{}.S".format(target)],
        out = "guest-{}.{}".format(target, suffix),
        cmd = "clang --target={} -Wno-unused-command-line-argument -c $SRCS -o $TMP/guest.o && `clang --print-prog-name=ld.lld` {} $TMP/guest.o -o $OUT".format(
            triple,
            " ".join(ldflags),
        ),
    )
    for target, (triple, ldflags, suffix) in GUESTS.items()
]

shims.export_file(
    name = "boot.sh",
    src = "tests/boot.sh",
)

# Each emulator boots its guest program: "ok" on the console, then a clean
# exit through the machine's own test device.
BOOT = {
    "aarch64": (
        "0",
        [
            "-M virt -cpu max -kernel $(location :guest-aarch64.elf) -semihosting",
            "-serial stdio",
        ],
    ),
    "microvm": (
        "1",
        [
            "-M microvm -bios $(location :guest-x86_64.bin)",
            "-chardev stdio,id=out -device isa-debugcon,chardev=out",
            "-device isa-debug-exit,iobase=0xf4,iosize=4",
        ],
    ),
    "riscv64": (
        "0",
        [
            "-M virt -bios none -kernel $(location :guest-riscv64.elf)",
            "-serial stdio",
        ],
    ),
    "x86_64": (
        "1",
        [
            "-M q35 -bios $(location :guest-x86_64.bin)",
            "-chardev stdio,id=out -device isa-debugcon,chardev=out",
            "-device isa-debug-exit,iobase=0xf4,iosize=4",
        ],
    ),
}

[
    shims.command_test(
        name = "test-boot-" + name,
        script = " ".join([
            "$(location :boot.sh)",
            status,
            "$(exe :qemu-system-{})".format("x86_64" if name == "microvm" else name),
            "-nodefaults -display none",
        ] + args),
    )
    for name, (status, args) in BOOT.items()
]

shims.export_file(
    name = "devices.sh",
    src = "tests/devices.sh",
)

# Each emulator starts with VNC, user-mode networking, a vvfat drive and
# virtio-net, -blk and -gpu devices; on x86_64, from the firmware and option
# ROMs in :qemu's share/qemu.
[
    shims.command_test(
        name = "test-backends-" + target,
        script = " ".join([
            "$(location :devices.sh)",
            "$(exe :qemu-system-{})".format(target),
            machine,
            "-device virtio-net-pci,netdev=net0",
            "-device virtio-blk-pci,drive=fat0",
            "-device virtio-gpu-pci",
        ]),
    )
    for target, machine in {
        "aarch64": "-M virt -cpu max",
        "riscv64": "-M virt",
        "x86_64": "-M q35",
    }.items()
]

shims.export_file(
    name = "kvm-boot.sh",
    src = "tests/kvm-boot.sh",
)

shims.command(
    name = "kvm-boot",
    cmd = ["$(location :kvm-boot.sh)"],
)

# The x86_64 boot again under KVM, skipped where /dev/kvm is not usable.
shims.dynamic_test(
    name = "test-boot-x86_64-kvm",
    args = [
        "$(location :boot.sh)",
        "$(exe :qemu-system-x86_64)",
        "-M",
        "q35,accel=kvm",
        "-nodefaults",
        "-display",
        "none",
        "-bios",
        "$(location :guest-x86_64.bin)",
        "-chardev",
        "stdio,id=out",
        "-device",
        "isa-debugcon,chardev=out",
        "-device",
        "isa-debug-exit,iobase=0xf4,iosize=4",
    ],
    dep = ":kvm-boot",
)

# defs.bzl's rule, used as its callers would, on the riscv64 guest program.
qemu.run_qemu(
    name = "test-run-qemu",
    args = [
        "-M",
        "virt",
        "-bios",
        "none",
        "-kernel",
        "$(location :guest-riscv64.elf)",
    ],
    system = "riscv64",
)
