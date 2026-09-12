// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The element type of a Vector128<T>, as Wasm SIMD's instructions see its
// lanes: sixteen 8-bit, eight 16-bit, four 32-bit or two 64-bit integers,
// signed or not, or four floats or two doubles.
internal enum Lane
{
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
}

// SIMD (docs/IMPORTER.md, "SIMD as built"). System.Runtime.Intrinsics'
// Vector128<T> is a value the module layer treats as it treats a primitive:
// a Wasm v128 in locals, parameters, results, fields, array elements, cells
// and boxes, of a type argument that stays per instantiation as every value
// type's does. Its members are FunctionEmitter.Simd's instructions, or the
// CoreLib's C# over them (corelib/Vector128.cs). T is one of the primitive
// numbers, native integers included (as 64-bit lanes: IntPtr.Size is 8).
internal sealed partial class Frontend
{
    public static bool IsVector128(ITypeSymbol? type) =>
        type is INamedTypeSymbol { Name: "Vector128", Arity: 1, ContainingNamespace: { Name: "Intrinsics", ContainingNamespace: { Name: "Runtime", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } } } };

    // Vector256<T> and Vector512<T>: the CoreLib declares them only so that
    // dotnet/runtime's sources testing their IsHardwareAccelerated compile;
    // they have no representation.
    public static bool IsUnacceleratedVector(ITypeSymbol? type) =>
        type is INamedTypeSymbol { Name: "Vector256" or "Vector512", Arity: 1, ContainingNamespace: { Name: "Intrinsics", ContainingNamespace: { Name: "Runtime", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } } } };

    // The static class of Vector128's members.
    public static bool IsVector128Class(ITypeSymbol? type) =>
        type is INamedTypeSymbol { Name: "Vector128", Arity: 0, ContainingNamespace: { Name: "Intrinsics", ContainingNamespace: { Name: "Runtime", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } } } };

    public static Lane? LaneOf(ITypeSymbol? element) => element?.SpecialType switch
    {
        SpecialType.System_SByte => Lane.I8,
        SpecialType.System_Byte => Lane.U8,
        SpecialType.System_Int16 => Lane.I16,
        SpecialType.System_UInt16 => Lane.U16,
        SpecialType.System_Int32 => Lane.I32,
        SpecialType.System_UInt32 => Lane.U32,
        SpecialType.System_Int64 => Lane.I64,
        SpecialType.System_UInt64 => Lane.U64,
        SpecialType.System_IntPtr => Lane.I64,
        SpecialType.System_UIntPtr => Lane.U64,
        SpecialType.System_Single => Lane.F32,
        SpecialType.System_Double => Lane.F64,
        _ => null,
    };

    // The lanes of a Vector128<T> of a supported T.
    public static Lane? VectorLane(ITypeSymbol? type) =>
        IsVector128(type) ? LaneOf(((INamedTypeSymbol)type!).TypeArguments[0]) : null;

    public static int LaneBytes(Lane lane) => lane switch
    {
        Lane.I8 or Lane.U8 => 1,
        Lane.I16 or Lane.U16 => 2,
        Lane.I32 or Lane.U32 or Lane.F32 => 4,
        _ => 8,
    };

    public static int LaneCount(Lane lane) => 16 / LaneBytes(lane);

    public static bool IsFloatLane(Lane lane) => lane is Lane.F32 or Lane.F64;

    public static bool IsSignedLane(Lane lane) => lane is Lane.I8 or Lane.I16 or Lane.I32 or Lane.I64;

    // What a lane is as a value on the Wasm stack.
    public static WType LaneType(Lane lane) => lane switch
    {
        Lane.I64 or Lane.U64 => WType.I64,
        Lane.F32 => WType.F32,
        Lane.F64 => WType.F64,
        _ => WType.I32,
    };

    private WType MapVector(ITypeSymbol type)
    {
        if (VectorLane(type) is null)
        {
            throw new CompileError(
                $"GP1001: Type '{type.ToDisplayString()}' is unsupported: a Vector128's elements are sbyte, byte, short, ushort, "
                + "int, uint, long, ulong, float or double.");
        }

        return WType.V128;
    }

    // The System.Numerics vectors and the types of float leaves that are
    // their bits as a Vector128<float> (Vector128.AsVector4 and the like):
    // Vector2, Vector3 and Vector4, Quaternion, Plane.
    public static int? NumericsVectorLanes(ITypeSymbol? type) =>
        type is INamedTypeSymbol { ContainingNamespace: { Name: "Numerics", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } } } named
            ? named.MetadataName switch
            {
                "Vector2" => 2,
                "Vector3" => 3,
                "Vector4" or "Quaternion" or "Plane" => 4,
                _ => null,
            }
            : null;

    // The CoreLib's helper a member of a Vector128<T> value runs
    // (corelib/Vector128.cs): Vector128.GetElement, ObjectEquals, Hash and
    // Format, closed over T.
    public IMethodSymbol VectorHelper(string name, ITypeSymbol element)
    {
        var vector = TypeNamed("System.Runtime.Intrinsics.Vector128")
                     ?? throw new InternalCompilerError("the CoreLib has no Vector128.");
        var helper = vector.GetMembers(name).OfType<IMethodSymbol>()
                         .FirstOrDefault(method => method is { IsStatic: true, Arity: 1 } && method.Parameters.Length > 0
                                                   && IsVector128(method.Parameters[0].Type))
                     ?? throw new InternalCompilerError($"the CoreLib's Vector128 has no {name}.");
        return helper.Construct(element);
    }

    // The member of a Vector128<T> a constrained call of an object or
    // interface member runs: its own of the name and parameters.
    public static IMethodSymbol? VectorMember(ITypeSymbol constrained, IMethodSymbol method)
    {
        if (method.ContainingType.TypeKind == TypeKind.Interface
            && constrained.FindImplementationForInterfaceMember(method.IsGenericMethod ? method.ConstructedFrom : method) is IMethodSymbol implemented)
        {
            return implemented;
        }

        return constrained.GetMembers(method.Name).OfType<IMethodSymbol>().FirstOrDefault(candidate =>
            !candidate.IsStatic && candidate.Parameters.Length == method.Parameters.Length
            && candidate.Parameters.Zip(method.Parameters).All(pair =>
                SymbolEqualityComparer.Default.Equals(pair.First.Type, pair.Second.Type)));
    }

    // What a call of one of Vector128's members needs: its types, the
    // helpers of a value's members, and the CoreLib's C# of a member
    // FunctionEmitter.Simd does not lower itself (which one that is can
    // depend on the call's constants, so the C# is registered for any;
    // pruning drops what no call reaches).
    private bool WalkSimdCall(IMethodSymbol method, Substitution generic)
    {
        var type = method.ContainingType;
        if (!IsVector128(type) && !IsVector128Class(type))
        {
            return false;
        }

        foreach (var parameter in method.Parameters)
        {
            MapType(Substitute(generic, parameter.Type));
        }

        if (!method.ReturnsVoid)
        {
            MapType(Substitute(generic, method.ReturnType));
        }

        if (IsVector128(type) && !method.IsStatic)
        {
            var element = ((INamedTypeSymbol)Substitute(generic, type)).TypeArguments[0];
            string? helper = (method.Name, method.Parameters.Length) switch
            {
                ("get_Item", 1) => "GetElement",
                ("GetHashCode", 0) => "Hash",
                ("ToString", 0) => "Format",
                ("Equals", 1) when IsObjectType(method.Parameters[0].Type) => "ObjectEquals",
                _ => null,
            };
            if (helper is not null)
            {
                EnsureMethod(VectorHelper(helper, element), Substitution.Empty);
            }

            return true;
        }

        if (IsModuleDefined(method))
        {
            EnsureMethod(method, generic);
        }

        return true;
    }
}
