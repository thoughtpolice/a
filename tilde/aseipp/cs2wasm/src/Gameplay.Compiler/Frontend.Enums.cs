// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Enums as text, as the CLR's ToString has them: a value's name; for a
// [Flags] enum (or the F format) the names of the members it combines,
// lowest value first, joined by ", "; otherwise its number. An enum's
// names reach a module only where code prints one of its values: a
// function of the value and the mode (0 for G, 1 for F).
internal sealed partial class Frontend
{
    private readonly Dictionary<INamedTypeSymbol, int> enumFormatters = new(SymbolEqualityComparer.Default);

    public void DemandEnumFormatter(INamedTypeSymbol type)
    {
        if (enumFormatters.ContainsKey(type))
        {
            return;
        }

        enumFormatters.Add(type, methods.Count);
        methods.Add(new(
            null,
            "<format> " + type.ToDisplayString(),
            [Represent(ScalarOf(type)!.Value), WType.I32],
            StringType(),
            true,
            type,
            MethodPlanKind.EnumFormat,
            Substitution.Empty));
    }

    public int EnumFormatter(INamedTypeSymbol type) => enumFormatters.TryGetValue(type, out int id)
        ? imports.Count + id
        : throw new InternalCompilerError($"enum '{type.ToDisplayString()}' prints without its names.");

    public bool IsFlags(INamedTypeSymbol type) =>
        flagsAttribute is not null
        && type.GetAttributes().Any(attribute => SymbolEqualityComparer.Default.Equals(attribute.AttributeClass, flagsAttribute));

    // An enum's members: names and values as unsigned 64-bit patterns (a
    // signed value sign-extended), ordered by value, first declared first.
    public static List<(string Name, ulong Value)> EnumMembers(INamedTypeSymbol type) => type.GetMembers()
        .OfType<IFieldSymbol>()
        .Where(field => field.HasConstantValue)
        .Select((field, index) => (field.Name, Value: EnumBits(field.ConstantValue!), Index: index))
        .OrderBy(member => member.Value)
        .ThenBy(member => member.Index)
        .Select(member => (member.Name, member.Value))
        .ToList();

    private static ulong EnumBits(object value) => value switch
    {
        sbyte v => (ulong)v,
        short v => (ulong)v,
        int v => (ulong)v,
        long v => (ulong)v,
        byte v => v,
        ushort v => v,
        uint v => v,
        ulong v => v,
        _ => throw new InternalCompilerError("enum constant of no integer type."),
    };
}
