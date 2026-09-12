// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// The runtime's intrinsics (runtime/Collections.cs): EqualityComparer<T>'s
// default equality and a hash consistent with it. Equality follows the
// comparer the CLR chooses for T: integers, bools, chars and enums by value,
// floating point by Equals (NaN equals NaN, 0 equals -0), a type
// implementing IEquatable<T> by its Equals(T), a nullable by its value, and
// anything else by Equals(object): an override, else class and interface
// instances and arrays by identity, and structs field by field, as
// ValueType.Equals compares them. Delegates compare by target and method in
// the CLR, which is not expressible here.
internal sealed partial class FunctionEmitter
{

    private WType EmitRuntimeIntrinsic(Intrinsic intrinsic, IMethodSymbol method, int[] arguments)
    {
        var type = Sub(method.TypeArguments[0]);
        if (intrinsic == Intrinsic.Equal)
        {
            EmitEqual(type, arguments[0], arguments[1]);
        }
        else
        {
            EmitHash(type, arguments[0]);
        }

        return WType.I32;
    }

    private WType EmitOrderingIntrinsic(Intrinsic intrinsic, IMethodSymbol method, int[] arguments)
    {
        EmitOrdering(intrinsic, Sub(method.TypeArguments[0]), arguments[0], arguments.Length > 1 ? arguments[1] : -1);
        return WType.I32;
    }

    // Comparer<T>.Default's order of two values in locals (Compare, and the
    // sort helpers' LessThan and GreaterThan and IsNaNOf).
    private void EmitOrdering(Intrinsic intrinsic, ITypeSymbol type, int left, int right)
    {
        if (frontend.IsRuntimeNullable(type))
        {
            EmitNullableOrdering(intrinsic, type, left, right);
            return;
        }

        if (Frontend.ScalarOf(type) is not { } scalar)
        {
            EmitComparableOrdering(intrinsic, type, left, right);
            return;
        }

        switch (intrinsic)
        {
            case Intrinsic.LessThan or Intrinsic.GreaterThan:
                LocalGet(left);
                LocalGet(right);
                code.Byte(BinaryOpcode(
                    scalar == Scalar.Bool ? Scalar.U8 : scalar,
                    intrinsic == Intrinsic.LessThan ? BinaryOperatorKind.LessThan : BinaryOperatorKind.GreaterThan));
                return;
            case Intrinsic.IsNaNOf:
                if (IsFloating(scalar))
                {
                    LocalGet(left);
                    LocalGet(left);
                    code.Byte(BinaryOpcode(scalar, BinaryOperatorKind.NotEquals));
                }
                else
                {
                    code.I32(0);
                }

                return;
            default:
                // (a > b) - (a < b), with NaN below every number and equal
                // to itself, as float's and double's CompareTo have it.
                var ordered = scalar == Scalar.Bool ? Scalar.U8 : scalar;
                LocalGet(left);
                LocalGet(right);
                code.Byte(BinaryOpcode(ordered, BinaryOperatorKind.GreaterThan));
                LocalGet(left);
                LocalGet(right);
                code.Byte(BinaryOpcode(ordered, BinaryOperatorKind.LessThan));
                code.Byte(0x6b); // i32.sub
                if (IsFloating(scalar))
                {
                    // Where either is NaN: 0 if both are, -1 if the left is, else 1.
                    int nanLeft = NewLocal(WType.I32);
                    LocalGet(left);
                    LocalGet(left);
                    code.Byte(BinaryOpcode(scalar, BinaryOperatorKind.NotEquals));
                    LocalSet(nanLeft);
                    int nanRight = NewLocal(WType.I32);
                    LocalGet(right);
                    LocalGet(right);
                    code.Byte(BinaryOpcode(scalar, BinaryOperatorKind.NotEquals));
                    LocalSet(nanRight);
                    int ordinary = Save(WType.I32);
                    LocalGet(nanLeft);
                    LocalGet(nanRight);
                    code.Byte(0x72); // i32.or
                    EmitChoice(WType.I32, () =>
                    {
                        LocalGet(nanRight);
                        LocalGet(nanLeft);
                        code.Byte(0x6b); // i32.sub
                    }, () => LocalGet(ordinary));
                }

                return;
        }
    }

    // A nullable's order, as the CLR's NullableComparer<T> has it (and its
    // ObjectComparer, over the boxes, for a T of IComparable alone): no
    // value first, two without equal, else the values' order.
    private void EmitNullableOrdering(Intrinsic intrinsic, ITypeSymbol type, int left, int right)
    {
        if (intrinsic == Intrinsic.IsNaNOf)
        {
            code.I32(0);
            return;
        }

        var layout = frontend.StructOf(type);
        int has = layout.Fields.FindIndex(field => field.Name == "hasValue");
        int held = layout.Fields.FindIndex(field => field.Name == "value");
        var valueType = ((INamedTypeSymbol)type).TypeArguments[0];
        var mappedValue = Map(valueType);
        code.OpIndex(0x20, left + layout.Offsets[has]); // local.get
        code.OpIndex(0x20, right + layout.Offsets[has]); // local.get
        code.Byte(0x71); // i32.and
        EmitChoice(WType.I32, () =>
        {
            PushLocal(left + layout.Offsets[held], mappedValue);
            int leftValue = Save(mappedValue);
            PushLocal(right + layout.Offsets[held], mappedValue);
            int rightValue = Save(mappedValue);
            EmitOrdering(Intrinsic.Compare, valueType, leftValue, rightValue);
        }, () =>
        {
            code.OpIndex(0x20, left + layout.Offsets[has]);
            code.OpIndex(0x20, right + layout.Offsets[has]);
            code.Byte(0x6b); // i32.sub
        });
        if (intrinsic is Intrinsic.LessThan or Intrinsic.GreaterThan)
        {
            code.I32(0);
            code.Byte(intrinsic == Intrinsic.LessThan ? (byte)0x48 : (byte)0x4a); // i32.lt_s, i32.gt_s
        }
    }

    // The default order of a type implementing IComparable<T>, as the CLR's
    // GenericComparer (Compare: a null first) and GenericArraySortHelper
    // (LessThan: the left's CompareTo, the left never null) use it; a type
    // without one throws NotSupportedException.
    private void EmitComparableOrdering(Intrinsic intrinsic, ITypeSymbol type, int left, int right)
    {
        if (intrinsic == Intrinsic.IsNaNOf)
        {
            code.I32(0);
            return;
        }

        if (frontend.ComparableCompareTo(type) is not { } compareTo)
        {
            if (frontend.ObjectCompareTo(type) is { } objectCompareTo)
            {
                EmitObjectComparerOrdering(intrinsic, type, objectCompareTo, left, right);
                return;
            }

            Call(frontend.MethodIndex(frontend.RuntimeMethod("Ordering", "Unsupported", 0)));
            return;
        }

        var mapped = Map(type);
        void CompareTo()
        {
            if (mapped.IsTuple)
            {
                CallOnPlace(new(LocationKind.Local, mapped, type, Local: left, ReadOnly: true), compareTo, [right]);
                return;
            }

            CheckNull(left);
            EmitReimplementedCall(type, frontend.ComparableMember(type), compareTo, left, () => LocalGet(right));
        }

        if (intrinsic is Intrinsic.LessThan or Intrinsic.GreaterThan)
        {
            CompareTo();
            code.I32(0);
            code.Byte(intrinsic == Intrinsic.LessThan ? (byte)0x48 : (byte)0x4a); // i32.lt_s, i32.gt_s
            return;
        }

        if (mapped.IsTuple)
        {
            CompareTo();
            return;
        }

        // Compare: 0 for two nulls, a null below anything else.
        LocalGet(left);
        code.Byte(0xd1); // ref.is_null
        EmitChoice(WType.I32, () =>
        {
            LocalGet(right);
            code.Byte(0xd1); // ref.is_null
            code.Byte(0x45); // i32.eqz
            code.I32(-1);
            code.Byte(0x6c); // i32.mul
        }, () =>
        {
            LocalGet(right);
            code.Byte(0xd1); // ref.is_null
            EmitChoice(WType.I32, () => code.I32(1), CompareTo);
        });
    }

    // The order of a type implementing the non-generic IComparable alone,
    // as the CLR's ObjectComparer<T> has it (Comparer.Default.Compare of
    // the values as objects): a reference equal to itself, then a null
    // first, else the left's CompareTo(object) of the right, boxed; the
    // sort helpers' LessThan and GreaterThan by its sign.
    private void EmitObjectComparerOrdering(Intrinsic intrinsic, ITypeSymbol type, IMethodSymbol compareTo, int left, int right)
    {
        var mapped = Map(type);
        if (type.IsValueType)
        {
            PushLocal(right, mapped);
            EmitBox(type);
            int boxed = Save(ObjectRef);
            CallOnPlace(new(LocationKind.Local, mapped, type, Local: left, ReadOnly: true), compareTo, [boxed]);
        }
        else
        {
            LocalGet(left);
            LocalGet(right);
            code.Byte(0xd3); // ref.eq
            EmitChoice(WType.I32, () => code.I32(0), () =>
            {
                LocalGet(left);
                code.Byte(0xd1); // ref.is_null
                EmitChoice(WType.I32, () => code.I32(-1), () =>
                {
                    LocalGet(right);
                    code.Byte(0xd1); // ref.is_null
                    EmitChoice(WType.I32, () => code.I32(1), () =>
                        EmitReimplementedCall(type, frontend.ObjectComparableMember(type), compareTo, left, () => LocalGet(right)));
                });
            });
        }

        if (intrinsic is Intrinsic.LessThan or Intrinsic.GreaterThan)
        {
            code.I32(0);
            code.Byte(intrinsic == Intrinsic.LessThan ? (byte)0x48 : (byte)0x4a); // i32.lt_s, i32.gt_s
        }
    }

    // Leaves 1 when the values in two locals of `type` are equal, as
    // EqualityComparer<T>.Default decides: by IEquatable<T>.Equals where
    // the type implements it (GenericEqualityComparer), a nullable by its
    // value's (NullableEqualityComparer), else as x.Equals((object)y) does
    // (ObjectEqualityComparer), which `byObject` asks for alone (a box's
    // Equals, and ValueType.Equals of a struct's fields). A record equals
    // by its Equals(R).
    private void EmitEqual(ITypeSymbol type, int left, int right, bool byObject = false)
    {
        var mapped = frontend.MapType(type);
        if (Frontend.VectorLane(type) is { } lane)
        {
            // Vector128<T>.Equals: lane by lane, NaN equal to NaN.
            EmitVectorEquals(left, right, lane);
            return;
        }

        if (frontend.IsDecimalType(type))
        {
            PushLocal(left, mapped);
            PushLocal(right, mapped);
            Call(frontend.MethodIndex(frontend.DecimalEquality));
            return;
        }

        if (frontend.IsRuntimeNullable(type))
        {
            EmitNullableEqual(type, left, right, byObject);
            return;
        }

        if (!byObject && Frontend.EquatableEquals(type) is { } equals)
        {
            if (type.TypeKind == TypeKind.Struct)
            {
                EmitStructCallEqual(type, equals, left, right);
            }
            else
            {
                EmitReferenceEqual(type, equals, left, right, Frontend.EquatableMember(type));
            }

            return;
        }

        if (Frontend.IsRecordClass(type))
        {
            EmitReferenceEqual(type, Frontend.TypedEquals((INamedTypeSymbol)type), left, right);
            return;
        }

        if (Frontend.IsObjectType(type) || Frontend.IsArrayInterface(type))
        {
            // An array interface's value is any object, an array or string
            // too (an eqref): compared as an object is.
            EmitHelperEqual(left, right);
            return;
        }

        if (frontend.ObjectSlots && (frontend.TryInterface(type, out _) || frontend.OverridesObjectMember(type, "Equals")))
        {
            EmitObjectEqual((INamedTypeSymbol)type, left, right);
            return;
        }

        if (Frontend.IsRecordStruct(type))
        {
            EmitStructCallEqual(type, Frontend.TypedEquals((INamedTypeSymbol)type), left, right);
            return;
        }

        if (frontend.StructObjectOverride(type, "Equals") is { } overriding)
        {
            // The struct's Equals(object), given a box of the other.
            PushLocal(right, mapped);
            EmitBox(type);
            int boxed = Save(WType.Ref(frontend.BoxOf(type).Heap));
            CallOnPlace(new(LocationKind.Local, mapped, type, Local: left, ReadOnly: true), overriding, [boxed]);
            return;
        }

        if (!mapped.IsTuple)
        {
            EmitLeafEqual(mapped, left, right);
            return;
        }

        EmitFieldsEqual(type, left, right, byObject: !Frontend.IsValueTuple(type));
    }

    // A struct's Equals(T) on the left value, given the right.
    private void EmitStructCallEqual(ITypeSymbol type, IMethodSymbol equals, int left, int right)
    {
        var mapped = frontend.MapType(type);
        PushLocal(right, mapped);
        int other = Save(mapped);
        CallOnPlace(new(LocationKind.Local, mapped, type, Local: left, ReadOnly: true), equals, [other]);
    }

    // Two nullables are equal when neither has a value, or both have equal
    // ones; a value is compared only with another.
    private void EmitNullableEqual(ITypeSymbol type, int left, int right, bool byObject)
    {
        var layout = frontend.StructOf(type);
        int has = layout.Fields.FindIndex(field => field.Name == "hasValue");
        int held = layout.Fields.FindIndex(field => field.Name == "value");
        var valueType = ((INamedTypeSymbol)type).TypeArguments[0];
        // Raw reads: a struct's first local stands for all of it.
        void BothHave()
        {
            code.OpIndex(0x20, left + layout.Offsets[has]); // local.get
            code.OpIndex(0x20, right + layout.Offsets[has]); // local.get
        }

        BothHave();
        code.Byte(0x71); // i32.and
        OpenBlock(0x04, WType.I32, new object());
        EmitEqual(
            valueType,
            Leaf(valueType, left + layout.Offsets[held]),
            Leaf(valueType, right + layout.Offsets[held]),
            byObject);
        code.Byte(0x05); // else
        BothHave();
        code.Byte(0x46); // i32.eq
        CloseBlock();
    }

    private bool IsStringHeap(WType type) => type.IsRef && frontend.StringUsed && type.Heap == frontend.StringHeap;

    private void EmitLeafEqual(WType type, int left, int right)
    {
        code.OpIndex(0x20, left); // local.get
        code.OpIndex(0x20, right); // local.get
        if (IsStringHeap(type))
        {
            CallString("Equal", 2);
            return;
        }

        if (type.IsRef && frontend.DelegateLayoutOfHeap(type.Heap) is { } layout)
        {
            // Delegates by type, method and target.
            Call(layout.Equal);
            return;
        }

        if (type.IsRef)
        {
            code.Byte(0xd3); // ref.eq
            return;
        }

        if (type == WType.I32)
        {
            code.Byte(0x46); // i32.eq
            return;
        }

        if (type == WType.I64)
        {
            code.Byte(0x51); // i64.eq
            return;
        }

        // left == right, or both NaN.
        bool single = type == WType.F32;
        code.Byte(single ? (byte)0x5b : (byte)0x61); // f32.eq / f64.eq
        code.OpIndex(0x20, left);
        code.OpIndex(0x20, left);
        code.Byte(single ? (byte)0x5c : (byte)0x62); // ne: left is NaN
        code.OpIndex(0x20, right);
        code.OpIndex(0x20, right);
        code.Byte(single ? (byte)0x5c : (byte)0x62); // ne: right is NaN
        code.Byte(0x71); // i32.and
        code.Byte(0x72); // i32.or
    }

    // Leaves a hash code of the value in a local of `type`: equal values
    // hash alike, as Equal decides. A record, or a struct overriding it,
    // hashes by its GetHashCode.
    private void EmitHash(ITypeSymbol type, int value)
    {
        var mapped = frontend.MapType(type);
        if (Frontend.IsVector128(type))
        {
            LocalGet(value);
            Call(frontend.MethodIndex(frontend.VectorHelper("Hash", ((INamedTypeSymbol)type).TypeArguments[0])));
            return;
        }

        if (frontend.IsDecimalType(type))
        {
            PushLocal(value, mapped);
            Call(frontend.MethodIndex(frontend.DecimalHash));
            return;
        }

        var getHashCode = type.IsRecord
            ? Frontend.ObjectOverride((INamedTypeSymbol)type, frontend.ObjectMethod("GetHashCode"))
            : null;
        if (getHashCode is not null && Frontend.IsRecordClass(type))
        {
            code.OpIndex(0x20, value); // local.get
            code.Byte(0xd1); // ref.is_null
            OpenBlock(0x04, WType.I32, new object());
            code.I32(0);
            code.Byte(0x05); // else
            code.OpIndex(0x20, value);
            EmitCallTarget(frontend.ResolveCall(getHashCode, type, false), value);
            CloseBlock();
            return;
        }

        if ((getHashCode ?? frontend.StructObjectOverride(type, "GetHashCode")) is { } structHash)
        {
            CallOnPlace(new(LocationKind.Local, mapped, type, Local: value, ReadOnly: true), structHash, []);
            return;
        }

        if (Frontend.IsObjectType(type) || Frontend.IsArrayInterface(type))
        {
            EmitHelperHash(value);
            return;
        }

        if (frontend.ObjectSlots && (frontend.TryInterface(type, out _) || frontend.OverridesObjectMember(type, "GetHashCode")))
        {
            // An interface value may be a record, which hashes by value.
            code.OpIndex(0x20, value); // local.get
            code.Byte(0xd1); // ref.is_null
            OpenBlock(0x04, WType.I32, new object());
            code.I32(0);
            code.Byte(0x05); // else
            code.OpIndex(0x20, value);
            EmitCallTarget(frontend.ObjectSlotCall("GetHashCode", (INamedTypeSymbol)type), value);
            CloseBlock();
            return;
        }

        if (!mapped.IsTuple)
        {
            EmitLeafHash(mapped, value, Frontend.ScalarOf(type));
            return;
        }

        EmitFieldsHash(type, value);
    }

    // The CLR's GetHashCode of a scalar (a char's mixes its bits, as the
    // CLR's does); a string's contents; an object's identity.
    private void EmitLeafHash(WType type, int value, Scalar? scalar = null)
    {
        if (IsStringHeap(type))
        {
            // A string's contents; null hashes to 0.
            code.OpIndex(0x20, value); // local.get
            code.Byte(0xd1); // ref.is_null
            OpenBlock(0x04, WType.I32, new object());
            code.I32(0);
            code.Byte(0x05); // else
            code.OpIndex(0x20, value);
            CallString("Hash", 1);
            CloseBlock();
            return;
        }

        if (type.IsRef && frontend.DelegateLayoutOfHeap(type.Heap) is { } layout)
        {
            EmitDelegateHash(value, layout);
            return;
        }

        if (type.IsRef && frontend.IsArrayHeap(type.Heap))
        {
            EmitArrayHash(value);
            return;
        }

        if (type.IsRef)
        {
            EmitIdentityHash(type, value);
            return;
        }

        code.OpIndex(0x20, value); // local.get
        if (type == WType.I32)
        {
            switch (scalar)
            {
                case Scalar.Char:
                    code.OpIndex(0x20, value);
                    code.I32(16);
                    code.Byte(0x74); // i32.shl
                    code.Byte(0x72); // i32.or
                    break;
            }

            return;
        }

        if (type == WType.I64)
        {
            EmitFoldWide();
            return;
        }

        // The bits, with 0 and -0 alike and every NaN alike, as the CLR's
        // float and double GetHashCode have them.
        if (type == WType.F32)
        {
            code.Byte(0xbc); // i32.reinterpret_f32
            int bits = Save(WType.I32);
            LocalGet(bits);
            code.I32(0x7f800000);
            code.Byte(0x71); // i32.and
            LocalGet(bits);
            LocalGet(bits);
            code.I32(1);
            code.Byte(0x6b); // i32.sub
            code.I32(0x7fffffff);
            code.Byte(0x71); // i32.and
            code.I32(0x7f800000);
            code.Byte(0x4f); // i32.ge_u
            code.Byte(0x1b); // select
            return;
        }

        code.Byte(0xbd); // i64.reinterpret_f64
        int wide = Save(WType.I64);
        LocalGet(wide);
        code.I64(0x7ff0000000000000);
        code.Byte(0x83); // i64.and
        LocalGet(wide);
        LocalGet(wide);
        code.I64(1);
        code.Byte(0x7d); // i64.sub
        code.I64(0x7fffffffffffffff);
        code.Byte(0x83); // i64.and
        code.I64(0x7ff0000000000000);
        code.Byte(0x5a); // i64.ge_u
        code.Byte(0x1b); // select
        EmitFoldWide();
    }

    // A delegate's hash: its type's and method's ids, which equal delegates
    // share (the CLR's mixes in its target's identity and type's hash,
    // which vary from run to run); 0 for null.
    private void EmitDelegateHash(int value, DelegateLayout layout)
    {
        LocalGet(value);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(0);
        code.Byte(0x05); // else
        LocalGet(value);
        code.RefCast(WType.NonNullRef(layout.Heap));
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField); // struct.get
        code.I32(31);
        code.Byte(0x6c); // i32.mul
        LocalGet(value);
        code.RefCast(WType.NonNullRef(layout.Heap));
        code.Gc(2, layout.Heap, Frontend.DelegateMethodField); // struct.get
        code.Byte(0x6a); // i32.add
        CloseBlock();
    }

    // An array's hash: its length, which it keeps for life, so equal (the
    // same) arrays hash alike; the CLR's identity hash is its own. 0 for
    // null.
    private void EmitArrayHash(int value)
    {
        LocalGet(value);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(0);
        code.Byte(0x05); // else
        LocalGet(value);
        code.RefCast(WType.NonNullRef(Frontend.ArrayHeap));
        code.Gc(15); // array.len
        code.I32(unchecked((int)0x9E3779B1));
        code.Byte(0x6c); // i32.mul
        CloseBlock();
    }

    // (int)bits ^ (int)(bits >> 32) of the i64 on the stack.
    private void EmitFoldWide()
    {
        int wide = Save(WType.I64);
        LocalGet(wide);
        code.Byte(0xa7); // i32.wrap_i64
        LocalGet(wide);
        code.I64(32);
        code.Byte(0x88); // i64.shr_u
        code.Byte(0xa7); // i32.wrap_i64
        code.Byte(0x73); // i32.xor
    }

    // An object's identity hash, assigned from the module's counter the
    // first time it is asked for (never 0); null hashes to 0.
    private void EmitIdentityHash(WType type, int value)
    {
        var (heap, field) = frontend.HashField(type);
        int hash = NewLocal(WType.I32);
        code.OpIndex(0x20, value); // local.get
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.Void, new object());
        code.I32(0);
        LocalSet(hash);
        code.Byte(0x05); // else
        code.OpIndex(0x20, value);
        code.Gc(2, heap, field); // struct.get
        LocalSet(hash);
        LocalGet(hash);
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        GlobalGet(frontend.NextHashGlobal);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(hash);
        LocalGet(hash);
        LocalGet(hash);
        code.Byte(0x45); // i32.eqz: the counter wrapped to 0, which means unassigned
        code.Byte(0x6a); // i32.add
        LocalSet(hash);
        LocalGet(hash);
        GlobalSet(frontend.NextHashGlobal);
        code.OpIndex(0x20, value);
        LocalGet(hash);
        code.Gc(5, heap, field); // struct.set
        CloseBlock();
        CloseBlock();
        LocalGet(hash);
    }
}
