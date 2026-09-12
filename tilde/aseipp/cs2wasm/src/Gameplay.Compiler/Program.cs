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

            var (output, inputs, limits) = ParseArguments(args);
            string absoluteOutput = Path.GetFullPath(output);
            var pathComparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            if (inputs.Any(path => string.Equals(Path.GetFullPath(path), absoluteOutput, pathComparison)))
            {
                throw new CompileError("Output must not overwrite an input source file.");
            }

            var sources = ReadSources(inputs);
            var product = Frontend.Compile(sources, limits);
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
            gameplayc 0.1.0-prototype
            native-aot={!RuntimeFeature.IsDynamicCodeSupported}
            host={RuntimeInformation.RuntimeIdentifier}
            frontend=Roslyn IOperation
            target=WebAssembly core 3.0 GC subset
            embedded-reference=System.Runtime
            external-assembler=false
            """);
    }

    private static void WriteHelp()
    {
        Console.WriteLine("""
            gameplayc [--fuel N] [--depth N] [--alloc-units N] [--max-array N]
                      -o output.wasm source.cs [more.cs ...]
            gameplayc --info

            A deliberately restricted C# -> Wasm GC compiler prototype.
            Public static methods with primitive signatures become exports.
            No .NET runtime, SDK, Roslyn DLL, or Wasm assembler is required
            beside a successfully Native-AOT-published executable.
            Unsupported features are errors, never fallback compilation.
            """);
    }

    private static (string Output, List<string> Inputs, Limits Limits) ParseArguments(string[] args)
    {
        string? output = null;
        var inputs = new List<string>();
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

        return (output, inputs, limits);
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
