# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Helpers for BUILD: turning sources.bzl's source sets into libraries."""

load("@root//buck/shims:shims.bzl", "shims")
load(":sources.bzl", "SOURCES")

# meson.build's flags for every C file, as clang accepts them: the common
# flags, the x86-64-v1 baseline, its hardening flags and the warnings it
# turns off. Optimization stays at meson's -O2 even in debug builds, where
# the emulators would otherwise run guest code too slowly to be useful.
QEMU_CFLAGS = [
    "-std=gnu11",
    "-O2",
    "-fno-strict-aliasing",
    "-fno-common",
    "-fwrapv",
    "-mcx16",
    "-msse2",
    "-ftrivial-auto-var-init=zero",
    "-fzero-call-used-regs=used-gpr",
    "-fstack-protector-strong",
    "-Wno-gnu-variable-sized-type-not-at-end",
    "-Wno-initializer-overrides",
    "-Wno-missing-include-dirs",
    "-Wno-psabi",
    "-Wno-shift-negative-value",
    "-Wno-string-plus-int",
    "-Wno-tautological-type-limit-compare",
    "-Wno-typedef-redefinition",
]

def _holds(cond, symbols):
    for s in cond:
        if s.startswith("!"):
            if s[1:] in symbols:
                return False
        elif s not in symbols:
            return False
    return True

def selected(entries, symbols):
    """The sources of a source set that a target with `symbols` builds."""
    out = []
    for cond, files in entries:
        if _holds(cond, symbols):
            out += [f for f in files if f not in out]
    return out

def unconditional(name):
    """The sources of a source set no target's configuration filters."""
    for cond, _ in SOURCES[name]:
        if cond:
            fail("{}: sources under {} need a per-target library".format(name, cond))
    return selected(SOURCES[name], {})

def partition(entries, targets, symbols):
    """{"t1+t2": sources} for the sources each set of targets builds alike."""
    users = {}
    for t in targets:
        for f in selected(entries, symbols[t]):
            users.setdefault(f, []).append(t)
    groups = {}
    for f, ts in users.items():
        groups.setdefault("+".join(ts), []).append(f)
    return groups

def decoder(path):
    """The name decodetree.py's output for a .decode file gets."""
    return "decode-" + path.rsplit("/", 1)[1].removesuffix(".decode")

def _src(f):
    """A source set entry as a cxx source, or None for a header."""
    if f.startswith("decodetree:") or f == "gen:block/module_block.h":
        return None
    if f.startswith("gen:"):
        return ":" + f.removeprefix("gen:").rsplit("/", 1)[-1]
    return ":src[{}]".format(f)

def qemu_library(name, srcs, flags = [], link_whole = True, deps = []):
    """A static library of source set entries, or of labels (":...").

    Linked whole by default, as meson.build links the objects of its
    libraries into each emulator: QEMU registers its types and devices from
    constructors no other object refers to.
    """
    srcs = [f if f.startswith(":") else _src(f) for f in srcs]
    shims.cxx_library(
        name = name,
        srcs = [s for s in srcs if s],
        compiler_flags = QEMU_CFLAGS,
        link_whole = link_whole,
        preprocessor_flags = flags,
        preferred_linkage = "static",
        deps = [":config"] + deps,
    )

def archive_files(extra):
    """Every source file the source sets name, and `extra`, sorted."""
    files = {f: True for f in extra}
    for entries in SOURCES.values():
        for _, srcs in entries:
            for f in srcs:
                if ":" not in f:
                    files[f] = True
    return sorted(files.keys())
