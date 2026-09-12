// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Globalization;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Gameplay.Compiler;

internal static class Program
{
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--info")
            {
                WriteInfo();
                return 0;
            }

            if (args.Length == 0 || args.Contains("--help", StringComparer.Ordinal))
            {
                WriteHelp();
                return 0;
            }

            var (output, inputs, limits, runtimeAsync, generators, library, references) = ParseArguments(args);
            string absoluteOutput = Path.GetFullPath(output);
            var pathComparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            if (inputs.Any(path => string.Equals(Path.GetFullPath(path), absoluteOutput, pathComparison)))
            {
                throw new CompileError("Output must not overwrite an input source file.");
            }

            var sources = ReadSources(inputs);
            var libraries = Frontend.ReadLibraries(references);
            if (library is not null)
            {
                if (!absoluteOutput.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                {
                    throw new CompileError("A library's output must be a .dll (its PDB is written beside it).");
                }

                var compiled = Frontend.CompileLibrary(sources, library, runtimeAsync, generators, libraries);
                WriteOutput(absoluteOutput, compiled.Image);
                WriteOutput(Path.ChangeExtension(absoluteOutput, ".pdb"), compiled.Pdb);
                Console.WriteLine($"Wrote {output}: library {library}, {compiled.Image.Length} bytes.");
                return 0;
            }

            using var total = Timings.Start("total");
            var product = Frontend.Compile(sources, limits, runtimeAsync, generators, libraries);
            WriteOutput(absoluteOutput, product.Bytes);

            Console.WriteLine($"Wrote {output}: {product.Bytes.Length} bytes; {product.Functions} functions; {product.HeapTypes} GC types.");
            foreach (string export in product.Exports)
            {
                Console.WriteLine("export " + export);
            }

            return 0;
        }
        catch (CompileError error)
        {
            Console.Error.WriteLine(error.Message);
            if (Environment.GetEnvironmentVariable("GAMEPLAYC_TRACE") is not null)
            {
                // Where the compiler decided it: for its own debugging.
                Console.Error.WriteLine(error.StackTrace);
            }

            return 1;
        }
        catch (IOException error)
        {
            Console.Error.WriteLine("I/O error: " + error.Message);
            return 2;
        }
        catch (UnauthorizedAccessException error)
        {
            Console.Error.WriteLine("Access error: " + error.Message);
            return 2;
        }
        catch (Exception error)
        {
            // A frontend/backend bug must not be reported as a policy rejection.
            Console.Error.WriteLine("Internal compiler error: " + error);
            return 3;
        }
    }

    private static void WriteInfo()
    {
        Console.WriteLine($"""
            gameplayc 0.2.0-prototype
            host={RuntimeInformation.RuntimeIdentifier}
            frontend=CIL importer
            target=WebAssembly core 3.0 GC subset
            embedded-references=.NET reference assemblies, gameplay CoreLib
            external-assembler=false
            """);
    }

    private static void WriteHelp()
    {
        Console.WriteLine("""
            gameplayc [--fuel N] [--depth N] [--alloc-units N] [--max-array N]
                      [--recover-after-trap] [--runtime-async]
                      [--generator generator.dll ...] [--reference library ...]
                      -o output.wasm source.cs [more.cs ...]
            gameplayc --library Name [--runtime-async] [--generator generator.dll ...]
                      [--reference library ...] -o Name.dll source.cs [more.cs ...]
            gameplayc --info

            A deliberately restricted C# -> Wasm GC compiler prototype.
            Public static methods of public classes with scalar signatures
            become exports under Namespace.Class.Method; [WasmExport("name")]
            names one explicitly, and [WasmImport("module", "name")] declares
            a host function (both from sdk/Gameplay.cs, which the compiler
            supplies). The reference assemblies and the gameplay CoreLib are
            embedded; no SDK or Wasm assembler is needed at run time.
            Unsupported features are errors, never fallback compilation.
            After a trap a module refuses every later entry (fault 18), as a
            .NET process ends; --recover-after-trap lets later entries run.
            The sources are compiled to IL by Roslyn and the IL to Wasm over
            the gameplay CoreLib. --runtime-async compiles async methods as
            runtime-async methods, which the compiler splits itself.
            --generator runs the Roslyn source generators an assembly
            declares over the sources, as csc's /analyzer does (the
            JIT-compiled compiler only).
            --library compiles the sources into a library assembly of that
            name (and its PDB beside it) instead of a module; --reference
            names a library assembly, or a directory of them, that the
            sources compile against and whose IL the module includes as
            its own. Only the module's own sources export and import.
            """);
    }

    private static (string Output, List<string> Inputs, Limits Limits, bool RuntimeAsync, List<string> Generators, string? Library, List<string> References) ParseArguments(string[] args)
    {
        string? output = null;
        string? library = null;
        var references = new List<string>();
        bool runtimeAsync = false;
        var inputs = new List<string>();
        var generators = new List<string>();
        var limits = new Limits();

        for (int index = 0; index < args.Length; index++)
        {
            string NextArgument()
            {
                if (++index >= args.Length)
                {
                    throw new CompileError("Missing option argument.");
                }

                return args[index];
            }

            int PositiveInteger(int maximum)
            {
                if (!int.TryParse(NextArgument(), NumberStyles.None, CultureInfo.InvariantCulture, out int value)
                    || value < 1 || value > maximum)
                {
                    throw new CompileError($"Expected an integer from 1 to {maximum}.");
                }

                return value;
            }

            switch (args[index])
            {
                case "-o":
                    if (output is not null)
                    {
                        throw new CompileError("Specify -o only once.");
                    }

                    output = NextArgument();
                    break;

                case "--fuel":
                    limits = limits with { Fuel = PositiveInteger(1_000_000) };
                    break;

                case "--depth":
                    limits = limits with { CallDepth = PositiveInteger(128) };
                    break;

                case "--alloc-units":
                    limits = limits with { AllocationUnits = PositiveInteger(16_777_216) };
                    break;

                case "--max-array":
                    limits = limits with { ArrayLength = PositiveInteger(1_048_576) };
                    break;

                case "--recover-after-trap":
                    limits = limits with { RecoverAfterTrap = true };
                    break;

                case "--runtime-async":
                    runtimeAsync = true;
                    break;

                case "--generator":
                    generators.Add(NextArgument());
                    break;

                case "--library":
                    if (library is not null)
                    {
                        throw new CompileError("Specify --library only once.");
                    }

                    library = NextArgument();
                    break;

                case "--reference":
                    references.Add(NextArgument());
                    break;

                default:
                    if (args[index].StartsWith('-'))
                    {
                        throw new CompileError($"Unknown option '{args[index]}'.");
                    }

                    inputs.Add(args[index]);
                    break;
            }
        }

        if (output is null || inputs.Count == 0)
        {
            throw new CompileError("Specify -o output.wasm and at least one C# source file.");
        }

        if (inputs.Count > 128)
        {
            throw new CompileError("Source file limit is 128.");
        }

        if (library is not null && limits != new Limits())
        {
            throw new CompileError("A library has no runtime budgets: the module referencing it sets them.");
        }

        return (output, inputs, limits, runtimeAsync, generators, library, references);
    }

    private static List<SourceFile> ReadSources(IReadOnlyList<string> inputs)
    {
        var sources = new List<SourceFile>();
        long inputBytes = 0;
        foreach (string path in inputs)
        {
            inputBytes += new FileInfo(path).Length;
            if (inputBytes > 8_000_000)
            {
                throw new CompileError("Total source file byte limit is 8,000,000.");
            }

            sources.Add(new SourceFile(path, File.ReadAllText(path)));
        }

        return sources;
    }

    private static void WriteOutput(string absoluteOutput, byte[] bytes)
    {
        // Publish only after the whole frontend/backend has succeeded. Leave
        // an existing output unchanged on failure; never emit partial Wasm.
        string directory = Path.GetDirectoryName(absoluteOutput)!;
        Directory.CreateDirectory(directory);
        string temporary = Path.Combine(directory, ".gameplayc-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.WriteAllBytes(temporary, bytes);
            File.Move(temporary, absoluteOutput, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }
}
