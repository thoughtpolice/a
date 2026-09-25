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
load(":inventory.bzl", "BINARIES", "DEFINES", "FILES", "LIBRARIES", "OVERLAY_FILES", "TABLEGEN")

SOURCE = ":llvm-project-23.1.0.src"

CHDIRENV = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"

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

CAPTURE = "cellar//bootstrap/stage1/tools:capture"

SED = "cellar//bootstrap/stage1/sed:sed"

CATM = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm"

def source_files():
    """Every tarball path the stages project out of the extracted source."""
    paths = {}
    for entry in LIBRARIES.values() + BINARIES.values():
        for src in entry["srcs"]:
            paths[src] = None
    for gen in TABLEGEN.values():
        paths[gen["td_file"]] = None
    for physical in OVERLAY_FILES.values():
        paths[physical] = None
    for recipe in FILES.values():
        for path in [recipe.get("template"), recipe.get("wrap")] + [path for path, _ in recipe.get("bundle", [])]:
            if path:
                paths[path] = None
    return sorted(paths.keys())

def _sed_script(substitutions):
    args = []
    for old, new in substitutions:
        for c in old.elems():
            if not (c.isalnum() or c in "_@# "):
                fail("template placeholder needs escaping: " + old)
        new = new.replace("\\", "\\\\").replace("&", "\\&").replace("|", "\\|").replace("\n", "\\n")
        args += ["-e", "s|{}|{}|".format(old, new)]
    return args

def llvm_files():
    """Configuration files shared by every stage, made from the tarball."""
    for path, recipe in FILES.items():
        name = "file-" + target_name(path)
        if "content" in recipe:
            write_file(
                name = name,
                content = recipe["content"],
            )
        elif "template" in recipe:
            generate(
                name = name,
                args = _sed_script(recipe["substitutions"]) + ["$(location {}[{}])".format(SOURCE, recipe["template"])],
                capture = CAPTURE,
                tool = SED,
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
                tool = CATM,
            )
        else:
            # clang/utils/bundle_resources.py: a raw string per input line.
            parts = []
            for i, (source, final_newline) in enumerate(recipe["bundle"]):
                write_file(
                    name = "{}-{}-head".format(name, i),
                    content = "const char {}[] = \n".format(source.rsplit("/", 1)[-1].replace(".", "_")),
                )
                generate(
                    name = "{}-{}-lines".format(name, i),
                    args = [
                        "-e",
                        's|^|  R"x(|',
                        "-e",
                        's|$|)x" "\\\\n"|',
                        "$(location {}[{}])".format(SOURCE, source),
                    ],
                    capture = CAPTURE,
                    tool = SED,
                )
                write_file(
                    name = "{}-{}-tail".format(name, i),
                    content = ('  R"x()x" "\\n"\n' if final_newline else "") + "  ;\n",
                )
                parts += [":{}-{}-{}".format(name, i, part) for part in ["head", "lines", "tail"]]
            concatenate(
                name = name,
                inputs = parts,
                tool = CATM,
            )

def _tablegen_outputs(stage):
    outputs = {}
    for key, gen in TABLEGEN.items():
        for i, (opts, outs) in enumerate(gen["outs"]):
            for out in outs:
                outputs[out] = ":{}-tblgen-{}-{}[{}]".format(stage, target_name(key), i, out.rsplit("/", 1)[-1])
    return outputs

def _generated_trees(stage):
    files = {path: ":file-" + target_name(path) for path in FILES}
    files.update({path: SOURCE + "[" + physical + "]" for path, physical in OVERLAY_FILES.items()})
    outputs = _tablegen_outputs(stage)
    for level, generator in enumerate(GENERATORS):
        tree = dict(files)
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

def _objects(stage, name, entry, toolchains, flags, defines):
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
            src = SOURCE + "[" + src + "]",
            defines = [defines.get(d.split("=")[0], d) for d in DEFINES[entry["defines"]]],
            flags = flags[language] + copts + includes,
            headers = [SOURCE, generated],
            object_name = "{}.o".format(i),
            toolchain = toolchains[language],
        )
        objects.append(":" + target)
    return objects

def llvm_stage(stage, toolchains, flags, defines, link):
    """Libraries, TableGen outputs and binaries of one stage.

    toolchains maps "c" and "c++" to compilers; flags maps them to extra
    compiler flags. defines replaces inventory defines by name, such as the
    target triples. link supplies startup objects, runtime libraries and
    end objects for binaries.
    """
    _generated_trees(stage)
    for key, gen in TABLEGEN.items():
        tool = ":{}-{}".format(stage, target_name(gen["tool"]))
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
                chdir = CHDIRENV,
                directory = True,
                files = [out.rsplit("/", 1)[-1] for out in outs],
                inputs = [SOURCE],
                tool = tool,
            )
    for name, entry in LIBRARIES.items():
        c_library(
            name = "{}-{}.a".format(stage, target_name(name)),
            objects = _objects(stage, name, entry, toolchains, flags, defines),
            output = "lib{}.a".format(target_name(name)),
            toolchain = toolchains["c++"],
        )
    for name, entry in BINARIES.items():
        c_binary(
            name = "{}-{}".format(stage, target_name(name)),
            end_objects = link["end_objects"],
            flags = link["flags"],
            libraries = [":{}-{}.a".format(stage, target_name(dep)) for dep in entry["link"]] + link["libraries"],
            objects = link["objects"] + _objects(stage, name, entry, toolchains, flags, defines),
            output = name.split(":")[1],
            toolchain = toolchains["c++"],
        )
