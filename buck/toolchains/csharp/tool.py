#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Action helper for the C# toolchain.

The .NET SDK, the NativeAOT runtime pack and the crossgen2 package are
downloaded as whole directories, and the analysis phase cannot enumerate
their contents. Every subcommand here takes those directories as arguments,
globs what it needs out of them (reference assemblies, runtime libraries,
apphost templates) and runs the underlying tool with a response file.

Subcommands:
  csc        compile C# sources into an IL assembly with Roslyn
  ilc        compile an IL assembly into a native object with ILCompiler
  link       link a NativeAOT object into an executable
  crossgen2  precompile an IL assembly with ReadyToRun code
  apphost    stamp the SDK's apphost template with an application name
  copy       copy one file out of a downloaded directory
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

# The SDK's apphost carries this placeholder (the SHA-256 of "foobar") where
# the application assembly's file name goes; dotnet/sdk's HostWriter does the
# same replacement.
APPHOST_PLACEHOLDER = b"c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2"
APPHOST_BUFFER = 1024

# Feature switches the SDK turns off for every trimmed/AOT application. Each
# one is passed to ilc both as a compile-time feature (dead code is removed)
# and as a runtime knob (AppContext reports the same answer).
AOT_FEATURE_SWITCHES = [
    ("Microsoft.Extensions.DependencyInjection.VerifyOpenGenericServiceTrimmability", "true"),
    ("System.ComponentModel.Design.IDesignerHost.IsSupported", "false"),
    ("System.ComponentModel.TypeConverter.EnableUnsafeBinaryFormatterInDesigntimeLicenseContextSerialization", "false"),
    ("System.ComponentModel.TypeDescriptor.IsComObjectDescriptorSupported", "false"),
    ("System.Data.DataSet.XmlSerializationIsSupported", "false"),
    ("System.Diagnostics.Tracing.EventSource.IsSupported", "false"),
    ("System.Linq.Enumerable.IsSizeOptimized", "true"),
    ("System.Linq.Expressions.CanEmitObjectArrayDelegate", "false"),
    ("System.Reflection.Metadata.MetadataUpdater.IsSupported", "false"),
    ("System.Resources.ResourceManager.AllowCustomResourceTypes", "false"),
    ("System.Resources.UseSystemResourceKeys", "false"),
    ("System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported", "false"),
    ("System.Runtime.InteropServices.BuiltInComInterop.IsSupported", "false"),
    ("System.Runtime.InteropServices.EnableConsumingManagedCodeFromNativeHosting", "false"),
    ("System.Runtime.InteropServices.EnableCppCLIHostActivation", "false"),
    ("System.Runtime.InteropServices.Marshalling.EnableGeneratedComInterfaceComImportInterop", "false"),
    ("System.Runtime.Serialization.EnableUnsafeBinaryFormatterSerialization", "false"),
    ("System.StartupHookProvider.IsSupported", "false"),
    ("System.Text.Encoding.EnableUnsafeUTF7Encoding", "false"),
    ("System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault", "false"),
    ("System.Threading.Thread.EnableAutoreleasePool", "false"),
]

# Assemblies ilc initializes before Main, in the order the SDK lists them.
AOT_INIT_ASSEMBLIES = [
    "System.Private.CoreLib",
    "System.Private.StackTraceMetadata",
    "System.Private.TypeLoader",
    "System.Private.Reflection.Execution",
]


def fail(message):
    sys.stderr.write("csharp tool: {}\n".format(message))
    sys.exit(1)


def scratch_dir():
    """A directory for response files and other temporaries. Buck2 gives each
    action its own; outside of one, a fresh temporary directory."""
    path = os.environ.get("BUCK_SCRATCH_PATH")
    if path:
        os.makedirs(path, exist_ok=True)
        return path
    return tempfile.mkdtemp(prefix="csharp-tool-")


def one(pattern, what):
    matches = sorted(glob.glob(pattern))
    if len(matches) != 1:
        fail("expected exactly one {} at {}, found {}".format(what, pattern, matches))
    return matches[0]


def dlls(directory):
    return sorted(glob.glob(os.path.join(directory, "*.dll")))


def quote(arg):
    """Quote one response-file argument the way csc, ilc and crossgen2 read
    them: double quotes around anything with spaces, backslash-escaped
    quotes inside."""
    if " " not in arg and '"' not in arg:
        return arg
    return '"' + arg.replace('"', '\\"') + '"'


def write_rsp(name, lines):
    path = os.path.join(scratch_dir(), name)
    with open(path, "w", encoding="utf-8") as rsp:
        for line in lines:
            rsp.write(quote(line) + "\n")
    return path


def run(command, env=None):
    sys.stderr.flush()
    result = subprocess.run(command, env=env)
    if result.returncode != 0:
        sys.exit(result.returncode)


def dotnet_env(sdk_root):
    """Environment for anything that runs under the downloaded SDK. The CLI is
    never invoked (csc runs as a plain application under the muxer), but the
    muxer and the apphosts read these, and none of them may touch $HOME."""
    env = dict(os.environ)
    root = os.path.abspath(sdk_root)
    env.update({
        "DOTNET_ROOT": root,
        "DOTNET_CLI_HOME": scratch_dir(),
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "DOTNET_NOLOGO": "1",
        "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1",
        "DOTNET_MULTILEVEL_LOOKUP": "0",
        "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false",
    })
    return env


def sdk_paths(sdk_root):
    muxer = os.path.join(sdk_root, "dotnet.exe" if os.name == "nt" else "dotnet")
    if not os.path.exists(muxer):
        fail("no dotnet muxer under {}".format(sdk_root))
    return {
        "dotnet": muxer,
        "csc": one(os.path.join(sdk_root, "sdk", "*", "Roslyn", "bincore", "csc.dll"), "csc.dll"),
        "ref_pack": one(os.path.join(sdk_root, "packs", "Microsoft.NETCore.App.Ref", "*"), "targeting pack"),
        "shared": one(os.path.join(sdk_root, "shared", "Microsoft.NETCore.App", "*"), "shared runtime"),
    }


def rid_parts(rid):
    """('linux', 'arm64') for 'linux-arm64'; the OS spelling is the one
    ilc and crossgen2 take on the command line."""
    os_name, _, arch = rid.rpartition("-")
    if not os_name or not arch:
        fail("malformed runtime identifier {}".format(rid))
    return os_name, arch


# MARK: csc


def target_framework_defines(tfm):
    """The preprocessor symbols the SDK defines for a net{major}.0 target."""
    if not tfm.startswith("net"):
        return []
    major = int(tfm[3:].split(".")[0])
    defines = ["NET", "NETCOREAPP", "NET{}_0".format(major)]
    defines += ["NETCOREAPP{}_OR_GREATER".format(v) for v in ("1_0", "1_1", "2_0", "2_1", "2_2", "3_0", "3_1")]
    defines += ["NET{}_0_OR_GREATER".format(v) for v in range(5, major + 1)]
    return defines


def cmd_csc(args):
    sdk = sdk_paths(args.sdk)
    ref_dir = os.path.join(sdk["ref_pack"], "ref", args.tfm)
    references = dlls(ref_dir)
    if not references:
        fail("no reference assemblies under {}".format(ref_dir))

    defines = target_framework_defines(args.tfm) + ["TRACE"]
    if not args.optimize:
        defines.append("DEBUG")
    defines += args.define

    # 1701 and 1702 are the assembly-unification notes the SDK always
    # silences: package assemblies reference older framework versions.
    nowarn = ["1701", "1702"] + args.nowarn

    lines = [
        "/nologo",
        "/nostdlib+",
        "/utf8output",
        "/deterministic+",
        "/highentropyva+",
        "/checked-",
        "/preferreduilang:en-US",
        "/langversion:" + args.lang_version,
        "/nullable:" + args.nullable,
        "/target:" + args.target,
        "/out:" + args.out,
        "/pdb:" + args.pdb,
        "/debug+",
        "/debug:portable",
        "/optimize+" if args.optimize else "/optimize-",
        "/define:" + ";".join(defines),
        "/warn:" + str(args.warn),
    ]
    lines.append("/nowarn:" + ",".join(nowarn))
    if args.warnaserror:
        lines.append("/warnaserror+")
    if args.unsafe:
        lines.append("/unsafe+")
    if args.main:
        lines.append("/main:" + args.main)
    if args.doc:
        lines.append("/doc:" + args.doc)
    for resource in args.resource:
        lines.append("/resource:" + resource)
    for analyzer in args.analyzer:
        lines.append("/analyzer:" + analyzer)
    for reference in references + args.reference:
        lines.append("/r:" + reference)
    lines += args.extra
    lines += args.sources

    # /noconfig (no csc.rsp from the SDK directory) only counts on the
    # command line itself.
    rsp = write_rsp(os.path.basename(args.out) + ".csc.rsp", lines)
    run([sdk["dotnet"], "exec", sdk["csc"], "/noconfig", "@" + rsp], env=dotnet_env(args.sdk))


# MARK: ilc


def nativeaot_dirs(pack, rid, tfm):
    lib = os.path.join(pack, "runtimes", rid, "lib", tfm)
    native = os.path.join(pack, "runtimes", rid, "native")
    if not os.path.isdir(lib) or not os.path.isdir(native):
        fail("the NativeAOT runtime pack at {} has no runtimes/{} layout".format(pack, rid))
    return lib, native


def cmd_ilc(args):
    os_name, arch = rid_parts(args.rid)
    lib, native = nativeaot_dirs(args.nativeaot_pack, args.rid, args.tfm)
    ilc = one(os.path.join(args.ilc_package, "tools", "ilc*"), "ilc")

    # The application's own dependencies come after the framework so that a
    # replacement assembly (see aot_assembly_overrides) wins over nothing:
    # ilc rejects two references with one simple name, so the rule already
    # dropped the original.
    references = dlls(lib) + dlls(native) + args.reference

    lines = [args.input, "-o:" + args.out]
    lines += ["-r:" + reference for reference in references]
    lines += [
        "--targetos:" + os_name,
        "--targetarch:" + arch,
        "--dehydrate",
    ]
    if args.optimize:
        lines.append("-O")
    lines.append("-g")
    lines.append("--exportsfile:" + args.exports)
    if args.debugger_support and os_name != "win":
        lines.append("--export-dynamic-symbol:DotNetRuntimeContractDescriptor")
    lines += ["--initassembly:" + assembly for assembly in AOT_INIT_ASSEMBLIES]

    pinvokes = ["System.Native", "System.IO.Compression.Native"]
    if not args.invariant_globalization:
        pinvokes.append("System.Globalization.Native")
    if os_name != "win":
        pinvokes.append("System.Net.Security.Native")
        pinvokes.append(
            "System.Security.Cryptography.Native.Apple" if os_name == "osx" else "System.Security.Cryptography.Native.OpenSsl"
        )
    lines += ["--directpinvoke:" + library for library in pinvokes]

    switches = list(AOT_FEATURE_SWITCHES)
    switches.append(("System.Diagnostics.Debugger.IsSupported", "true" if args.debugger_support else "false"))
    if args.invariant_globalization:
        switches.append(("System.Globalization.Invariant", "true"))
    lines += ["--feature:{}={}".format(name, value) for name, value in switches]
    lines += ["--runtimeknob:{}={}".format(name, value) for name, value in switches]
    lines.append("--runtimeknob:RUNTIME_IDENTIFIER=" + args.rid)
    if args.server_gc:
        lines.append("--runtimeopt:gcServer=1")

    if args.stack_trace_support:
        lines.append("--stacktracedata:frames")
    lines.append("--scanreflection")
    lines.append("--methodbodyfolding:" + ("generic" if args.optimize else "none"))
    if args.optimize and args.optimization_preference == "speed":
        lines.append("--Ot")
    if args.optimize and args.optimization_preference == "size":
        lines.append("--Os")
    if args.nowarn:
        lines.append("--nowarn:" + ";".join(args.nowarn))
    if args.warnaserror:
        lines.append("--warnaserror")
    if args.single_warn:
        lines.append("--singlewarn")
    lines.append("--resilient")
    lines.append("--generateunmanagedentrypoints:System.Private.CoreLib,HIDDEN")
    lines += args.extra

    rsp = write_rsp(os.path.basename(args.out) + ".ilc.rsp", lines)
    run([ilc, "@" + rsp])


# MARK: link


def cmd_link(args):
    os_name, arch = rid_parts(args.rid)
    if os_name == "win":
        fail("NativeAOT linking on Windows needs link.exe, which this toolchain does not drive yet")
    _, native = nativeaot_dirs(args.nativeaot_pack, args.rid, args.tfm)
    apple = os_name == "osx"

    def sdk_lib(name):
        path = os.path.join(native, name)
        if not os.path.exists(path):
            fail("the NativeAOT runtime pack has no {}".format(name))
        return path

    # Managed shims first, then the runtime, then the compression and
    # platform libraries: single-pass linkers need every dependency after
    # the objects that use it.
    shims = ["System.Native", "System.IO.Compression.Native"]
    if not args.invariant_globalization:
        shims.append("System.Globalization.Native")
    shims.append("System.Net.Security.Native")
    shims.append("System.Security.Cryptography.Native.Apple" if apple else "System.Security.Cryptography.Native.OpenSsl")
    libraries = [sdk_lib("lib{}.a".format(shim)) for shim in shims]
    libraries.append(sdk_lib("libbootstrapper.o"))
    libraries.append(sdk_lib("libRuntime.ServerGC.a" if args.server_gc else "libRuntime.WorkstationGC.a"))
    libraries.append(sdk_lib("libeventpipe-disabled.a"))
    if arch in ("x64", "arm64"):
        vxsort = "libRuntime.VxsortEnabled.a" if args.optimization_preference == "speed" else "libRuntime.VxsortDisabled.a"
        libraries.append(sdk_lib(vxsort))
    libraries.append(sdk_lib("libstandalonegc-disabled.a"))
    libraries.append(sdk_lib("libaotminipal.a"))
    if not apple:
        libraries.append(sdk_lib("libstdc++compat.a"))
    for bundled in ("libz.a", "libbrotlienc.a", "libbrotlidec.a", "libbrotlicommon.a", "libzstd.a"):
        path = os.path.join(native, bundled)
        if os.path.exists(path):
            libraries.append(path)

    command = list(args.linker)
    command += [args.object, "-o", args.out]
    if apple:
        command += ["-exported_symbols_list", args.exports]
    else:
        command += ["-Wl,--version-script=" + args.exports, "-Wl,--export-dynamic"]
        if args.debugger_support:
            command.append("-Wl,-u,DotNetRuntimeContractDescriptor")
    if apple:
        command.append("-Wl,-dead_strip")
    command.append("-g")
    if not apple:
        command.append("-gz=zlib")
        if args.fuse_ld:
            command.append("-fuse-ld=" + args.fuse_ld)
    command += libraries
    if apple:
        command += ["-L/usr/lib/swift", "-lobjc", "-lswiftCore", "-lswiftFoundation", "-licucore", "-ldl", "-lm"]
        for framework in ("CoreFoundation", "CryptoKit", "Foundation", "Network", "Security", "GSS"):
            command += ["-framework", framework]
    else:
        command += [
            "-Wl,--build-id=sha1",
            "-Wl,--as-needed",
            "-pthread",
            "-ldl",
            "-lrt",
            "-lm",
            "-pie",
            "-Wl,-pie",
            "-Wl,-z,relro",
            "-Wl,-z,now",
            "-Wl,--eh-frame-hdr",
            "-Wl,--discard-all",
            "-Wl,--gc-sections",
        ]
        if args.fuse_ld == "lld":
            command.append("-Wl,--icf=all")
            # lld 13+ needs to be told to keep the section ilc uses to find
            # the compiled modules at startup.
            sections = os.path.join(scratch_dir(), "sections.ld")
            with open(sections, "w", encoding="utf-8") as script:
                script.write("OVERWRITE_SECTIONS { __modules : { KEEP(*(__modules)) } }\n")
            command.append("-Wl,-T," + sections)
    command += args.extra

    run(command)

    if apple:
        if args.dbg:
            run(["dsymutil", "--minimize", "-o", args.dbg, args.out])
        if args.strip:
            run(["strip", "-no_code_signature_warning", "-x", args.out])
        return

    objcopy = list(args.objcopy) if args.objcopy else ["objcopy"]
    if args.dbg:
        run(objcopy + ["--only-keep-debug", args.out, args.dbg])
    if args.strip:
        run(objcopy + ["--strip-debug", "--strip-unneeded", args.out])
        if args.dbg:
            run(objcopy + ["--add-gnu-debuglink=" + args.dbg, args.out])


# MARK: crossgen2


def cmd_crossgen2(args):
    os_name, arch = rid_parts(args.rid)
    sdk = sdk_paths(args.sdk)
    crossgen2 = one(os.path.join(args.crossgen2_package, "tools", "crossgen2*"), "crossgen2")

    lines = [args.input, "-o:" + args.out]
    lines += ["-r:" + reference for reference in dlls(sdk["shared"]) + args.reference]
    lines += ["--targetos:" + os_name, "--targetarch:" + arch]
    if args.optimize:
        lines.append("--Ot" if args.optimization_preference == "speed" else "-O")
    lines += args.extra

    rsp = write_rsp(os.path.basename(args.out) + ".crossgen2.rsp", lines)
    run([crossgen2, "@" + rsp])


# MARK: apphost


def cmd_apphost(args):
    template = one(
        os.path.join(args.sdk, "packs", "Microsoft.NETCore.App.Host.*", "*", "runtimes", "*", "native", "apphost*"),
        "apphost template",
    )
    with open(template, "rb") as source:
        image = bytearray(source.read())
    offset = image.find(APPHOST_PLACEHOLDER)
    if offset < 0:
        fail("{} carries no application path placeholder".format(template))
    name = args.app.encode("utf-8") + b"\0"
    if len(name) > APPHOST_BUFFER:
        fail("application name {} is longer than the apphost's buffer".format(args.app))
    image[offset:offset + len(name)] = name
    with open(args.out, "wb") as out:
        out.write(image)
    os.chmod(args.out, 0o755)


# MARK: executable


def cmd_executable(args):
    """NuGet packages are zip files without Unix permission bits, so the
    compilers inside come out of http_archive unexecutable. Copy the package
    and mark the named files."""
    if os.path.lexists(args.out):
        shutil.rmtree(args.out)
    shutil.copytree(args.source, args.out, symlinks=True)
    for pattern in args.chmod:
        for path in glob.glob(os.path.join(args.out, pattern)):
            os.chmod(path, os.stat(path).st_mode | 0o755)


# MARK: copy


def cmd_copy(args):
    source = one(args.source, "file") if glob.has_magic(args.source) else args.source
    if not os.path.isfile(source):
        fail("{} does not exist".format(source))
    shutil.copyfile(source, args.out)


# MARK: main


def main(argv):
    parser = argparse.ArgumentParser(prog="csharp-tool", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    csc = commands.add_parser("csc")
    csc.add_argument("--sdk", required=True)
    csc.add_argument("--tfm", required=True)
    csc.add_argument("--target", choices=["library", "exe"], required=True)
    csc.add_argument("--out", required=True)
    csc.add_argument("--pdb", required=True)
    csc.add_argument("--doc")
    csc.add_argument("--lang-version", required=True)
    csc.add_argument("--nullable", required=True)
    csc.add_argument("--warn", type=int, required=True)
    csc.add_argument("--optimize", action="store_true")
    csc.add_argument("--warnaserror", action="store_true")
    csc.add_argument("--unsafe", action="store_true")
    csc.add_argument("--main")
    csc.add_argument("--define", action="append", default=[])
    csc.add_argument("--nowarn", action="append", default=[])
    csc.add_argument("--reference", action="append", default=[])
    csc.add_argument("--resource", action="append", default=[])
    csc.add_argument("--analyzer", action="append", default=[])
    csc.add_argument("--extra", action="append", default=[])
    csc.add_argument("sources", nargs="+")
    csc.set_defaults(func=cmd_csc)

    ilc = commands.add_parser("ilc")
    ilc.add_argument("--ilc-package", required=True)
    ilc.add_argument("--nativeaot-pack", required=True)
    ilc.add_argument("--rid", required=True)
    ilc.add_argument("--tfm", required=True)
    ilc.add_argument("--input", required=True)
    ilc.add_argument("--out", required=True)
    ilc.add_argument("--exports", required=True)
    ilc.add_argument("--reference", action="append", default=[])
    ilc.add_argument("--optimize", action="store_true")
    ilc.add_argument("--optimization-preference", choices=["speed", "size", "none"], default="none")
    ilc.add_argument("--debugger-support", action="store_true")
    ilc.add_argument("--invariant-globalization", action="store_true")
    ilc.add_argument("--server-gc", action="store_true")
    ilc.add_argument("--stack-trace-support", action="store_true")
    ilc.add_argument("--single-warn", action="store_true")
    ilc.add_argument("--warnaserror", action="store_true")
    ilc.add_argument("--nowarn", action="append", default=[])
    ilc.add_argument("--extra", action="append", default=[])
    ilc.set_defaults(func=cmd_ilc)

    link = commands.add_parser("link")
    link.add_argument("--nativeaot-pack", required=True)
    link.add_argument("--rid", required=True)
    link.add_argument("--tfm", required=True)
    link.add_argument("--object", required=True)
    link.add_argument("--exports", required=True)
    link.add_argument("--out", required=True)
    link.add_argument("--dbg")
    link.add_argument("--strip", action="store_true")
    link.add_argument("--fuse-ld")
    link.add_argument("--objcopy", action="append")
    link.add_argument("--optimization-preference", choices=["speed", "size", "none"], default="none")
    link.add_argument("--debugger-support", action="store_true")
    link.add_argument("--invariant-globalization", action="store_true")
    link.add_argument("--server-gc", action="store_true")
    link.add_argument("--extra", action="append", default=[])
    link.add_argument("linker", nargs="+", help="the C compiler driver used as the linker")
    link.set_defaults(func=cmd_link)

    crossgen2 = commands.add_parser("crossgen2")
    crossgen2.add_argument("--sdk", required=True)
    crossgen2.add_argument("--crossgen2-package", required=True)
    crossgen2.add_argument("--rid", required=True)
    crossgen2.add_argument("--input", required=True)
    crossgen2.add_argument("--out", required=True)
    crossgen2.add_argument("--reference", action="append", default=[])
    crossgen2.add_argument("--optimize", action="store_true")
    crossgen2.add_argument("--optimization-preference", choices=["speed", "size", "none"], default="none")
    crossgen2.add_argument("--extra", action="append", default=[])
    crossgen2.set_defaults(func=cmd_crossgen2)

    apphost = commands.add_parser("apphost")
    apphost.add_argument("--sdk", required=True)
    apphost.add_argument("--app", required=True, help="file name of the application assembly")
    apphost.add_argument("--out", required=True)
    apphost.set_defaults(func=cmd_apphost)

    executable = commands.add_parser("executable")
    executable.add_argument("--source", required=True)
    executable.add_argument("--out", required=True)
    executable.add_argument("--chmod", action="append", default=[], help="glob, relative to the package, of files to mark executable")
    executable.set_defaults(func=cmd_executable)

    copy = commands.add_parser("copy")
    copy.add_argument("--source", required=True)
    copy.add_argument("--out", required=True)
    copy.set_defaults(func=cmd_copy)

    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
