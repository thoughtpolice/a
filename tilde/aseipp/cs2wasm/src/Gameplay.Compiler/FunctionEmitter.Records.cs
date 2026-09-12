// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Object members over a type's fields (see Frontend.Records): the defaults
// of System.Object's, formatting, and field-by-field equality and hashing.
internal sealed partial class FunctionEmitter
{

    // The vtable slots this function dispatches through.
    public HashSet<SlotUse> SlotUses { get; } = [];

    public CompileError? DeferredError { get; private set; }

    // System.Object's Equals and GetHashCode for a class that does not
    // override them: identity. Like a thunk, no call of its own.
    private WasmFunction EmitObjectDefault()
    {
        if (plan.Parameters.Length == 2)
        {
            LocalGet(0);
            LocalGet(1);
            code.Byte(0xd3); // ref.eq
        }
        else
        {
            EmitIdentityHash(plan.Parameters[0], 0);
        }

        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    private int LoadToLocal(Location location)
    {
        Load(location);
        return Save(location.Type);
    }

    // A field of a class instance in a local, known not to be null.
    private Location FieldOfObject(int receiver, IFieldSymbol field)
    {
        var type = frontend.MapType(field.Type);
        return new(
            LocationKind.Field,
            type,
            field.Type,
            Receiver: receiver,
            Container: frontend.MapType(field.ContainingType),
            Field: frontend.FieldIndex(field),
            Boxed: type.IsTuple,
            NonNull: true);
    }

    // Of a struct at a place, or of a class instance in a local.
    private int LoadMember(Location? place, int receiver, ITypeSymbol type, ISymbol member)
    {
        switch (member)
        {
            case IFieldSymbol field:
                return LoadToLocal(place is not null ? FieldOfPlace(place, field, readOnly: true) : FieldOfObject(receiver, field));
            case IPropertySymbol { GetMethod: { } getter } property:
                if (place is not null)
                {
                    CallOnPlace(place, getter, []);
                }
                else
                {
                    LocalGet(receiver);
                    EmitCallTarget(frontend.ResolveCall(getter, type, false), receiver);
                }

                return Save(frontend.MapType(property.Type));
            default:
                throw new InternalCompilerError($"'{member.ToDisplayString()}' has no value to read.");
        }
    }

    // A value's ToString, from a local: a string itself; a record's
    // ToString, with a null record class formatting as ""; a struct's
    // override or its type's name; any other object's ToString; or a
    // scalar's.
    private void EmitFormattedLocal(ITypeSymbol type, int value)
    {
        if (Frontend.IsVector128(type))
        {
            LocalGet(value);
            Call(frontend.MethodIndex(frontend.VectorHelper("Format", ((INamedTypeSymbol)type).TypeArguments[0])));
            return;
        }

        if (IsString(type))
        {
            LocalGet(value);
            return;
        }

        if (frontend.IsDecimalType(type))
        {
            PushLocal(value, frontend.MapType(type));
            code.Byte(0xd0); // ref.null: no format
            code.Signed(frontend.StringHeap);
            Call(frontend.MethodIndex(frontend.RuntimeMethod("Number", "FormatDecimal", 2)));
            return;
        }

        if (!type.IsRecord && Frontend.IsStruct(type))
        {
            if (Frontend.ObjectOverride((INamedTypeSymbol)type, frontend.ObjectMethod("ToString")) is { } overriding)
            {
                CallOnPlace(new(LocationKind.Local, frontend.MapType(type), type, Local: value, ReadOnly: true), overriding, []);
                return;
            }

            if (Frontend.ClrName((INamedTypeSymbol)type) is not { } name)
            {
                string message = $"Formatting '{type.ToDisplayString()}' is unsupported: the CLR's names of generic types are not reproduced.";
                throw new CompileError(message);
            }

            EmitLiteral(name);
            return;
        }

        if (type is IArrayTypeSymbol && Frontend.FormatProblem(type) is null)
        {
            // Its type's name, which is its static type's; null prints
            // nothing.
            LocalGet(value);
            code.Byte(0xd1); // ref.is_null
            OpenBlock(0x04, Text, new object());
            EmitLiteral("");
            code.Byte(0x05); // else
            EmitLiteral(Frontend.ClrName(type)!);
            CloseBlock();
            return;
        }

        if (!type.IsRecord && frontend.MapType(type).IsRef && !Frontend.IsSupportedDelegate(type) && type is not IArrayTypeSymbol)
        {
            EmitHelperToString(value);
            return;
        }

        var toString = type.IsRecord ? Frontend.ObjectOverride((INamedTypeSymbol)type, frontend.ObjectMethod("ToString")) : null;
        if (toString is not null && Frontend.IsRecordClass(type))
        {
            LocalGet(value);
            code.Byte(0xd1); // ref.is_null
            OpenBlock(0x04, WType.Ref(frontend.StringHeap), new object());
            EmitLiteral("");
            code.Byte(0x05); // else
            LocalGet(value);
            EmitCallTarget(frontend.ResolveCall(toString, type, false), value);
            CloseBlock();
            return;
        }

        if (toString is not null)
        {
            CallOnPlace(new(LocationKind.Local, frontend.MapType(type), type, Local: value, ReadOnly: true), toString, []);
            return;
        }

        LocalGet(value);
        FormatScalar(type);
    }

    // Leaves 1 when the struct values from `left` and `right` on are equal
    // field by field: each as EqualityComparer<T>.Default compares it (a
    // record struct's or a tuple's Equals), or `byObject`, as
    // ValueType.Equals does, by the field's Equals(object).
    private void EmitFieldsEqual(ITypeSymbol type, int left, int right, bool byObject = false)
    {
        var layout = frontend.StructOf(type);
        var fieldTypes = frontend.ExactFieldTypes(type);
        code.I32(1);
        for (int position = 0; position < layout.Fields.Count; position++)
        {
            var fieldType = fieldTypes[position];
            var stored = layout.Fields[position].Type;
            EmitEqual(
                fieldType,
                ExactLeaf(fieldType, stored, left + layout.Offsets[position]),
                ExactLeaf(fieldType, stored, right + layout.Offsets[position]),
                byObject);
            code.Byte(0x71); // i32.and
        }
    }

    // A field's leaf as a local of its exact type: a shared struct's
    // reference field holds its canonical type, which a cast narrows.
    private int ExactLeaf(ITypeSymbol fieldType, ITypeSymbol stored, int local)
    {
        var exact = frontend.MapType(fieldType);
        var canonical = frontend.MapType(stored);
        if (!exact.IsRef || exact == canonical)
        {
            return Leaf(fieldType, local);
        }

        code.OpIndex(0x20, local); // local.get
        CastToShape(canonical, exact);
        int copy = NewLocal(exact);
        code.OpIndex(0x21, copy); // local.set
        return copy;
    }

    // A struct's leaf as a local of its own: the struct's first local
    // stands for the whole struct (tupleLocals), so a field held there is
    // copied out before code that reads it as a local.
    private int Leaf(ITypeSymbol fieldType, int local)
    {
        var mapped = frontend.MapType(fieldType);
        if (!mapped.IsRef || !tupleLocals.ContainsKey(local))
        {
            return local;
        }

        code.OpIndex(0x20, local); // local.get
        int copy = NewLocal(mapped);
        code.OpIndex(0x21, copy); // local.set
        return copy;
    }

    private void EmitFieldsHash(ITypeSymbol type, int value)
    {
        var layout = frontend.StructOf(type);
        var fieldTypes = frontend.ExactFieldTypes(type);
        code.I32(0);
        for (int position = 0; position < layout.Fields.Count; position++)
        {
            code.I32(31);
            code.Byte(0x6c); // i32.mul
            EmitHash(fieldTypes[position], ExactLeaf(fieldTypes[position], layout.Fields[position].Type, value + layout.Offsets[position]));
            code.Byte(0x6a); // i32.add
        }
    }

    // EqualityComparer<T>.Default.Equals of class or interface values in
    // locals, by a typed Equals (a record's Equals(R), IEquatable<T>'s):
    // both null, or the left's Equals of the right.
    private void EmitReferenceEqual(ITypeSymbol type, IMethodSymbol equals, int left, int right, IMethodSymbol? member = null)
    {
        code.OpIndex(0x20, left); // local.get
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.OpIndex(0x20, right);
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x05); // else
        code.OpIndex(0x20, right);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(0);
        code.Byte(0x05); // else
        EmitReimplementedCall(type, member, equals, left, () => code.OpIndex(0x20, right));
        CloseBlock();
        CloseBlock();
    }

    // A call of T's implementation of an interface member (none: of the
    // method) on `self`, not null, its arguments pushed by `arguments`, as
    // the interface dispatches it: a class of the module deriving from T
    // that re-implements the interface runs its own, tested for most
    // derived first (Frontend.Reimplementation).
    private void EmitReimplementedCall(ITypeSymbol type, IMethodSymbol? member, IMethodSymbol implementation, int self, Action arguments)
    {
        var targets = member is null ? [] : frontend.Reimplementations(type, member);
        void Direct(ITypeSymbol receiverType, IMethodSymbol method, int receiver)
        {
            code.OpIndex(0x20, receiver); // local.get
            arguments();
            EmitCallTarget(frontend.ResolveCall(method, receiverType, false, generic), receiver);
        }

        if (targets.Count != 0)
        {
            // In a local of its own, which a type test reads.
            code.OpIndex(0x20, self);
            self = Save(Map(type));
        }

        void Dispatch(int index)
        {
            if (index == targets.Count)
            {
                Direct(type, implementation, self);
                return;
            }

            var (reimplementing, method) = targets[index];
            EmitTypeTest(self, reimplementing);
            EmitChoice(Map(implementation.ReturnType), () =>
            {
                var cast = WType.NonNullRef(Map(reimplementing).Heap);
                code.OpIndex(0x20, self);
                code.RefCast(cast);
                Direct(reimplementing, method, Save(cast));
            }, () => Dispatch(index + 1));
        }

        Dispatch(0);
    }

    // ObjectEqualityComparer's Equals of $Object values in locals, whose
    // Equals a record may override: both null, or the left's Equals.
    private void EmitObjectEqual(INamedTypeSymbol type, int left, int right)
    {
        code.OpIndex(0x20, left); // local.get
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.OpIndex(0x20, right);
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x05); // else
        code.OpIndex(0x20, right);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(0);
        code.Byte(0x05); // else
        code.OpIndex(0x20, left);
        code.OpIndex(0x20, right);
        EmitCallTarget(frontend.ObjectSlotCall("Equals", type), left);
        CloseBlock();
        CloseBlock();
    }
}
