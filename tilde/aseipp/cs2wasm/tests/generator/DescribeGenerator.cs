// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A small incremental source generator for tests/generator: it declares
// [Describe] itself (post-initialization output), and gives each partial
// type marked with it a `Describe()` listing its instance fields and a
// `FieldCount` constant. It reports PROBE001 (an error) on a type that is
// not partial, PROBE002 (a warning) on one with no fields, and throws for
// `[Describe(Explode = true)]`, so the tests see all three surface. It
// also writes `Probe.Build`, what the build told it through its global
// analyzer options (gameplayc's build_property.GameplayOutputKind and
// GameplayAssemblyName), which tests/generator/Kinds.cs and Built.cs read
// in a library and a module.
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Probe.Generators;

[Generator]
public sealed class DescribeGenerator : IIncrementalGenerator
{
    private const string AttributeName = "Probe.DescribeAttribute";

    private static readonly DiagnosticDescriptor NotPartial = new(
        "PROBE001",
        "Described types must be partial",
        "'{0}' is marked [Describe] but is not partial",
        "Probe",
        DiagnosticSeverity.Error,
        isEnabledByDefault: true);

    private static readonly DiagnosticDescriptor NoFields = new(
        "PROBE002",
        "Described type has no fields",
        "'{0}' is marked [Describe] but declares no instance fields",
        "Probe",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(output => output.AddSource("DescribeAttribute.g.cs", """
            namespace Probe
            {
                [global::System.AttributeUsage(global::System.AttributeTargets.Class | global::System.AttributeTargets.Struct)]
                internal sealed class DescribeAttribute : global::System.Attribute
                {
                    public bool Explode { get; set; }
                }
            }
            """));

        var build = context.AnalyzerConfigOptionsProvider.Select(static (options, _) => (
            Kind: options.GlobalOptions.TryGetValue("build_property.GameplayOutputKind", out var kind) ? kind : "",
            Name: options.GlobalOptions.TryGetValue("build_property.GameplayAssemblyName", out var name) ? name : ""));
        context.RegisterSourceOutput(build, static (output, build) => output.AddSource("Build.g.cs", $$"""
            namespace Probe
            {
                internal static class Build
                {
                    public const string OutputKind = "{{build.Kind}}";
                    public const string AssemblyName = "{{build.Name}}";
                }
            }
            """));

        var described = context.SyntaxProvider.ForAttributeWithMetadataName(
            AttributeName,
            static (node, _) => node is TypeDeclarationSyntax,
            static (attributed, _) => Model.Of((INamedTypeSymbol)attributed.TargetSymbol, (TypeDeclarationSyntax)attributed.TargetNode, attributed.Attributes[0]));

        context.RegisterSourceOutput(described, static (output, model) =>
        {
            if (model.Explode)
            {
                throw new System.InvalidOperationException($"asked to explode on {model.Name}");
            }

            if (!model.Partial)
            {
                output.ReportDiagnostic(Diagnostic.Create(NotPartial, model.Location, model.Name));
                return;
            }

            if (model.Fields.IsEmpty)
            {
                output.ReportDiagnostic(Diagnostic.Create(NoFields, model.Location, model.Name));
            }

            var text = new StringBuilder();
            if (model.Namespace.Length != 0)
            {
                text.Append("namespace ").Append(model.Namespace).AppendLine(";");
            }

            text.Append("partial ").Append(model.Kind).Append(' ').AppendLine(model.Name)
                .AppendLine("{")
                .Append("    public const int FieldCount = ").Append(model.Fields.Length).AppendLine(";")
                .Append("    public static string Describe() => \"")
                .Append(model.Name).Append('(')
                .Append(string.Join(", ", model.Fields.Items))
                .AppendLine(")\";")
                .AppendLine("}");
            output.AddSource(model.Name + ".Describe.g.cs", text.ToString());
        });
    }

    // What the output depends on, as values, so the pipeline caches it.
    private sealed record Model(
        string Namespace, string Name, string Kind, bool Partial, bool Explode,
        EquatableArray Fields, Location Location)
    {
        public static Model Of(INamedTypeSymbol type, TypeDeclarationSyntax syntax, AttributeData attribute) => new(
            type.ContainingNamespace.IsGlobalNamespace ? "" : type.ContainingNamespace.ToDisplayString(),
            type.Name,
            type.TypeKind == TypeKind.Struct ? "struct" : "class",
            syntax.Modifiers.Any(modifier => modifier.ValueText == "partial"),
            attribute.NamedArguments.Any(argument => argument.Key == "Explode" && argument.Value.Value is true),
            new EquatableArray(type.GetMembers().OfType<IFieldSymbol>()
                .Where(field => !field.IsStatic && !field.IsImplicitlyDeclared)
                .Select(field => field.Name + ":" + field.Type.ToDisplayString())
                .ToImmutableArray()),
            syntax.Identifier.GetLocation());
    }

    private sealed record EquatableArray(ImmutableArray<string> Items)
    {
        public bool IsEmpty => Items.IsEmpty;

        public int Length => Items.Length;

        public bool Equals(EquatableArray? other) => other is not null && Items.SequenceEqual(other.Items);

        public override int GetHashCode() => Items.Aggregate(17, (hash, item) => hash * 31 + item.GetHashCode());

        public override string ToString() => string.Join(", ", Items);
    }
}
