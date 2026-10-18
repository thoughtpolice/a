# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Write sources.bzl from QEMU's meson.build files.

QEMU's build lists its sources in meson "source sets": per-directory
`foo_ss.add(when: 'CONFIG_X', if_true: files(...))` calls that the top-level
meson.build gathers into a few libraries (libqemuutil, libsystem, the common
library, one library per target) and filters by each target's Kconfig
symbols. This reads those files as text, without running meson, and writes
the gathered sets out as Starlark data, so that BUILD can do the filtering.

What meson would decide by probing the host or reading its options is fixed
here instead, in the tables below: the features this build has, the optional
dependencies it found, and the options it was configured with. A Kconfig
condition (a CONFIG_* or TARGET_* symbol) is kept as data, since BUILD
evaluates it per target; everything else is resolved now.

Usage:
    sources.py SRCDIR (--target NAME DEVICES.mak KCONFIG...)... > sources.bzl

DEVICES.mak is a target's minikconf output, and KCONFIG the target's
accelerator and architecture symbols that BUILD passed minikconf.
"""

import os
import re
import sys

# meson variables for this configuration: system emulators only, on Linux,
# with no tools, guest agent or user-mode emulation.
VARIABLES = {
    "coroutine_backend": "ucontext",
    "cpu": "x86_64",
    "host_arch": "x86_64",
    "host_os": "linux",
    "bsd_oses": ["dragonfly", "freebsd", "netbsd", "openbsd"],
    "dbus_display": False,
    "enable_modules": False,
    "enable_passt": False,
    "glib_has_gslice": False,
    "have_afalg": False,
    "have_block": True,
    "have_bsd_user": False,
    "have_ga": False,
    "have_host_block_device": True,
    "have_ivshmem": True,
    "have_keyring": True,
    "have_l2tpv3": True,
    "have_libvduse": False,
    "have_linux_user": False,
    "have_membarrier": False,
    "have_netmap": False,
    "have_qemu_vnc": False,
    "have_rust": False,
    "have_system": True,
    "have_tcg": True,
    "have_tools": False,
    "have_tpm": True,
    "have_user": False,
    "have_vduse_blk_export": False,
    "have_vhost": False,
    "have_vhost_kernel": False,
    "have_vhost_net": False,
    "have_vhost_net_user": False,
    "have_vhost_net_vdpa": False,
    "have_vhost_user": False,
    "have_vhost_user_blk_server": False,
    "have_vhost_user_crypto": False,
    "have_vhost_vdpa": False,
    "have_virtfs": False,
    "have_xen_pci_passthrough": False,
    "hv_balloon": False,
    "multiprocess_allowed": False,
    "vfio_user_server_allowed": False,
}

# Dependencies meson looks up, and whether this build has them. glib, zlib,
# pixman, libfdt and libslirp come from third-party//; the rest are glibc's
# own libraries, or features left out.
FOUND = {
    "fdt", "glib", "iconv", "inotify", "libm", "pixman", "rt", "slirp",
    "threads", "util", "vnc", "zlib",
}

# Options that differ from QEMU's defaults, or that a condition reads.
OPTIONS = {
    # Only vvfat of the optional image formats: -drive file=fat:rw:DIR is the
    # quickest way to hand firmware a directory. Its rw mode keeps the
    # changes in a qcow (version 1) image, so that driver comes too.
    "bochs": False,
    "cloop": False,
    "colo_proxy": False,
    "dmg": False,
    "fuzzing": False,
    "parallels": False,
    "plugins": False,
    "qcow1": True,
    "qed": False,
    "replication": False,
    "rng_none": False,
    "tcg_interpreter": False,
    "vdi": False,
    "vhdx": False,
    "vmdk": False,
    "vpc": False,
    "vvfat": True,
    "b_lto": False,
    "cfi": False,
}

# config-host.h settings that meson.build conditions read back; see
# config-host.h.in.
HOST_CONFIG = {
    "CONFIG_EPOLL": True,
    "CONFIG_INOTIFY1": True,
    "CONFIG_REPLICATION": False,
}

# Conditions on values meson.build computes in ways this does not follow.
CONDITIONS = {
    # Every target here has gdb XML files.
    "gdbstub_xml_files.length() > 0": True,
}

TRACE_BACKENDS = ["log"]

# The accelerators meson.build can enable, of which the --target arguments
# name each target's.
ACCELERATORS = {"CONFIG_KVM", "CONFIG_TCG"}

# meson.build's disassemblers table, for the host and targets here: a target
# gets these symbols when its base architecture or the host's starts with the
# key.
DISASSEMBLERS = {
    "i386": ["CONFIG_I386_DIS"],
    "riscv": ["CONFIG_RISCV_DIS"],
    "x86_64": ["CONFIG_I386_DIS"],
}

# The base architectures of the targets BUILD builds; the per-architecture
# source sets of the others are not written out.
ARCHES = ["arm", "i386", "riscv"]

# The directories under hw/ and target/ that belong to one architecture.
ALL_ARCHES = [
    "alpha", "arm", "avr", "hexagon", "hppa", "i386", "loongarch", "m68k",
    "microblaze", "mips", "or1k", "ppc", "riscv", "rx", "s390x", "sh4",
    "sparc", "sparc64", "tricore", "xtensa",
]

# The top-level source sets meson.build turns into libraries, by the name
# sources.bzl gives them.
TOP_SETS = {
    "audio_ss": "audio",
    "authz_ss": "authz",
    "block_ss": "block",
    "blockdev_ss": "blockdev",
    "chardev_ss": "chardev",
    "common_ss": "common",
    "crypto_ss": "crypto",
    "hwcore_ss": "hwcore",
    "io_ss": "io",
    "qmp_ss": "qmp",
    "qom_ss": "qom",
    "specific_ss": "specific",
    "stub_ss": "stub",
    "system_ss": "system",
    "trace_ss": "trace",
    "util_ss": "util",
}

# Directories meson.build enters that hold no emulator sources for this build:
# documentation, tests, tools, user-mode emulation and the Python venv.
SKIP_DIRS = {
    "bsd-user", "common-user", "contrib/plugins", "docs", "linux-user",
    "pc-bios", "po", "pyvenv", "qga", "rust", "storage-daemon", "tests",
    "tests/qtest/fuzz", "tests/qtest/libqos", "tools",
}

# Per-architecture dictionaries in meson.build, by their sources.bzl name, or
# None for the user-mode ones, which are not written out.
ARCH_DICTS = {
    "hw_arch": "hw_arch",
    "hw_common_arch": "hw_common_arch",
    "target_arch": "target_arch",
    "target_common_arch": "target_common_arch",
    "target_common_system_arch": "target_common_system_arch",
    "target_stubs_arch": "target_stubs_arch",
    "target_system_arch": "target_system_arch",
    "target_user_arch": None,
}

# Plain file lists meson.build builds libraries from directly.
FILE_VARIABLES = {
    "event_loop_base": "event_loop_base",
    "libui_sources": "ui",
    "migration_files": "migration",
}

# Generated sources a source set names, and what sources.bzl calls them.
# BUILD makes each one; a variable that is only a library or dependency
# (`ui`, `migration`, `genh`, ...) is dropped. The QAPI and trace sources are
# added in loops this does not follow, so BUILD adds them to util itself.
GENERATED = {
    "block_gen_c": "gen:block/block-gen.c",
    "gdbstub_xml": "gen:gdbstub-xml.c",
    "module_block_h": "gen:block/module_block.h",
}

LIST_VARIABLES = ["qapi_all_modules", "trace_events_subdirs"]


class Unknown(Exception):
    pass


def strip(text):
    """Drop comments and the bodies of ''' strings, which hold C probes."""
    text = re.sub(r"'''.*?'''", "''", text, flags=re.S)
    # meson f-strings name variables as @var@.
    text = re.sub(r"(?<![\w'])f'([^']*)'", lambda m: "'" + re.sub(r"@(\w+)@", lambda v: VARIABLES[v.group(1)], m.group(1)) + "'", text)
    out = []
    for line in text.split("\n"):
        res, quote = "", None
        for ch in line:
            if quote:
                if ch == quote:
                    quote = None
            elif ch in "'\"":
                quote = ch
            elif ch == "#":
                break
            res += ch
        out.append(res)
    return "\n".join(out)


def split_top(text, sep):
    """Split at `sep` characters outside brackets and quotes."""
    parts, cur, depth, quote = [], "", 0, None
    for ch in text:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return parts


def statements(text):
    """Yield logical statements, joining lines while a bracket is open."""
    cur, depth, quote = "", 0, None
    for line in text.split("\n"):
        for ch in line:
            if quote:
                if ch == quote:
                    quote = None
            elif ch in "'\"":
                quote = ch
            elif ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
        cur += line + "\n"
        if depth == 0 and not cur.rstrip().endswith("\\"):
            if cur.strip():
                yield re.sub(r"\\\n", " ", cur.strip())
            cur = ""


def items(expr):
    """Flatten `[a, b] + c` into its items."""
    expr = expr.strip()
    plus = split_top(expr, "+")
    if len(plus) > 1:
        return [i for p in plus for i in items(p)]
    if expr.startswith("[") and expr.endswith("]"):
        return [i for p in split_top(expr[1:-1], ",") for i in items(p)]
    return [expr] if expr else []


def strings(expr):
    out = []
    for i in items(expr):
        m = re.fullmatch(r"'([^']*)'", i)
        if not m:
            raise Unknown("not a string: " + i)
        out.append(m.group(1))
    return out


class Walker:
    def __init__(self, root, devices, accelerators):
        self.root = root
        self.devices = devices
        self.accelerators = accelerators
        self.sets = {}      # instance id -> list of entries
        self.current = {}   # set variable -> instance id
        self.dicts = {name: {} for name in ARCH_DICTS}
        self.local_dicts = {}
        self.modules = {}
        self.target_modules = {}
        self.files = {}     # file-list variable -> files
        self.decode = {}    # decodetree variable -> [(path, args)]
        self.lists = {name: [] for name in LIST_VARIABLES}
        self.next_id = 0
        for name in TOP_SETS:
            self.new_set(name)

    def new_set(self, name):
        self.next_id += 1
        self.current[name] = "%s#%d" % (name, self.next_id)
        self.sets[self.current[name]] = []

    # Conditions on `if` lines.
    def condition(self, expr, where):
        if expr.strip() in CONDITIONS:
            return CONDITIONS[expr.strip()]
        e = expr
        e = re.sub(r"'(\w+)'\s+in\s+get_option\('trace_backends'\)", lambda m: repr(m.group(1) in TRACE_BACKENDS), e)
        e = re.sub(r"(\w+)\.found\(\)", lambda m: repr(m.group(1) in FOUND), e)
        e = re.sub(r"get_option\('(\w+)'\)\.(allowed|enabled)\(\)", lambda m: self.option(m.group(1), where), e)
        e = re.sub(r"get_option\('(\w+)'\)", lambda m: self.option(m.group(1), where), e)
        e = re.sub(r"'(\w+)'\s+not\s+in\s+config_all_accel", lambda m: repr(m.group(1) not in self.accelerators), e)
        e = re.sub(r"'(\w+)'\s+in\s+config_all_accel", lambda m: repr(m.group(1) in self.accelerators), e)
        e = re.sub(r"config_all_devices\.has_key\('(\w+)'\)", lambda m: repr(m.group(1) in self.devices), e)
        e = re.sub(r"config_host_data\.get\('(\w+)'\)", lambda m: self.host_config(m.group(1), where), e)
        e = e.replace("host_machine.system()", repr(VARIABLES["host_os"]))
        try:
            return bool(eval(e, {"__builtins__": {}}, dict(VARIABLES, true=True, false=False)))
        except Exception as exc:
            raise Unknown("%s: cannot evaluate `if %s` (%s)" % (where, expr, exc))

    def host_config(self, name, where):
        if name not in HOST_CONFIG:
            raise Unknown("%s: %s is not in HOST_CONFIG" % (where, name))
        return repr(HOST_CONFIG[name])

    def option(self, name, where):
        if name not in OPTIONS:
            raise Unknown("%s: option %s is not in OPTIONS" % (where, name))
        return repr(OPTIONS[name])

    def file_items(self, expr, d):
        """Resolve one source-set item to files, set references or tokens."""
        out = []
        for item in items(expr):
            m = re.fullmatch(r"files\((.*)\)", item, re.S)
            if m:
                out += [os.path.normpath(os.path.join(d, f)) for f in strings("[" + m.group(1) + "]")]
            elif item in self.files:
                out += self.files[item]
            elif item in self.decode:
                out += ["decodetree:" + p for p, _ in self.decode[item]]
            elif item in self.current:
                out.append(("set", self.current[item]))
            elif item in GENERATED:
                out.append(GENERATED[item])
            elif re.fullmatch(r"[\w\[\]]+", item):
                # A dependency object or library: only its link matters.
                pass
            else:
                raise Unknown("%s: cannot resolve source item %s" % (d, item))
        return out

    def when(self, expr, d):
        """A when: list as Kconfig symbols, or None if a dependency is missing."""
        syms = []
        for item in items(expr):
            m = re.fullmatch(r"'(\w+)'", item)
            if m:
                syms.append(m.group(1))
            elif item in FOUND:
                pass
            elif re.fullmatch(r"\w+", item):
                return None
            else:
                raise Unknown("%s: cannot resolve when: %s" % (d, item))
        return syms

    def decodetree(self, expr, d):
        out = []
        for item in items(expr):
            m = re.fullmatch(r"decodetree\.process\('([^']+)'(?:,\s*extra_args:\s*(.*))?\)", item, re.S)
            if not m:
                raise Unknown("%s: not a decodetree call: %s" % (d, item))
            args = strings(m.group(2)) if m.group(2) else []
            out.append((os.path.normpath(os.path.join(d, m.group(1))), args))
        return out

    def walk(self, d):
        parts = d.split("/")
        if len(parts) == 2 and parts[0] in ("hw", "target") and parts[1] in ALL_ARCHES and parts[1] not in ARCHES:
            return
        if d in SKIP_DIRS:
            return
        path = os.path.join(self.root, d, "meson.build")
        if not os.path.exists(path):
            return
        # One [taken, any branch taken] per open if, where taken may be None
        # for a condition the tables cannot answer. That is only an error if
        # the branch turns out to add sources.
        conds = []
        loops = 0
        where = os.path.join(d, "meson.build")
        for st in statements(strip(open(path).read())):
            m = re.fullmatch(r"(if|elif)\s+(.*)", st, re.S)
            if m:
                if m.group(1) == "if":
                    taken = self.try_condition(m.group(2), where)
                    conds.append([taken, taken])
                else:
                    prev = conds.pop()
                    if prev[1] is True:
                        taken = False
                    elif prev[1] is None:
                        taken = None
                    else:
                        taken = self.try_condition(m.group(2), where)
                    conds.append([taken, True if prev[1] or taken else (None if taken is None else False)])
                continue
            if st == "else":
                prev = conds[-1]
                conds[-1] = [None if prev[1] is None else not prev[1], True]
                continue
            if st == "endif":
                conds.pop()
                continue
            if st.startswith("foreach"):
                loops += 1
                continue
            if st == "endforeach":
                loops -= 1
                continue
            if any(c[0] is False for c in conds) or loops:
                # Dead code, or the body of a loop: the loops this build reaches
                # only add the modules of dependencies it does not have, or
                # generated files BUILD makes itself.
                continue
            unknown = [c for c in conds if c[0] is None]
            if st == "subdir_done()":
                if unknown:
                    raise Unknown("%s: subdir_done() under an unknown condition" % where)
                return
            if self.statement(st, d, where) and unknown:
                raise Unknown("%s: `%s` is under a condition sources.py cannot evaluate: %s" % (
                    where, st.split("\n")[0], self.unknown_reason))

    def try_condition(self, expr, where):
        try:
            return self.condition(expr, where)
        except Unknown as e:
            self.unknown_reason = str(e)
            return None

    def statement(self, st, d, where):
        m = re.fullmatch(r"subdir\('([^']+)'\)", st)
        if m:
            self.walk(os.path.normpath(os.path.join(d, m.group(1))))
            return True
        m = re.fullmatch(r"(\w+)\s*=\s*ss\.source_set\(\)", st)
        if m:
            self.new_set(m.group(1))
            return True
        m = re.fullmatch(r"(\w+_modules)\s*=\s*\{\}", st)
        if m:
            self.local_dicts[m.group(1)] = {}
            return True
        m = re.fullmatch(r"(\w+)\s*(\+?=)\s*(.*)", st, re.S)
        if m and m.group(1) in LIST_VARIABLES:
            value = strings(m.group(3))
            self.lists[m.group(1)] = (self.lists[m.group(1)] if m.group(2) == "+=" else []) + value
            return True
        if m and "decodetree.process" in m.group(3):
            self.decode[m.group(1)] = self.decodetree(m.group(3), d)
            return True
        if m and re.fullmatch(r"files\(.*\)", m.group(3).strip(), re.S):
            value = self.file_items(m.group(3), d)
            self.files[m.group(1)] = (self.files.get(m.group(1), []) if m.group(2) == "+=" else []) + value
            return True
        m = re.fullmatch(r"(\w+)\s*\+=\s*\{\s*'([^']+)'\s*:\s*(\w+)\s*\}", st, re.S)
        if m:
            dname, key, value = m.groups()
            if dname in self.dicts:
                self.dicts[dname][key] = self.current[value]
            elif dname == "modules":
                self.modules[key] = dict(self.local_dicts[value])
            elif dname == "target_modules":
                self.target_modules[key] = dict(self.local_dicts[value])
            elif dname in self.local_dicts:
                self.local_dicts[dname][key] = self.current[value]
            else:
                return False
            return True
        m = re.fullmatch(r"modules\s*\+=\s*\{\s*'([^']+)'\s*:\s*\{\s*'([^']+)'\s*:\s*(\w+)\s*\}\s*\}", st, re.S)
        if m:
            self.modules[m.group(1)] = {m.group(2): self.current[m.group(3)]}
            return True
        m = re.fullmatch(r"(\w+)\.(add|add_all)\((.*)\)", st, re.S)
        if m and m.group(1) in self.current:
            self.add(self.current[m.group(1)], m.group(3), d)
            return True
        return False

    def add(self, inst, args, d):
        positional, keywords = [], {}
        for part in split_top(args, ","):
            m = re.fullmatch(r"(when|if_true|if_false)\s*:\s*(.*)", part, re.S)
            if m:
                keywords[m.group(1)] = m.group(2)
            else:
                positional.append(part)
        entry = {
            "files": [f for p in positional for f in self.file_items(p, d)],
            "if_false": self.file_items(keywords.get("if_false", "[]"), d),
            "if_true": self.file_items(keywords.get("if_true", "[]"), d),
            "when": self.when(keywords["when"], d) if "when" in keywords else [],
        }
        self.sets[inst].append(entry)

    def fold_modules(self):
        # meson.build adds modules to block_ss, audio_ss or system_ss, and
        # target modules to specific_ss, when modules are disabled.
        for dname, mods in self.modules.items():
            top = {"audio": "audio_ss", "block": "block_ss"}.get(dname, "system_ss")
            for inst in mods.values():
                self.sets[self.current[top]].append({"files": [("set", inst)], "if_false": [], "if_true": [], "when": []})
        for mods in self.target_modules.values():
            for inst in mods.values():
                self.sets[self.current["specific_ss"]].append({"files": [("set", inst)], "if_false": [], "if_true": [], "when": []})

    def flatten(self, inst, cond, out):
        for e in self.sets[inst]:
            self.emit(e["files"], cond, out)
            if e["when"] is None:
                self.emit(e["if_false"], cond, out)
                continue
            self.emit(e["if_true"], cond + e["when"], out)
            # With no symbols left, the when: named only dependencies this
            # build has, and if_false is dead.
            if e["if_false"] and e["when"]:
                if len(e["when"]) != 1:
                    raise Unknown("if_false with a compound when: %r" % e["when"])
                self.emit(e["if_false"], cond + ["!" + e["when"][0]], out)

    def emit(self, files, cond, out):
        for f in files:
            if isinstance(f, tuple):
                self.flatten(f[1], cond, out)
            else:
                key = tuple(sorted(set(cond)))
                if f not in out.setdefault(key, []):
                    out[key].append(f)


def target_config(root, name, kconfig, devices):
    """The configuration meson.build builds for a -softmmu target.

    Returns the symbols its source sets are filtered by, and the defines of
    its config-target.h, as meson.build's target loop computes them.
    """
    config = {"TARGET_NAME": name, "CONFIG_SYSTEM_ONLY": "y", "CONFIG_SOFTMMU": "y"}
    for line in open(os.path.join(root, "configs/targets/%s-softmmu.mak" % name)):
        line = line.strip()
        if line and not line.startswith("#"):
            k, v = line.split("=", 1)
            config[k.strip()] = v.strip()
    for sym in kconfig:
        k, v = sym.split("=")
        if k in ACCELERATORS and v == "y":
            config[k] = "y"
    config["TARGET_" + config["TARGET_ARCH"].upper()] = "y"
    config.setdefault("TARGET_BASE_ARCH", config["TARGET_ARCH"])
    config.setdefault("TARGET_ABI_DIR", config["TARGET_ARCH"])
    config.setdefault("TARGET_BIG_ENDIAN", "n")
    for prefix, syms in DISASSEMBLERS.items():
        if VARIABLES["host_arch"].startswith(prefix) or config["TARGET_BASE_ARCH"].startswith(prefix):
            for sym in syms:
                config[sym] = "y"

    defines = {}
    for k, v in config.items():
        if not k.startswith(("TARGET_", "CONFIG_")) or k in ("TARGET_XML_FILES", "TARGET_ABI_DIR"):
            continue
        if k == "TARGET_ARCH":
            defines[k] = v.upper()
        elif k == "TARGET_BASE_ARCH":
            defines["TARGET_" + v.upper()] = "1"
        elif k == "TARGET_NAME":
            defines[k] = '\\"%s\\"' % v
        elif v == "y":
            defines[k] = "1"
        elif v == "n":
            defines[k] = "0"
        else:
            defines[k] = v
    # meson's source sets count any non-empty value as set, "n" included.
    symbols = {k for k, v in config.items() if v} | set(devices)
    return config, symbols, defines


def starlark_list(values, indent):
    pad = " " * indent
    return "[\n" + "".join('%s    "%s",\n' % (pad, v) for v in values) + pad + "]"


def starlark_strings(values):
    return "[" + ", ".join('"%s"' % v for v in values) + "]"


def parse_args(argv):
    """SRCDIR (--target NAME DEVICES.mak KCONFIG...)..."""
    root, rest = argv[0], argv[1:]
    targets = []
    while rest:
        if rest[0] != "--target" or len(rest) < 3:
            sys.exit("usage: sources.py SRCDIR (--target NAME DEVICES.mak KCONFIG...)...")
        name, mak, rest = rest[1], rest[2], rest[3:]
        kconfig = []
        while rest and rest[0] != "--target":
            kconfig.append(rest.pop(0))
        devices = sorted(line.strip().split("=")[0] for line in open(mak) if line.strip())
        targets.append((name, kconfig, devices))
    return root, targets


def main():
    root, targets = parse_args(sys.argv[1:])
    configs = {}
    for name, kconfig, devices in targets:
        configs[name] = (devices,) + target_config(root, name, kconfig, devices)
    all_devices = set().union(*(set(c[0]) for c in configs.values()))
    all_accelerators = {k for c in configs.values() for k in c[1] if k in ACCELERATORS}
    w = Walker(root, all_devices, all_accelerators)
    w.walk(".")
    w.fold_modules()

    sets = {}
    for var, name in TOP_SETS.items():
        sets[name] = {}
        w.flatten(w.current[var], [], sets[name])
    for dname, name in ARCH_DICTS.items():
        if name is None:
            continue
        for arch in ARCHES:
            if arch in w.dicts[dname]:
                sets[name + "/" + arch] = {}
                w.flatten(w.dicts[dname][arch], [], sets[name + "/" + arch])
    # meson.build merges hw_common_arch into target_common_system_arch.
    for arch in ARCHES:
        hw = sets.pop("hw_common_arch/" + arch, {})
        merged = sets.setdefault("target_common_system_arch/" + arch, {})
        for cond, files in hw.items():
            merged.setdefault(cond, []).extend(f for f in files if f not in merged.get(cond, []))
    # trace_ss is part of libqemuutil.
    for cond, files in sets.pop("trace").items():
        sets["util"].setdefault(cond, []).extend(f for f in files if f not in sets["util"].get(cond, []))
    for var, name in FILE_VARIABLES.items():
        sets[name] = {(): w.files[var]}

    # Leave out what no target can build: a condition naming a symbol no
    # target has, or negating one every target has. sources-up-to-date fails
    # when a change to devices/ makes the cut wrong.
    symbol_sets = [c[2] for c in configs.values()]
    def possible(cond):
        for sym in cond:
            if sym.startswith("!"):
                if all(sym[1:] in s for s in symbol_sets):
                    return False
            elif not any(sym in s for s in symbol_sets):
                return False
        return True
    for name in sets:
        sets[name] = {c: f for c, f in sets[name].items() if f and possible(c)}

    decode = {}
    for entries in w.decode.values():
        for path, args in entries:
            if path.split("/")[1] in ARCHES:
                decode[path] = args

    out = sys.stdout
    out.write("# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp\n")
    out.write("# SPDX-License-Identifier: Apache-2.0\n\n")
    out.write("# @generated by sources.py from QEMU's meson.build files and the targets'\n")
    out.write("# devices/ selections. Do not edit; see sources-up-to-date in BUILD.\n\n")
    out.write("# Each source set is a list of (condition, sources): a source is built for a\n")
    out.write("# target whose SYMBOLS include every one the condition names, and none it\n")
    out.write("# names with a leading \"!\".\n")
    out.write("SOURCES = {\n")
    for name in sorted(sets):
        if not sets[name]:
            continue
        out.write('    "%s": [\n' % name)
        for cond in sorted(sets[name], key = lambda c: (len(c), c)):
            out.write("        (\n")
            out.write("            %s,\n" % starlark_strings(cond))
            out.write("            %s,\n" % starlark_list(sorted(sets[name][cond]), 12))
            out.write("        ),\n")
        out.write("    ],\n")
    out.write("}\n\n")
    out.write("# The Kconfig symbols minikconf enables for each target, which make up its\n")
    out.write("# config-devices.h.\n")
    out.write("DEVICES = {\n")
    for name in sorted(configs):
        out.write('    "%s": %s,\n' % (name, starlark_list(configs[name][0], 4)))
    out.write("}\n\n")
    out.write("# The symbols each target's source sets are filtered by: its devices, and\n")
    out.write("# what meson.build adds from configs/targets/ and the accelerators.\n")
    out.write("SYMBOLS = {\n")
    for name in sorted(configs):
        out.write('    "%s": %s,\n' % (name, starlark_list(sorted(configs[name][2]), 4)))
    out.write("}\n\n")
    out.write("# The defines of each target's config-target.h.\n")
    out.write("TARGET_CONFIG = {\n")
    for name in sorted(configs):
        out.write('    "%s": {\n' % name)
        for k, v in sorted(configs[name][3].items()):
            out.write('        "%s": "%s",\n' % (k, v))
        out.write("    },\n")
    out.write("}\n\n")
    out.write("# The TARGET_BASE_ARCH of each target.\n")
    out.write("BASE_ARCH = {\n")
    for name in sorted(configs):
        out.write('    "%s": "%s",\n' % (name, configs[name][1]["TARGET_BASE_ARCH"]))
    out.write("}\n\n")
    out.write("# The gdb feature descriptions of each target, under gdbstub/gdb-xml/.\n")
    out.write("GDB_XML = {\n")
    for name in sorted(configs):
        out.write('    "%s": %s,\n' % (name, starlark_list(configs[name][1].get("TARGET_XML_FILES", "").split(), 4)))
    out.write("}\n\n")
    out.write("# decodetree.py's extra arguments for each decoder of the targets' architectures.\n")
    out.write("DECODETREE = {\n")
    for path in sorted(decode):
        out.write('    "%s": %s,\n' % (path, starlark_strings(decode[path])))
    out.write("}\n\n")
    out.write("QAPI_MODULES = %s\n\n" % starlark_list(w.lists["qapi_all_modules"], 0))
    out.write("TRACE_EVENTS_SUBDIRS = %s\n" % starlark_list(w.lists["trace_events_subdirs"], 0))


if __name__ == "__main__":
    try:
        main()
    except Unknown as e:
        sys.exit("sources.py: %s" % e)
