// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Gameplay.Fuzz;

// The fuzzer's CLR oracle: a long-running process that compiles each
// generated program with Roslyn in process (C# 15, nullable disabled, as
// gameplayc parses gameplay code), loads it into a collectible
// AssemblyLoadContext, invokes the requested static methods in order on that
// one load (static state persists between calls, as in one Wasm instance),
// and answers with one JSON line per request. Results and exceptions use the
// encoding of tests/reference/Program.cs.
//
// Request:  {"id": 1, "source": "...", "calls": [{"method": "Fuzz.Entry.E0", "args": ["1"]}]}
// Response: {"id": 1, "compiled": true, "diagnostics": [], "results": [{"Kind": ..., "Value": ..., "Exception": ..., "Chain": [...]}]}
internal static class Oracle
{
    // gameplayc supplies sdk/Gameplay.cs to every program; the oracle binds
    // the same declarations (the attribute types only, which is all gameplay
    // code sees of them).
    private const string SdkSource = """
        namespace Gameplay
        {
            [System.AttributeUsage(System.AttributeTargets.Method, AllowMultiple = false)]
            public sealed class WasmImportAttribute : System.Attribute
            {
                public WasmImportAttribute(string module, string name) { Module = module; Name = name; }
                public string Module { get; }
                public string Name { get; }
            }

            [System.AttributeUsage(System.AttributeTargets.Method, AllowMultiple = false)]
            public sealed class WasmExportAttribute : System.Attribute
            {
                public WasmExportAttribute(string name) { Name = name; }
                public string Name { get; }
            }

            [System.AttributeUsage(
                System.AttributeTargets.Class | System.AttributeTargets.Struct | System.AttributeTargets.Method
                    | System.AttributeTargets.Constructor,
                AllowMultiple = false)]
            public sealed class CanonicalAbiAttribute : System.Attribute
            {
            }
        }
        """;

    private static readonly CSharpParseOptions ParseOptions = new(LanguageVersion.CSharp15);

    private static readonly SyntaxTree SdkTree = CSharpSyntaxTree.ParseText(SdkSource, ParseOptions, "Gameplay.cs");

    public static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        if (args.Length != 0)
        {
            Console.Error.WriteLine("Usage: FuzzOracle < requests.jsonl");
            return 2;
        }

        // Deeply nested generated expressions need more stack than the main
        // thread has, for Roslyn and for the JIT.
        int status = 0;
        var thread = new Thread(() => status = Serve(), 64 * 1024 * 1024);
        thread.Start();
        thread.Join();
        return status;
    }

    private static int Serve()
    {
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        MetadataReference[] references = FrameworkReferences();
        using var output = Console.OpenStandardOutput();
        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            if (line.Length == 0)
            {
                continue;
            }

            byte[] response = Handle(line, references);
            output.Write(response);
            output.WriteByte((byte)'\n');
            output.Flush();
        }

        return 0;
    }

    // The framework the oracle itself runs on: the implementation assemblies
    // of the shared runtime.
    private static MetadataReference[] FrameworkReferences()
    {
        string paths = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            ?? throw new InvalidOperationException("No trusted platform assemblies.");
        return paths.Split(Path.PathSeparator)
            .Where(path =>
            {
                string name = Path.GetFileName(path);
                return name.StartsWith("System.", StringComparison.Ordinal)
                    || name is "netstandard.dll" or "mscorlib.dll";
            })
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToArray();
    }

    private static byte[] Handle(string line, MetadataReference[] references)
    {
        using JsonDocument request = JsonDocument.Parse(line);
        JsonElement root = request.RootElement;
        long id = root.GetProperty("id").GetInt64();
        string source = root.GetProperty("source").GetString() ?? "";

        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("id", id);

            var tree = CSharpSyntaxTree.ParseText(source, ParseOptions, "Program.cs", Encoding.UTF8);
            var compilation = CSharpCompilation.Create(
                "Fuzz" + id.ToString(CultureInfo.InvariantCulture),
                [tree, SdkTree],
                references,
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    optimizationLevel: OptimizationLevel.Release,
                    checkOverflow: false,
                    allowUnsafe: false,
                    concurrentBuild: false,
                    deterministic: true,
                    nullableContextOptions: NullableContextOptions.Disable));
            using var image = new MemoryStream();
            var emitted = compilation.Emit(image);
            var errors = emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToArray();
            writer.WriteBoolean("compiled", emitted.Success);
            writer.WriteStartArray("diagnostics");
            foreach (var error in errors.Take(16))
            {
                writer.WriteStringValue(error.ToString());
            }

            writer.WriteEndArray();
            writer.WriteStartArray("results");
            if (emitted.Success)
            {
                image.Position = 0;
                var context = new AssemblyLoadContext("fuzz", isCollectible: true);
                try
                {
                    Assembly assembly = context.LoadFromStream(image);
                    foreach (JsonElement call in root.GetProperty("calls").EnumerateArray())
                    {
                        Invoke(writer, assembly, call);
                    }
                }
                finally
                {
                    context.Unload();
                }
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }

    private static void Invoke(Utf8JsonWriter writer, Assembly assembly, JsonElement call)
    {
        writer.WriteStartObject();
        string methodName = call.GetProperty("method").GetString() ?? "";
        int separator = methodName.LastIndexOf('.');
        Type? type = separator < 0 ? null : assembly.GetType(methodName[..separator]);
        MethodInfo? method = type?.GetMethod(methodName[(separator + 1)..], BindingFlags.Public | BindingFlags.Static);
        if (method is null)
        {
            writer.WriteString("Kind", "missing");
            writer.WriteEndObject();
            return;
        }

        ParameterInfo[] parameters = method.GetParameters();
        JsonElement[] arguments = call.GetProperty("args").EnumerateArray().ToArray();
        if (arguments.Length != parameters.Length)
        {
            writer.WriteString("Kind", "missing");
            writer.WriteEndObject();
            return;
        }

        object[] values = arguments.Select((argument, index) => ParseArgument(
            argument.GetString() ?? throw new InvalidDataException("Arguments must be strings."),
            parameters[index].ParameterType)).ToArray();
        try
        {
            object? result = method.Invoke(null, values);
            writer.WriteString("Kind", "value");
            writer.WriteString("Value", EncodeValue(result));
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            writer.WriteString("Kind", "exception");
            writer.WriteString("Exception", exception.InnerException.GetType().Name);
            writer.WriteStartArray("Chain");
            for (Type? t = exception.InnerException.GetType(); t is not null && t != typeof(object); t = t.BaseType)
            {
                writer.WriteStringValue(t.Name);
            }

            writer.WriteEndArray();
        }

        writer.WriteEndObject();
    }

    // Copied from tests/reference/Program.cs: inputs arrive as the runner
    // printed them, integers in decimal (unsigned types unsigned), chars by
    // code, enums by underlying value.
    private static object ParseArgument(string value, Type type)
    {
        if (type.IsEnum)
            return Enum.ToObject(type, ParseArgument(value, Enum.GetUnderlyingType(type)));
        if (type == typeof(bool))
            return value == "1";
        if (type == typeof(float))
            return float.Parse(value, CultureInfo.InvariantCulture);
        if (type == typeof(double))
            return double.Parse(value, CultureInfo.InvariantCulture);
        if (type == typeof(char))
            return (char)ushort.Parse(value, CultureInfo.InvariantCulture);
        if (type == typeof(int) || type == typeof(sbyte) || type == typeof(byte) || type == typeof(short)
            || type == typeof(ushort) || type == typeof(uint) || type == typeof(long) || type == typeof(ulong))
            return Convert.ChangeType(value, type, CultureInfo.InvariantCulture);
        throw new NotSupportedException($"Unsupported oracle input type: {type}.");
    }

    // Copied from tests/reference/Program.cs: results are encoded as the Wasm
    // caller sees them, every 32-bit-or-narrower integer as a signed i32,
    // 64-bit integers as a signed i64, floating point by its bits widened to
    // double (any NaN is equal).
    private static string EncodeValue(object? value) => value switch
    {
        null => "void",
        bool boolean => boolean ? "i32:1" : "i32:0",
        sbyte integer => "i32:" + ((int)integer).ToString(CultureInfo.InvariantCulture),
        byte integer => "i32:" + ((int)integer).ToString(CultureInfo.InvariantCulture),
        short integer => "i32:" + ((int)integer).ToString(CultureInfo.InvariantCulture),
        ushort integer => "i32:" + ((int)integer).ToString(CultureInfo.InvariantCulture),
        char character => "i32:" + ((int)character).ToString(CultureInfo.InvariantCulture),
        int integer => "i32:" + integer.ToString(CultureInfo.InvariantCulture),
        uint integer => "i32:" + unchecked((int)integer).ToString(CultureInfo.InvariantCulture),
        long integer => "i64:" + integer.ToString(CultureInfo.InvariantCulture),
        ulong integer => "i64:" + unchecked((long)integer).ToString(CultureInfo.InvariantCulture),
        float number => EncodeFloatingPoint(number),
        double number => EncodeFloatingPoint(number),
        Enum enumeration => EncodeValue(Convert.ChangeType(enumeration, Enum.GetUnderlyingType(enumeration.GetType()), CultureInfo.InvariantCulture)),
        _ => throw new NotSupportedException($"Unsupported oracle result type: {value.GetType()}."),
    };

    private static string EncodeFloatingPoint(double value)
    {
        if (double.IsNaN(value))
            return "f64:NaN";
        return "f64:" + BitConverter.DoubleToUInt64Bits(value).ToString("x16", CultureInfo.InvariantCulture);
    }
}
