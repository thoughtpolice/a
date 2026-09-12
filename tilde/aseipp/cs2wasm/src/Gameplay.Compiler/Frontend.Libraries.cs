// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

namespace Gameplay.Compiler;

// A gameplay library: an assembly gameplayc compiled from C# with
// `--library` (over the same reference assemblies and options as a
// module's sources), and its portable PDB, for source locations.
internal sealed record ReferencedLibrary(string Name, string Path, byte[] Image, byte[]? Pdb);

// A compiled library: its assembly and PDB.
internal sealed record LibraryProduct(byte[] Image, byte[] Pdb);

// Referenced libraries (docs/IMPORTER.md, "Libraries"): a module's sources
// compile against the libraries they reference, and the importer imports
// the libraries' IL with the module's, as the module's own code: the same
// discovery, closed world, sharing and checks, their member references
// checked against the allowlist as the module's are. Only the module's own
// assembly exports and imports (WasmImport, WasmExport and the canonical
// ABI glue are its sources' alone).
internal sealed partial class Frontend
{
    // The imported libraries, and their IL.
    [ThreadStatic]
    private static HashSet<IAssemblySymbol>? libraryAssemblies;

    [ThreadStatic]
    private static List<IlModule>? libraryModules;

    // A symbol of a referenced library.
    public static bool InLibrary(ISymbol symbol) =>
        libraryAssemblies is not null && symbol.OriginalDefinition.ContainingAssembly is { } assembly
        && libraryAssemblies.Contains(assembly);

    private static IlModule? LibraryModuleOf(ISymbol symbol)
    {
        foreach (var module in libraryModules ?? [])
        {
            if (module.Defines(symbol))
            {
                return module;
            }
        }

        return null;
    }

    // The libraries of `--reference` paths: an assembly, or a directory of
    // them (what gameplay.library builds: a library and those it
    // references), each with the PDB beside it if there is one. An
    // assembly named twice (a library two others reference) is read once.
    public static List<ReferencedLibrary> ReadLibraries(IEnumerable<string> paths)
    {
        var files = new List<string>();
        foreach (string path in paths)
        {
            if (Directory.Exists(path))
            {
                files.AddRange(Directory.GetFiles(path, "*.dll").Order(StringComparer.Ordinal));
            }
            else if (File.Exists(path))
            {
                files.Add(path);
            }
            else
            {
                throw new CompileError($"Reference '{path}' is neither an assembly nor a directory.");
            }
        }

        var libraries = new List<ReferencedLibrary>();
        foreach (string file in files)
        {
            byte[] image = File.ReadAllBytes(file);
            string name = LibraryName(file, image);
            if (libraries.FirstOrDefault(library => library.Name == name) is { } known)
            {
                if (!known.Image.AsSpan().SequenceEqual(image))
                {
                    throw new CompileError($"References '{known.Path}' and '{file}' are two different assemblies named {name}.");
                }

                continue;
            }

            string pdb = Path.ChangeExtension(file, ".pdb");
            libraries.Add(new ReferencedLibrary(name, file, image, File.Exists(pdb) ? File.ReadAllBytes(pdb) : null));
        }

        if (libraries.Count > 64)
        {
            throw new CompileError("Reference limit is 64 libraries.");
        }

        return libraries;
    }

    // A referenced assembly's name, which must be a library's: an assembly
    // without a public key, of a library's name.
    private static string LibraryName(string path, byte[] image)
    {
        string name;
        bool keyed;
        try
        {
            using var pe = new PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image));
            if (!pe.HasMetadata)
            {
                throw new BadImageFormatException();
            }

            var reader = pe.GetMetadataReader();
            if (!reader.IsAssembly)
            {
                throw new BadImageFormatException();
            }

            var definition = reader.GetAssemblyDefinition();
            name = reader.GetString(definition.Name);
            keyed = !definition.PublicKey.IsNil;
        }
        catch (BadImageFormatException)
        {
            throw new CompileError($"Reference '{path}' is not an assembly.");
        }

        if (keyed || !ValidLibraryName(name))
        {
            throw new CompileError($"Reference '{path}' ({name}) is not a gameplay library (gameplayc --library).");
        }

        return name;
    }

    // A library's assembly name: letters, digits, '.', '_' and '-', not a
    // name of the module's own assembly, the CoreLib's, or the
    // framework's.
    public static bool ValidLibraryName(string name) =>
        name.Length is > 0 and <= 128
        && name.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-')
        && char.IsAsciiLetter(name[0])
        && !name.Equals("Gameplay", StringComparison.OrdinalIgnoreCase)
        && !name.StartsWith("Gameplay.", StringComparison.OrdinalIgnoreCase)
        && !name.Equals("System", StringComparison.OrdinalIgnoreCase)
        && !name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
        && !name.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase)
        && !name.Equals("mscorlib", StringComparison.OrdinalIgnoreCase)
        && !name.Equals("netstandard", StringComparison.OrdinalIgnoreCase);

    // A library of sources: compiled as a module's are, against the
    // libraries it references, under its own name, and its member
    // references checked against the allowlist, so that a library that
    // compiles is one any module can reference.
    public static LibraryProduct CompileLibrary(
        IReadOnlyList<SourceFile> sources, string name, bool runtimeAsync = false,
        IReadOnlyList<string>? generators = null, IReadOnlyList<ReferencedLibrary>? references = null)
    {
        if (!ValidLibraryName(name))
        {
            throw new CompileError($"'{name}' is not a library name: letters, digits, '.', '_' and '-', starting with a letter, "
                                   + "and not Gameplay's, System's, Microsoft's or the framework's.");
        }

        references ??= [];
        if (references.Any(library => library.Name == name))
        {
            throw new CompileError($"The library {name} must not reference itself.");
        }

        var (trees, parseOptions) = Parse(sources, runtimeAsync, bindings: false);
        var (image, pdb, assemblies, source) = EmitAssembly(name, trees, Generators.Load(generators ?? []), parseOptions, references, library: true);
        var import = ImportCompilation(image, references, assemblies, source.Options);
        try
        {
            var owned = references.Select(library => library.Name).ToHashSet(StringComparer.Ordinal);
            CheckUserReferences(LoadImported(import, image, pdb, references), owned);
        }
        finally
        {
            ClearImported();
        }

        return new LibraryProduct(image, pdb);
    }

    // The assembly of sources and its PDB, as C# compiles them for gameplay
    // code, and the reference assemblies it is compiled against. A library
    // and a module are both compiled as a DLL; the generators learn which
    // this is from the build (Generators.BuildProperties).
    private static (byte[] Image, byte[] Pdb, List<(string Name, byte[] Image)> References, CSharpCompilation Source) EmitAssembly(
        string assemblyName, IReadOnlyList<SyntaxTree> trees, ImmutableArray<ISourceGenerator> generators,
        CSharpParseOptions parseOptions, IReadOnlyList<ReferencedLibrary> libraries, bool library)
    {
        var references = ReferenceAssemblies
            .Select(name => (Name: name, Image: ReadResource("Gameplay.Compiler.Reference." + name + ".dll")))
            .ToList();
        byte[] coreImage = ReadResource(CoreLibResource);
        using (Timings.Start("abi-reference"))
        {
            references.Add((AbiAssembly, AbiReference(
                coreImage,
                references.Select(reference => MetadataReference.CreateFromImage(ImmutableCollectionsMarshal.AsImmutableArray(reference.Image))))));
        }

        var source = CSharpCompilation.Create(
            assemblyName,
            trees,
            references.Select(reference => MetadataReference.CreateFromImage(ImmutableCollectionsMarshal.AsImmutableArray(reference.Image)))
                .Concat(libraries.Select(library => MetadataReference.CreateFromImage(ImmutableCollectionsMarshal.AsImmutableArray(library.Image), filePath: library.Path))),
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Release,
                checkOverflow: false,
                allowUnsafe: false,
                concurrentBuild: false,
                deterministic: true,
                nullableContextOptions: NullableContextOptions.Disable));
        source = Generators.Run(source, generators, parseOptions, Generators.BuildProperties(library, assemblyName));
        Diagnostic[] diagnostics;
        using (Timings.Start("roslyn-check"))
        {
            diagnostics = source.GetDiagnostics()
                .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                .ToArray();
        }

        if (diagnostics.Length != 0)
        {
            throw new CompileError(string.Join(Environment.NewLine, diagnostics.Take(32).Select(d => d.ToString())));
        }

        CheckBoundaryNames(source.Assembly.GlobalNamespace);
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();
        using var emitting = Timings.Start("roslyn-emit");
        var emitted = source.Emit(
            peStream,
            pdbStream,
            options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
        if (!emitted.Success)
        {
            throw new CompileError(string.Join(
                Environment.NewLine,
                emitted.Diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                    .Take(32)
                    .Select(diagnostic => diagnostic.ToString())));
        }

        return (peStream.ToArray(), pdbStream.ToArray(), references, source);
    }
}
