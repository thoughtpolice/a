// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Records, and what the object members of any type need: equality, hashing
// and printing. A record's members are the IL C# synthesizes for them; a
// class record's ToString, GetHashCode and Equals(object) override
// System.Object's, and live in slots of the root vtable (see
// Frontend.Classes) when code dispatches them. A synthesized member gets a
// function when code needs it: a call, or an equality, hash or printing
// that reaches it (see the Demand methods); only members of the record's
// own vtable slots have one up front. A module that passes records around
// as data pays for their fields and vtables alone.
internal sealed partial class Frontend
{

    private readonly List<INamedTypeSymbol> recordClasses = [];
    // The System.Object slots code dispatches through, each with the static
    // types of the receivers; and whether any record prints.
    private readonly List<(string Slot, INamedTypeSymbol Receiver)> objectSlotDemands = [];
    private readonly HashSet<ITypeSymbol> equalityDemands = new(SymbolEqualityComparer.Default);
    private readonly HashSet<ITypeSymbol> objectEqualityDemands = new(SymbolEqualityComparer.Default);
    private readonly HashSet<ITypeSymbol> hashDemands = new(SymbolEqualityComparer.Default);

    public static bool IsRecordClass(ITypeSymbol? type) => type is INamedTypeSymbol { IsRecord: true, TypeKind: TypeKind.Class };

    public static bool IsRecordStruct(ITypeSymbol? type) => type is INamedTypeSymbol { IsRecord: true, TypeKind: TypeKind.Struct };

    public IMethodSymbol ObjectMethod(string name) => compilation.GetSpecialType(SpecialType.System_Object)
        .GetMembers(name)
        .OfType<IMethodSymbol>()
        .First(member => !member.IsStatic);

    // A method's parameters and result: shared instantiations take their
    // canonical forms' (Frontend.Sharing), a ref result is a reference, and
    // a covariant override returns its slot's type.
    private List<WType> PlanParameters(IMethodSymbol method) =>
        SignatureOf(method).Parameters.Select(ParameterType).ToList();

    private WType PlanResult(IMethodSymbol method) => method switch
    {
        _ when method.ReturnsByRef || method.ReturnsByRefReadonly => RefParameterType(SignatureOf(method).ReturnType),
        _ when HasCovariantResult(method) => MapType(SignatureOf(SlotRoot(method)).ReturnType),
        _ => MapType(SignatureOf(method).ReturnType),
    };

    // A record's typed Equals, synthesized or declared.
    public static IMethodSymbol TypedEquals(INamedTypeSymbol type) => type.GetMembers("Equals")
        .OfType<IMethodSymbol>()
        .First(method => !method.IsStatic && method.Parameters.Length == 1
                         && SymbolEqualityComparer.Default.Equals(method.Parameters[0].Type, type));

    public static string? FormatProblem(ITypeSymbol type)
    {
        if (type.SpecialType is SpecialType.System_String or SpecialType.System_Decimal || type.IsRecord)
        {
            return null;
        }

        if (IsObjectType(type) || type.TypeKind is TypeKind.Class or TypeKind.Interface or TypeKind.Delegate)
        {
            // Its ToString, whatever it is.
            return null;
        }

        if (IsStruct(type))
        {
            return ClrName((INamedTypeSymbol)type) is null ? "the CLR's names of generic types are not reproduced." : null;
        }

        if (type is IArrayTypeSymbol { ElementType: var element })
        {
            // An array prints its runtime type's name, which covariance can
            // make other than its static type's.
            return IsBoxable(element) || element.SpecialType == SpecialType.System_String || element.IsSealed
                ? null
                : "an array of references prints its runtime type, which is not kept apart here.";
        }

        return ScalarOf(type) is null ? "only strings, numbers, bools, chars and records format." : null;
    }

    // EqualityComparer<T>.Default.Equals of a type (or, `byObject`, what
    // x.Equals((object)y) runs, as ValueType.Equals compares a struct's
    // fields): what FunctionEmitter.EmitEqual calls.
    public void DemandEquality(ITypeSymbol type, bool byObject = false)
    {
        if (!(byObject ? objectEqualityDemands : equalityDemands).Add(type) || VectorLane(type) is not null)
        {
            // A Vector128's is FunctionEmitter.Simd's.
            return;
        }

        if (IsDecimalType(type))
        {
            EnsureMethod(DecimalEquality, Substitution.Empty);
        }
        else if (IsRuntimeNullable(type))
        {
            DemandEquality(((INamedTypeSymbol)type).TypeArguments[0], byObject);
        }
        else if (!byObject && EquatableEquals(type) is { } equals)
        {
            if (equals.ContainingType.TypeKind == TypeKind.Interface)
            {
                // Called through the interface, which it adopts.
                MapType(equals.ContainingType);
            }
            else
            {
                EnsureMethod(equals, Substitution.Empty);
                DemandReimplementations(type, EquatableMember(type)!);
            }
        }
        else if (type is INamedTypeSymbol { IsRecord: true } record)
        {
            EnsureMethod(TypedEquals(record), Substitution.Empty);
        }
        else if (StructObjectOverride(type, "Equals") is { } overriding)
        {
            EnsureMethod(overriding, Substitution.Empty);
            EnsureBox(type);
        }
        else if (IsStruct(type))
        {
            foreach (var fieldType in ExactFieldTypes(type))
            {
                DemandEquality(fieldType, !IsValueTuple(type));
            }
        }
        else if (IsObjectType(type))
        {
            DemandObjectMember("Equals");
        }
        else if (IsSupportedDelegate(type))
        {
            EnsureDelegateEqual(DelegateOf(type));
        }
        else if (type is INamedTypeSymbol { TypeKind: TypeKind.Interface or TypeKind.Class } implemented
                 && (implemented.TypeKind == TypeKind.Interface || IsSourceClass(implemented))
                 && (RecordImplements(implemented) || objectOverrides.Contains("Equals")))
        {
            DemandObjectSlot("Equals", implemented);
        }
    }

    // The Equals(T) that EqualityComparer<T>.Default calls on a type
    // implementing IEquatable<T>, as the CLR's GenericEqualityComparer<T>
    // does: the implementation a class or struct runs, or the interface's
    // member on an interface extending IEquatable<T>. IEquatable<T> is
    // invariant, so a class deriving from an IEquatable<Base> has none and
    // compares by Equals(object). Records (whose Equals(R) is theirs),
    // strings, numbers and decimal compare as they did.
    public static IMethodSymbol? EquatableEquals(ITypeSymbol type)
    {
        if (EquatableMember(type) is not { } member)
        {
            return null;
        }

        if (type.TypeKind == TypeKind.Interface)
        {
            return member;
        }

        return ((INamedTypeSymbol)type).FindImplementationForInterfaceMember(member) is IMethodSymbol implementation && IsModuleDefined(implementation)
            ? implementation
            : null;
    }

    // IEquatable<T>.Equals, of a type EquatableEquals is for.
    public static IMethodSymbol? EquatableMember(ITypeSymbol type)
    {
        if (type is not INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct or TypeKind.Interface, IsRecord: false } named
            || type.SpecialType is SpecialType.System_Object or SpecialType.System_String or SpecialType.System_Decimal
                or SpecialType.System_IntPtr or SpecialType.System_UIntPtr
            || ScalarOf(type) is not null)
        {
            return null;
        }

        var equatable = named.AllInterfaces.FirstOrDefault(candidate =>
            FullName(candidate.OriginalDefinition) == "System.IEquatable`1"
            && SymbolEqualityComparer.Default.Equals(candidate.TypeArguments[0], type));
        return equatable?.GetMembers("Equals").OfType<IMethodSymbol>().SingleOrDefault();
    }

    // A struct's own override of Equals(object) or GetHashCode, which the
    // CLR's ObjectEqualityComparer<T> (and ValueType.Equals, for a field)
    // calls. A record struct's are its record members; the runtime's
    // ValueTuple and Nullable compare as their fields, as their overrides
    // do.
    public IMethodSymbol? StructObjectOverride(ITypeSymbol type, string slot) =>
        type is INamedTypeSymbol { IsRecord: false } named && IsStruct(named) && !IsValueTuple(named) && !IsRuntimeNullable(named)
            ? ObjectOverride(named, ObjectMethod(slot))
            : null;

    // The types of a struct's fields, in its layout's order, as the struct
    // itself has them: a shared instantiation's layout is its canonical
    // form's (Frontend.Sharing), whose fields are over object, where
    // equality and hashing are the exact type arguments'.
    public IReadOnlyList<ITypeSymbol> ExactFieldTypes(ITypeSymbol type)
    {
        var layout = StructOf(type);
        if (Untupled(type) is not INamedTypeSymbol exact || SymbolEqualityComparer.Default.Equals(exact, layout.Symbol))
        {
            return layout.Fields.Select(field => field.Type).ToList();
        }

        return layout.Fields
            .Select(field => exact.GetMembers(field.Name).OfType<IFieldSymbol>().FirstOrDefault()?.Type ?? field.Type)
            .ToList();
    }

    // The runtime's ValueTuple, whose Equals compares its elements as
    // EqualityComparer<T>.Default does; other structs without an Equals
    // of their own compare theirs as ValueType.Equals does, by Equals(object).
    public static bool IsValueTuple(ITypeSymbol type) =>
        Untupled(type) is INamedTypeSymbol { Name: "ValueTuple", Arity: > 0, ContainingNamespace: { Name: "System" } system }
        && system.ContainingNamespace.IsGlobalNamespace;

    // A hash consistent with it.
    public void DemandHash(ITypeSymbol type)
    {
        if (!hashDemands.Add(type))
        {
            return;
        }

        if (IsDecimalType(type))
        {
            EnsureMethod(DecimalHash, Substitution.Empty);
        }
        else if (IsVector128(type))
        {
            EnsureMethod(VectorHelper("Hash", ((INamedTypeSymbol)type).TypeArguments[0]), Substitution.Empty);
        }
        else if (type is INamedTypeSymbol { IsRecord: true, TypeKind: TypeKind.Class } record)
        {
            DemandObjectSlot("GetHashCode", record);
        }
        else if (type is INamedTypeSymbol { IsRecord: true } recordStruct)
        {
            EnsureMethod(ObjectOverride(recordStruct, ObjectMethod("GetHashCode"))!, Substitution.Empty);
        }
        else if (StructObjectOverride(type, "GetHashCode") is { } overriding)
        {
            EnsureMethod(overriding, Substitution.Empty);
        }
        else if (IsStruct(type))
        {
            foreach (var fieldType in ExactFieldTypes(type))
            {
                DemandHash(fieldType);
            }
        }
        else if (IsObjectType(type))
        {
            DemandObjectMember("GetHashCode");
        }
        else if (type is INamedTypeSymbol { TypeKind: TypeKind.Interface or TypeKind.Class } implemented
                 && (implemented.TypeKind == TypeKind.Interface || IsSourceClass(implemented))
                 && (RecordImplements(implemented) || objectOverrides.Contains("GetHashCode")))
        {
            DemandObjectSlot("GetHashCode", implemented);
        }
    }

    // A value's ToString, where it formats: a record's or a struct's
    // override, or any object's.
    public void DemandPrinting(ITypeSymbol? type)
    {
        if (VectorLane(type) is not null)
        {
            EnsureMethod(VectorHelper("Format", ((INamedTypeSymbol)type!).TypeArguments[0]), Substitution.Empty);
            return;
        }

        if (type is INamedTypeSymbol { TypeKind: TypeKind.Enum } enumType)
        {
            DemandEnumFormatter(enumType);
            return;
        }

        if (ScalarOf(type) is Scalar.F32 or Scalar.F64)
        {
            EnsureRuntimeMethod("Number", ScalarOf(type) == Scalar.F32 ? "FormatSingle" : "FormatDouble", 2);
            return;
        }

        if (IsDecimalType(type))
        {
            // Its ToString, or its format in an interpolation.
            EnsureRuntimeMethod("Number", "FormatDecimal", 2);
            type = RuntimeDecimal;
        }

        if (type is INamedTypeSymbol { IsRecord: true, TypeKind: TypeKind.Class } record)
        {
            DemandObjectSlot("ToString", record);
        }
        else if (type is INamedTypeSymbol { TypeKind: TypeKind.Struct } value
                 && ObjectOverride(value, ObjectMethod("ToString")) is { } overriding)
        {
            EnsureMethod(overriding, Substitution.Empty);
        }
        else if (IsObjectType(type) || type is INamedTypeSymbol { TypeKind: TypeKind.Interface or TypeKind.Class }
                 && type.SpecialType != SpecialType.System_String && !IsSupportedDelegate(type))
        {
            DemandObjectMember("ToString");
        }
    }

    // A dispatch through a System.Object slot on a receiver of a static
    // type: the overrides of the records it can be, now and later.
    public void DemandObjectSlot(string slot, INamedTypeSymbol receiver)
    {
        if (objectSlotDemands.Any(demand => demand.Slot == slot && SymbolEqualityComparer.Default.Equals(demand.Receiver, receiver)))
        {
            return;
        }

        // A sealed record's are called directly.
        objectSlots |= !(receiver.IsSealed && receiver.TypeKind == TypeKind.Class);
        objectSlotDemands.Add((slot, receiver));
        var member = ObjectMethod(slot);
        foreach (var record in recordClasses.Where(record => DerivesFrom(record, receiver)).ToList())
        {
            if (ObjectOverride(record, member) is { } overriding)
            {
                EnsureMethod(overriding, Substitution.Empty);
            }
        }
    }

    // Whether a record class registered so far may implement the interface.
    private bool RecordImplements(INamedTypeSymbol implemented) =>
        recordClasses.Any(record => DerivesFrom(record, implemented));
}
