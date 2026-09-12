// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln.Generator;

using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;

// What the generator reads from each attributed declaration, as values the
// incremental pipeline can compare, so an edit that does not change them
// does not regenerate the world.

// An immutable array compared by its elements.
internal readonly struct Values<T> : IEquatable<Values<T>>, IEnumerable<T>
{
    private readonly ImmutableArray<T> items;

    public Values(IEnumerable<T> items)
    {
        this.items = items.ToImmutableArray();
    }

    public ImmutableArray<T> Items => items.IsDefault ? ImmutableArray<T>.Empty : items;

    public int Count => Items.Length;

    public T this[int index] => Items[index];

    public bool Equals(Values<T> other) => Items.SequenceEqual(other.Items);

    public override bool Equals(object? obj) => obj is Values<T> other && Equals(other);

    public override int GetHashCode()
    {
        int hash = 17;
        foreach (var item in Items)
        {
            hash = hash * 31 + (item?.GetHashCode() ?? 0);
        }

        return hash;
    }

    public IEnumerator<T> GetEnumerator() => ((IEnumerable<T>)Items).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

// The declarations a partial type is nested in and its own, outermost
// first, as `partial class Outer`, `partial record struct Inner`, so
// generated members can be declared inside it; Partial says whether they
// all are.
internal sealed record TypeShell(string Namespace, Values<string> Headers, bool Partial, bool Generic)
{
    public static TypeShell Of(INamedTypeSymbol type)
    {
        var headers = new List<string>();
        bool partial = true;
        bool generic = false;
        for (var current = type; current is not null; current = current.ContainingType)
        {
            generic |= current.IsGenericType;
            bool isPartial = current.DeclaringSyntaxReferences.Any(reference =>
                reference.GetSyntax() is Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax declaration
                && declaration.Modifiers.Any(modifier => modifier.ValueText == "partial"));
            partial &= isPartial;
            string keyword = current.IsRecord
                ? (current.TypeKind == TypeKind.Struct ? "record struct" : "record")
                : current.TypeKind switch
                {
                    TypeKind.Struct => "struct",
                    TypeKind.Interface => "interface",
                    _ => "class",
                };
            headers.Insert(0, "partial " + keyword + " " + current.Name);
        }

        return new TypeShell(
            type.ContainingNamespace.IsGlobalNamespace ? "" : type.ContainingNamespace.ToDisplayString(),
            new Values<string>(headers),
            partial,
            generic);
    }
}

// Where a declaration comes from: the compilation's own sources (Library
// null), or a referenced library, by its assembly name: a Kiln library, or
// (Kiln false) one compiled without Kiln's generator. Problem says why a
// library's declaration cannot join the program's schedule, or why a Kiln
// library's own declaration cannot join any (it is not public).
internal sealed record Origin(string? Library, string? Problem, bool Kiln = true)
{
    public static readonly Origin Source = new(null, null);

    public bool IsLibrary => Library is not null;
}

internal sealed record ComponentModel(string Type, string Name, TypeShell Shell, bool IsStruct, bool IsTag, Location Location, Origin Origin);

internal sealed record ResourceModel(string Type, string Name, bool IsClass, bool Constructible, Location Location, Origin Origin);

internal sealed record EventModel(string Type, string Name, TypeShell Shell, bool IsStruct, Location Location, Origin Origin);

internal sealed record BundleModel(string Type, string Name, bool IsStruct, Values<(string Name, string Type)> Members, Location Location, Origin Origin);

// The declarations of the Kiln libraries a program references, read from
// their metadata.
internal sealed record LibraryModel(
    Values<ComponentModel> Components,
    Values<ResourceModel> Resources,
    Values<EventModel> Events,
    Values<BundleModel> Bundles,
    Values<SystemModel> Systems);

// What the generator writes for: a program (its schedule and its own
// declarations' members) or a Kiln library (its own declarations' members,
// and the mark of a Kiln library when Kiln's attribute for it is there),
// and its assembly's name, which names what it writes.
internal sealed record Target(bool IsLibrary, string Assembly, bool Marks);

internal enum Passing
{
    Value,
    In,
    Ref,
    Out,
    RefReadOnly,
}

// A parameter: its type's name, and for EventReader<T> and EventWriter<T>,
// which of the two it is and T.
internal sealed record ParameterModel(string Name, string Type, Passing Passing, string Generic, string Argument);

internal sealed record SystemModel(
    string Class,
    string ClassName,
    TypeShell Shell,
    string Method,
    bool Static,
    bool ReturnsVoid,
    bool Generic,
    int Phase,
    int Order,
    Values<ParameterModel> Parameters,
    Values<string> With,
    Values<string> Without,
    Values<string> After,
    Values<string> Before,
    string? RunIf,
    bool RunIfValid,
    Values<ParameterModel> RunIfParameters,
    Location Location,
    Origin Origin)
{
    public string FullName => ClassName + "." + Method;
}
