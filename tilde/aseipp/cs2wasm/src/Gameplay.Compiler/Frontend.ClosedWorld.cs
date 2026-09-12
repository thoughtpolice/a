// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Closed-world pruning (docs/IMPORTER.md, "Closed-world pruning").
// A module is a closed world: every object it will ever hold is made by its
// own code. So an array can only be seen as anything but its own type
// (object, IEnumerable<T>, an array of a base type) where code converts it,
// and arrays nothing converts need none of what the module does for
// arrays of unknown type: the non-generic collection interfaces' and the
// covariant ones' members for them, their Type objects and names, store
// checks. Code converts a value where IL moves it into storage of another
// type, which discovery sees in each body in exact types (a shared method's
// code in each exact instantiation's): an argument, a store, a return, a
// cast, and the join of two paths.
//
// And a type test for what the module never makes never holds: a module
// compiled once is compiled again in the world the first compilation made
// (the classes and boxes whose vtables it kept, the arrays it converted,
// whether it has strings), where `isinst X` of an X none of them is folds
// to null and `x.GetType() == typeof(X)` to false (Il.Folding), so the
// branches only those tests led to (System.Linq's specializations for
// sources the module never has) are not compiled, nor what they make.
// Its classes are those of the last compilation whose world held: a
// compilation in them makes a part of what that one made. Its arrays are
// taken optimistically, none at first (a Linq operator's own `[]` behind
// its `is T[]` test is what makes an array an IEnumerable<T>), and a
// compilation holds only if every array it let escape, or a folded test
// would have tested, was in its world; if not, it compiles again with
// them. It repeats while a new world would fold more; the last
// compilation that held is the module.
internal sealed partial class Frontend
{
    // The arrays code may see as another type.
    private readonly HashSet<ITypeSymbol> escapingArrays = new(SymbolEqualityComparer.Default);

    // Whether an array may be seen as another type: always outside IL
    // mode, where this is not tracked.
    public bool Escapes(IArrayTypeSymbol array) => escapingArrays.Contains(array);

    // All of them, once discovery is done.
    public IReadOnlySet<ITypeSymbol> EscapingArrays => escapingArrays;

    // The world a first compilation made, which this one folds type tests
    // by (null in the first), and the one this one makes.
    public ClosedWorld? World { get; }

    public ClosedWorld? LastWorld { get; private set; }

    // The types tests test for that the world did not fold them by (all,
    // in a first compilation): whether the world this one makes would.
    private readonly HashSet<(ITypeSymbol, bool)> openTests = [];

    public int WorldFolds { get; private set; }

    public bool WouldFold(ClosedWorld next) => openTests.Any(test => !CouldBe(next, test.Item1, test.Item2));

    // Whether a test (of a type the IL names independently of shared type
    // arguments) never holds in the world: the analysis folds it.
    public bool NeverHolds(ITypeSymbol type, bool exactly)
    {
        if (World is { } world && !CouldBe(world, type, exactly))
        {
            if (DebugEscapes)
            {
                Console.Error.WriteLine($"never {(exactly ? "exactly " : "")}{type.ToDisplayString()}");
            }

            WorldFolds++;
            return true;
        }

        openTests.Add((type, exactly));
        return false;
    }

    // Whether a value may be of a type (exactly of it), in a world:
    // whether one of its objects, boxes, arrays or strings is. What a
    // world does not account for (type parameters, delegates, System's
    // own roots, what the importer maps to other types) may be.
    private bool CouldBe(ClosedWorld world, ITypeSymbol type, bool exactly)
    {
        if (world.Answers.TryGetValue((type, exactly), out bool known))
        {
            return known;
        }

        bool answer = type switch
        {
            INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable =>
                !exactly && CouldBe(world, nullable.TypeArguments[0], false),
            { SpecialType: SpecialType.System_String } => world.Strings,
            { SpecialType: SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum
                or SpecialType.System_Delegate or SpecialType.System_MulticastDelegate or SpecialType.System_Array } => true,
            IArrayTypeSymbol { IsSZArray: true } array => world.Arrays.Any(candidate =>
                exactly ? SymbolEqualityComparer.Default.Equals(candidate, array) : Converts(candidate, array)),
            INamedTypeSymbol { TypeKind: TypeKind.Interface } face =>
                world.Made.Concat(world.Arrays).Any(candidate => Converts(candidate, face))
                || (world.Strings && Converts(SpecialTypeOf(SpecialType.System_String), face))
                || Converts(SpecialTypeOf(SpecialType.System_MulticastDelegate), face),
            INamedTypeSymbol { TypeKind: TypeKind.Class } named when !IsSupportedDelegate(named) && world.Classes.Contains(named) =>
                world.Made.Any(candidate => exactly ? SymbolEqualityComparer.Default.Equals(candidate, named) : Converts(candidate, named)),
            INamedTypeSymbol { TypeKind: TypeKind.Struct or TypeKind.Enum } value when !IsSharedInstance(value) =>
                ScalarOf(value) is { } scalar
                    ? world.Made.Any(candidate => candidate.IsValueType && ScalarOf(candidate) == scalar)
                    : world.Made.Any(candidate => SymbolEqualityComparer.Default.Equals(candidate, value)),
            _ => true,
        };
        world.Answers.Add((type, exactly), answer);
        return answer;
    }

    // Whether a value of one type is one of another: the same, or by a
    // reference or boxing conversion.
    private bool Converts(ITypeSymbol candidate, ITypeSymbol type) =>
        SymbolEqualityComparer.Default.Equals(candidate, type)
        || ClassifyConversion(candidate, type) is { IsImplicit: true } conversion
           && (conversion.IsReference || conversion.IsIdentity || conversion.IsBoxing);

    private void Escape(IlSlot slot, ITypeSymbol? destination)
    {
        if (slot is { Kind: IlKind.Ref, Type: IArrayTypeSymbol array } && destination is not null
            && !SymbolEqualityComparer.Default.Equals(array, Unnamed(destination)))
        {
            Escape(array);
        }
    }

    // GAMEPLAYC_DEBUG_ESCAPES=1 prints where each array first escapes, and
    // each test the world folds.
    private static readonly bool DebugEscapes = Environment.GetEnvironmentVariable("GAMEPLAYC_DEBUG_ESCAPES") == "1";

    private string escapeSite = "";

    private void Escape(ITypeSymbol array)
    {
        if (escapingArrays.Add(array) && DebugEscapes)
        {
            Console.Error.WriteLine($"escape {array.ToDisplayString()} {escapeSite}");
        }
    }

    // Which parameters of a method its body only tests for null (as
    // ArgumentNullException.ThrowIfNull does): an array passed there goes
    // no further.
    private readonly Dictionary<IMethodSymbol, bool[]> nullTested = new(SymbolEqualityComparer.Default);

    private bool OnlyTestsForNull(IMethodSymbol method, int parameter)
    {
        var definition = method.OriginalDefinition;
        if (!nullTested.TryGetValue(definition, out var tested))
        {
            tested = new bool[definition.Parameters.Length];
            if (!definition.IsVirtual && !definition.IsAbstract && !definition.IsOverride && IlOf(method) is { } body)
            {
                var instructions = body.Instructions;
                int offset = definition.IsStatic ? 0 : 1;
                for (int index = 0; index < tested.Length; index++)
                {
                    tested[index] = true;
                }

                for (int index = 0; index < instructions.Length; index++)
                {
                    var instruction = instructions[index];
                    int argument = (int)instruction.Operand - offset;
                    if (instruction.OpCode is ILOpCode.Starg or ILOpCode.Ldarga && argument >= 0 && argument < tested.Length)
                    {
                        tested[argument] = false;
                    }
                    else if (instruction.OpCode is ILOpCode.Ldarg && argument >= 0 && argument < tested.Length
                             && !(index + 1 < instructions.Length && instructions[index + 1].OpCode is ILOpCode.Brtrue or ILOpCode.Brfalse)
                             && !(index + 2 < instructions.Length && instructions[index + 1].OpCode is ILOpCode.Ldnull
                                  && instructions[index + 2].OpCode is ILOpCode.Ceq or ILOpCode.Cgt_un or ILOpCode.Beq or ILOpCode.Bne_un))
                    {
                        tested[argument] = false;
                    }
                }
            }

            nullTested.Add(definition, tested);
        }

        return tested[parameter];
    }

    // What an instruction converts, in an exact body's analysis.
    private void NoteEscapes(IlAnalysis flow, int index)
    {
        if (flow.After[index] is null)
        {
            return;
        }

        var before = flow.Before[index];
        var instruction = flow.Instructions[index];
        if (DebugEscapes)
        {
            escapeSite = $"{flow.Method.ToDisplayString()} IL_{instruction.Offset:x4} {instruction.OpCode}";
        }

        if (flow.Operands[index] is IlPopFirst or IlFoldedTest && before[^1] is { Kind: IlKind.Ref, Type: IArrayTypeSymbol folded })
        {
            // A test the world folded, of an array: whether the world has
            // the array is for the next compilation to check.
            Escape(folded);
            return;
        }

        switch (instruction.OpCode)
        {
            case ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj when flow.Operands[index] is IMethodSymbol method:
                int count = method.Parameters.Length + (method.IsStatic || instruction.OpCode == ILOpCode.Newobj ? 0 : 1);
                if (count > before.Length || ArrayRedirect(method, [.. before.Skip(before.Length - count)]) is not null
                    || method is { IsStatic: true, ContainingType.SpecialType: SpecialType.System_Array })
                {
                    // System.Array's own, of the array's type.
                    break;
                }

                int first = before.Length - method.Parameters.Length;
                for (int parameter = 0; parameter < method.Parameters.Length; parameter++)
                {
                    if (!OnlyTestsForNull(method, parameter))
                    {
                        Escape(before[first + parameter], method.Parameters[parameter].Type);
                    }
                }

                if (!method.IsStatic && instruction.OpCode != ILOpCode.Newobj)
                {
                    Escape(before[first - 1], flow.Constrained[index] ?? method.ContainingType);
                }

                break;
            case ILOpCode.Stloc when flow.HasLocal((int)instruction.Operand) && !flow.Locals[(int)instruction.Operand].ByRef:
                Escape(before[^1], flow.Locals[(int)instruction.Operand].Type);
                break;
            case ILOpCode.Starg:
                Escape(before[^1], flow.Arguments[(int)instruction.Operand].Type);
                break;
            case ILOpCode.Stfld or ILOpCode.Stsfld when flow.Operands[index] is ISymbol field:
                Escape(before[^1], StorageType(field));
                break;
            case ILOpCode.Stelem or ILOpCode.Stelem_ref when before.Length >= 3:
                Escape(before[^1], (before[^3].Type as IArrayTypeSymbol)?.ElementType);
                break;
            case ILOpCode.Stind_ref or ILOpCode.Stobj when before.Length >= 2:
                Escape(before[^1], before[^2].Type);
                break;
            case ILOpCode.Ret when before.Length == 1 && !flow.Method.ReturnsByRef:
                Escape(before[^1], flow.Method.ReturnType);
                break;
            case ILOpCode.Castclass or ILOpCode.Isinst when before[^1] is { Kind: IlKind.Ref, Type: IArrayTypeSymbol tested }:
                // Tested even as itself: the world must answer that it is
                // (Frontend.CouldBe).
                Escape(tested);
                break;
            case ILOpCode.Call when flow.Operands[index] is IlExactTypeTest && before[^1] is { Kind: IlKind.Ref, Type: IArrayTypeSymbol tested }:
                Escape(tested);
                break;
            case ILOpCode.Unbox_any when flow.Operands[index] is ITypeSymbol target:
                Escape(before[^1], target);
                break;
        }
    }

    // What a body converts: each instruction, and each join of an array
    // with another type.
    private void NoteEscapes(IlAnalysis flow)
    {
        for (int index = 0; index < flow.Instructions.Length; index++)
        {
            NoteEscapes(flow, index);
        }

        escapeSite = DebugEscapes ? flow.Method.ToDisplayString() + " join" : "";
        foreach (var array in flow.JoinedArrays)
        {
            Escape(array);
        }
    }
}

// What one compilation of a module made (see Frontend.ClosedWorld): the
// classes and boxes whose vtables it kept (all it may make objects of), the
// classes it knew (their tests are its classes' own), the arrays it
// converted, whether it has strings.
internal sealed class ClosedWorld(
    IReadOnlyCollection<ITypeSymbol> made, IReadOnlySet<INamedTypeSymbol> classes, IReadOnlySet<ITypeSymbol> arrays, bool strings)
{
    // GAMEPLAYC_CLOSED_WORLD=0 compiles once.
    public static bool Enabled => Environment.GetEnvironmentVariable("GAMEPLAYC_CLOSED_WORLD") != "0";

    public IReadOnlyCollection<ITypeSymbol> Made { get; } = made;

    public IReadOnlySet<INamedTypeSymbol> Classes { get; } = classes;

    public IReadOnlySet<ITypeSymbol> Arrays { get; } = arrays;

    public bool Strings { get; } = strings;

    public Dictionary<(ITypeSymbol, bool), bool> Answers { get; } = [];

    // At most this many compilations after the first.
    public const int MaxPasses = 5;

    // The same world with other arrays.
    public ClosedWorld WithArrays(IEnumerable<ITypeSymbol> arrays) =>
        new(Made, Classes, arrays.ToHashSet<ITypeSymbol>(SymbolEqualityComparer.Default), Strings);
}
