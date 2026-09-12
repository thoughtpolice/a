// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln.Generator;

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

/// <summary>
/// Kiln's world generator. It reads the [Component], [Resource], [Event],
/// [Bundle] and [System] declarations of a program's sources and of the
/// Kiln libraries it references (read from their metadata) and writes the
/// program's
/// schedule, Kiln.Generated.GameSchedule: its components' ids, each
/// world's storage, channels, resources and readers, each system's query
/// loop, and the phases' order, decided at compile time (Schedule). Where
/// a declaration is compiled, program or library, it writes what the
/// declaration needs: a component's IComponent and an event's IEvent, a
/// resource's world property, a bundle's Spawn and Add. Everything is
/// plain, typed C#: nothing is looked up by reflection at run time.
/// </summary>
/// <remarks>
/// Whether it compiles a program or a Kiln library the build says, in the
/// global analyzer option build_property.GameplayOutputKind (`module` or
/// `library`), which gameplayc gives every generator. Without it (csc, as
/// the CLR builds of the tests run it), a DLL is a library and an
/// executable a program. A library's output marks the assembly
/// [assembly: Kiln.Generated.KilnLibrary], which is how a program's
/// generator knows its Kiln libraries.
/// </remarks>
[Generator]
public sealed class WorldGenerator : IIncrementalGenerator
{
    private const string Kiln = "Kiln.";

    // The build's word on what is compiled, `library` or `module`.
    private const string OutputKindOption = "build_property.GameplayOutputKind";

    // What marks a Kiln library, which the generator writes into one.
    private const string Marker = "Kiln.Generated.KilnLibraryAttribute";

    private static readonly SymbolDisplayFormat Qualified = SymbolDisplayFormat.FullyQualifiedFormat;

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var components = context.SyntaxProvider.ForAttributeWithMetadataName(
            Kiln + "ComponentAttribute",
            static (node, _) => node is TypeDeclarationSyntax,
            static (attributed, _) => ReadComponent(
                (INamedTypeSymbol)attributed.TargetSymbol,
                attributed.TargetNode is TypeDeclarationSyntax declaration ? declaration.Identifier.GetLocation() : Location.None,
                OwnOrigin(attributed.TargetSymbol))).Collect();

        var resources = context.SyntaxProvider.ForAttributeWithMetadataName(
            Kiln + "ResourceAttribute",
            static (node, _) => node is TypeDeclarationSyntax,
            static (attributed, _) => ReadResource(
                (INamedTypeSymbol)attributed.TargetSymbol,
                ((TypeDeclarationSyntax)attributed.TargetNode).Identifier.GetLocation(),
                OwnOrigin(attributed.TargetSymbol))).Collect();

        var events = context.SyntaxProvider.ForAttributeWithMetadataName(
            Kiln + "EventAttribute",
            static (node, _) => node is TypeDeclarationSyntax,
            static (attributed, _) => ReadEvent(
                (INamedTypeSymbol)attributed.TargetSymbol,
                ((TypeDeclarationSyntax)attributed.TargetNode).Identifier.GetLocation(),
                OwnOrigin(attributed.TargetSymbol))).Collect();

        var bundles = context.SyntaxProvider.ForAttributeWithMetadataName(
            Kiln + "BundleAttribute",
            static (node, _) => node is TypeDeclarationSyntax,
            static (attributed, _) => ReadBundle(
                (INamedTypeSymbol)attributed.TargetSymbol,
                ((TypeDeclarationSyntax)attributed.TargetNode).Identifier.GetLocation(),
                OwnOrigin(attributed.TargetSymbol))).Collect();

        var systems = context.SyntaxProvider.ForAttributeWithMetadataName(
            Kiln + "SystemAttribute",
            static (node, _) => node is MethodDeclarationSyntax,
            static (attributed, _) =>
            {
                var method = (IMethodSymbol)attributed.TargetSymbol;
                return ReadSystem(method, attributed.Attributes[0], ((MethodDeclarationSyntax)attributed.TargetNode).Identifier.GetLocation(), OwnSystemOrigin(method));
            }).Collect();

        var kind = context.AnalyzerConfigOptionsProvider.Select(static (options, _) =>
            options.GlobalOptions.TryGetValue(OutputKindOption, out var value) ? value : null);
        var target = context.CompilationProvider.Combine(kind).Select(static (input, _) =>
        {
            var (compilation, kind) = input;
            bool library = kind switch
            {
                "library" => true,
                "module" => false,
                _ => compilation.Options.OutputKind is OutputKind.DynamicallyLinkedLibrary or OutputKind.NetModule,
            };
            return new Target(library, compilation.AssemblyName ?? "", library && compilation.GetTypeByMetadataName(Marker) is not null);
        });

        var libraries = context.CompilationProvider.Select(static (compilation, _) => ReadLibraries(compilation));

        var all = components.Combine(resources).Combine(events).Combine(bundles).Combine(systems).Combine(target).Combine(libraries);
        context.RegisterSourceOutput(all, static (output, input) =>
        {
            var ((((((components, resources), events), bundles), systems), target), libraries) = input;
            Emitter.Emit(output, target, components, resources, events, bundles, systems, libraries);
        });
    }

    // MARK: Declarations

    private static ComponentModel ReadComponent(INamedTypeSymbol type, Location location, Origin origin)
    {
        bool tag = !type.GetMembers().OfType<IFieldSymbol>().Any(field => !field.IsStatic);
        return new ComponentModel(type.ToDisplayString(Qualified), type.Name, TypeShell.Of(type), type.TypeKind == TypeKind.Struct, tag, location, origin);
    }

    private static ResourceModel ReadResource(INamedTypeSymbol type, Location location, Origin origin) =>
        new(
            type.ToDisplayString(Qualified),
            type.Name,
            type.TypeKind == TypeKind.Class && !type.IsGenericType,
            !type.IsAbstract && type.InstanceConstructors.Any(constructor =>
                constructor.Parameters.IsEmpty && constructor.DeclaredAccessibility is Accessibility.Public or Accessibility.Internal),
            location,
            origin);

    private static EventModel ReadEvent(INamedTypeSymbol type, Location location, Origin origin) =>
        new(type.ToDisplayString(Qualified), type.Name, TypeShell.Of(type), type.TypeKind == TypeKind.Struct && !type.IsGenericType, location, origin);

    private static BundleModel ReadBundle(INamedTypeSymbol type, Location location, Origin origin)
    {
        var members = type.GetMembers()
            .OfType<IPropertySymbol>()
            .Where(property => !property.IsStatic && property.GetMethod is not null && property.Name != "EqualityContract")
            .Select(property => (property.Name, property.Type.ToDisplayString(Qualified)));
        return new BundleModel(
            type.ToDisplayString(Qualified),
            type.Name,
            type.TypeKind == TypeKind.Struct && !type.IsGenericType,
            new Values<(string, string)>(members),
            location,
            origin);
    }

    private static SystemModel ReadSystem(IMethodSymbol method, AttributeData attribute, Location location, Origin origin)
    {
        int phase = attribute.ConstructorArguments.Length > 0 && attribute.ConstructorArguments[0].Value is int value ? value : 2;
        int order = attribute.NamedArguments.FirstOrDefault(argument => argument.Key == "Order").Value.Value is int given ? given : 0;
        var with = ImmutableArray.CreateBuilder<string>();
        var without = ImmutableArray.CreateBuilder<string>();
        var after = ImmutableArray.CreateBuilder<string>();
        var before = ImmutableArray.CreateBuilder<string>();
        string? runIf = null;
        foreach (var other in method.GetAttributes())
        {
            var type = other.AttributeClass;
            if (type is null || type.ContainingNamespace?.ToDisplayString() != "Kiln")
            {
                continue;
            }

            string argument = other.ConstructorArguments.Length > 0 && other.ConstructorArguments[0].Value is string text ? text : "";
            switch (type.Name)
            {
                case "WithAttribute" when type.IsGenericType:
                    with.Add(type.TypeArguments[0].ToDisplayString(Qualified));
                    break;
                case "WithoutAttribute" when type.IsGenericType:
                    without.Add(type.TypeArguments[0].ToDisplayString(Qualified));
                    break;
                case "AfterAttribute":
                    after.Add(argument);
                    break;
                case "BeforeAttribute":
                    before.Add(argument);
                    break;
                case "RunIfAttribute":
                    runIf = argument;
                    break;
            }
        }

        bool runIfValid = true;
        var runIfParameters = ImmutableArray<ParameterModel>.Empty;
        if (runIf is not null)
        {
            var condition = method.ContainingType.GetMembers(runIf).OfType<IMethodSymbol>().ToList();
            if (condition.Count == 1 && condition[0].IsStatic && condition[0].ReturnType.SpecialType == SpecialType.System_Boolean
                && !condition[0].IsGenericMethod)
            {
                runIfParameters = condition[0].Parameters.Select(ReadParameter).ToImmutableArray();
            }
            else
            {
                runIfValid = false;
            }
        }

        return new SystemModel(
            method.ContainingType.ToDisplayString(Qualified),
            method.ContainingType.Name,
            TypeShell.Of(method.ContainingType),
            method.Name,
            method.IsStatic,
            method.ReturnsVoid,
            method.IsGenericMethod,
            phase,
            order,
            new Values<ParameterModel>(method.Parameters.Select(ReadParameter)),
            new Values<string>(with),
            new Values<string>(without),
            new Values<string>(after),
            new Values<string>(before),
            runIf,
            runIfValid,
            new Values<ParameterModel>(runIfParameters),
            location,
            origin);
    }

    private static ParameterModel ReadParameter(IParameterSymbol parameter)
    {
        var passing = parameter.RefKind switch
        {
            RefKind.Ref => Passing.Ref,
            RefKind.In => Passing.In,
            RefKind.Out => Passing.Out,
            RefKind.RefReadOnlyParameter => Passing.RefReadOnly,
            _ => Passing.Value,
        };
        string generic = "";
        string argument = "";
        if (parameter.Type is INamedTypeSymbol { IsGenericType: true } named
            && named.ContainingNamespace?.ToDisplayString() == "Kiln"
            && named.Name is "EventReader" or "EventWriter")
        {
            generic = named.Name;
            argument = named.TypeArguments[0].ToDisplayString(Qualified);
        }

        return new ParameterModel(parameter.Name, parameter.Type.ToDisplayString(Qualified), passing, generic, argument);
    }

    // MARK: Libraries

    private static bool IsKilnLibrary(IAssemblySymbol assembly) =>
        assembly.GetAttributes().Any(attribute => attribute.AttributeClass is { Name: "KilnLibraryAttribute" } marker
                                                  && marker.ContainingNamespace?.ToDisplayString() == "Kiln.Generated");

    // Whether an assembly compiled against Kiln's may declare what Kiln's
    // attributes describe (the generator reads a library's that is not a
    // Kiln library only to say why none of it joins the schedule).
    private static bool UsesKiln(IAssemblySymbol assembly, IAssemblySymbol? kiln) =>
        kiln is not null && assembly.Modules.Any(module =>
            module.ReferencedAssemblySymbols.Any(referenced => referenced.Name == kiln.Name));

    private static bool IsKiln(INamedTypeSymbol? type, string name) =>
        type is not null && type.Name == name && type.ContainingNamespace?.ToDisplayString() == "Kiln";

    // A declaration of the compilation's own sources. What a Kiln library
    // declares must be public (every program referencing it uses it); a
    // program's need not be.
    private static Origin OwnOrigin(ISymbol symbol) => new(null, IsPublic(symbol) ? null : "it is not public");

    private static Origin OwnSystemOrigin(IMethodSymbol method)
    {
        if (!IsPublic(method))
        {
            return new Origin(null, "it is not public");
        }

        return RunIfMethod(method) is { } condition && !IsPublic(condition)
            ? new Origin(null, "its run condition is not public")
            : Origin.Source;
    }

    private static IMethodSymbol? RunIfMethod(IMethodSymbol method)
    {
        var runIf = method.GetAttributes().FirstOrDefault(attribute => IsKiln(attribute.AttributeClass, "RunIfAttribute"));
        return runIf is { ConstructorArguments.Length: > 0 } && runIf.ConstructorArguments[0].Value is string name
            ? method.ContainingType.GetMembers(name).OfType<IMethodSymbol>().FirstOrDefault()
            : null;
    }

    private static bool IsPublic(ISymbol symbol)
    {
        for (var current = symbol; current is not null && current is not INamespaceSymbol; current = current.ContainingSymbol)
        {
            if (current.DeclaredAccessibility != Accessibility.Public)
            {
                return false;
            }
        }

        return true;
    }

    // The declarations of the Kiln libraries the compilation references, in
    // their metadata, each with what keeps it from the program's schedule:
    // being inaccessible, or, for a component or event, missing the
    // interface Kiln's generator writes where it is declared. Those of a
    // library compiled against Kiln but without Kiln's generator (so not
    // marked a Kiln library) are read to be refused.
    private static LibraryModel ReadLibraries(Compilation compilation)
    {
        var kiln = compilation.GetTypeByMetadataName(Kiln + "ComponentAttribute")?.ContainingAssembly;
        var components = new List<ComponentModel>();
        var resources = new List<ResourceModel>();
        var events = new List<EventModel>();
        var bundles = new List<BundleModel>();
        var systems = new List<SystemModel>();
        foreach (var assembly in compilation.SourceModule.ReferencedAssemblySymbols.OrderBy(assembly => assembly.Name, System.StringComparer.Ordinal))
        {
            bool marked = IsKilnLibrary(assembly);
            if (!marked && (SymbolEqualityComparer.Default.Equals(assembly, kiln) || !UsesKiln(assembly, kiln)))
            {
                continue;
            }

            var unmarked = marked ? null : new Origin(assembly.Name, "its library was compiled without Kiln's generator", Kiln: false);

            foreach (var type in Types(assembly.GlobalNamespace))
            {
                foreach (var attribute in type.GetAttributes())
                {
                    string? name = attribute.AttributeClass?.ContainingNamespace?.ToDisplayString() == "Kiln" ? attribute.AttributeClass.Name : null;
                    switch (name)
                    {
                        case "ComponentAttribute":
                            components.Add(ReadComponent(type, Location.None, unmarked ?? LibraryOrigin(compilation, assembly, type, "IComponent")));
                            break;
                        case "ResourceAttribute":
                            resources.Add(ReadResource(type, Location.None, unmarked ?? LibraryOrigin(compilation, assembly, type, null)));
                            break;
                        case "EventAttribute":
                            events.Add(ReadEvent(type, Location.None, unmarked ?? LibraryOrigin(compilation, assembly, type, "IEvent")));
                            break;
                        case "BundleAttribute":
                            bundles.Add(ReadBundle(type, Location.None, unmarked ?? LibraryOrigin(compilation, assembly, type, null)));
                            break;
                    }
                }

                foreach (var method in type.GetMembers().OfType<IMethodSymbol>())
                {
                    var system = method.GetAttributes().FirstOrDefault(attribute => IsKiln(attribute.AttributeClass, "SystemAttribute"));
                    if (system is null)
                    {
                        continue;
                    }

                    string? problem = !compilation.IsSymbolAccessibleWithin(method, compilation.Assembly)
                        ? "it is not public"
                        : RunIfMethod(method) is { } condition && !compilation.IsSymbolAccessibleWithin(condition, compilation.Assembly)
                            ? "its run condition is not public"
                            : null;
                    systems.Add(ReadSystem(method, system, Location.None, unmarked ?? new Origin(assembly.Name, problem)));
                }
            }
        }

        return new LibraryModel(
            new Values<ComponentModel>(components),
            new Values<ResourceModel>(resources),
            new Values<EventModel>(events),
            new Values<BundleModel>(bundles),
            new Values<SystemModel>(systems));
    }

    private static Origin LibraryOrigin(Compilation compilation, IAssemblySymbol assembly, INamedTypeSymbol type, string? contract)
    {
        if (!compilation.IsSymbolAccessibleWithin(type, compilation.Assembly))
        {
            return new Origin(assembly.Name, "it is not public");
        }

        if (contract is not null && !type.AllInterfaces.Any(implemented =>
                IsKiln(implemented, contract) && SymbolEqualityComparer.Default.Equals(implemented.TypeArguments[0], type)))
        {
            return new Origin(assembly.Name, "it is not " + contract + "<" + type.Name + ">: compile the library with Kiln's generator");
        }

        return new Origin(assembly.Name, null);
    }

    private static IEnumerable<INamedTypeSymbol> Types(INamespaceSymbol space)
    {
        foreach (var member in space.GetMembers())
        {
            if (member is INamespaceSymbol inner)
            {
                foreach (var type in Types(inner))
                {
                    yield return type;
                }
            }
            else if (member is INamedTypeSymbol type)
            {
                foreach (var nested in Nested(type))
                {
                    yield return nested;
                }
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> Nested(INamedTypeSymbol type)
    {
        yield return type;
        foreach (var inner in type.GetTypeMembers())
        {
            foreach (var nested in Nested(inner))
            {
                yield return nested;
            }
        }
    }
}
