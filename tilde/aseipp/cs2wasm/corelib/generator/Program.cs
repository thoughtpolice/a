// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// coresurface: the gameplay CoreLib's framework surface (see
// docs/IMPORTER.md, "CoreLib and type-reference resolution"). It reads the
// C# sources of .NET's reference assemblies (dotnet/runtime's
// src/libraries/*/ref/*.cs, pinned in buck/third-party), keeps the types
// corelib/surface.txt allows, and writes them out with every member
// `extern`: declarations the importer implements (intrinsics, shims, the
// module layer's framework types), with .NET's exact names and signatures.
// A type CoreLib's own sources define replaces the reference's; one they
// declare `partial` is merged, member by member, the sources' members
// winning. What no longer compiles once types are left out (a member whose
// signature names one, a base interface, an attribute) is dropped, until
// the surface and CoreLib's sources compile together. dotnet/runtime's own
// implementation sources (--impl) are taken where they fit: each member
// that does not compile against the rest is dropped (the report lists
// them), and their types replace .NET's declarations; --resx makes the
// resource strings they throw with an SR class. dotnet/runtime's sources of
// interfaces the surface keeps (--defaults) give them their default
// members: the members with bodies are merged into the surface's
// declaration, which stays the surface's, as CoreLib's own `[Surface]`
// partial declarations do (each member that does not compile is dropped,
// leaving the surface's extern one). It then compiles
// them, as the pinned Roslyn does gameplay code, into the CoreLib assembly:
// a core library, with no references.

using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Gameplay.CoreSurface;

internal static class Program
{
    public static int Main(string[] args)
    {
        var references = new List<string>();
        var sources = new List<string>();
        var implementations = new List<string>();
        var defaults = new List<string>();
        var patches = new List<string>();
        var resources = new List<string>();
        string? allowlist = null;
        string? output = null;
        string? report = null;
        string? assembly = null;
        string? pdb = null;
        string? sourceRoot = null;
        for (int i = 0; i < args.Length; i++)
        {
            string Next() => ++i < args.Length ? args[i] : throw new ArgumentException($"{args[i - 1]} needs a value");
            switch (args[i])
            {
                case "--ref":
                    references.Add(Next());
                    break;
                case "--source":
                    sources.Add(Next());
                    break;
                case "--impl":
                    implementations.Add(Next());
                    break;
                case "--defaults":
                    defaults.Add(Next());
                    break;
                case "--patch":
                    patches.Add(Next());
                    break;
                case "--resx":
                    resources.Add(Next());
                    break;
                case "--allow":
                    allowlist = Next();
                    break;
                case "--out":
                    output = Next();
                    break;
                case "--report":
                    report = Next();
                    break;
                case "--assembly":
                    assembly = Next();
                    break;
                case "--pdb":
                    pdb = Next();
                    break;
                case "--source-root":
                    sourceRoot = Next();
                    break;
                default:
                    if (args[i].StartsWith('@'))
                    {
                        foreach (string line in File.ReadAllLines(args[i][1..]))
                        {
                            if (line.Length > 0)
                            {
                                sources.Add(line);
                            }
                        }

                        break;
                    }

                    Console.Error.WriteLine($"coresurface: unknown argument {args[i]}");
                    return 2;
            }
        }

        if (allowlist is null || output is null || references.Count == 0)
        {
            Console.Error.WriteLine("usage: coresurface --allow surface.txt --out directory --ref ref.cs... [--source corelib.cs...] "
                                    + "[--impl dotnet-runtime.cs... [--patch file.cs.patch...]] [--defaults IInterface.cs...] [--resx Strings.resx...] [--source-root dir] "
                                    + "[--report report.txt] [--assembly out.dll --pdb out.pdb]");
            return 2;
        }

        Generator? generator = null;
        try
        {
            generator = new Generator(Allowlist.Read(allowlist), sourceRoot, Patches.Read(patches));
            Directory.CreateDirectory(output);
            var files = generator.Run(references, sources, implementations, defaults, resources);
            foreach (var (name, text) in files)
            {
                File.WriteAllText(Path.Combine(output, name), text);
            }

            if (assembly is not null)
            {
                generator.Emit(files, assembly, pdb ?? Path.ChangeExtension(assembly, ".pdb"));
            }

            if (report is not null)
            {
                File.WriteAllText(report, generator.Report());
            }

            return 0;
        }
        catch (SurfaceError error)
        {
            Console.Error.WriteLine("coresurface: " + error.Message);

            // What was dropped before it failed, which is often why.
            if (report is not null && generator is not null)
            {
                File.WriteAllText(report, generator.Report());
                Console.Error.WriteLine($"coresurface: what was dropped so far is in {report}");
            }

            return 1;
        }
    }
}

internal sealed class SurfaceError(string message) : Exception(message);

// Patches of dotnet/runtime's implementation sources (--patch): unified
// diffs (`diff -u a/F b/F`, after comment lines of their own), each applied
// to the source of its file name before it is parsed. Every hunk must
// match exactly where it says, so a changed source fails the build rather
// than taking a patch half-applied.
internal sealed class Patches
{
    private readonly Dictionary<string, List<(int Start, List<string> Old, List<string> New)>> hunks = new(StringComparer.Ordinal);

    public static Patches Read(IEnumerable<string> paths)
    {
        var patches = new Patches();
        foreach (string path in paths)
        {
            string? target = null;
            List<(int Start, List<string> Old, List<string> New)>? current = null;
            foreach (string line in File.ReadAllLines(path))
            {
                if (line.StartsWith("+++ b/", StringComparison.Ordinal))
                {
                    target = line["+++ b/".Length..].Trim();
                    if (!patches.hunks.TryAdd(target, current = []))
                    {
                        throw new SurfaceError($"{path}: {target} is patched twice");
                    }
                }
                else if (line.StartsWith("@@ ", StringComparison.Ordinal))
                {
                    if (current is null)
                    {
                        throw new SurfaceError($"{path}: a hunk before its file");
                    }

                    // @@ -start,count +start,count @@
                    string range = line.Split(' ')[1];
                    int start = int.Parse(range[1..].Split(',')[0], System.Globalization.CultureInfo.InvariantCulture);
                    current.Add((start, [], []));
                }
                else if (current is { Count: > 0 } && line.Length > 0 && line[0] is ' ' or '-' or '+')
                {
                    var (_, old, @new) = current[^1];
                    if (line[0] != '+')
                    {
                        old.Add(line[1..]);
                    }

                    if (line[0] != '-')
                    {
                        @new.Add(line[1..]);
                    }
                }
                else if (current is { Count: > 0 } && line.Length == 0)
                {
                    // An empty context line whose space an editor dropped.
                    var (_, old, @new) = current[^1];
                    old.Add("");
                    @new.Add("");
                }
            }
        }

        return patches;
    }

    public string Apply(string file, string text)
    {
        if (!hunks.TryGetValue(file, out var fileHunks))
        {
            return text;
        }

        string newline = text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var lines = text.Split(newline).ToList();
        int shift = 0;
        foreach (var (start, old, @new) in fileHunks)
        {
            int at = start - 1 + shift;
            if (at < 0 || at + old.Count > lines.Count || !lines.GetRange(at, old.Count).SequenceEqual(old))
            {
                throw new SurfaceError($"the patch of {file} does not apply at line {start}");
            }

            lines.RemoveRange(at, old.Count);
            lines.InsertRange(at, @new);
            shift += @new.Count - old.Count;
        }

        return string.Join(newline, lines);
    }
}

// Which reference types the surface keeps: `namespace N` keeps N's
// top-level types, `type N.T` one type (`T`1` for a generic one), `exclude
// N.T` leaves one out. Nested types follow their containing type.
internal sealed class Allowlist
{
    private readonly HashSet<string> namespaces = new(StringComparer.Ordinal);
    private readonly HashSet<string> types = new(StringComparer.Ordinal);
    private readonly HashSet<string> excluded = new(StringComparer.Ordinal);

    public static Allowlist Read(string path)
    {
        var list = new Allowlist();
        int number = 0;
        foreach (string raw in File.ReadAllLines(path))
        {
            number++;
            string line = raw.Split('#')[0].Trim();
            if (line.Length == 0)
            {
                continue;
            }

            string[] words = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Length != 2)
            {
                throw new SurfaceError($"{path}:{number}: expected `namespace N`, `type N.T` or `exclude N.T`");
            }

            var set = words[0] switch
            {
                "namespace" => list.namespaces,
                "type" => list.types,
                "exclude" => list.excluded,
                _ => throw new SurfaceError($"{path}:{number}: unknown rule {words[0]}"),
            };
            if (!set.Add(words[1]))
            {
                throw new SurfaceError($"{path}:{number}: {words[1]} is listed twice");
            }
        }

        return list;
    }

    public bool Keeps(string space, string fullName) =>
        !excluded.Contains(fullName) && (types.Contains(fullName) || namespaces.Contains(space));

    public bool Excludes(string fullName) => excluded.Contains(fullName);

    public IEnumerable<string> Types => types;
}

internal sealed class Generator(Allowlist rules, string? sourceRoot, Patches patches)
{
    private readonly Allowlist allowlist = rules;
    private List<SyntaxTree> sourceTrees = [];
    private List<SyntaxTree> implementationTrees = [];
    private readonly List<string> implementationRemoved = [];
    private readonly CSharpParseOptions referenceOptions = new(LanguageVersion.CSharp15, DocumentationMode.None);
    private readonly List<string> removed = [];
    private readonly List<string> kept = [];

    // Types CoreLib's sources declare, by metadata name, and whether all
    // their declarations are partial (merged with the reference's).
    private readonly Dictionary<string, bool> declared = new(StringComparer.Ordinal);

    private const string DefinedBySources = "CoreLib's sources define it";

    // The surface, a file per reference source: its name and text.
    public List<(string Name, string Text)> Run(
        List<string> referencePaths,
        List<string> sourcePaths,
        List<string> implementationPaths,
        List<string> defaultPaths,
        List<string> resourcePaths)
    {
        sourceTrees = sourcePaths
            .Select(path => CSharpSyntaxTree.ParseText(
                File.ReadAllText(path),
                referenceOptions,
                sourceRoot is null ? path : Path.GetRelativePath(sourceRoot, path),
                Encoding.UTF8))
            .ToList();
        if (resourcePaths.Count != 0)
        {
            sourceTrees.Add(CSharpSyntaxTree.ParseText(ResourceStrings(resourcePaths), referenceOptions, "SR.g.cs", Encoding.UTF8));
        }

        foreach (var tree in sourceTrees)
        {
            foreach (var (name, declaration) in TypeDeclarations(tree.GetRoot()))
            {
                bool partial = declaration.Modifiers.Any(SyntaxKind.PartialKeyword);
                declared[name] = declared.TryGetValue(name, out bool all) ? all && partial : partial;
            }
        }

        // dotnet/runtime's types replace .NET's declarations of them (as the
        // runtime layer's do), partial so CoreLib's sources can add to them.
        implementationTrees = implementationPaths
            .Select(path => CSharpSyntaxTree.ParseText(
                patches.Apply(Path.GetFileName(path), File.ReadAllText(path)),
                referenceOptions,
                "dotnet-runtime/" + Path.GetFileName(path),
                Encoding.UTF8))
            .Select(tree => tree.WithRootAndOptions(new Partial().Visit(tree.GetRoot())!, referenceOptions))
            .ToList();
        foreach (var tree in implementationTrees)
        {
            foreach (var (name, _) in TypeDeclarations(tree.GetRoot()))
            {
                declared[name] = false;
            }
        }

        // dotnet/runtime's interfaces' default members, merged into the
        // surface's interfaces (as droppable as the implementation sources'
        // members), which they mark as the surface's unless CoreLib's own
        // sources declare them (and mark them themselves).
        var defaultSources = new List<(SyntaxTree Tree, HashSet<string> Marked)>();
        foreach (string path in defaultPaths)
        {
            var tree = CSharpSyntaxTree.ParseText(
                patches.Apply(Path.GetFileName(path), File.ReadAllText(path)),
                referenceOptions,
                "dotnet-runtime/" + Path.GetFileName(path),
                Encoding.UTF8);
            var marked = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (name, declaration) in TypeDeclarations(tree.GetRoot()))
            {
                if (declaration is not InterfaceDeclarationSyntax)
                {
                    throw new SurfaceError($"{path}: {name} is not an interface, whose default members --defaults takes");
                }

                if (!declared.ContainsKey(name))
                {
                    marked.Add(name);
                    declared[name] = true;
                }
            }

            defaultSources.Add((tree, marked));
        }

        var implementationSources = implementationTrees;

        var referenceTrees = referencePaths
            .Select(path => (CSharpSyntaxTree)CSharpSyntaxTree.ParseText(File.ReadAllText(path), referenceOptions, path, Encoding.UTF8))
            .ToList();
        var originalTrees = referenceTrees;

        // The types kept, bodies made extern.
        referenceTrees = referenceTrees
            .Select(tree => (CSharpSyntaxTree)tree.WithRootAndOptions(
                new Selector(this).Visit(tree.GetRoot())!, referenceOptions))
            .ToList();
        foreach (string type in allowlist.Types)
        {
            if (!kept.Contains(type) && !declared.ContainsKey(type))
            {
                throw new SurfaceError($"surface.txt names {type}, which no reference source declares");
            }
        }

        // Drop what does not compile, then the members CoreLib's partial
        // declarations define themselves, until nothing is left to drop. A
        // default member that does not compile was dropped after the
        // surface's declaration it replaced, so the surface is made again
        // without it, which leaves the surface's.
        var selectedTrees = referenceTrees;
        var failedDefaults = new HashSet<string>(StringComparer.Ordinal);
        for (int attempt = 0; ; attempt++)
        {
            if (attempt == 8)
            {
                throw new SurfaceError("the default members did not converge");
            }

            referenceTrees = selectedTrees;
            var defaultTrees = defaultSources
                .Select(source => source.Tree.WithRootAndOptions(
                    new DefaultMembers(source.Marked, failedDefaults).Visit(source.Tree.GetRoot())!, referenceOptions))
                .ToList();
            implementationTrees = [.. implementationSources, .. defaultTrees];
            removed.Clear();
            implementationRemoved.Clear();
            int failures = failedDefaults.Count;
            for (int round = 0; ; round++)
            {
                if (round == 64)
                {
                    throw new SurfaceError("the surface did not converge");
                }

                var compilation = Compile(referenceTrees, [.. sourceTrees, .. implementationTrees]);
                var drops = new Dictionary<SyntaxTree, HashSet<SyntaxNode>>();
                void Drop(SyntaxNode node, string why)
                {
                    if (!drops.TryGetValue(node.SyntaxTree, out var set))
                    {
                        drops.Add(node.SyntaxTree, set = []);
                    }

                    if (set.Add(node))
                    {
                        (implementationTrees.Contains(node.SyntaxTree) ? implementationRemoved : removed).Add($"{Describe(node)}: {why}");
                        if (why != DefinedBySources && node is MemberDeclarationSyntax { Parent: InterfaceDeclarationSyntax @interface }
                            && defaultTrees.Any(tree => tree.FilePath == node.SyntaxTree.FilePath))
                        {
                            failedDefaults.Add(DefaultMembers.Key(@interface, node));
                        }
                    }
                }

                // The members CoreLib's partial declarations define first: the
                // duplicates are what else fails (a base interface an explicit
                // implementation is ambiguous for, say).
                foreach (var tree in referenceTrees)
                {
                    SemanticModel? model = null;
                    foreach (var type in tree.GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>())
                    {
                        if (!declared.ContainsKey(FullName(type)))
                        {
                            continue;
                        }

                        model ??= compilation.GetSemanticModel(tree);
                        foreach (var member in type.Members)
                        {
                            if (IsDefinedBySources(model, member))
                            {
                                Drop(member, DefinedBySources);
                            }
                        }
                    }
                }

                // And dotnet/runtime's members CoreLib's own sources define.
                foreach (var tree in implementationTrees)
                {
                    var model = compilation.GetSemanticModel(tree);
                    foreach (var type in tree.GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>())
                    {
                        foreach (var member in type.Members)
                        {
                            if (IsDefinedIn(model, member, sourceTrees))
                            {
                                Drop(member, DefinedBySources);
                            }
                        }
                    }
                }

                var errors = drops.Count != 0
                    ? []
                    : compilation.GetDiagnostics()
                        .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                        .ToList();
                var sourceErrors = errors
                    .Where(diagnostic => !referenceTrees.Contains(diagnostic.Location.SourceTree)
                                         && !implementationTrees.Contains(diagnostic.Location.SourceTree!))
                    .ToList();
                foreach (var diagnostic in errors.Except(sourceErrors))
                {
                    var tree = diagnostic.Location.SourceTree!;
                    var node = tree.GetRoot().FindNode(diagnostic.Location.SourceSpan, getInnermostNodeForTie: true);
                    if (Droppable(node) is { } target)
                    {
                        if (implementationTrees.Contains(tree) && target is MemberDeclarationSyntax { Modifiers: var modifiers }
                            && modifiers.Any(SyntaxKind.OverrideKeyword))
                        {
                            // Dropped, the base's member would run in its place:
                            // CoreLib's sources must define it instead.
                            throw new SurfaceError($"{Describe(target)} of dotnet/runtime's sources overrides, and does not compile: {diagnostic}");
                        }

                        Drop(target, diagnostic.GetMessage());
                    }
                    else
                    {
                        throw new SurfaceError($"cannot drop what fails in {diagnostic}");
                    }
                }

                if (failedDefaults.Count != failures)
                {
                    // Made again without them: what failed only because
                    // they were dropped is taken again.
                    break;
                }

                if (drops.Count == 0)
                {
                    if (sourceErrors.Count != 0)
                    {
                        throw new SurfaceError("CoreLib's sources do not compile against the surface:" + Environment.NewLine
                            + string.Join(Environment.NewLine, sourceErrors.Take(64).Select(diagnostic => diagnostic.ToString())));
                    }

                    FindGaps(Compile(originalTrees, []), compilation);
                    break;
                }

                referenceTrees = referenceTrees
                    .Select(tree => drops.TryGetValue(tree, out var nodes)
                        ? (CSharpSyntaxTree)tree.WithRootAndOptions(tree.GetRoot().RemoveNodes(nodes, SyntaxRemoveOptions.KeepDirectives)!, referenceOptions)
                        : tree)
                    .ToList();
                implementationTrees = implementationTrees
                    .Select(tree => drops.TryGetValue(tree, out var nodes)
                        ? tree.WithRootAndOptions(tree.GetRoot().RemoveNodes(nodes, SyntaxRemoveOptions.KeepDirectives)!, tree.Options)
                        : tree)
                    .ToList();
            }

            if (failedDefaults.Count == failures)
            {
                foreach (string failed in failedDefaults.Order(StringComparer.Ordinal))
                {
                    implementationRemoved.Add($"{failed.Replace('\n', ':').Split('{')[0].Trim()}: a default member that does not compile (the surface's declaration stays)");
                }

                break;
            }
        }

        var files = new List<(string Name, string Text)>();
        foreach (var tree in referenceTrees)
        {
            var root = new BaseListCleaner().Visit(tree.GetRoot())!.NormalizeWhitespace(eol: "\n");
            var text = new StringBuilder();
            text.Append("// <auto-generated>\n");
            text.Append("// The gameplay CoreLib's framework surface, written by coresurface from\n");
            text.Append($"// {Path.GetFileName(tree.FilePath)}, a .NET reference source (Licensed to the .NET Foundation\n");
            text.Append("// under one or more agreements; the .NET Foundation licenses it under the MIT\n");
            text.Append("// license).\n");
            text.Append("// </auto-generated>\n");
            text.Append("#pragma warning disable\n");
            text.Append(root.ToFullString());
            text.Append('\n');
            files.Add(("Surface." + Path.GetFileNameWithoutExtension(tree.FilePath) + ".g.cs", text.ToString()));
        }

        return files;
    }

    // A member a type's declaration in one of the given trees also has.
    private static bool IsDefinedIn(SemanticModel model, MemberDeclarationSyntax member, List<SyntaxTree> trees)
    {
        if (member is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)
        {
            return false;
        }

        var symbol = member switch
        {
            BaseFieldDeclarationSyntax field => field.Declaration.Variables.Select(variable => model.GetDeclaredSymbol(variable)).FirstOrDefault(),
            _ => model.GetDeclaredSymbol(member),
        };
        if (symbol?.ContainingType is not { } type)
        {
            return false;
        }

        return type.GetMembers(symbol.Name).Any(other =>
            !SymbolEqualityComparer.Default.Equals(other, symbol)
            && other.DeclaringSyntaxReferences.Any(reference => trees.Contains(reference.SyntaxTree))
            && Same(other, symbol));
    }

    private static bool Same(ISymbol a, ISymbol b) => (a, b) switch
    {
        (IMethodSymbol x, IMethodSymbol y) => x.Arity == y.Arity && x.MethodKind == y.MethodKind
            && x.Parameters.Length == y.Parameters.Length
            && x.Parameters.Zip(y.Parameters).All(pair => pair.First.RefKind == pair.Second.RefKind && SameType(pair.First.Type, pair.Second.Type))
            && SameConversion(x, y),
        (IPropertySymbol x, IPropertySymbol y) => x.Parameters.Length == y.Parameters.Length
            && x.Parameters.Zip(y.Parameters).All(pair => SameType(pair.First.Type, pair.Second.Type)),
        // A field CoreLib's sources make a property of the same name (a
        // matrix's Impl rows, corelib/Numerics.cs), or the other way round.
        (IPropertySymbol { Parameters.Length: 0 }, IFieldSymbol) or (IFieldSymbol, IPropertySymbol { Parameters.Length: 0 }) => true,
        _ => a.Kind == b.Kind,
    };

    // The resource strings of the .resx files (System.Private.CoreLib's,
    // and an assembly's whose sources the CoreLib takes), as the SR class
    // dotnet/runtime's sources name them by. A name two of them give must
    // have one text.
    private static string ResourceStrings(List<string> paths)
    {
        var strings = new Dictionary<string, string>(StringComparer.Ordinal);
        var text = new StringBuilder();
        text.Append("// <auto-generated/>\n#pragma warning disable\nnamespace System\n{\n    internal static partial class SR\n    {\n");
        foreach (string path in paths)
        {
            var document = System.Xml.Linq.XDocument.Load(path);
            foreach (var data in document.Root!.Elements("data"))
            {
                string? name = data.Attribute("name")?.Value;
                string? value = data.Element("value")?.Value;
                if (name is null || value is null || !SyntaxFacts.IsValidIdentifier(name))
                {
                    continue;
                }

                if (strings.TryGetValue(name, out string? earlier))
                {
                    if (earlier != value)
                    {
                        throw new SurfaceError($"{path}: the resource string {name} differs from another .resx's");
                    }

                    continue;
                }

                strings.Add(name, value);
                text.Append($"        internal static string {name} => @\"{value.Replace("\"", "\"\"")}\";\n");
            }
        }

        text.Append("""
        internal static string Format(string format, object? arg0) => string.Format(format, arg0);

        internal static string Format(string format, object? arg0, object? arg1) => string.Format(format, arg0, arg1);

        internal static string Format(string format, object? arg0, object? arg1, object? arg2) => string.Format(format, arg0, arg1, arg2);

        internal static string Format(string format, params object?[] args) => string.Format(format, args);

        internal static string Format(IFormatProvider? provider, string format, object? arg0) => string.Format(provider, format, arg0);

        internal static string Format(IFormatProvider? provider, string format, object? arg0, object? arg1) => string.Format(provider, format, arg0, arg1);
    }
}

""");
        return text.ToString();
    }

    // Every type declaration partial.
    private sealed class Partial : CSharpSyntaxRewriter
    {
        public override SyntaxNode? VisitClassDeclaration(ClassDeclarationSyntax node) => Make(base.VisitClassDeclaration(node));

        public override SyntaxNode? VisitStructDeclaration(StructDeclarationSyntax node) => Make(base.VisitStructDeclaration(node));

        public override SyntaxNode? VisitInterfaceDeclaration(InterfaceDeclarationSyntax node) => Make(base.VisitInterfaceDeclaration(node));

        private static SyntaxNode? Make(SyntaxNode? node) =>
            node is TypeDeclarationSyntax type && !type.Modifiers.Any(SyntaxKind.PartialKeyword)
                ? type.AddModifiers(SyntaxFactory.Token(SyntaxKind.PartialKeyword).WithTrailingTrivia(SyntaxFactory.Space))
                : node;
    }

    // An interface's default members alone (--defaults): a partial
    // declaration without bases, constraints or attributes of the surface's
    // interface, marked as the surface's where CoreLib's sources do not
    // declare it.
    private sealed class DefaultMembers(HashSet<string> marked, HashSet<string> failed) : CSharpSyntaxRewriter
    {
        // A member by its interface and text, which a failure is known by.
        public static string Key(InterfaceDeclarationSyntax @interface, SyntaxNode member) =>
            FullName(@interface) + "\n" + member.WithoutTrivia().ToString();

        public override SyntaxNode? VisitInterfaceDeclaration(InterfaceDeclarationSyntax node)
        {
            var members = node.Members.Where(member => !failed.Contains(Key(node, member)) && member switch
            {
                BaseMethodDeclarationSyntax method => method.Body is not null || method.ExpressionBody is not null,
                BasePropertyDeclarationSyntax property => property is PropertyDeclarationSyntax { ExpressionBody: not null }
                    || property.AccessorList?.Accessors.Any(accessor => accessor.Body is not null || accessor.ExpressionBody is not null) == true,
                _ => false,
            });
            var declaration = node
                .WithMembers(SyntaxFactory.List(members))
                .WithBaseList(null)
                .WithConstraintClauses(default)
                .WithAttributeLists(default)
                .WithModifiers(SyntaxFactory.TokenList(
                    SyntaxFactory.Token(SyntaxKind.PublicKeyword).WithTrailingTrivia(SyntaxFactory.Space),
                    SyntaxFactory.Token(SyntaxKind.PartialKeyword).WithTrailingTrivia(SyntaxFactory.Space)));
            return marked.Contains(FullName(node))
                ? declaration.AddAttributeLists(SyntaxFactory.AttributeList(SyntaxFactory.SingletonSeparatedList(
                    SyntaxFactory.Attribute(SyntaxFactory.ParseName("global::Gameplay.Runtime.SurfaceAttribute")))))
                : declaration;
        }
    }

    // Base lists left empty by what was dropped.
    private sealed class BaseListCleaner : CSharpSyntaxRewriter
    {
        public override SyntaxNode? VisitBaseList(BaseListSyntax node) => node.Types.Count == 0 ? null : base.VisitBaseList(node);
    }

    // The CoreLib assembly: the surface as written, and the sources.
    public void Emit(List<(string Name, string Text)> files, string assemblyPath, string pdbPath)
    {
        var surfaceTrees = files.Select(file =>
            CSharpSyntaxTree.ParseText(file.Text, referenceOptions, file.Name, Encoding.UTF8));
        var compilation = CSharpCompilation.Create(
            "Gameplay.CoreLib",
            [.. surfaceTrees, .. sourceTrees, .. implementationTrees],
            [],
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Release,
                checkOverflow: false,
                allowUnsafe: true,
                deterministic: true,
                concurrentBuild: true,
                nullableContextOptions: NullableContextOptions.Annotations));
        using var assembly = File.Create(assemblyPath);
        using var pdb = File.Create(pdbPath);
        var result = compilation.Emit(
            assembly,
            pdb,
            options: new Microsoft.CodeAnalysis.Emit.EmitOptions(
                debugInformationFormat: Microsoft.CodeAnalysis.Emit.DebugInformationFormat.PortablePdb));
        if (!result.Success)
        {
            throw new SurfaceError("the CoreLib does not compile:" + Environment.NewLine + string.Join(
                Environment.NewLine,
                result.Diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                    .Take(64)
                    .Select(diagnostic => diagnostic.ToString())));
        }
    }

    public string Report()
    {
        var text = new StringBuilder();
        text.AppendLine($"# {kept.Count} types kept");
        foreach (string type in kept.Order(StringComparer.Ordinal))
        {
            text.AppendLine("kept " + type);
        }

        text.AppendLine($"# {removed.Count} declarations dropped");
        foreach (string line in removed)
        {
            text.AppendLine("dropped " + line);
        }

        text.AppendLine($"# {implementationRemoved.Count} declarations of dotnet/runtime's sources dropped");
        foreach (string line in implementationRemoved)
        {
            text.AppendLine("unused " + line);
        }

        text.AppendLine($"# {gaps.Count} members of .NET's types that CoreLib's own lack");
        foreach (string line in gaps)
        {
            text.AppendLine("missing " + line);
        }

        return text.ToString();
    }

    // The members .NET declares that CoreLib's own types (those its sources
    // define in place of .NET's) have no member of the signature of: what
    // code compiled against .NET cannot call here.
    private readonly List<string> gaps = [];

    private void FindGaps(CSharpCompilation framework, CSharpCompilation corelib)
    {
        foreach (string name in declared.Keys.Order(StringComparer.Ordinal))
        {
            if (framework.GetTypeByMetadataName(name) is not { } theirs || corelib.GetTypeByMetadataName(name) is not { } ours)
            {
                continue;
            }

            var own = ours.GetMembers().Where(Visible).Select(Signature).ToHashSet(StringComparer.Ordinal);
            foreach (var member in theirs.GetMembers().Where(Visible))
            {
                if (!own.Contains(Signature(member)))
                {
                    gaps.Add($"{name}: {member.ToDisplayString()}");
                }
            }
        }
    }

    private static bool Visible(ISymbol member) =>
        member.DeclaredAccessibility is Accessibility.Public or Accessibility.Protected or Accessibility.ProtectedOrInternal
        && !member.IsImplicitlyDeclared
        && member is not IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.Destructor };

    private static string Signature(ISymbol member) => member switch
    {
        IMethodSymbol method => $"{method.MethodKind} {method.Name}`{method.Arity}({string.Join(",", method.Parameters.Select(parameter => parameter.RefKind + " " + TypeText(parameter.Type)))})",
        IPropertySymbol property => $"property {property.Name}({string.Join(",", property.Parameters.Select(parameter => TypeText(parameter.Type)))})",
        INamedTypeSymbol type => "type " + type.MetadataName,
        _ => member.Kind + " " + member.Name,
    };

    private static string TypeText(ITypeSymbol type) => type switch
    {
        ITypeParameterSymbol parameter => (parameter.TypeParameterKind == TypeParameterKind.Method ? "!!" : "!") + parameter.Ordinal,
        IArrayTypeSymbol array => TypeText(array.ElementType) + "[" + new string(',', array.Rank - 1) + "]",
        IPointerTypeSymbol pointer => TypeText(pointer.PointedAtType) + "*",
        INamedTypeSymbol { IsTupleType: true, TupleUnderlyingType: { } underlying } => TypeText(underlying),
        INamedTypeSymbol named =>
            (named.ContainingType is { } outer ? TypeText(outer) + "+"
                : named.ContainingNamespace is { IsGlobalNamespace: false } space ? space.ToDisplayString() + "." : "")
            + named.MetadataName
            + (named.TypeArguments.Length > 0 ? "<" + string.Join(",", named.TypeArguments.Select(TypeText)) + ">" : ""),
        _ => type.ToDisplayString(),
    };

    private static CSharpCompilation Compile(IEnumerable<SyntaxTree> referenceTrees, IEnumerable<SyntaxTree> sourceTrees) =>
        CSharpCompilation.Create(
            "Gameplay.CoreLib",
            [.. referenceTrees, .. sourceTrees],
            [],
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Annotations,
                // Pointer members stay: what csc lowers stackalloc to
                // takes one.
                allowUnsafe: true,
                concurrentBuild: true));

    // A member CoreLib's own partial declaration of its type also has: the
    // same kind, name, arity and parameter types.
    private static bool IsDefinedBySources(SemanticModel model, MemberDeclarationSyntax member)
    {
        if (member is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax or NamespaceDeclarationSyntax
            or BaseNamespaceDeclarationSyntax)
        {
            return false;
        }

        var symbols = member switch
        {
            BaseFieldDeclarationSyntax field => field.Declaration.Variables.Select(variable => model.GetDeclaredSymbol(variable)),
            _ => [model.GetDeclaredSymbol(member)],
        };
        foreach (var symbol in symbols)
        {
            if (symbol?.ContainingType is not { } type
                || type.DeclaringSyntaxReferences.All(reference => reference.SyntaxTree == member.SyntaxTree))
            {
                continue;
            }

            foreach (var other in type.GetMembers(symbol.Name))
            {
                if (SymbolEqualityComparer.Default.Equals(other, symbol)
                    || other.DeclaringSyntaxReferences.All(reference => reference.SyntaxTree == member.SyntaxTree)
                    || other.Kind != symbol.Kind)
                {
                    continue;
                }

                if (other is IMethodSymbol a && symbol is IMethodSymbol b)
                {
                    if (a.Arity == b.Arity && a.MethodKind == b.MethodKind && a.Parameters.Length == b.Parameters.Length
                        && a.Parameters.Zip(b.Parameters).All(pair =>
                            pair.First.RefKind == pair.Second.RefKind && SameType(pair.First.Type, pair.Second.Type))
                        && SameConversion(a, b))
                    {
                        return true;
                    }
                }
                else if (other is IPropertySymbol p && symbol is IPropertySymbol q)
                {
                    if (p.Parameters.Length == q.Parameters.Length
                        && p.Parameters.Zip(q.Parameters).All(pair => SameType(pair.First.Type, pair.Second.Type)))
                    {
                        return true;
                    }
                }
                else
                {
                    return true;
                }
            }
        }

        return false;
    }

    // Conversion operators of one parameter type differ by their result
    // (and a checked one from an unchecked one by its name).
    private static bool SameConversion(IMethodSymbol a, IMethodSymbol b) =>
        a.MethodKind != MethodKind.Conversion || (a.Name == b.Name && SameType(a.ReturnType, b.ReturnType));

    // Alike, method type parameters by position.
    private static bool SameType(ITypeSymbol a, ITypeSymbol b) => (a, b) switch
    {
        (ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Method } x,
            ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Method } y) => x.Ordinal == y.Ordinal,
        (IArrayTypeSymbol x, IArrayTypeSymbol y) => x.Rank == y.Rank && SameType(x.ElementType, y.ElementType),
        (INamedTypeSymbol { IsGenericType: true } x, INamedTypeSymbol { IsGenericType: true } y) =>
            SymbolEqualityComparer.Default.Equals(x.OriginalDefinition, y.OriginalDefinition)
            && x.TypeArguments.Zip(y.TypeArguments).All(pair => SameType(pair.First, pair.Second)),
        _ => SymbolEqualityComparer.Default.Equals(a, b),
    };

    // What to drop for an error at a node: the base type, the attribute,
    // the constraint's member, or the member it is in.
    private static SyntaxNode? Droppable(SyntaxNode node)
    {
        for (var current = node; current is not null; current = current.Parent)
        {
            switch (current)
            {
                case AttributeSyntax attribute:
                    var list = (AttributeListSyntax)attribute.Parent!;
                    return list.Attributes.Count == 1 ? list : attribute;
                case BaseTypeSyntax baseType:
                    // A class's base class cannot go; its interfaces can.
                    var declaration = baseType.Parent!.Parent as TypeDeclarationSyntax;
                    if (declaration is ClassDeclarationSyntax && baseType == ((BaseListSyntax)baseType.Parent).Types[0]
                        && baseType.Type.ToString().Split('.')[^1] is var name
                        && !(name.Length > 1 && name[0] == 'I' && char.IsUpper(name[1])))
                    {
                        return null;
                    }

                    return baseType;
                case TypeParameterConstraintClauseSyntax when current.Parent is TypeDeclarationSyntax:
                    return current.Parent;
                case UsingDirectiveSyntax:
                    // A namespace the CoreLib does not have.
                    return current;
                case EnumMemberDeclarationSyntax:
                    return current;
                case MemberDeclarationSyntax member when member is not BaseNamespaceDeclarationSyntax:
                    return member;
            }
        }

        return null;
    }

    private static string Describe(SyntaxNode node) => node switch
    {
        BaseTypeDeclarationSyntax type => FullName(type),
        DelegateDeclarationSyntax type => FullName(type),
        MemberDeclarationSyntax member when member.Parent is MemberDeclarationSyntax container and (BaseTypeDeclarationSyntax or DelegateDeclarationSyntax) =>
            FullName(container) + ": " + OneLine(member),
        _ => (node.FirstAncestorOrSelf<BaseTypeDeclarationSyntax>() is { } type ? FullName(type) + ": " : "") + OneLine(node),
    };

    private static string OneLine(SyntaxNode node)
    {
        string text = string.Join(' ', node.WithoutTrivia().ToString().Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Select(line => line.Trim()));
        return text.Length > 160 ? text[..160] + "..." : text;
    }

    // The metadata name of a type declaration: namespace, containing types
    // (+), and `arity.
    public static string FullName(MemberDeclarationSyntax declaration)
    {
        string Own(MemberDeclarationSyntax type) => type switch
        {
            TypeDeclarationSyntax { TypeParameterList: { } parameters } named => named.Identifier.ValueText + "`" + parameters.Parameters.Count,
            BaseTypeDeclarationSyntax named => named.Identifier.ValueText,
            DelegateDeclarationSyntax { TypeParameterList: { } parameters } named => named.Identifier.ValueText + "`" + parameters.Parameters.Count,
            DelegateDeclarationSyntax named => named.Identifier.ValueText,
            _ => throw new InvalidOperationException(),
        };

        string name = Own(declaration);
        var parent = declaration.Parent;
        while (parent is BaseTypeDeclarationSyntax outer)
        {
            name = Own(outer) + "+" + name;
            parent = outer.Parent;
        }

        string space = Namespace(declaration);
        return space.Length == 0 ? name : space + "." + name;
    }

    public static string Namespace(SyntaxNode node)
    {
        var parts = new List<string>();
        for (var current = node.Parent; current is not null; current = current.Parent)
        {
            if (current is BaseNamespaceDeclarationSyntax space)
            {
                parts.Insert(0, space.Name.ToString());
            }
        }

        return string.Join('.', parts);
    }

    private static IEnumerable<(string Name, BaseTypeDeclarationSyntax Declaration)> TypeDeclarations(SyntaxNode root) =>
        root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>().Select(declaration => (FullName(declaration), declaration));

    // The first pass: the kept types, and their members as extern
    // declarations.
    private sealed class Selector(Generator generator) : CSharpSyntaxRewriter
    {
        public override SyntaxNode? VisitClassDeclaration(ClassDeclarationSyntax node) => KeepType(node, base.VisitClassDeclaration);

        public override SyntaxNode? VisitStructDeclaration(StructDeclarationSyntax node) => KeepType(node, base.VisitStructDeclaration);

        public override SyntaxNode? VisitInterfaceDeclaration(InterfaceDeclarationSyntax node) => KeepType(node, base.VisitInterfaceDeclaration);

        public override SyntaxNode? VisitEnumDeclaration(EnumDeclarationSyntax node) => KeepType(node, base.VisitEnumDeclaration);

        public override SyntaxNode? VisitRecordDeclaration(RecordDeclarationSyntax node) => KeepType(node, base.VisitRecordDeclaration);

        public override SyntaxNode? VisitDelegateDeclaration(DelegateDeclarationSyntax node)
        {
            string name = FullName(node);
            if (!Kept(node, name))
            {
                return null;
            }

            generator.kept.Add(name);
            return generator.declared.ContainsKey(name) ? node : Marked(node);
        }

        // The importer tells the surface's types by this.
        private static T Marked<T>(T node)
            where T : MemberDeclarationSyntax =>
            (T)node.AddAttributeLists(SyntaxFactory.AttributeList(SyntaxFactory.SingletonSeparatedList(
                SyntaxFactory.Attribute(SyntaxFactory.ParseName("global::Gameplay.Runtime.SurfaceAttribute")))));

        private bool Kept(MemberDeclarationSyntax node, string name)
        {
            if (generator.declared.TryGetValue(name, out bool partial) && !partial)
            {
                return false;
            }

            if (node.Parent is BaseTypeDeclarationSyntax)
            {
                return !generator.allowlist.Excludes(name);
            }

            return generator.allowlist.Keeps(Namespace(node), name) || generator.declared.ContainsKey(name);
        }

        private SyntaxNode? KeepType<T>(T node, Func<T, SyntaxNode?> visit)
            where T : BaseTypeDeclarationSyntax
        {
            string name = FullName(node);
            if (!Kept(node, name))
            {
                return null;
            }

            generator.kept.Add(name);
            var visited = (BaseTypeDeclarationSyntax)visit(node)!;
            if (!visited.Modifiers.Any(SyntaxKind.PartialKeyword) && visited is TypeDeclarationSyntax)
            {
                // Every kept type is partial, so CoreLib's sources can
                // merge into it.
                visited = visited.AddModifiers(SyntaxFactory.Token(SyntaxKind.PartialKeyword).WithTrailingTrivia(SyntaxFactory.Space));
            }

            // A type CoreLib's sources merge into is theirs unless they mark
            // it themselves (a primitive's generic math is CoreLib's while
            // the type stays .NET's); nested types the sources declare, or
            // csc makes of their members, are never marked.
            return generator.declared.ContainsKey(name) ? visited : Marked(visited);
        }

        public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node) =>
            node.Body is null && node.ExpressionBody is null
                ? node
                : Extern(node.WithBody(null).WithExpressionBody(null).WithSemicolonToken(SemicolonAfter(node.Body)));

        public override SyntaxNode? VisitOperatorDeclaration(OperatorDeclarationSyntax node) =>
            node.Body is null && node.ExpressionBody is null
                ? node
                : Extern(node.WithBody(null).WithExpressionBody(null).WithSemicolonToken(SemicolonAfter(node.Body)));

        public override SyntaxNode? VisitConversionOperatorDeclaration(ConversionOperatorDeclarationSyntax node) =>
            node.Body is null && node.ExpressionBody is null
                ? node
                : Extern(node.WithBody(null).WithExpressionBody(null).WithSemicolonToken(SemicolonAfter(node.Body)));

        public override SyntaxNode? VisitConstructorDeclaration(ConstructorDeclarationSyntax node) =>
            Extern(node.WithInitializer(null).WithBody(null).WithExpressionBody(null).WithSemicolonToken(SemicolonAfter(node.Body)));

        public override SyntaxNode? VisitDestructorDeclaration(DestructorDeclarationSyntax node) =>
            Extern(node.WithBody(null).WithExpressionBody(null).WithSemicolonToken(SemicolonAfter(node.Body)));

        public override SyntaxNode? VisitPropertyDeclaration(PropertyDeclarationSyntax node) =>
            node.AccessorList is { } accessors && HasBodies(accessors)
                ? Extern(node.WithAccessorList(BodilessAccessors(accessors)))
                : node;

        public override SyntaxNode? VisitIndexerDeclaration(IndexerDeclarationSyntax node) =>
            node.AccessorList is { } accessors && HasBodies(accessors)
                ? Extern(node.WithAccessorList(BodilessAccessors(accessors)))
                : node;

        public override SyntaxNode? VisitEventDeclaration(EventDeclarationSyntax node) =>
            node.AccessorList is { } accessors && HasBodies(accessors)
                ? Extern(node.WithAccessorList(BodilessAccessors(accessors)))
                : node;

        private static bool HasBodies(AccessorListSyntax accessors) =>
            accessors.Accessors.Any(accessor => accessor.Body is not null || accessor.ExpressionBody is not null);

        // A body's semicolon, keeping the directives before the body.
        private static SyntaxToken SemicolonAfter(SyntaxNode? body) =>
            SyntaxFactory.Token(SyntaxKind.SemicolonToken)
                .WithLeadingTrivia(body?.GetLeadingTrivia().Where(trivia => trivia.IsDirective) ?? []);

        private static AccessorListSyntax BodilessAccessors(AccessorListSyntax accessors) =>
            accessors.WithAccessors(SyntaxFactory.List(accessors.Accessors.Select(accessor =>
                accessor.WithBody(null).WithExpressionBody(null).WithSemicolonToken(SemicolonAfter(accessor.Body)))));

        // Abstract members and interfaces' abstract members stay as they
        // are; anything with a body in the reference becomes extern.
        private static T Extern<T>(T node)
            where T : MemberDeclarationSyntax
        {
            if (node.Modifiers.Any(SyntaxKind.AbstractKeyword) || node.Modifiers.Any(SyntaxKind.ExternKeyword))
            {
                return node;
            }

            return (T)node.AddModifiers(SyntaxFactory.Token(SyntaxKind.ExternKeyword).WithTrailingTrivia(SyntaxFactory.Space));
        }
    }
}
