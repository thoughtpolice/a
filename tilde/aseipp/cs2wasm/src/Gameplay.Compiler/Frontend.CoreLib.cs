// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

namespace Gameplay.Compiler;

// Compilation over the gameplay CoreLib (see docs/IMPORTER.md, "CoreLib and
// type-reference resolution"): the sources are compiled against .NET's
// reference assemblies, so their API surface is .NET's, and imported with
// the CoreLib (corelib/, built by csc into Gameplay.CoreLib.dll and embedded
// here) as the core library. A type reference into a reference assembly
// resolves to the CoreLib's type of its name, as .NET's own type
// forwarding resolves it to System.Private.CoreLib: each reference assembly
// is stood in for by a facade of its identity that forwards every CoreLib
// type.
internal sealed partial class Frontend
{
    // The reference assemblies gameplay code compiles against, embedded as
    // Gameplay.Compiler.Reference.<name>.dll.
    private static readonly string[] ReferenceAssemblies =
    [
        "System.Runtime",
        "System.Collections",
        "System.Linq",
        "System.Memory",
        "System.Numerics.Vectors",
        "System.Runtime.InteropServices",
        "System.Runtime.Intrinsics",
        "System.Runtime.Numerics",
        "System.Threading",
    ];

    // The framework's implementation assemblies imported over the CoreLib
    // (docs/IMPORTER.md, "Framework assemblies"), embedded as
    // Gameplay.Compiler.Framework.<name>.dll: each stands for its reference
    // assembly, whose facade it replaces, and its IL is compiled where code
    // reaches it, as the CoreLib's own is.
    private static readonly string[] FrameworkAssemblies =
    [
        "System.Collections",
        "System.Linq",
    ];

    // The CoreLib's boundary memory (runtime/Canonical.cs) and the runtime
    // of the component model's async functions (corelib/ComponentTasks.cs),
    // which the glue witgen generates calls, and the gameplay API the
    // CoreLib implements (corelib/Frames.cs): a reference assembly of their
    // public members, made from the CoreLib's metadata, that the sources
    // compile against and a facade forwards like the others.
    private const string AbiAssembly = "Gameplay.Abi";

    private static readonly string[] AbiTypes = ["Gameplay.Runtime.Memory", "Gameplay.Runtime.Canonical", "Gameplay.Frames", "Gameplay.Runtime.ComponentTasks"];

    // And the classes of futures' and streams' ends the glue and gameplay
    // code use (corelib/Channels.cs), and the table of exported resources'
    // objects (corelib/Resources.cs), with their public and protected
    // members.
    private static readonly string[] AbiClasses =
    [
        "Gameplay.Runtime.ChannelOps`1", "Gameplay.Runtime.StreamReader`1", "Gameplay.Runtime.StreamWriter`1",
        "Gameplay.Runtime.FutureReader`1", "Gameplay.Runtime.FutureWriter`1", "Gameplay.Runtime.ResourceReps`1",
    ];

    private const string CoreLibResource = "Gameplay.Compiler.CoreLib.dll";
    private const string CoreLibPdbResource = "Gameplay.Compiler.CoreLib.pdb";

    // The CoreLib's assembly: its types but the surface's are the runtime
    // layer's.
    [ThreadStatic]
    private static IAssemblySymbol? coreLibrary;

    [ThreadStatic]
    private static Dictionary<INamedTypeSymbol, bool>? surfaceTypes;

    [ThreadStatic]
    private static IlModule? coreModule;

    // The imported framework assemblies, and their IL.
    [ThreadStatic]
    private static HashSet<IAssemblySymbol>? frameworkAssemblies;

    [ThreadStatic]
    private static List<IlModule>? frameworkModules;

    // A symbol of an imported framework assembly.
    public static bool InFramework(ISymbol symbol) =>
        frameworkAssemblies is not null && symbol.OriginalDefinition.ContainingAssembly is { } assembly
        && frameworkAssemblies.Contains(assembly);

    private static IlModule? FrameworkModuleOf(ISymbol symbol)
    {
        if (frameworkModules is null)
        {
            return null;
        }

        foreach (var module in frameworkModules)
        {
            if (module.Defines(symbol))
            {
                return module;
            }
        }

        return null;
    }

    // A static method of a surface type that the CoreLib's sources give a
    // body (a partial declaration merged with .NET's, as the numeric types'
    // generic math): CoreLib IL, compiled where code reaches it, while the
    // type keeps the module layer's framework treatment.
    private static bool IsSurfaceBody(IMethodSymbol method) =>
        coreModule is not null && method.IsStatic && InCoreLibrary(method)
        && method.ContainingType is { } type && IsSurfaceType(type) && coreModule.HasBody(method);

    // A CoreLib type that is .NET's declaration (corelib/generator marks
    // each, nested ones too), not CoreLib's own.
    private static bool IsSurfaceType(INamedTypeSymbol type)
    {
        var definition = type.OriginalDefinition;
        surfaceTypes ??= new(SymbolEqualityComparer.Default);
        if (!surfaceTypes.TryGetValue(definition, out bool surface))
        {
            surface = definition.GetAttributes().Any(attribute =>
                attribute.AttributeClass is { Name: "SurfaceAttribute", ContainingNamespace: { Name: "Runtime", ContainingNamespace.Name: "Gameplay" } });
            surfaceTypes.Add(definition, surface);
        }

        return surface;
    }

    public static bool InCoreLibrary(ISymbol symbol) =>
        coreLibrary is not null && SymbolEqualityComparer.Default.Equals(symbol.OriginalDefinition.ContainingAssembly, coreLibrary);


    // An attribute class: metadata for the compiler, never code (the
    // CoreLib's own, and those csc embeds in it).
    private static bool IsAttributeClass(INamedTypeSymbol type)
    {
        for (var current = type.BaseType; current is not null; current = current.BaseType)
        {
            if (current is { Name: "Attribute", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } })
            {
                return true;
            }
        }

        return false;
    }

    // The import and export names, checked on the source's symbols: the
    // metadata's are UTF-8, where a lone surrogate has already become a
    // replacement character.
    private static void CheckBoundaryNames(INamespaceOrTypeSymbol container)
    {
        foreach (var member in container.GetMembers())
        {
            if (member is INamespaceOrTypeSymbol nested)
            {
                CheckBoundaryNames(nested);
                continue;
            }

            if (member is not IMethodSymbol method)
            {
                continue;
            }

            foreach (var attribute in method.GetAttributes())
            {
                if (attribute.AttributeClass is not { Name: "WasmImportAttribute" or "WasmExportAttribute", ContainingNamespace.Name: "Gameplay" } boundary
                    || !boundary.ContainingNamespace.ContainingNamespace.IsGlobalNamespace)
                {
                    continue;
                }

                if (attribute.ConstructorArguments.Any(argument => argument.Value is string name && !ValidBoundaryName(name)))
                {
                    throw CompileError.At(method, boundary.Name == "WasmImportAttribute"
                        ? "WasmImport requires nonempty, valid Unicode module/name strings of at most 256 characters without control characters."
                        : "WasmExport requires a nonempty, valid Unicode name of at most 256 characters without control characters.");
                }
            }
        }
    }

    // The ABI reference assembly: each public static method and read-only
    // property of the ABI types, with a body that is never run.
    private static byte[] AbiReference(byte[] coreImage, IEnumerable<MetadataReference> references)
    {
        var probe = CSharpCompilation.Create(
            "<probe>", [], [MetadataReference.CreateFromImage(ImmutableCollectionsMarshal.AsImmutableArray(coreImage))]);
        var text = new System.Text.StringBuilder();
        var format = SymbolDisplayFormat.FullyQualifiedFormat;
        foreach (string name in AbiTypes)
        {
            var type = probe.GetTypeByMetadataName(name)
                       ?? throw new InternalCompilerError($"the CoreLib has no {name}.");
            text.Append($"namespace {type.ContainingNamespace.ToDisplayString()} {{ public static class {type.Name} {{\n");
            foreach (var method in type.GetMembers().OfType<IMethodSymbol>()
                         .Where(method => method is { IsStatic: true, DeclaredAccessibility: Accessibility.Public, MethodKind: MethodKind.Ordinary }))
            {
                text.Append($"public static {AbiSignature(method)} => throw null;\n");
            }

            foreach (var property in type.GetMembers().OfType<IPropertySymbol>()
                         .Where(property => property is { IsStatic: true, DeclaredAccessibility: Accessibility.Public, GetMethod: not null, SetMethod: null }))
            {
                text.Append($"public static {property.Type.ToDisplayString(format)} {property.Name} => throw null;\n");
            }

            text.Append("} }\n");
        }

        foreach (string name in AbiClasses)
        {
            var type = probe.GetTypeByMetadataName(name)
                       ?? throw new InternalCompilerError($"the CoreLib has no {name}.");
            string modifier = type.IsAbstract ? "abstract " : type.IsSealed ? "sealed " : "";
            string typeParameters = "<" + string.Join(", ", type.TypeParameters.Select(parameter => parameter.Name)) + ">";
            var bases = type.Interfaces.Select(face => face.ToDisplayString(format)).ToList();
            text.Append($"namespace {type.ContainingNamespace.ToDisplayString()} {{ public {modifier}class {type.Name}{typeParameters}");
            text.Append(bases.Count == 0 ? " {\n" : " : " + string.Join(", ", bases) + " {\n");
            foreach (var member in type.GetMembers())
            {
                string? access = member.DeclaredAccessibility switch
                {
                    Accessibility.Public => "public",
                    Accessibility.Protected => "protected",
                    _ => null,
                };
                if (access is null || member.IsImplicitlyDeclared)
                {
                    continue;
                }

                switch (member)
                {
                    case IMethodSymbol { MethodKind: MethodKind.Constructor } constructor:
                        text.Append($"{access} {type.Name}({AbiParameters(constructor)}) {{ }}\n");
                        break;
                    case IMethodSymbol { MethodKind: MethodKind.Ordinary } method:
                        string kind = method.IsStatic ? "static " : method.IsAbstract ? "abstract " : method.IsOverride ? "override " : method.IsVirtual ? "virtual " : "";
                        text.Append($"{access} {kind}{AbiSignature(method)}{(method.IsAbstract ? ";" : " => throw null;")}\n");
                        break;
                    case IPropertySymbol { GetMethod: not null, SetMethod: null } property:
                        text.Append($"{access} {(property.IsStatic ? "static " : "")}{property.Type.ToDisplayString(format)} {property.Name} => throw null;\n");
                        break;
                }
            }

            text.Append("} }\n");
        }

        var abi = CSharpCompilation.Create(
            AbiAssembly,
            [CSharpSyntaxTree.ParseText(text.ToString())],
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, deterministic: true));
        using var stream = new MemoryStream();
        var emitted = abi.Emit(stream, options: new EmitOptions(metadataOnly: true));
        if (!emitted.Success)
        {
            throw new InternalCompilerError("the ABI reference assembly did not compile: "
                                            + string.Join("; ", emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        }

        return stream.ToArray();
    }

    // A method's result, name, type parameters and parameters, as C# for the
    // ABI reference assembly.
    private static string AbiSignature(IMethodSymbol method)
    {
        string typeParameters = method.IsGenericMethod ? "<" + string.Join(", ", method.TypeParameters.Select(parameter => parameter.Name)) + ">" : "";
        return $"{method.ReturnType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)} {method.Name}{typeParameters}({AbiParameters(method)})";
    }

    private static string AbiParameters(IMethodSymbol method) =>
        string.Join(", ", method.Parameters.Select(parameter =>
            (parameter.RefKind == RefKind.Out ? "out " : parameter.RefKind == RefKind.Ref ? "ref " : "")
            + parameter.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) + " " + parameter.Name
            + (parameter.HasExplicitDefaultValue ? " = default" : "")));

    private static CompilationProduct CompileIl(
        IReadOnlyList<SyntaxTree> trees, Limits limits, ImmutableArray<ISourceGenerator> generators,
        CSharpParseOptions parseOptions, IReadOnlyList<ReferencedLibrary> libraries)
    {
        byte[] image, pdb;
        List<(string Name, byte[] Image)> references;
        CSharpCompilation source;
        using (Timings.Start("roslyn"))
        {
            (image, pdb, references, source) = EmitAssembly("Gameplay", trees, generators, parseOptions, libraries, library: false);
        }

        Import import;
        using (Timings.Start("import-compilation"))
        {
            import = ImportCompilation(image, libraries, references, source.Options);
        }

        var owned = libraries.Select(library => library.Name).ToHashSet(StringComparer.Ordinal);
        try
        {
            IlModule module;
            using (Timings.Start("load"))
            {
                module = LoadImported(import, image, pdb, libraries);
            }

            DumpReferences("<user>", image);
            foreach (var library in libraries)
            {
                DumpReferences(library.Name, library.Image);
            }

            foreach (var (name, frameworkImage, _) in import.Framework)
            {
                DumpReferences(name, frameworkImage);
            }

            CheckUserReferences(module, owned);
            foreach (var library in libraryModules!)
            {
                CheckUserReferences(library, owned);
            }

            foreach (var (name, frameworkImage, _) in import.Framework)
            {
                CheckFrameworkReferences(name, frameworkImage);
            }

            var compilation = import.Compilation;
            coreModule = new IlModule(import.CoreImage, ReadOptionalResource(CoreLibPdbResource), compilation, coreLibrary!);
            bool polymorphic = false;
            bool enumerables = false;
            var covariant = new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default);
            HashSet<string>? unshared = null;
            bool share = true;
            ClosedWorld? world = null;
            int passes = 0;
            CompilationProduct? sound = null;
            while (true)
            {
                Frontend frontend;
                using (Timings.Start("pass-setup"))
                {
                    frontend = new Frontend(compilation, limits, polymorphic, enumerables, module, coreModule, covariant, unshared, world, share);
                }

                try
                {
                    using (Timings.Start("discover"))
                    {
                        frontend.DiscoverImported();
                    }

                    if (world is not null && !frontend.EscapingArrays.IsSubsetOf(world.Arrays))
                    {
                        // Arrays escaped that the world does not have: it
                        // does not hold, whatever emission makes (which
                        // lets no more escape), so it compiles again with
                        // them, unemitted.
                        if (passes == ClosedWorld.MaxPasses)
                        {
                            return sound!;
                        }

                        Timings.Note("again: arrays escape");
                        world = world.WithArrays(world.Arrays.Union<ITypeSymbol>(frontend.EscapingArrays, SymbolEqualityComparer.Default));
                        passes++;
                        continue;
                    }

                    sound = frontend.Emit();

                    // Once more, in a world this one tells of (see
                    // Frontend.ClosedWorld): what it cannot make is never
                    // tested for, so what only such tests led to is not
                    // made either.
                    var made = frontend.LastWorld!;
                    var next = world is null ? made.WithArrays([]) : made;
                    bool folds;
                    using (Timings.Start("would-fold"))
                    {
                        folds = frontend.WouldFold(next);
                    }

                    if (!ClosedWorld.Enabled || passes == ClosedWorld.MaxPasses || !folds)
                    {
                        return sound;
                    }

                    Timings.Note("again: closed world");
                    world = next;
                    passes++;
                    continue;
                }
                catch (ObjectValuesFound) when (!polymorphic)
                {
                    Timings.Note("again: object values");
                    polymorphic = true;
                }
                catch (EnumerablesFound) when (!enumerables)
                {
                    Timings.Note("again: enumerables");
                    enumerables = true;
                }
                catch (ArrayCovarianceFound found) when (covariant.Add(found.Element))
                {
                    Timings.Note("again: array covariance");
                }
                catch (SharingRevised revised) when (unshared is null)
                {
                    Timings.Note("again: sharing revised");
                    unshared = revised.Unshared;
                    share = !revised.Off;
                }

                // Compiled otherwise, it makes its world anew.
                world = null;
                passes = 0;
            }
        }
        finally
        {
            ClearImported();
        }
    }

    private static byte[] FrameworkImage(string name) => ReadResource("Gameplay.Compiler.Framework." + name + ".dll");

    // The compilation the importer reads an emitted assembly's IL in, with
    // the CoreLib as its core library, the libraries the assembly
    // references, and the framework's assemblies.
    private sealed record Import(
        CSharpCompilation Compilation, byte[] CoreImage, MetadataReference Core,
        List<(string Name, byte[] Image, MetadataReference Reference)> Framework,
        List<MetadataReference> Libraries, MetadataReference Image);

    private static Import ImportCompilation(
        byte[] image, IReadOnlyList<ReferencedLibrary> libraries, List<(string Name, byte[] Image)> references,
        CSharpCompilationOptions options)
    {
        byte[] coreImage = ReadResource(CoreLibResource);
        var coreReference = MetadataReference.CreateFromImage(ImmutableCollectionsMarshal.AsImmutableArray(coreImage));
        var forwarded = PublicTypes(coreImage);
        // The framework assemblies replace their reference assemblies'
        // facades; what they reference that no reference assembly stands
        // for (System.Private.CoreLib, which System.Collections is compiled
        // against) is a facade of the name, which they reference by name
        // alone (Weakened).
        var provided = references.Select(reference => reference.Name).ToHashSet(StringComparer.Ordinal);
        var weak = new SortedDictionary<string, Version>(StringComparer.Ordinal);
        var framework = FrameworkAssemblies
            .Select(name =>
            {
                byte[] weakened = Weakened(FrameworkImage(name), provided, weak);
                return (Name: name, Image: weakened, Reference: (MetadataReference)MetadataReference.CreateFromImage(ImmutableCollectionsMarshal.AsImmutableArray(weakened)));
            })
            .ToList();
        var facades = references
            .Where(reference => !framework.Any(assembly => assembly.Name == reference.Name))
            .Select(reference => MetadataReference.CreateFromImage(Facade(reference.Image, coreImage, forwarded)))
            .Concat(weak.Select(named => MetadataReference.CreateFromImage(Facade(NamedAssembly(named.Key, named.Value), coreImage, forwarded))))
            .ToList();
        var libraryReferences = libraries
            .Select(library => (MetadataReference)MetadataReference.CreateFromImage(ImmutableCollectionsMarshal.AsImmutableArray(library.Image), filePath: library.Path))
            .ToList();
        var imageReference = MetadataReference.CreateFromImage(image);
        var import = CSharpCompilation.Create(
            "<import>",
            [],
            [coreReference, .. facades, .. framework.Select(assembly => assembly.Reference), .. libraryReferences, imageReference],
            options.WithMetadataImportOptions(MetadataImportOptions.All));
        return new Import(import, coreImage, coreReference, framework, libraryReferences, imageReference);
    }

    // The import's assemblies, as the compilation's statics know them: the
    // emitted one (whose IL module this returns), the CoreLib, the
    // framework's and the libraries'.
    private static IlModule LoadImported(Import import, byte[] image, byte[]? pdb, IReadOnlyList<ReferencedLibrary> libraries)
    {
        var compilation = import.Compilation;
        IAssemblySymbol Loaded(MetadataReference reference, string name) =>
            (IAssemblySymbol?)compilation.GetAssemblyOrModuleSymbol(reference) ?? throw new InternalCompilerError($"{name} did not load.");

        var core = Loaded(import.Core, "the CoreLib");
        if (!SymbolEqualityComparer.Default.Equals(compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly, core))
        {
            throw new InternalCompilerError("the CoreLib is not the import's core library.");
        }

        var assembly = Loaded(import.Image, "the emitted assembly");
        importedAssembly = assembly;
        coreLibrary = core;
        frameworkAssemblies = new(SymbolEqualityComparer.Default);
        frameworkModules = [];
        foreach (var (name, frameworkImage, reference) in import.Framework)
        {
            var frameworkAssembly = Loaded(reference, name);
            frameworkAssemblies.Add(frameworkAssembly);
            frameworkModules.Add(new IlModule(frameworkImage, null, compilation, frameworkAssembly));
        }

        libraryAssemblies = new(SymbolEqualityComparer.Default);
        libraryModules = [];
        for (int index = 0; index < libraries.Count; index++)
        {
            var libraryAssembly = Loaded(import.Libraries[index], libraries[index].Name);
            libraryAssemblies.Add(libraryAssembly);
            libraryModules.Add(new IlModule(libraries[index].Image, libraries[index].Pdb, compilation, libraryAssembly));
        }

        return new IlModule(image, pdb, compilation, assembly);
    }

    private static void ClearImported()
    {
        importedAssembly = null;
        coreLibrary = null;
        coreModule = null;
        surfaceTypes = null;
        unnamedTypes = null;
        tupleNamed = null;
        symbolKeys = null;
        conversions = null;
        frameworkAssemblies = null;
        frameworkModules = null;
        libraryAssemblies = null;
        libraryModules = null;
    }

    private static byte[]? ReadOptionalResource(string name)
    {
        using var resource = typeof(Frontend).Assembly.GetManifestResourceStream(name);
        if (resource is null)
        {
            return null;
        }

        var data = new byte[resource.Length];
        resource.ReadExactly(data);
        return data;
    }

    // The public top-level types an assembly defines: namespace and name.
    private static List<(string Namespace, string Name)> PublicTypes(byte[] image)
    {
        using var pe = new PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image));
        var reader = pe.GetMetadataReader();
        var types = new List<(string, string)>();
        foreach (var handle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(handle);
            if (!type.IsNested && (type.Attributes & TypeAttributes.VisibilityMask) == TypeAttributes.Public)
            {
                types.Add((reader.GetString(type.Namespace), reader.GetString(type.Name)));
            }
        }

        return types;
    }

    private readonly Dictionary<IMethodSymbol, IMethodSymbol> redirects = new(SymbolEqualityComparer.Default);

    // What a call of a framework assembly's method runs instead: the
    // CoreLib's own of the same type name and signature, where the
    // framework's needs what the CoreLib does not have: System.Linq's
    // operators over decimal, whose generic math the CoreLib's decimal does
    // not implement.
    public IMethodSymbol Redirected(IMethodSymbol method)
    {
        if (!InFramework(method) || method.ContainingType is not { Name: "Enumerable" } type
            || type.ContainingNamespace?.ToDisplayString() != "System.Linq")
        {
            return method;
        }

        var definition = method.OriginalDefinition;
        if (definition.IsGenericMethod)
        {
            definition = definition.ConstructedFrom;
        }

        if (!redirects.TryGetValue(definition, out var target))
        {
            bool overDecimal = definition.Parameters.Any(parameter => MentionsDecimal(parameter.Type)) || MentionsDecimal(definition.ReturnType);
            target = definition;
            if (overDecimal && coreLibrary?.GetTypeByMetadataName("System.Linq.Enumerable") is { } own)
            {
                target = own.GetMembers(definition.Name).OfType<IMethodSymbol>()
                    .FirstOrDefault(candidate => candidate.Arity == definition.Arity && SameDefinitionSignature(candidate, definition))
                    ?? definition;
            }

            redirects.Add(definition, target);
        }

        if (SymbolEqualityComparer.Default.Equals(target, definition))
        {
            return method;
        }

        return method.IsGenericMethod ? target.Construct([.. method.TypeArguments]) : target;
    }

    private static bool MentionsDecimal(ITypeSymbol type) => type switch
    {
        { SpecialType: SpecialType.System_Decimal } => true,
        INamedTypeSymbol named => named.TypeArguments.Any(MentionsDecimal),
        IArrayTypeSymbol array => MentionsDecimal(array.ElementType),
        _ => false,
    };

    // Two method definitions' parameter and result types alike, method
    // type parameters by position.
    private static bool SameDefinitionSignature(IMethodSymbol left, IMethodSymbol right)
    {
        static bool Same(ITypeSymbol a, ITypeSymbol b) => (a, b) switch
        {
            (ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Method } x,
                ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Method } y) => x.Ordinal == y.Ordinal,
            (IArrayTypeSymbol x, IArrayTypeSymbol y) => x.Rank == y.Rank && Same(x.ElementType, y.ElementType),
            (INamedTypeSymbol { IsGenericType: true } x, INamedTypeSymbol { IsGenericType: true } y) =>
                SymbolEqualityComparer.Default.Equals(x.OriginalDefinition, y.OriginalDefinition)
                && x.TypeArguments.Zip(y.TypeArguments).All(pair => Same(pair.First, pair.Second)),
            _ => SymbolEqualityComparer.Default.Equals(a, b),
        };

        return left.Parameters.Length == right.Parameters.Length
               && Same(left.ReturnType, right.ReturnType)
               && left.Parameters.Zip(right.Parameters).All(pair => pair.First.RefKind == pair.Second.RefKind && Same(pair.First.Type, pair.Second.Type));
    }

    // A framework image whose references to assemblies no reference
    // assembly stands for (added to `weak`) name them without a public key
    // token, so that a facade of the name alone stands for them.
    private static byte[] Weakened(byte[] image, IReadOnlySet<string> provided, IDictionary<string, Version> weak)
    {
        var copy = (byte[])image.Clone();
        using var pe = new PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image));
        var reader = pe.GetMetadataReader();
        int table = pe.PEHeaders.MetadataStartOffset + reader.GetTableMetadataOffset(TableIndex.AssemblyRef);
        int rowSize = reader.GetTableRowSize(TableIndex.AssemblyRef);
        foreach (var handle in reader.AssemblyReferences)
        {
            var reference = reader.GetAssemblyReference(handle);
            string name = reader.GetString(reference.Name);
            if (provided.Contains(name) || FrameworkAssemblies.Contains(name) || reference.PublicKeyOrToken.IsNil)
            {
                continue;
            }

            weak[name] = weak.TryGetValue(name, out var known) && known > reference.Version ? known : reference.Version;
            // The row: four 2-byte version numbers, 4-byte flags, then the
            // key's blob index, 2 or 4 bytes wide.
            int row = table + (MetadataTokens.GetRowNumber(handle) - 1) * rowSize;
            int blob = MetadataTokens.GetHeapOffset(reference.PublicKeyOrToken);
            if (BitConverter.ToUInt32(copy, row + 12) == (uint)blob)
            {
                BitConverter.TryWriteBytes(copy.AsSpan(row + 12, 4), 0u);
            }
            else if (BitConverter.ToUInt16(copy, row + 12) == blob)
            {
                BitConverter.TryWriteBytes(copy.AsSpan(row + 12, 2), (ushort)0);
            }
            else
            {
                throw new InternalCompilerError($"the reference to {name} did not decode.");
            }
        }

        return copy;
    }

    // An empty assembly of a name and version and no public key: the
    // identity a facade of it takes.
    private static byte[] NamedAssembly(string name, Version version)
    {
        var metadata = new MetadataBuilder();
        metadata.AddAssembly(
            metadata.GetOrAddString(name),
            version,
            default,
            default,
            default,
            AssemblyHashAlgorithm.None);
        metadata.AddModule(0, metadata.GetOrAddString(name + ".dll"), metadata.GetOrAddGuid(Guid.Empty), default, default);
        metadata.AddTypeDefinition(
            default,
            default,
            metadata.GetOrAddString("<Module>"),
            default,
            MetadataTokens.FieldDefinitionHandle(1),
            MetadataTokens.MethodDefinitionHandle(1));
        var builder = new ManagedPEBuilder(
            PEHeaderBuilder.CreateLibraryHeader(),
            new MetadataRootBuilder(metadata),
            new BlobBuilder());
        var blob = new BlobBuilder();
        builder.Serialize(blob);
        return blob.ToArray();
    }

    // A facade module's GUID, from its name: it need only be stable and
    // distinct, so two FNV-1a hashes of the name stand in for a
    // cryptographic hash, which on Linux would load the system's OpenSSL.
    private static Guid NameGuid(string name)
    {
        Span<byte> bytes = stackalloc byte[16];
        byte[] text = System.Text.Encoding.UTF8.GetBytes(name);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt64LittleEndian(bytes, Fnv1a(text, 0xcbf29ce484222325));
        System.Buffers.Binary.BinaryPrimitives.WriteUInt64LittleEndian(bytes[8..], Fnv1a(text, 0x84222325cbf29ce4));
        return new Guid(bytes);
    }

    private static ulong Fnv1a(byte[] text, ulong hash)
    {
        foreach (byte b in text)
        {
            hash = unchecked((hash ^ b) * 0x100000001b3);
        }

        return hash;
    }

    // An assembly of a reference assembly's identity that forwards the
    // given types to the CoreLib.
    private static ImmutableArray<byte> Facade(byte[] referenceImage, byte[] coreImage, List<(string Namespace, string Name)> forwarded)
    {
        AssemblyDefinition identity;
        MetadataReader reference;
        using var referencePe = new PEReader(ImmutableCollectionsMarshal.AsImmutableArray(referenceImage));
        reference = referencePe.GetMetadataReader();
        identity = reference.GetAssemblyDefinition();
        using var corePe = new PEReader(ImmutableCollectionsMarshal.AsImmutableArray(coreImage));
        var coreReader = corePe.GetMetadataReader();
        var coreIdentity = coreReader.GetAssemblyDefinition();

        var metadata = new MetadataBuilder();
        string name = reference.GetString(identity.Name);
        metadata.AddAssembly(
            metadata.GetOrAddString(name),
            identity.Version,
            metadata.GetOrAddString(reference.GetString(identity.Culture)),
            metadata.GetOrAddBlob(reference.GetBlobBytes(identity.PublicKey)),
            identity.Flags,
            identity.HashAlgorithm);
        metadata.AddModule(
            0,
            metadata.GetOrAddString(name + ".dll"),
            metadata.GetOrAddGuid(NameGuid(name)),
            default,
            default);
        metadata.AddTypeDefinition(
            default,
            default,
            metadata.GetOrAddString("<Module>"),
            default,
            MetadataTokens.FieldDefinitionHandle(1),
            MetadataTokens.MethodDefinitionHandle(1));
        var core = metadata.AddAssemblyReference(
            metadata.GetOrAddString(coreReader.GetString(coreIdentity.Name)),
            coreIdentity.Version,
            default,
            default,
            default,
            default);
        foreach (var (space, typeName) in forwarded)
        {
            metadata.AddExportedType(
                TypeAttributes.Public | (TypeAttributes)0x00200000,
                metadata.GetOrAddString(space),
                metadata.GetOrAddString(typeName),
                core,
                0);
        }

        var builder = new ManagedPEBuilder(
            PEHeaderBuilder.CreateLibraryHeader(),
            new MetadataRootBuilder(metadata),
            new BlobBuilder());
        var blob = new BlobBuilder();
        builder.Serialize(blob);
        return [.. blob.ToArray()];
    }
}
