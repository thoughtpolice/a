# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Instantiate the LLVM inventory for one compiler stage. The inventory names
# libraries and binaries as "package:name" and paths relative to the source
# tarball; every stage compiles the same sources with its own toolchain and
# runs its own TableGen binaries.

load("@cellar//bootstrap:actions.bzl", "concatenate", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":inventory.bzl", "BINARIES", "DEFINES", "FILES", "LIBRARIES", "LLVM_VERSION", "OVERLAY_FILES", "RESOURCE_HEADERS", "TABLEGEN")

# The compiler's part of the tarball. The runtimes have a tree of their own,
# so that their files never change this one.
SOURCE = ":compiler-source"

LLVM_MAJOR = LLVM_VERSION.split(".")[0]

SED = "cellar//bootstrap/stage1/sed:sed"

CATM = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm"

PYTHON = "cellar//bootstrap/stage1/python:python3"

# Generated headers are grouped by the program that makes them. A library
# compiles against the tree of the latest generator it needs, so the
# TableGen binaries themselves never wait on their own outputs.
GENERATORS = [
    "config",
    "llvm:llvm-min-tblgen",
    "llvm:llvm-tblgen",
    "clang:clang-tblgen",
]

def target_name(name):
    return name.replace(":", "-").replace("/", "-")

def _level(generators):
    level = 0
    for generator in generators:
        level = max(level, GENERATORS.index(generator))
    return level

def sed_replacement(text):
    """text as the replacement of a sed s|pattern|replacement| command, which
    reads a backslash, an ampersand, the delimiter and a newline specially."""
    return text.replace("\\", "\\\\").replace("&", "\\&").replace("|", "\\|").replace("\n", "\\n")

def source_files():
    """Every tarball path the stages project out of the extracted source."""
    paths = {}

    # AArch64's Support library uses NEON in place of the x86 BLAKE3 assembly.
    # This is only a projection; both inventories share the extracted tree.
    paths["llvm/lib/Support/BLAKE3/blake3_neon.c"] = None
    for entry in LIBRARIES.values() + BINARIES.values():
        for src in entry["srcs"]:
            if src not in FILES:
                paths[src] = None
    for gen in TABLEGEN.values():
        paths[gen["td_file"]] = None
    for physical in OVERLAY_FILES.values():
        paths[physical] = None
    generated = _generated_paths()
    for path in RESOURCE_HEADERS:
        if path not in generated:
            paths[path] = None
    for recipe in FILES.values():
        for path in [recipe.get("template"), recipe.get("wrap"), recipe.get("script")] + recipe.get("args", []):
            if path and path not in FILES:
                paths[path] = None
    return sorted(paths.keys())

def _sed_script(substitutions):
    args = []
    for old, new in substitutions:
        for c in old.elems():
            if not (c.isalnum() or c in "_@# "):
                fail("template placeholder needs escaping: " + old)
        args += ["-e", "s|{}|{}|".format(old, sed_replacement(new))]
    return args

def llvm_files(target_cpu = None):
    """Configuration files shared by every stage, made from the tarball."""
    kwargs = {"target_cpu": target_cpu} if target_cpu else {}
    for path, recipe in FILES.items():
        name = "file-" + target_name(path)

        # Compilers choose a language by extension, so outputs keep the name.
        output = path.rsplit("/", 1)[-1]
        if "content" in recipe:
            write_file(
                name = name,
                content = recipe["content"],
            )
        elif "template" in recipe:
            generate(
                name = name,
                args = _sed_script(recipe["substitutions"]) + ["$(location {}[{}])".format(SOURCE, recipe["template"])],
                capture = True,
                output = output,
                tool = SED,
                **kwargs
            )
        elif "wrap" in recipe:
            write_file(
                name = name + "-prefix",
                content = recipe["prefix"],
            )
            write_file(
                name = name + "-suffix",
                content = recipe["suffix"],
            )
            concatenate(
                name = name,
                inputs = [
                    ":" + name + "-prefix",
                    "{}[{}]".format(SOURCE, recipe["wrap"]),
                    ":" + name + "-suffix",
                ],
                output = output,
                tool = CATM,
                **kwargs
            )
        else:
            # The script runs in its output directory and names its output
            # among its arguments.
            generate(
                name = name,
                args = ["$(location {}[{}])".format(SOURCE, recipe["script"])] + [
                    output if arg == path else "$(location {}[{}])".format(SOURCE, arg)
                    for arg in recipe["args"]
                ],
                chdir = True,
                directory = True,
                files = [output],
                tool = PYTHON,
                **kwargs
            )

def _file(path):
    """The target that holds a file the inventory makes from the tarball."""
    if "script" in FILES[path]:
        return ":file-{}[{}]".format(target_name(path), path.rsplit("/", 1)[-1])
    return ":file-" + target_name(path)

def _scripted_files():
    """The files LLVM's Python scripts make, which only the last generated
    tree holds, so that only the libraries compiling against clang-tblgen's
    outputs wait for the bootstrapped Python."""
    paths = [path for path, recipe in FILES.items() if "script" in recipe]
    for path in paths:
        if not path.startswith("clang/"):
            fail("files made by scripts join only clang-tblgen's tree, which no LLVM library compiles against: " + path)
    return paths

def _generated_paths():
    return {out: None for gen in TABLEGEN.values() for opts, outs in gen["outs"] for out in outs}

def resource_headers(stage):
    """Clang's resource directory headers, some made by clang-tblgen."""
    outputs = _tablegen_outputs(stage)
    return {
        "lib/clang/{}/include/{}".format(LLVM_MAJOR, path[len("clang/lib/Headers/"):]): outputs.get(path, "{}[{}]".format(SOURCE, path))
        for path in RESOURCE_HEADERS
    }

def _tablegen_outputs(stage):
    outputs = {}
    for key, gen in TABLEGEN.items():
        for i, (opts, outs) in enumerate(gen["outs"]):
            for out in outs:
                outputs[out] = ":{}-tblgen-{}-{}[{}]".format(stage, target_name(key), i, out.rsplit("/", 1)[-1])
    return outputs

def _generated_trees(stage):
    files = {path: _file(path) for path in FILES}
    files.update({path: SOURCE + "[" + physical + "]" for path, physical in OVERLAY_FILES.items()})
    scripted = _scripted_files()
    outputs = _tablegen_outputs(stage)
    for level, generator in enumerate(GENERATORS):
        tree = {
            path: target
            for path, target in files.items()
            if path not in scripted or generator == GENERATORS[-1]
        }
        for key, gen in TABLEGEN.items():
            if GENERATORS.index(gen["tool"]) <= level:
                for opts, outs in gen["outs"]:
                    for out in outs:
                        tree[out] = outputs[out]
        filegroup(
            name = "{}-generated-{}".format(stage, level),
            srcs = tree,
        )

def _include_flags(includes, generated):
    flags = [
        "-iquote",
        "$(location {})".format(SOURCE),
        "-iquote",
        "$(location {})".format(generated),
    ]
    for include in includes:
        flags += [
            "-isystem",
            "$(location {})/{}".format(SOURCE, include),
            "-isystem",
            "$(location {})/{}".format(generated, include),
        ]
    return flags

def _objects(stage, name, entry, toolchains, flags, defines, target_cpu = None, inventory_defines = DEFINES):
    generated = ":{}-generated-{}".format(stage, _level(entry["generators"]))
    includes = _include_flags(entry["includes"], generated)
    copts = [
        copt.replace("@SOURCE@", "$(location {})".format(SOURCE)).replace("@GENERATED@", "$(location {})".format(generated))
        for copt in entry["copts"]
    ]
    objects = []
    for i, src in enumerate(entry["srcs"]):
        language = "c" if src.endswith((".c", ".S")) else "c++"
        target = "{}-{}-{}".format(stage, target_name(name), i)
        c_object(
            name = target,
            src = _file(src) if src in FILES else SOURCE + "[" + src + "]",
            defines = [defines.get(d.split("=")[0], d) for d in inventory_defines[entry["defines"]]],
            flags = flags[language] + copts + includes,
            headers = [SOURCE, generated],
            object_name = "{}.o".format(i),
            toolchain = toolchains[language],
            **({"target_cpu": target_cpu} if target_cpu else {})
        )
        objects.append(":" + target)
    return objects

def llvm_stage(stage, toolchains, flags, defines, runtime, link_flags, link_objects = [], link_libraries = [], target_cpu = None, generators = None, chdir = True, libraries = LIBRARIES, inventory_defines = DEFINES):
    """Libraries, TableGen outputs and binaries of one stage.

    toolchains maps "c" and "c++" to compilers; flags maps them to extra
    compiler flags. defines replaces inventory defines by name, such as the
    target triples. Binaries link against runtime with link_flags, with
    link_objects before their own objects and link_libraries after their
    own libraries.
    """
    kwargs = {"target_cpu": target_cpu} if target_cpu else {}
    _generated_trees(stage)
    for key, gen in TABLEGEN.items():
        tool = generators[gen["tool"]] if generators else ":{}-{}".format(stage, target_name(gen["tool"]))
        includes = []
        for include in gen["includes"]:
            includes += ["-I", "$(location {})/{}".format(SOURCE, include)]
        for i, (opts, outs) in enumerate(gen["outs"]):
            generate(
                name = "{}-tblgen-{}-{}".format(stage, target_name(key), i),
                args = opts + ["$(location {})/{}".format(SOURCE, gen["td_file"])] + includes + [
                    "-o",
                    outs[0].rsplit("/", 1)[-1],
                ],
                chdir = chdir,
                directory = True,
                files = [out.rsplit("/", 1)[-1] for out in outs],
                inputs = [SOURCE],
                tool = tool,
                **kwargs
            )
    for name, entry in libraries.items():
        c_library(
            name = "{}-{}.a".format(stage, target_name(name)),
            objects = _objects(stage, name, entry, toolchains, flags, defines, target_cpu, inventory_defines),
            output = "lib{}.a".format(target_name(name)),
            toolchain = toolchains["c++"],
            **kwargs
        )
    for name, entry in BINARIES.items():
        c_binary(
            name = "{}-{}".format(stage, target_name(name)),
            flags = link_flags,
            libraries = [":{}-{}.a".format(stage, target_name(dep)) for dep in entry["link"]] + link_libraries,
            objects = link_objects + _objects(stage, name, entry, toolchains, flags, defines, target_cpu, inventory_defines),
            output = name.split(":")[1],
            runtime = runtime,
            toolchain = toolchains["c++"],
            **kwargs
        )
