// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Reference conversions and type tests. An upcast is free: a subclass's
// struct is a Wasm subtype of its base's. A downcast tests the value's
// dynamic type with ref.test and faults with InvalidCast (the CLR's
// InvalidCastException) when it fails; null converts to null.
internal sealed partial class FunctionEmitter
{

    // Leaves 1 when the saved reference is not null and its dynamic type is
    // `type`, derives from it or implements it.
    private void EmitTypeTest(int value, ITypeSymbol type)
    {
        type = Sub(type);
        if (locals[value - parameterCount] is { IsRef: true, Heap: Frontend.EqHeap }
            && type is not IArrayTypeSymbol { IsSZArray: true })
        {
            RequireExactTest(type);
        }

        var target = Map(type);
        if (!target.IsRef)
        {
            if (!Frontend.IsBoxable(type) || !locals[value - parameterCount].IsRef)
            {
                throw new CompileError($"Type tests need a reference type, not '{type.ToDisplayString()}'.");
            }

            // A value type's box, exactly.
            EmitBoxTest(value, type);
            return;
        }

        if (frontend.TryInterface(type, out var implemented))
        {
            EmitImplementsTest(value, implemented);
            if (Frontend.IsArrayInterface(type))
            {
                EmitEnumerableSourceTest(value, type);
            }

            return;
        }

        if (type is IArrayTypeSymbol { IsSZArray: true, ElementType: var element } && element.IsReferenceType)
        {
            // By array covariance, an array of any type its elements
            // convert to by reference: of the module's array types, each
            // whose elements do (a closed world).
            code.I32(0);
            foreach (int heap in frontend.ArrayHeapsConvertingTo(element))
            {
                LocalGet(value);
                code.RefTest(WType.NonNullRef(heap));
                code.Byte(0x72); // i32.or
            }

            return;
        }

        if (frontend.TryLayout(type, out var shared) && frontend.SharesHeap(shared))
        {
            // Its class id (Frontend.Sharing).
            EmitClassIdTest(value, shared);
            return;
        }

        if (frontend.UsesRepresentation(type))
        {
            // A shared class nothing made.
            code.I32(0);
            return;
        }

        if (type is IArrayTypeSymbol familyArray && frontend.IsFamilyArray(familyArray))
        {
            // Its own subtype of its family's heap type.
            LocalGet(value);
            code.RefTest(WType.NonNullRef(frontend.ArrayAllocationHeap(familyArray)));
            return;
        }

        LocalGet(value);
        code.RefTest(WType.NonNullRef(target.Heap));
    }

    // An object implements an interface when its class's itables hold an
    // itable at the interface's id. A value whose static class is not
    // polymorphic implements none.
    private void EmitImplementsTest(int value, InterfaceLayout implemented)
    {
        var type = locals[value - parameterCount];
        if (type.IsRef && type.Heap == Frontend.EqHeap && frontend.ObjectHeap >= 0)
        {
            // An object or a union: a $Object first.
            LocalGet(value);
            code.RefTest(WType.NonNullRef(frontend.ObjectHeap));
            OpenBlock(0x04, WType.I32, new object());
            LocalGet(value);
            code.RefCast(WType.Ref(frontend.ObjectHeap));
            EmitImplementsTest(Save(WType.Ref(frontend.ObjectHeap)), implemented);
            code.Byte(0x05); // else
            code.I32(0);
            CloseBlock();
            return;
        }

        if (!frontend.IsObject(type))
        {
            code.I32(0);
            return;
        }

        LocalGet(value);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(0);
        code.Byte(0x05); // else
        LocalGet(value);
        code.Gc(2, frontend.ObjectHeap, 0); // struct.get: the vtable
        code.Gc(2, frontend.ObjectVTable, 0); // struct.get: the itables
        int tables = NewLocal(WType.Ref(frontend.ITables));
        LocalSet(tables);
        code.I32(implemented.Id);
        LocalGet(tables);
        code.Gc(15); // array.len
        code.Byte(0x49); // i32.lt_u
        OpenBlock(0x04, WType.I32, new object());
        LocalGet(tables);
        code.I32(implemented.Id);
        code.Gc(11, frontend.ITables); // array.get
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x45); // i32.eqz
        code.Byte(0x05); // else
        code.I32(0);
        CloseBlock();
        CloseBlock();
    }

    // A test of an object for a delegate type, which delegate types of one
    // signature share, or an array type, which array covariance makes
    // inexact, would not be the CLR's.
    private static void RequireExactTest(ITypeSymbol type)
    {
        if (Frontend.IsSupportedDelegate(type)
            || type is IArrayTypeSymbol { ElementType: var element }
               && !(Frontend.IsBoxable(element) || element.SpecialType == SpecialType.System_String || element.IsSealed))
        {
            throw new CompileError($"Testing an object for '{type.ToDisplayString()}' is unsupported: delegates of one signature, "
                + "and arrays of references, are not told apart here.");
        }
    }
}
