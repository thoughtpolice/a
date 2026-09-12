// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Import-time constant folding (docs/IMPORTER.md, "Framework assemblies"),
// as a JIT folds what it knows of the machine and of the instantiation:
// the framework's IL tests hardware intrinsics' IsSupported, vectors'
// IsHardwareAccelerated, feature switches, RuntimeFeature, whether a type
// argument holds references, `typeof(T) == typeof(X)` and
// `typeof(T).IsEnum`, `IsValueType` or `IsPrimitive`, and takes a
// path of its own for each answer. Folding replaces each such call by the
// constant it returns, then the conditional branches on constants by
// unconditional ones (or nothing), so the paths not taken are never
// reached: their instructions are not typed, walked or lowered, and a
// token among them that names what the CoreLib does not have (a Vector256
// API) is no error.
internal sealed partial class IlAnalysis
{
    private void Fold()
    {
        var folded = Instructions.ToBuilder();
        bool changed = false;
        for (int index = 0; index < folded.Count; index++)
        {
            var instruction = folded[index];
            if (instruction.OpCode is ILOpCode.Call && Operands[index] is IMethodSymbol resource
                && frontend.ResourceText(resource, index > 0 ? Operands[index - 1] as string : null) is var (text, key))
            {
                // A framework assembly's resource string, which the CLR
                // looks up by its key: the message itself.
                if (key)
                {
                    folded[index - 1] = new IlInstruction(folded[index - 1].Offset, ILOpCode.Nop);
                    Operands[index - 1] = null;
                }

                folded[index] = new IlInstruction(instruction.Offset, ILOpCode.Ldstr);
                Operands[index] = text;
                changed = true;
                continue;
            }

            if (instruction.OpCode is ILOpCode.Call
                && (Operands[index] is IMethodSymbol method
                    ? frontend.FoldedCall(method)
                    // What the CoreLib does not have (Vector256's members)
                    // is folded by its name.
                    : unresolved[index] is not null && Code.Module.MemberName(instruction.Token) is var (space, type, name)
                        ? Frontend.FoldedCall(space, type, name) : null) is { } value)
            {
                folded[index] = new IlInstruction(instruction.Offset, ILOpCode.Ldc_i4, value);
                Operands[index] = null;
                unresolved[index] = null;
                changed = true;
                continue;
            }

            if (instruction.OpCode is ILOpCode.Ldsfld
                && Operands[index] is IFieldSymbol { Name: "IsLittleEndian", ContainingType: { Name: "BitConverter", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } } })
            {
                // Wasm's memory, and so every value's bytes, are little-endian.
                folded[index] = new IlInstruction(instruction.Offset, ILOpCode.Ldc_i4, 1);
                Operands[index] = null;
                changed = true;
                continue;
            }

            if (instruction.OpCode is ILOpCode.Isinst && Operands[index] is ITypeSymbol tested
                && shared?.Invoke(OpenOperands[index]) != true && frontend.NeverHolds(tested, exactly: false))
            {
                // Of a type the module never makes (Frontend.ClosedWorld):
                // null, whatever the value.
                folded[index] = new IlInstruction(instruction.Offset, ILOpCode.Ldnull);
                Operands[index] = IlPopFirst.Instance;
                changed = true;
            }
        }

        // `x.GetType() == typeof(X)`: a test of x's exact type (as RyuJIT
        // folds it), which needs no Type object of x's class.
        for (int index = 0; index + 3 < folded.Count; index++)
        {
            if (folded[index].OpCode is ILOpCode.Call or ILOpCode.Callvirt && Operands[index] is IMethodSymbol getType
                && Frontend.IsGetType(getType) && Constrained[index] is null
                && folded[index + 1].OpCode == ILOpCode.Ldtoken && Operands[index + 1] is ITypeSymbol tested
                && folded[index + 2].OpCode == ILOpCode.Call
                && Operands[index + 2] is IMethodSymbol { Name: "GetTypeFromHandle", ContainingType.Name: "Type" }
                && folded[index + 3].OpCode == ILOpCode.Call
                && Operands[index + 3] is IMethodSymbol { Name: "op_Equality" or "op_Inequality", ContainingType.Name: "Type" } equality
                && Frontend.HasExactTypeTest(tested)
                && !Enumerable.Range(index + 1, 3).Any(inner => IsTarget(folded, inner)))
            {
                for (int inner = index; inner < index + 3; inner++)
                {
                    folded[inner] = new IlInstruction(folded[inner].Offset, ILOpCode.Nop);
                    Operands[inner] = null;
                }

                var test = new IlExactTypeTest(tested, equality.Name == "op_Inequality") { Open = OpenOperands[index + 1] };
                Operands[index + 3] = test;
                if (shared?.Invoke(test.Open) != true && frontend.NeverHolds(tested, exactly: true))
                {
                    // Of a type the module never makes: false (true, !=).
                    folded[index + 3] = new IlInstruction(folded[index + 3].Offset, ILOpCode.Ldc_i4, test.Negated ? 1 : 0);
                    Operands[index + 3] = IlPopFirst.Instance;
                }

                changed = true;
            }
        }

        // What a branch lands on, where a run of constants ends: a value
        // from elsewhere may be on the stack there.
        var targets = new HashSet<int>();
        foreach (var instruction in folded)
        {
            if (instruction.Targets is { } many)
            {
                targets.UnionWith(many);
            }
            else if (IsBranch(instruction.OpCode))
            {
                targets.Add(instruction.Target);
            }
        }

        foreach (var region in Code.Regions)
        {
            targets.Add(region.TryStart);
            targets.Add(region.HandlerStart);
            if (region.FilterStart >= 0)
            {
                targets.Add(region.FilterStart);
            }
        }

        // The constants on top of the stack within a straight run of
        // instructions: each value and the instructions that computed it.
        var run = new List<(object Value, List<int> From)>();
        // The locals the run stored a null in (a type test's that never
        // holds, which branches read back).
        var nullLocals = new HashSet<int>();
        for (int index = 0; index < folded.Count; index++)
        {
            var instruction = folded[index];
            if (targets.Contains(instruction.Offset))
            {
                run.Clear();
                nullLocals.Clear();
            }

            switch (instruction.OpCode)
            {
                case ILOpCode.Ldnull:
                    run.Add((IlNullConstant.Instance, [index]));
                    continue;
                case ILOpCode.Stloc when run is [.., (IlNullConstant, _)]:
                    run.RemoveAt(run.Count - 1);
                    nullLocals.Add((int)instruction.Operand);
                    continue;
                case ILOpCode.Ldloc when nullLocals.Contains((int)instruction.Operand):
                    run.Add((IlNullConstant.Instance, [index]));
                    continue;
                case ILOpCode.Brtrue or ILOpCode.Brfalse when run is [.., (IlNullConstant, var from)]:
                    Settle(folded, from, index, instruction.OpCode == ILOpCode.Brfalse);
                    changed = true;
                    run.Clear();
                    nullLocals.Clear();
                    continue;
                case ILOpCode.Ceq or ILOpCode.Cgt_un when run is [.., (IlNullConstant, var leftFrom), (IlNullConstant, var rightFrom)]:
                    Replace(run, 2, instruction.OpCode == ILOpCode.Ceq ? 1 : 0, [.. leftFrom, .. rightFrom, index]);
                    continue;
                case ILOpCode.Ldc_i4:
                    run.Add(((int)instruction.Operand, [index]));
                    continue;
                case ILOpCode.Ldtoken when Operands[index] is ITypeSymbol token:
                    run.Add((new TypeHandle(token, shared?.Invoke(OpenOperands[index]) == true), [index]));
                    continue;
                case ILOpCode.Call when Operands[index] is IMethodSymbol { Name: "GetTypeFromHandle", ContainingType.Name: "Type" }
                                        && run is [.., (TypeHandle handle, var from)]:
                    run[^1] = (new TypeObject(handle.Type, handle.Shared), [.. from, index]);
                    continue;
                case ILOpCode.Call when Operands[index] is IMethodSymbol { Name: "op_Equality" or "op_Inequality", ContainingType.Name: "Type", Parameters.Length: 2 } equality
                                        && run is [.., (TypeObject left, var leftFrom), (TypeObject right, var rightFrom)]:
                    bool same = SymbolEqualityComparer.Default.Equals(left.Type, right.Type);
                    if ((left.Shared && CouldBeShared(right.Type)) || (right.Shared && CouldBeShared(left.Type)))
                    {
                        // Of a shared type argument: its exact type decides.
                        FoldedByShared = true;
                    }

                    Replace(run, 2, (same == (equality.Name == "op_Equality")) ? 1 : 0, [.. leftFrom, .. rightFrom, index]);
                    continue;
                case ILOpCode.Call or ILOpCode.Callvirt when Operands[index] is IMethodSymbol { Name: "get_IsEnum" or "get_IsValueType" or "get_IsPrimitive", ContainingType.Name: "Type", Parameters.Length: 0 } property
                                                           && run is [.., (TypeObject tested, var testedFrom)]:
                    bool holds = property.Name switch
                    {
                        "get_IsEnum" => tested.Type.TypeKind == TypeKind.Enum,
                        "get_IsPrimitive" => tested.Type.TypeKind != TypeKind.Enum
                                             && (Frontend.ScalarOf(tested.Type) is not null),
                        _ => tested.Type.IsValueType,
                    };
                    Replace(run, 1, holds ? 1 : 0, [.. testedFrom, index]);
                    continue;
                case ILOpCode.Ceq when run is [.., (int left, var leftFrom), (int right, var rightFrom)]:
                    Replace(run, 2, left == right ? 1 : 0, [.. leftFrom, .. rightFrom, index]);
                    continue;
                case ILOpCode.And or ILOpCode.Or or ILOpCode.Xor
                    when run is [.., (int left, var leftFrom), (int right, var rightFrom)]:
                    int combined = instruction.OpCode switch
                    {
                        ILOpCode.And => left & right,
                        ILOpCode.Or => left | right,
                        _ => left ^ right,
                    };
                    Replace(run, 2, combined, [.. leftFrom, .. rightFrom, index]);
                    continue;
                case ILOpCode.Brtrue or ILOpCode.Brfalse when run is [.., (int condition, var from)]:
                    bool taken = (condition != 0) == (instruction.OpCode == ILOpCode.Brtrue);
                    Settle(folded, from, index, taken);
                    changed = true;
                    run.Clear();
                    nullLocals.Clear();
                    continue;
                case ILOpCode.Beq or ILOpCode.Bne_un when run is [.., (int left, var leftFrom), (int right, var rightFrom)]:
                    Settle(folded, [.. leftFrom, .. rightFrom], index, (left == right) == (instruction.OpCode == ILOpCode.Beq));
                    changed = true;
                    run.Clear();
                    nullLocals.Clear();
                    continue;
                case ILOpCode.Nop:
                    continue;
            }

            run.Clear();
            nullLocals.Clear();
        }

        if (changed)
        {
            Instructions = folded.ToImmutable();
        }
    }

    // Whether a type could be a shared type argument's exact type: a
    // reference type, or a struct over one.
    private static bool CouldBeShared(ITypeSymbol type) =>
        !type.IsValueType || (type is INamedTypeSymbol named && named.TypeArguments.Any(argument => CouldBeShared(argument)));

    private static void Replace(List<(object Value, List<int> From)> run, int count, int value, List<int> from)
    {
        run.RemoveRange(run.Count - count, count);
        run.Add((value, from));
    }

    // A branch on a constant: the instructions that computed it do
    // nothing, and it goes where the constant sends it.
    private void Settle(ImmutableArray<IlInstruction>.Builder folded, List<int> from, int branch, bool taken)
    {
        foreach (int index in from)
        {
            // A folded type test still takes the value it tested.
            bool test = Operands[index] is IlPopFirst;
            folded[index] = new IlInstruction(folded[index].Offset, test ? ILOpCode.Pop : ILOpCode.Nop);
            Operands[index] = test ? IlFoldedTest.Instance : null;
        }

        var instruction = folded[branch];
        folded[branch] = taken
            ? new IlInstruction(instruction.Offset, ILOpCode.Br, instruction.Operand)
            : new IlInstruction(instruction.Offset, ILOpCode.Nop);
    }

    private static bool IsBranch(ILOpCode opcode) => opcode is ILOpCode.Br or ILOpCode.Leave || IsConditional(opcode);

    // Whether a branch or handler lands on an instruction.
    private bool IsTarget(ImmutableArray<IlInstruction>.Builder instructions, int index)
    {
        int offset = instructions[index].Offset;
        return instructions.Any(instruction => instruction.Targets is { } many ? many.Contains(offset) : IsBranch(instruction.OpCode) && instruction.Target == offset)
               || Code.Regions.Any(region => region.TryStart == offset || region.HandlerStart == offset || region.FilterStart == offset);
    }

    private sealed record TypeHandle(ITypeSymbol Type, bool Shared);

    private sealed record IlNullConstant
    {
        public static readonly IlNullConstant Instance = new();
    }

    private sealed record TypeObject(ITypeSymbol Type, bool Shared);
}

// `x.GetType() == typeof(Type)` (or !=, Negated), on the call of the
// operator, whose operands' instructions are gone: x is on the stack.
internal sealed record IlExactTypeTest(ITypeSymbol Type, bool Negated)
{
    // The tested type as the definition names it.
    public ISymbol? Open { get; init; }
}

// The operand of a constant a type test that never holds folded to: the
// instruction takes the tested value first.
internal sealed record IlPopFirst
{
    public static readonly IlPopFirst Instance = new();
}

// The operand of the pop a folded type test left where a branch took its
// answer: what it tested is still told of (Frontend.NoteEscapes).
internal sealed record IlFoldedTest
{
    public static readonly IlFoldedTest Instance = new();
}

internal sealed partial class Frontend
{
    // Whether an exact type test tells a type's objects from all others:
    // arrays of one element type, strings, boxes and classes have their own
    // heap types (delegates of one signature share theirs).
    public static bool HasExactTypeTest(ITypeSymbol type) =>
        type is IArrayTypeSymbol { IsSZArray: true }
        || type.SpecialType == SpecialType.System_String
        || (type is INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct or TypeKind.Enum } && !IsSupportedDelegate(type));

    // Whether the task library flows ExecutionContext (corelib/
    // ExecutionContext.cs): only where the module's own code or a library
    // of it names ExecutionContext or AsyncLocal<T>, the only ways to set
    // or see one. Without, every context is the default, and the task
    // library's code for flowing it folds away.
    private bool FlowsExecutionContext => flowsExecutionContext ??=
        new[] { il }.Concat(libraryModules ?? []).Any(module =>
            module.ReferencesType("System.Threading", "ExecutionContext")
            || module.ReferencesType("System.Threading", "AsyncLocal`1"));

    private bool? flowsExecutionContext;

    // Whether tasks may run on schedulers but the default (corelib/
    // TaskScheduler.cs): only where the module's own code or a library of
    // it names TaskScheduler or a TaskFactory, the only ways to have
    // another. Without, every delegate task goes to the frame loop's
    // queue, and the task library's code for schedulers folds away.
    private bool HasTaskSchedulers => hasTaskSchedulers ??=
        new[] { il }.Concat(libraryModules ?? []).Any(module =>
            module.ReferencesType("System.Threading.Tasks", "TaskScheduler")
            || module.ReferencesType("System.Threading.Tasks", "TaskFactory")
            || module.ReferencesType("System.Threading.Tasks", "TaskFactory`1"));

    private bool? hasTaskSchedulers;

    // The CLR's values of the feature switches the imported framework
    // assemblies define ([FeatureSwitchDefinition]): what `dotnet run`
    // leaves them at, as the differential oracle runs.
    private static readonly Dictionary<string, bool> FeatureSwitches = new(StringComparer.Ordinal)
    {
        ["System.Linq.Enumerable.IsSizeOptimized"] = false,
    };

    // The constant a parameterless static call returns, where the importer
    // knows it (see IlAnalysis.Fold): the machine has no hardware
    // intrinsics and no dynamic code; resource keys are resolved here
    // (Frontend.Resources); a type argument's holding references is known
    // once it is closed.
    public int? FoldedCall(IMethodSymbol method)
    {
        if (!method.IsStatic || method.Parameters.Length != 0)
        {
            return null;
        }

        if (method is { Name: "get_Size", ContainingType.SpecialType: SpecialType.System_IntPtr or SpecialType.System_UIntPtr })
        {
            // Native ints are 64-bit, as on the CLR the fixtures are
            // compared with.
            return 8;
        }

        if (method.ReturnType.SpecialType != SpecialType.System_Boolean)
        {
            return null;
        }

        var type = method.ContainingType;
        if (method.Name == "get_IsSupported" && IsVector128(type))
        {
            // Of the element types Wasm's v128 has lanes of (Frontend.Simd).
            return ContainsTypeParameters(type) ? null : VectorLane(type) is not null ? 1 : 0;
        }

        if (type.ContainingType is null && FoldedCall(type.ContainingNamespace?.ToDisplayString() ?? "", type.MetadataName, method.Name) is { } known)
        {
            return known;
        }

        if (method.Name == "FlowsExecutionContext" && IsRuntimeIntrinsic(method))
        {
            return FlowsExecutionContext ? 1 : 0;
        }

        if (method.Name == "HasTaskSchedulers" && IsRuntimeIntrinsic(method))
        {
            return HasTaskSchedulers ? 1 : 0;
        }

        if (method is { Name: "SortsByComparer", TypeArguments: [var sorted] } && IsRuntimeIntrinsic(method)
            && !ContainsTypeParameters(sorted))
        {
            return SortsByComparer(sorted) ? 1 : 0;
        }

        if (method is { Name: "IsReferenceOrContainsReferences", TypeArguments: [var argument], ContainingType.Name: "RuntimeHelpers" }
            && !ContainsTypeParameters(argument))
        {
            return HoldsReferences(argument, new(SymbolEqualityComparer.Default)) ? 1 : 0;
        }

        if (method.AssociatedSymbol is IPropertySymbol property
            && property.GetAttributes().FirstOrDefault(attribute => attribute.AttributeClass?.Name == "FeatureSwitchDefinitionAttribute")
                is { ConstructorArguments: [{ Value: string name }] }
            && FeatureSwitches.TryGetValue(name, out bool enabled))
        {
            return enabled ? 1 : 0;
        }

        return null;
    }

    // The message a framework assembly's SR gives: a property's (whose
    // getter looks its key up), or GetResourceString's of a constant key
    // (then Key: the key's ldstr goes too).
    public (string Text, bool Key)? ResourceText(IMethodSymbol method, string? key)
    {
        if (method is not { IsStatic: true, ContainingType: { Name: "SR", ContainingType: null } sr }
            || sr.ContainingNamespace?.ToDisplayString() != "System" || !InFramework(method)
            || IlModuleOf(method) is not { } module)
        {
            return null;
        }

        if (method is { Name: "GetResourceString", Parameters: [{ Type.SpecialType: SpecialType.System_String }] } && key is not null)
        {
            return (module.ResourceStrings.GetValueOrDefault(key, key), true);
        }

        if (method.MethodKind == MethodKind.PropertyGet && IlOf(method) is { Instructions: [{ OpCode: ILOpCode.Ldstr } load, { OpCode: ILOpCode.Call }, { OpCode: ILOpCode.Ret }] })
        {
            string name = module.UserString(load.Token);
            return (module.ResourceStrings.GetValueOrDefault(name, name), false);
        }

        return null;
    }

    // The same by the method's namespace, type (metadata) name and name.
    public static int? FoldedCall(string space, string type, string name) => name switch
    {
        "get_IsSupported" when space.StartsWith("System.Runtime.Intrinsics", StringComparison.Ordinal)
                               || (type == "Vector`1" && space == "System.Numerics") => 0,
        // Wasm SIMD's v128 is Vector128 (Frontend.Simd); there is nothing
        // of Vector64, Vector256, Vector512 or Vector<T>, so code takes
        // its 128-bit paths or its scalar ones.
        "get_IsHardwareAccelerated" when space == "System.Runtime.Intrinsics" && type == "Vector128" => 1,
        "get_IsHardwareAccelerated" when space == "System.Runtime.Intrinsics" || (type == "Vector" && space == "System.Numerics") => 0,
        "get_IsDynamicCodeSupported" or "get_IsDynamicCodeCompiled" when type == "RuntimeFeature" => 0,
        "UsingResourceKeys" when type == "SR" && space == "System" => 0,
        "IsBitwiseEquatable" when type == "RuntimeHelpers" => 0,
        // As IntPtr.Size is 8, as on the oracle's CLR.
        "get_Is64BitProcess" when type == "Environment" && space == "System" => 1,
        _ => null,
    };

    // Whether a value of a type holds object references, as the CLR's
    // RuntimeHelpers.IsReferenceOrContainsReferences<T> answers.
    private bool HoldsReferences(ITypeSymbol type, HashSet<ITypeSymbol> seen)
    {
        if (!type.IsValueType)
        {
            return true;
        }

        if (ScalarOf(type) is not null || type.TypeKind == TypeKind.Enum || !seen.Add(type))
        {
            return false;
        }

        return type.GetMembers().OfType<IFieldSymbol>()
            .Where(field => !field.IsStatic && !field.IsConst)
            .Any(field => field.RefKind != RefKind.None || HoldsReferences(field.Type, seen));
    }
}
