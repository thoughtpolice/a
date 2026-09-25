# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# These rules describe action mechanics only. Packages select sources, flags,
# compiler predecessors, runtime libraries and installation layouts in BUILD.

load("@cellar//bootstrap/platforms:rules.bzl", "native_attrs")

ObjectInfo = provider(fields = ["artifact", "abi", "format"])
LibraryInfo = provider(fields = ["artifact", "abi", "object_format", "format"])
SysrootInfo = provider(fields = ["root", "abi", "object_format"])
CompilerInfo = provider(fields = [
    "command",
    "linker",
    "archiver",
    "archive_flags",
    "archive_format",
    "family",
    "stage",
    "abi",
    "object_format",
    "execution_runtime",
    "sysroot",
    "cflags",
    "ldflags",
])

def _compiler_impl(ctx):
    expected = ("mes", "mes-concat") if ctx.attrs.family == "mescc" else ("elf64-x86-64", "ar")
    if (ctx.attrs.object_format, ctx.attrs.archive_format) != expected:
        fail("compiler family requires object/archive formats {}".format(expected))
    sysroot = ctx.attrs.sysroot[SysrootInfo] if ctx.attrs.sysroot else None
    if sysroot and (sysroot.abi != ctx.attrs.abi or sysroot.object_format != ctx.attrs.object_format):
        fail("compiler output ABI/object format does not match its sysroot")
    command = cmd_args(ctx.attrs.compiler[RunInfo])
    if sysroot and ctx.attrs.family == "tcc":
        command.add("-B", sysroot.root)
    runtime = ctx.attrs.execution_runtime[DefaultInfo].default_outputs if ctx.attrs.execution_runtime else []
    command = cmd_args(command, hidden = runtime)
    linker = ctx.attrs.linker[RunInfo] if ctx.attrs.linker else command
    return [DefaultInfo(), RunInfo(args = command), CompilerInfo(
        command = command,
        linker = linker,
        archiver = ctx.attrs.archiver[RunInfo] if ctx.attrs.archiver else None,
        archive_flags = ctx.attrs.archive_flags,
        archive_format = ctx.attrs.archive_format,
        family = ctx.attrs.family,
        stage = ctx.attrs.stage,
        abi = ctx.attrs.abi,
        object_format = ctx.attrs.object_format,
        execution_runtime = runtime,
        sysroot = sysroot,
        cflags = ctx.attrs.cflags,
        ldflags = ctx.attrs.ldflags,
    )]

_compiler_rule = rule(impl = _compiler_impl, attrs = {
    "compiler": attrs.exec_dep(providers = [RunInfo]),
    "linker": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
    "archiver": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
    "archive_flags": attrs.list(attrs.string(), default = []),
    "archive_format": attrs.enum(["mes-concat", "ar"]),
    "family": attrs.enum(["mescc", "tcc", "gcc", "clang"]),
    "stage": attrs.string(),
    "abi": attrs.enum(["x86_64-mes", "x86_64-sysv"]),
    "object_format": attrs.enum(["mes", "elf64-x86-64"]),
    "execution_runtime": attrs.option(attrs.exec_dep(), default = None),
    "sysroot": attrs.option(attrs.dep(providers = [SysrootInfo]), default = None),
    "cflags": attrs.list(attrs.arg(), default = []),
    "ldflags": attrs.list(attrs.arg(), default = []),
})

def compiler(**kwargs):
    _compiler_rule(**native_attrs(kwargs))

def _logical_path(path):
    if not path or path.startswith("/") or ".." in path.split("/"):
        fail("expected a relative path within the declared source tree: " + path)
    return "source/" + path

def _object_impl(ctx):
    tc = ctx.attrs.toolchain[CompilerInfo]

    # MesCC creates assembly beside each object. Keep the whole scratch tree
    # declared and give all compiler generations the same short object name.
    work = ctx.actions.declare_output("work", dir = True, has_content_based_path = False)
    obj = work.project(ctx.attrs.object_name)
    flags = cmd_args(tc.cflags, ctx.attrs.flags)
    for define in ctx.attrs.defines:
        flags.add("-D", define)
    for include in ctx.attrs.includes:
        flags.add("-I", include)
    if ctx.attrs.source_tree != None:
        if ctx.attrs.source_alias == None:
            fail("logical source compilation requires a bootstrapped source_alias tool")
        source = _logical_path(ctx.attrs.logical_source)
        for include in ctx.attrs.logical_includes:
            flags.add("-I", _logical_path(include))
    else:
        if ctx.attrs.logical_source or ctx.attrs.logical_includes or ctx.attrs.source_alias:
            fail("logical source arguments require source_tree")
        source = ctx.attrs.src

    # Register complete header trees before their projected source/include
    # paths. Buck's native sandbox creates input links in visitation order;
    # visiting a child first can hide its parent's other declared files.
    command = cmd_args(cmd_args(hidden = ctx.attrs.headers), tc.command, flags, "-c", source, "-o", ctx.attrs.object_name)
    if ctx.attrs.source_tree != None:
        # The immutable tree is aliased inside this action's writable output.
        # GCC receives stable source/include spellings while its intermediate
        # assembly and temporary files remain in the declared work directory.
        command = cmd_args(ctx.attrs.source_alias[RunInfo], ctx.attrs.source_tree, command, hidden = ctx.attrs.src)
    ctx.actions.run(
        cmd_args(ctx.attrs.chdir[RunInfo], work.as_output(), cmd_args(command, relative_to = work)),
        clear_environment = True,
        category = "bootstrap_compile",
    )
    return [
        DefaultInfo(default_output = obj),
        ObjectInfo(artifact = obj, abi = tc.abi, format = tc.object_format),
    ]

_c_object_rule = rule(impl = _object_impl, attrs = {
    "toolchain": attrs.exec_dep(providers = [CompilerInfo]),
    "src": attrs.source(),
    "source_tree": attrs.option(attrs.source(), default = None),
    "logical_source": attrs.string(default = ""),
    "logical_includes": attrs.list(attrs.string(), default = []),
    "source_alias": attrs.option(attrs.exec_dep(providers = [RunInfo]), default = None),
    "headers": attrs.list(attrs.source(), default = []),
    "includes": attrs.list(attrs.source(), default = []),
    "defines": attrs.list(attrs.string(), default = []),
    "flags": attrs.list(attrs.arg(), default = []),
    "object_name": attrs.string(default = "unit.o"),
    "chdir": attrs.exec_dep(providers = [RunInfo], default = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"),
})

def c_object(**kwargs):
    _c_object_rule(**native_attrs(kwargs))

def _objects(deps, tc):
    result = []
    for dep in deps:
        obj = dep[ObjectInfo]
        if obj.abi != tc.abi or obj.format != tc.object_format:
            fail("incompatible object {}: {}/{}, compiler produces {}/{}".format(dep.label, obj.abi, obj.format, tc.abi, tc.object_format))
        result.append(obj.artifact)
    return result

def _archive_impl(ctx):
    tc = ctx.attrs.toolchain[CompilerInfo]
    if tc.archiver == None:
        fail("toolchain has no archiver")
    objects = _objects(ctx.attrs.objects, tc)
    names = {}
    for obj in objects:
        # The seed TCC archiver stores only 15 characters of a member name;
        # binutils and LLVM archivers keep long names whole.
        name = obj.basename[:15] if tc.family in ("mescc", "tcc") else obj.basename
        if name in names:
            fail("archive member name collision: " + name)
        names[name] = True
    output = ctx.actions.declare_output(ctx.attrs.output, has_content_based_path = False)
    ctx.actions.run(
        cmd_args(tc.archiver, tc.archive_flags, output.as_output(), objects),
        clear_environment = True,
        category = "bootstrap_archive",
    )
    return [DefaultInfo(default_output = output), LibraryInfo(
        artifact = output,
        abi = tc.abi,
        object_format = tc.object_format,
        format = tc.archive_format,
    )]

_c_library_rule = rule(impl = _archive_impl, attrs = {
    "toolchain": attrs.exec_dep(providers = [CompilerInfo]),
    "objects": attrs.list(attrs.dep(providers = [ObjectInfo])),
    "output": attrs.string(),
})

def c_library(**kwargs):
    _c_library_rule(**native_attrs(kwargs))

# crtend.o ends .eh_frame with the zero terminator that ld keeps only from the
# last input supplying the section, and crtn.o ends .init and .fini. As in a
# compiler driver's link, both follow the libraries.
_END_OBJECTS = [
    "crtend.o",
    "crtn.o",
]

def _binary_impl(ctx):
    tc = ctx.attrs.toolchain[CompilerInfo]
    for dep in ctx.attrs.objects:
        if any([dep.label.name.endswith(name) for name in _END_OBJECTS]):
            fail("{} must be linked after the libraries: list it in end_objects".format(dep.label))
    objects = _objects(ctx.attrs.objects, tc)
    libraries = []
    for dep in ctx.attrs.libraries:
        lib = dep[LibraryInfo]
        if lib.abi != tc.abi or lib.object_format != tc.object_format or lib.format != tc.archive_format:
            fail("incompatible library: " + str(dep.label))
        libraries.append(lib.artifact)
    if tc.object_format == "mes":
        # MesCC only accepts .o positional inputs; its .a format is an ordered
        # concatenation of those same objects. Expose explicit libraries under
        # .o names so MesCC cannot silently drop them or search an ambient -L.
        aliases = ctx.actions.copied_dir("mes-libraries", {
            "lib{}.o".format(i): lib
            for i, lib in enumerate(libraries)
        }, has_content_based_path = False)
        libraries = [aliases.project("lib{}.o".format(i)) for i in range(len(libraries))]
    work = ctx.actions.declare_output("work", dir = True, has_content_based_path = False)
    output = work.project(ctx.attrs.output)
    end_objects = _objects(ctx.attrs.end_objects, tc)
    command = cmd_args(tc.linker, tc.ldflags, ctx.attrs.flags, objects, libraries, end_objects, "-o", ctx.attrs.output)
    ctx.actions.run(
        cmd_args(ctx.attrs.chdir[RunInfo], work.as_output(), cmd_args(command, relative_to = work)),
        clear_environment = True,
        category = "bootstrap_link",
    )
    return [DefaultInfo(default_output = output), RunInfo(args = cmd_args(output))]

_c_binary_rule = rule(impl = _binary_impl, attrs = {
    "toolchain": attrs.exec_dep(providers = [CompilerInfo]),
    "objects": attrs.list(attrs.dep(providers = [ObjectInfo])),
    "libraries": attrs.list(attrs.dep(providers = [LibraryInfo]), default = []),
    "end_objects": attrs.list(attrs.dep(providers = [ObjectInfo]), default = []),
    "flags": attrs.list(attrs.arg(), default = []),
    "output": attrs.string(default = "program"),
    "chdir": attrs.exec_dep(providers = [RunInfo], default = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"),
})

def c_binary(**kwargs):
    _c_binary_rule(**native_attrs(kwargs))

def _import_impl(ctx):
    # Attach ABI metadata to an existing bootstrapped artifact. This does not
    # run an installed compiler or introduce a new binary seed.
    artifact = ctx.attrs.src
    if ctx.attrs.kind == "object":
        info = ObjectInfo(artifact = artifact, abi = ctx.attrs.abi, format = ctx.attrs.object_format)
    else:
        info = LibraryInfo(artifact = artifact, abi = ctx.attrs.abi, object_format = ctx.attrs.object_format, format = ctx.attrs.archive_format)
    return [DefaultInfo(default_output = artifact), info]

_bootstrap_artifact_rule = rule(impl = _import_impl, attrs = {
    "src": attrs.source(),
    "kind": attrs.enum(["object", "library"]),
    "abi": attrs.enum(["x86_64-mes", "x86_64-sysv"]),
    "object_format": attrs.enum(["mes", "elf64-x86-64"]),
    "archive_format": attrs.enum(["mes-concat", "ar"], default = "mes-concat"),
})

def bootstrap_artifact(**kwargs):
    _bootstrap_artifact_rule(**native_attrs(kwargs))

def _sysroot_impl(ctx):
    files = dict(ctx.attrs.files)
    for path, dep in ctx.attrs.objects.items():
        obj = dep[ObjectInfo]
        if obj.abi != ctx.attrs.abi or obj.format != ctx.attrs.object_format:
            fail("sysroot object ABI mismatch: " + path)
        if path in files:
            fail("duplicate sysroot path: " + path)
        files[path] = obj.artifact
    for path, dep in ctx.attrs.libraries.items():
        lib = dep[LibraryInfo]
        if lib.abi != ctx.attrs.abi or lib.object_format != ctx.attrs.object_format:
            fail("sysroot library ABI mismatch: " + path)
        if path in files:
            fail("duplicate sysroot path: " + path)
        files[path] = lib.artifact
    output = ctx.actions.copied_dir("sysroot", files, has_content_based_path = False)
    return [DefaultInfo(default_output = output, sub_targets = {
        path: [DefaultInfo(default_output = output.project(path))]
        for path in files
    }), SysrootInfo(root = output, abi = ctx.attrs.abi, object_format = ctx.attrs.object_format)]

_sysroot_rule = rule(impl = _sysroot_impl, attrs = {
    "abi": attrs.enum(["x86_64-mes", "x86_64-sysv"]),
    "object_format": attrs.enum(["mes", "elf64-x86-64"]),
    "files": attrs.dict(attrs.string(), attrs.source(), default = {}),
    "objects": attrs.dict(attrs.string(), attrs.dep(providers = [ObjectInfo]), default = {}),
    "libraries": attrs.dict(attrs.string(), attrs.dep(providers = [LibraryInfo]), default = {}),
})

def sysroot(**kwargs):
    _sysroot_rule(**native_attrs(kwargs))
