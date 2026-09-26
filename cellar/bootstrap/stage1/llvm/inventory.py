#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Translate LLVM's Bazel overlay into a cellar inventory.

LLVM keeps Bazel build files for its projects under
utils/bazel/llvm-project-overlay. They list every library's sources, include
directories, defines and TableGen invocations. This evaluates them for one
configuration, x86_64 Linux with musl and GCC, and writes the closure of the
requested tools as Starlark data for the cellar BUILD files. It runs against
an extracted release tarball, and nothing in a build runs it;
buck2 run cellar//bootstrap/stage1/llvm:inventory runs it with the
bootstrapped python3 and passes it the tarball, the committed inventory and
the tools that inventory names.

    inventory.py path/to/llvm-project-23.1.0.src inventory.bzl \
        //llvm:llvm-min-tblgen //llvm:llvm-tblgen

With --check, it instead regenerates an existing inventory from the binaries
it names and fails if the result differs.

The evaluation follows Bazel: globs stay within their package, selects are
resolved against the configuration after every package is loaded, `defines`
and `includes` propagate to dependents, and TableGen gets the transitive
include directories of its td_library dependencies.

It also records the source and header lists that the runtimes' CMake files
spell out literally, such as the headers libc++ installs and the generic
compiler-rt builtins. Which of them a configuration builds is decided in the
BUILD files.
"""

import argparse
import os
import re
import shlex
import sys

OVERLAY = "utils/bazel/llvm-project-overlay"

# The configuration: constraint values that hold, and build setting values.
CONSTRAINTS = {
    "@platforms//os:linux",
    "@platforms//cpu:x86_64",
    "@llvm//platforms/config:musl",
}
SETTINGS = {
    "@rules_cc//cc/compiler:compiler": "gcc",
    "//third-party:llvm_enable_zlib": "false",
    "//third-party:llvm_enable_zstd": "false",
}
TARGETS = ["AArch64", "X86"]

# Packages this configuration never needs. Labels into them are errors.
STUB_PACKAGES = {
    "libc": {
        # APFloat includes LLVM libc's shared math headers. The overlay's
        # target is header-only; its dependencies are more headers.
        "shared_math_headers_for_apfloat": {"includes": ["libc", "libc/include"]},
    },
}


class Failure(Exception):
    pass


def fail(message, *args):
    raise Failure(" ".join([str(message)] + [str(a) for a in args]))


class Select:
    """A select or a concatenation involving selects, resolved later."""

    def __init__(self, parts):
        self.parts = parts  # [(operator, value-or-("select", dict))]

    @staticmethod
    def of(mapping):
        return Select([("", ("select", mapping))])

    def _join(self, operator, other, reverse):
        other_parts = other.parts if isinstance(other, Select) else [("", ("value", other))]
        if reverse:
            left, right = other_parts, self.parts
        else:
            left, right = self.parts, other_parts
        return Select(left + [(operator, right[0][1])] + right[1:])

    def __add__(self, other):
        return self._join("+", other, False)

    def __radd__(self, other):
        return self._join("+", other, True)

    def __or__(self, other):
        return self._join("|", other, False)

    def __ror__(self, other):
        return self._join("|", other, True)


class Label:
    def __init__(self, package, name):
        self.package = package
        self.name = name

    def __repr__(self):
        return "//{}:{}".format(self.package, self.name)

    def __eq__(self, other):
        return isinstance(other, Label) and (self.package, self.name) == (other.package, other.name)

    def __hash__(self):
        return hash((self.package, self.name))


def parse_label(text, package):
    if isinstance(text, Label):
        return text
    if text.startswith("@llvm-project//"):
        text = text[len("@llvm-project"):]
    if text.startswith("@"):
        return None  # an external repository
    if text.startswith("//"):
        body = text[2:]
        if ":" in body:
            pkg, name = body.split(":", 1)
        else:
            pkg, name = body, body.rsplit("/", 1)[-1]
        return Label(pkg, name)
    if text.startswith(":"):
        return Label(package, text[1:])
    return Label(package, text)


class Rule:
    def __init__(self, kind, package, attrs):
        self.kind = kind
        self.package = package
        self.attrs = attrs
        self.label = Label(package, attrs["name"])


class Workspace:
    def __init__(self, root):
        self.root = root
        self.rules = {}
        self.outputs = {}  # Label of a generated file -> producing rule
        self.loaded = set()
        self.subpackages = self._find_packages()
        self.file_cache = {}
        self.current = None

    # Package discovery and globbing.

    def _find_packages(self):
        packages = set()
        base = os.path.join(self.root, OVERLAY)
        for directory, _, files in os.walk(base):
            if "BUILD.bazel" in files or "BUILD" in files:
                packages.add(os.path.relpath(directory, base).replace(os.sep, "/"))
        packages.discard(".")
        return packages

    def package_files(self, package):
        """Files of a package, as (package-relative path, workspace path)."""
        if package in self.file_cache:
            return self.file_cache[package]
        files = {}
        for base, prefix in [(os.path.join(self.root, package), package),
                             (os.path.join(self.root, OVERLAY, package), OVERLAY + "/" + package)]:
            for directory, dirs, names in os.walk(base):
                relative = os.path.relpath(directory, base).replace(os.sep, "/")
                relative = "" if relative == "." else relative
                keep = []
                for d in dirs:
                    sub = (relative + "/" + d) if relative else d
                    if package + "/" + sub not in self.subpackages:
                        keep.append(d)
                dirs[:] = keep
                for name in names:
                    path = (relative + "/" + name) if relative else name
                    if prefix.startswith(OVERLAY) and (name in ("BUILD.bazel", "BUILD") or name.endswith(".bzl")):
                        continue
                    # Overlay files replace source files of the same path.
                    files[path] = prefix + "/" + path
        self.file_cache[package] = files
        return files

    @staticmethod
    def _pattern(glob):
        out = ""
        i = 0
        while i < len(glob):
            if glob.startswith("**/", i):
                out += "(?:.*/)?"
                i += 3
            elif glob.startswith("**", i):
                out += ".*"
                i += 2
            elif glob[i] == "*":
                out += "[^/]*"
                i += 1
            elif glob[i] == "?":
                out += "[^/]"
                i += 1
            else:
                out += re.escape(glob[i])
                i += 1
        return re.compile(out + r"\Z")

    def glob(self, include, exclude=(), allow_empty=True, exclude_directories=1):
        files = self.package_files(self.current)
        patterns = [self._pattern(g) for g in include]
        excludes = [self._pattern(g) for g in exclude]
        result = sorted(
            path for path in files
            if any(p.match(path) for p in patterns) and not any(p.match(path) for p in excludes)
        )
        if not result and not allow_empty:
            fail("empty glob in", self.current, include)
        return result

    # Loading.

    def load_package(self, package):
        if package in self.loaded:
            return
        self.loaded.add(package)
        if package in STUB_PACKAGES:
            for name, attrs in STUB_PACKAGES[package].items():
                self.add_rule("stub_library", package, dict(attrs, name=name))
            return
        path = os.path.join(self.root, OVERLAY, package, "BUILD.bazel")
        if not os.path.exists(path):
            fail("no overlay package", package)
        saved = self.current
        self.current = package
        try:
            env = self.environment(package)
            with open(path) as f:
                code = compile(f.read(), path, "exec")
            exec(code, env)
        finally:
            self.current = saved

    def add_rule(self, kind, package, attrs):
        rule = Rule(kind, package, attrs)
        if rule.label in self.rules:
            fail("duplicate rule", rule.label)
        self.rules[rule.label] = rule
        return rule

    def environment(self, package):
        ws = self
        env = {"__builtins__": __builtins__}

        def rule_function(kind):
            def create(**attrs):
                ws.add_rule(kind, ws.current, attrs)
            return create

        def load(label, *names, **aliases):
            symbols = self.bzl_symbols(label)
            for name in names:
                if name not in symbols:
                    fail("unknown symbol", name, "from", label)
                env[name] = symbols[name]
            for alias, name in aliases.items():
                env[alias] = symbols[name]

        env.update(self.builtins(rule_function))
        env["load"] = load
        return env

    def builtins(self, rule_function):
        ws = self

        class Native:
            pass

        native = Native()
        functions = {
            "glob": self.glob,
            "select": Select.of,
            "fail": fail,
            "package_name": lambda: ws.current,
            "repository_name": lambda: "@",
            "Label": lambda text: text,
            "struct": lambda **kw: type("struct", (), kw),
            "package": lambda **kw: None,
            "licenses": lambda *a, **kw: None,
            "exports_files": lambda *a, **kw: None,
            "config_setting": rule_function("config_setting"),
            "alias": rule_function("alias"),
            "filegroup": rule_function("filegroup"),
            "genrule": rule_function("genrule"),
            "cc_library": rule_function("cc_library"),
            "cc_binary": rule_function("cc_binary"),
            "cc_test": lambda **kw: None,
            "test_suite": lambda **kw: None,
            "sh_binary": lambda **kw: None,
            "sh_test": lambda **kw: None,
            "py_binary": lambda **kw: None,
            "py_library": lambda **kw: None,
        }
        for name, value in functions.items():
            setattr(native, name, value)
        functions["native"] = native
        return functions

    def bzl_symbols(self, label):
        ws = self

        def rule_function(kind):
            def create(**attrs):
                ws.add_rule(kind, ws.current, attrs)
            return create

        def ignore(**kwargs):
            return None

        def gentbl(kind):
            def create(name, tblgen, td_file, tbl_outs, td_srcs=[], includes=[], deps=[],
                       strip_include_prefix=None, test=False, copts=None, skip_opts=[], **kwargs):
                ws.add_rule(kind, ws.current, dict(
                    name=name, tblgen=tblgen, td_file=td_file, tbl_outs=tbl_outs,
                    td_srcs=td_srcs, includes=includes, deps=deps,
                    strip_include_prefix=strip_include_prefix, skip_opts=skip_opts,
                    **{k: v for k, v in kwargs.items() if k in ("defines",)}))
            return create

        def generate_driver_selects(name):
            return []

        def llvm_driver_cc_binary(name, needs_posix_utility_signal_handling=False, deps=None, **kwargs):
            args = ""
            if needs_posix_utility_signal_handling:
                args = ", /*InstallPipeSignalExitHandler=*/true, /*NeedsPOSIXUtilitySignalHandling=*/true"
            ws.add_rule("expand_template", ws.current, dict(
                name="_gen_" + name,
                out=name + "-driver.cpp",
                substitutions={"@TOOL_NAME@": name.replace("-", "_"), "@INITLLVM_ARGS@": args},
                template="//llvm:cmake/modules/llvm-driver-template.cpp.in",
            ))
            ws.add_rule("cc_binary", ws.current, dict(
                name=name,
                srcs=[name + "-driver.cpp"],
                deps=(deps or []) + ["//llvm:Support"],
                **kwargs
            ))

        def cc_plugin_library(name, srcs, hdrs, include_prefix=None, strip_include_prefix=None, **kwargs):
            ws.add_rule("cc_library", ws.current, dict(
                name=name, srcs=srcs, hdrs=hdrs, include_prefix=include_prefix,
                strip_include_prefix=strip_include_prefix, **kwargs))

        def config_setting_group(name, match_any=None, match_all=None):
            ws.add_rule("config_setting_group", ws.current, dict(
                name=name, match_any=match_any or [], match_all=match_all or []))

        def with_or(mapping, no_match_error=""):
            expanded = {}
            for key, value in mapping.items():
                for k in (key if isinstance(key, tuple) else (key,)):
                    expanded[k] = value
            return Select.of(expanded)

        selects = type("selects", (), {
            "config_setting_group": staticmethod(config_setting_group),
            "with_or": staticmethod(with_or),
        })

        common = {
            "bool_flag": rule_function("flag"),
            "string_flag": rule_function("flag"),
            "string_list_flag": rule_function("flag"),
            "BuildSettingInfo": None,
            "expand_template": rule_function("expand_template"),
            "write_file": rule_function("write_file"),
            "run_binary": rule_function("run_binary"),
            "cc_library": rule_function("cc_library"),
            "cc_binary": rule_function("cc_binary"),
            "cc_test": ignore,
            "cc_shared_library": ignore,
            "py_binary": ignore,
            "py_library": ignore,
            "py_test": ignore,
            "sh_binary": ignore,
            "sh_test": ignore,
            "selects": selects,
            "gentbl_cc_library": gentbl("gentbl_cc_library"),
            "gentbl_filegroup": gentbl("gentbl_filegroup"),
            "td_library": rule_function("td_library"),
            "binary_alias": rule_function("alias_binary"),
            "enum_targets_gen": rule_function("enum_targets_gen"),
            "generate_driver_selects": generate_driver_selects,
            "generate_driver_tools_def": rule_function("driver_tools_def"),
            "llvm_driver_cc_binary": llvm_driver_cc_binary,
            "cc_plugin_library": cc_plugin_library,
            "workspace_root": rule_function("workspace_root"),
            "llvm_targets": TARGETS,
            "cc_library_wrapper": rule_function("cc_library"),
        }
        if label in ("//:vars.bzl",):
            return self.version_vars()
        if label in (":config.bzl", "//llvm:config.bzl"):
            return self.exec_bzl("llvm/config.bzl")
        return common

    def exec_bzl(self, path):
        env = self.environment("llvm")
        with open(os.path.join(self.root, OVERLAY, path)) as f:
            exec(compile(f.read(), path, "exec"), env)
        return env

    def version_vars(self):
        values = {}
        with open(os.path.join(self.root, "cmake/Modules/LLVMVersion.cmake")) as f:
            for line in f:
                m = re.match(r"\s*set\((LLVM_VERSION_\w+) (\w*)\)", line)
                if m and m.group(1) not in values:
                    values[m.group(1)] = m.group(2)
        major, minor, patch = values["LLVM_VERSION_MAJOR"], values["LLVM_VERSION_MINOR"], values["LLVM_VERSION_PATCH"]
        suffix = values.get("LLVM_VERSION_SUFFIX", "")
        return {
            "LLVM_VERSION_MAJOR": major,
            "LLVM_VERSION_MINOR": minor,
            "LLVM_VERSION_PATCH": patch,
            "LLVM_VERSION_SUFFIX": suffix,
            "LLVM_VERSION": "{}.{}.{}".format(major, minor, patch),
            "PACKAGE_VERSION": "{}.{}.{}{}".format(major, minor, patch, suffix),
            "CMAKE_CXX_STANDARD": "17",
        }

    # Configuration.

    def rule(self, label):
        self.load_package(label.package)
        return self.rules.get(label)

    def setting_value(self, text, package):
        label = parse_label(text, package)
        key = text if text.startswith("@") else "//{}:{}".format(label.package, label.name)
        if key in SETTINGS:
            return SETTINGS[key]
        rule = self.rule(label)
        if rule is None or rule.kind != "flag":
            fail("unknown build setting", text)
        default = rule.attrs.get("build_setting_default")
        if isinstance(default, bool):
            return "true" if default else "false"
        return default

    def matches(self, key, package):
        if key == "//conditions:default":
            return False
        if key.startswith("@"):
            return key in CONSTRAINTS
        label = parse_label(key, package)
        rule = self.rule(label)
        if rule is None:
            fail("unknown condition", key)
        if rule.kind == "config_setting_group":
            if rule.attrs["match_any"]:
                return any(self.matches(k, label.package) for k in rule.attrs["match_any"])
            return all(self.matches(k, label.package) for k in rule.attrs["match_all"])
        if rule.kind != "config_setting":
            fail("condition is not a config_setting", key)
        for value in rule.attrs.get("constraint_values", []):
            if value.startswith("@"):
                if value not in CONSTRAINTS:
                    return False
            elif not self.matches(value, label.package):
                return False
        for flag, value in rule.attrs.get("flag_values", {}).items():
            if str(self.setting_value(flag, label.package)).lower() != str(value).lower():
                return False
        if rule.attrs.get("values") or rule.attrs.get("define_values"):
            return False
        return True

    def resolve(self, value, package):
        if isinstance(value, Select):
            result = None
            for operator, (kind, item) in value.parts:
                if kind == "select":
                    chosen = [k for k in item if self.matches(k, package)]
                    if len(chosen) > 1:
                        fail("ambiguous select in", package, chosen)
                    if chosen:
                        item = item[chosen[0]]
                    elif "//conditions:default" in item:
                        item = item["//conditions:default"]
                    else:
                        fail("no select branch matches in", package, list(item))
                item = self.resolve(item, package)
                if operator == "":
                    result = item
                elif operator == "+":
                    result = result + item
                else:
                    result = dict(result, **item) if isinstance(result, dict) else result | item
            return result
        if isinstance(value, list):
            return [self.resolve(v, package) for v in value]
        if isinstance(value, tuple):
            return tuple(self.resolve(v, package) for v in value)
        if isinstance(value, dict):
            return {self.resolve(k, package): self.resolve(v, package) for k, v in value.items()}
        return value

    def attr(self, rule, name, default=None):
        return self.resolve(rule.attrs.get(name, default), rule.package)


def outputs_of(rule):
    a = rule.attrs
    if rule.kind in ("write_file", "expand_template", "enum_targets_gen", "driver_tools_def"):
        return [a["out"]]
    if rule.kind in ("gentbl_cc_library", "gentbl_filegroup"):
        outs = []
        for opts, out in tbl_outs(a["tbl_outs"]):
            outs.extend(out)
        return outs
    if rule.kind in ("genrule", "run_binary"):
        return list(a.get("outs", []))
    return []


def tbl_outs(value):
    if isinstance(value, dict):
        value = [(opts, out) for out, opts in value.items()]
    result = []
    for opts, out in value:
        result.append((list(opts), [out] if isinstance(out, str) else list(out)))
    return result


SOURCE_SUFFIXES = (".c", ".cc", ".cpp", ".S", ".s")


class Inventory:
    """The closure of the requested binaries, in cellar terms."""

    def __init__(self, workspace):
        self.ws = workspace
        self.libraries = {}  # name -> entry
        self.binaries = {}
        self.tablegen = {}
        self.files = {}  # workspace path -> content
        self.overlay = {}  # workspace path -> overlay path in the tarball
        self.cc_cache = {}
        self.output_cache = {}

    # Label resolution.

    def producer(self, label):
        """The rule producing a generated file label, or None."""
        package = label.package
        if package not in self.output_cache:
            self.ws.load_package(package)
            outputs = {}
            for rule in list(self.ws.rules.values()):
                if rule.package != package:
                    continue
                for out in self.outputs_of(rule):
                    outputs[out] = rule
            self.output_cache[package] = outputs
        return self.output_cache[package].get(label.name)

    def outputs_of(self, rule):
        a = rule.attrs
        if rule.kind in ("write_file", "expand_template", "enum_targets_gen", "driver_tools_def"):
            return [a["out"]]
        if rule.kind in ("gentbl_cc_library", "gentbl_filegroup"):
            return [out for opts, outs in tbl_outs(self.ws.attr(rule, "tbl_outs")) for out in outs]
        if rule.kind in ("genrule", "run_binary"):
            return list(self.ws.attr(rule, "outs", []))
        return []

    def files_of(self, text, package):
        """Workspace paths of a srcs/hdrs entry."""
        label = parse_label(text, package)
        if label is None:
            fail("external label", text)
        rule = self.ws.rule(label)
        if rule is not None:
            if rule.kind in ("filegroup",):
                return [f for src in self.ws.attr(rule, "srcs", []) for f in self.files_of(src, rule.package)]
            if rule.kind == "alias":
                return self.files_of(self.ws.attr(rule, "actual"), rule.package)
            if rule.kind in ("gentbl_cc_library", "gentbl_filegroup", "genrule", "run_binary",
                             "write_file", "expand_template", "enum_targets_gen"):
                self.generate(rule)
                return [rule.package + "/" + out for out in self.outputs_of(rule)]
            if rule.kind in ("cc_library", "stub_library"):
                return []
            fail("unexpected source rule", rule.kind, label)
        producer = self.producer(label)
        if producer is not None:
            self.generate(producer)
            return [label.package + "/" + label.name]
        physical = self.ws.package_files(label.package).get(label.name)
        if physical is None:
            fail("missing file", label)
        logical = label.package + "/" + label.name
        if physical != logical:
            self.overlay[logical] = physical
        return [logical]

    # Generated files.

    def generate(self, rule):
        key = "{}:{}".format(rule.package, rule.attrs["name"])
        if key in self.tablegen:
            return
        kind = rule.kind
        outputs = self.outputs_of(rule)
        out = rule.package + "/" + outputs[0] if len(outputs) == 1 else None
        # Files derived from the tarball are recipes applied at build time,
        # so the inventory carries no LLVM source text.
        if kind == "write_file":
            content = self.ws.attr(rule, "content")
            if isinstance(content, list):
                content = "\n".join(content) + "\n"
            self.files[out] = {"content": content}
        elif kind == "expand_template":
            template = self.files_of(self.ws.attr(rule, "template"), rule.package)[0]
            self.files[out] = {
                "template": self.physical(template),
                "substitutions": [[old, new] for old, new in self.ws.attr(rule, "substitutions").items()],
            }
        elif kind == "enum_targets_gen":
            template = self.files_of(self.ws.attr(rule, "src"), rule.package)[0]
            macro = rule.attrs["macro_name"]
            placeholder = rule.attrs.get("placeholder_name") or "@LLVM_ENUM_{}S@".format(macro)
            targets = self.ws.attr(rule, "targets")
            replacement = "\n".join("LLVM_{}({})\n".format(macro, t) for t in targets)
            self.files[out] = {"template": self.physical(template), "substitutions": [[placeholder, replacement]]}
        elif kind == "run_binary" and rule.attrs["name"] == "analysis_htmllogger_gen":
            # clang/utils/bundle_resources.py: one string per input file.
            inputs = []
            for arg in self.ws.attr(rule, "args")[1:]:
                path = self.physical(self.files_of(re.match(r"\$\(execpath (.*)\)", arg).group(1), rule.package)[0])
                with open(os.path.join(self.ws.root, path)) as f:
                    # The script splits on newlines, so a final newline
                    # contributes one more, empty, line.
                    inputs.append([path, f.read().endswith("\n")])
            self.files[out] = {"bundle": inputs}
        elif kind == "genrule" and rule.attrs["name"] == "instrumentor_variables_gen":
            (src,) = self.ws.attr(rule, "srcs")
            self.files[out] = {
                "wrap": self.physical(self.files_of(src, rule.package)[0]),
                "prefix": 'constexpr char InstrumentorRuntimeHelper[] = R"(',
                "suffix": ')";\n',
            }
        elif kind in ("gentbl_cc_library", "gentbl_filegroup"):
            self.tablegen[key] = None
            tool = self.binary(self.ws.attr(rule, "tblgen"), rule.package)
            td_file = self.files_of(self.ws.attr(rule, "td_file"), rule.package)[0]
            includes = []
            for include in self.ws.attr(rule, "includes", []) + ["/"]:
                includes.append(self.include_path(include, rule.package))
            includes.append(os.path.dirname(td_file))
            for dep in self.ws.attr(rule, "deps", []):
                includes.extend(self.td_includes(parse_label(dep, rule.package)))
            skip = self.ws.attr(rule, "skip_opts", [])
            outs = [(opts, [rule.package + "/" + o for o in out])
                    for opts, out in tbl_outs(self.ws.attr(rule, "tbl_outs"))
                    if not any(s in opts for s in skip)]
            self.tablegen[key] = {
                "tool": tool,
                "td_file": td_file,
                "includes": unique(includes),
                "outs": outs,
            }
        else:
            fail("cannot generate", kind, rule.label)

    def physical(self, path):
        """The tarball path of a workspace source path."""
        if self.is_generated(path):
            fail("generated file used as a template", path)
        return self.overlay.get(path, path)

    @staticmethod
    def include_path(include, package):
        if include.startswith("/"):
            return include.strip("/") or "."
        return package if include in (".", "") else package + "/" + include

    def td_includes(self, label):
        rule = self.ws.rule(label)
        if rule is None:
            fail("unknown td dependency", label)
        if rule.kind == "alias":
            return self.td_includes(parse_label(self.ws.attr(rule, "actual"), rule.package))
        if rule.kind not in ("td_library",):
            return []
        result = [self.include_path(i, rule.package) for i in self.ws.attr(rule, "includes", [])]
        for dep in self.ws.attr(rule, "deps", []):
            result.extend(self.td_includes(parse_label(dep, rule.package)))
        return result

    # C and C++ libraries.

    def cc(self, label):
        """Compile interface of a cc dependency: includes, defines, generated headers, link order."""
        if label in self.cc_cache:
            return self.cc_cache[label]
        rule = self.ws.rule(label)
        if rule is None:
            fail("unknown dependency", label)
        if rule.kind == "alias":
            info = self.cc(parse_label(self.ws.attr(rule, "actual"), rule.package))
            self.cc_cache[label] = info
            return info
        info = {"includes": [], "defines": [], "generated": [], "link": [], "linkopts": []}
        if rule.kind == "stub_library":
            info["includes"] = rule.attrs.get("includes", [])
        elif rule.kind in ("gentbl_cc_library",):
            self.generate(rule)
            prefix = rule.attrs.get("strip_include_prefix")
            if prefix:
                info["includes"] = [self.include_path(prefix, rule.package)]
            info["generated"] = [rule.package + "/" + o for o in self.outputs_of(rule)]
        elif rule.kind == "cc_library":
            info = self.library(rule)
        else:
            fail("unexpected cc dependency", rule.kind, label)
        self.cc_cache[label] = info
        return info

    def library(self, rule):
        name = "{}:{}".format(rule.package, rule.attrs["name"])
        deps = [parse_label(d, rule.package) for d in self.ws.attr(rule, "deps", [])]
        deps = [d for d in deps if d is not None]
        infos = [self.cc(d) for d in deps]
        sources, headers = [], []
        for src in self.ws.attr(rule, "srcs", []):
            for path in self.files_of(src, rule.package):
                (sources if path.endswith(SOURCE_SUFFIXES) else headers).append(path)
        for attr in ("hdrs", "textual_hdrs"):
            for hdr in self.ws.attr(rule, attr, []):
                headers.extend(self.files_of(hdr, rule.package))
        includes = [self.include_path(i, rule.package) for i in self.ws.attr(rule, "includes", [])]
        prefix = self.ws.attr(rule, "strip_include_prefix")
        if prefix:
            includes.append(self.include_path(prefix, rule.package))
        if self.ws.attr(rule, "include_prefix"):
            fail("include_prefix is unsupported", rule.label)
        defines = tokenize_defines(self.ws.attr(rule, "defines", []))
        generated = [h for h in headers if self.is_generated(h)]
        transitive_includes = unique(includes + [i for info in infos for i in info["includes"]])
        transitive_defines = unique(defines + [d for info in infos for d in info["defines"]])
        transitive_generated = unique(generated + [g for info in infos for g in info["generated"]])
        link = [name] if sources else []
        link = unique(link + [l for info in infos for l in info["link"]], last=True)
        linkopts = unique(list(self.ws.attr(rule, "linkopts", [])) + [o for info in infos for o in info["linkopts"]])
        if sources:
            self.libraries[name] = {
                "srcs": sources,
                "copts": clean_copts(self.ws.attr(rule, "copts", [])),
                "defines": unique(tokenize_defines(self.ws.attr(rule, "local_defines", [])) + transitive_defines),
                "includes": transitive_includes,
                "generated": transitive_generated,
            }
        return {
            "includes": transitive_includes,
            "defines": transitive_defines,
            "generated": transitive_generated,
            "link": link,
            "linkopts": linkopts,
        }

    def summarize_generators(self):
        """Replace each generated-header list with the programs that make them."""
        producers = {path: "config" for path in self.files}
        for gen in self.tablegen.values():
            for opts, outs in gen["outs"]:
                for out in outs:
                    producers[out] = gen["tool"]
        for entry in list(self.libraries.values()) + list(self.binaries.values()):
            entry["generators"] = sorted({producers[path] for path in entry.pop("generated")})

    def share_defines(self):
        """Libraries use few distinct define lists; name them once."""
        sets = []
        for entry in list(self.libraries.values()) + list(self.binaries.values()):
            if entry["defines"] not in sets:
                sets.append(entry["defines"])
            entry["defines"] = sets.index(entry["defines"])
        return sets

    def is_generated(self, path):
        package, _, name = path.partition("/")
        for pkg in sorted(self.ws.loaded, key=len, reverse=True):
            if path.startswith(pkg + "/"):
                return self.producer(Label(pkg, path[len(pkg) + 1:])) is not None
        return False

    def binary(self, text, package):
        label = parse_label(text, package)
        rule = self.ws.rule(label)
        if rule is None:
            fail("unknown binary", label)
        if rule.kind in ("alias", "alias_binary"):
            return self.binary(self.ws.attr(rule, "actual" if rule.kind == "alias" else "binary"), rule.package)
        if rule.kind != "cc_binary":
            fail("not a cc_binary", label)
        name = "{}:{}".format(rule.package, rule.attrs["name"])
        if name in self.binaries:
            return name
        self.binaries[name] = None
        library = dict(rule.attrs, name=rule.attrs["name"] + ".main")
        main = Rule("cc_library", rule.package, library)
        info = self.library(main)
        entry = self.libraries.pop(name + ".main")
        entry["link"] = info["link"][1:]
        entry["linkopts"] = clean_copts(info["linkopts"])
        self.binaries[name] = entry
        return name


def clean_copts(copts):
    """Bazel shell-tokenizes copts; drop its Make variables for this toolchain."""
    result = []
    for copt in copts:
        if "$(STACK_FRAME_UNLIMITED)" in copt:
            continue
        copt = copt.replace("-I$(GENDIR)/$(WORKSPACE_ROOT)/", "-I@GENERATED@/")
        copt = copt.replace("-I$(WORKSPACE_ROOT)/", "-I@SOURCE@/")
        if "$(" in copt:
            fail("unsupported Make variable", copt)
        result.extend(shlex.split(copt))
    return result


def tokenize_defines(defines):
    """Bazel shell-tokenizes each define into exactly one word."""
    result = []
    for define in defines:
        words = shlex.split(define)
        if len(words) != 1:
            fail("define is not one word", define)
        result.append(words[0])
    return result


def unique(items, last=False):
    """Items without repeats, keeping the first (or, for link order, last) occurrence."""
    if last:
        seen, result = set(), []
        for item in reversed(items):
            if item not in seen:
                seen.add(item)
                result.append(item)
        return list(reversed(result))
    seen, result = set(), []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def starlark(value, indent=0):
    pad = "    " * indent
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = ["{"]
        for key in sorted(value):
            lines.append("{}    {}: {},".format(pad, starlark(key), starlark(value[key], indent + 1)))
        lines.append(pad + "}")
        return "\n".join(lines)
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        lines = ["["]
        for item in value:
            lines.append("{}    {},".format(pad, starlark(item, indent + 1)))
        lines.append(pad + "]")
        return "\n".join(lines)
    if isinstance(value, str):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'
    if value is None:
        return "None"
    return repr(value)


# The literal lists each runtime's CMake file assigns first, by directory.
RUNTIME_LISTS = {
    "compiler-rt/lib/builtins": ["GENERIC_SOURCES", "BF16_SOURCES", "GENERIC_TF_SOURCES", "x86_80_BIT_SOURCES"],
    "libcxx/include": ["files"],
    "libcxx/src": ["LIBCXX_SOURCES", "LIBCXX_EXPERIMENTAL_SOURCES"],
    "libcxxabi/include": ["files"],
    "libcxxabi/src": ["LIBCXXABI_SOURCES"],
    "libunwind/include": ["files"],
    "libunwind/src": ["LIBUNWIND_CXX_SOURCES", "LIBUNWIND_C_SOURCES", "LIBUNWIND_ASM_SOURCES"],
}


def cmake_list(path, name):
    """The items of the first set(name ...) in a CMake file, one per line."""
    try:
        with open(path) as f:
            text = f.read()
    except OSError as e:
        fail("cannot read", path + ":", e.strerror)
    m = re.search(r"^set\({}\n(.*?)^\s*\)".format(re.escape(name)), text, re.S | re.M)
    if not m:
        fail("no set({} ...) in".format(name), path)
    items = [line.strip() for line in m.group(1).splitlines() if line.strip() and not line.strip().startswith("#")]
    for item in items:
        if not re.fullmatch(r"[\w./+-]+", item):
            fail("unexpected item in set({} ...) of".format(name), path, item)
    return items


HEADER = """\
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Generated by inventory.py from the LLVM {version} release tarball; do not
# edit. Paths are relative to the tarball's top directory. See README.md.
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="compare with the existing output instead")
    parser.add_argument("source", help="extracted llvm-project-*.src directory")
    parser.add_argument("output", help="inventory .bzl to write")
    parser.add_argument("binaries", nargs="*", help="binaries whose closure to write")
    args = parser.parse_args()
    if args.check:
        env = {}
        with open(args.output) as f:
            exec(f.read(), env)
        args.binaries = env["ROOTS"]
    if not args.binaries:
        parser.error("no binaries named")
    ws = Workspace(os.path.abspath(args.source))
    inventory = Inventory(ws)
    resource_headers = []
    try:
        for binary in args.binaries:
            inventory.binary(binary, "")
        if "//clang:clang" in args.binaries:
            # The headers Clang finds in its resource directory, some of them
            # generated by clang-tblgen.
            resource_headers = inventory.files_of("//clang:builtin_headers_files", "")
        runtime_lists = {
            directory: {name: cmake_list(os.path.join(ws.root, directory, "CMakeLists.txt"), name) for name in names}
            for directory, names in RUNTIME_LISTS.items()
        }
    except Failure as e:
        sys.exit("inventory: " + str(e))
    inventory.summarize_generators()
    defines = inventory.share_defines()
    version = ws.version_vars()["PACKAGE_VERSION"]
    sections = [
        ("LLVM_VERSION", version),
        ("ROOTS", args.binaries),
        ("TARGETS", TARGETS),
        ("DEFINES", defines),
        ("LIBRARIES", inventory.libraries),
        ("BINARIES", inventory.binaries),
        ("TABLEGEN", {k: v for k, v in inventory.tablegen.items()}),
        ("FILES", inventory.files),
        ("OVERLAY_FILES", inventory.overlay),
        ("RESOURCE_HEADERS", resource_headers),
        ("RUNTIME_LISTS", runtime_lists),
    ]
    text = HEADER.format(version=version) + "".join(
        "\n{} = {}\n".format(name, starlark(value)) for name, value in sections
    )
    if args.check:
        with open(args.output) as f:
            if f.read() != text:
                sys.exit("inventory: {} differs from the tarball's overlay; regenerate it".format(args.output))
        print("inventory: {} matches".format(args.output))
        return
    with open(args.output, "w") as f:
        f.write(text)


if __name__ == "__main__":
    main()
