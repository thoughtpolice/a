// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Managed references (see Frontend.References): taking one, ref locals,
// ref returns, and the load and store functions of a type with handles.
internal sealed partial class FunctionEmitter
{

    // The location a reference in a local names.
    private Location ReferenceLocation(int reference, ITypeSymbol type)
    {
        type = Sub(type);
        var mapped = Map(type);
        return new(LocationKind.Local, mapped, type, Local: reference, Boxed: true, NonNull: true, Handle: !mapped.IsTuple);
    }

    // With a reference on the stack, pushes the value it refers to.
    private void LoadThroughReference(WType type)
    {
        if (frontend.HasHandles(type))
        {
            Call(frontend.ReferenceHelpers(type).Load);
        }
        else
        {
            code.RefCast(WType.NonNullRef(frontend.CellHeap(type)));
            code.Gc(2, frontend.CellHeap(type), 0); // struct.get
        }

        // A reference's value is an eqref under shared generics.
        CastToShape(frontend.ReferenceKey(type), type);
    }

    // With a reference on the stack, stores the value in local `value`
    // through it.
    private void StoreThroughReference(WType type, int value)
    {
        if (frontend.HasHandles(type))
        {
            LocalGet(value);
            Call(frontend.ReferenceHelpers(type).Store);
            return;
        }

        code.RefCast(WType.NonNullRef(frontend.CellHeap(type)));
        LocalGet(value);
        code.Gc(5, frontend.CellHeap(type), 0); // struct.set
    }

    // A type's load and store functions: a cell's value, or through a
    // handle, an array's element or a field of the object (or a static
    // field) the handle numbers.
    private WasmFunction EmitReferenceAccess(bool store)
    {
        var type = store ? plan.Parameters[1] : plan.Result;
        int cell = frontend.CellHeap(type);
        int handle = frontend.HandleHeap(type);
        LocalGet(0);
        code.RefTest(WType.NonNullRef(cell));
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(0);
        code.RefCast(WType.NonNullRef(cell));
        if (store)
        {
            LocalGet(1);
            code.Gc(5, cell, 0); // struct.set
        }
        else
        {
            code.Gc(2, cell, 0); // struct.get
        }

        code.Byte(0x0f); // return
        CloseBlock();
        LocalGet(0);
        code.RefCast(WType.NonNullRef(handle));
        int reference = Save(WType.Ref(handle));
        LocalGet(reference);
        code.Gc(2, handle, 1); // struct.get: the index
        int index = Save(WType.I32);
        LocalGet(index);
        code.I32(0);
        code.Byte(0x4e); // i32.ge_s
        OpenBlock(0x04, WType.Void, new object());
        // An element of whichever array type of these elements it is.
        foreach (int arrayHeap in frontend.ArrayHeapsOf(type))
        {
            LocalGet(reference);
            code.Gc(2, handle, 0); // struct.get: the array
            code.RefTest(WType.NonNullRef(arrayHeap));
            OpenBlock(0x04, WType.Void, new object());
            LocalGet(reference);
            code.Gc(2, handle, 0); // struct.get: the array
            code.RefCast(WType.NonNullRef(arrayHeap));
            LocalGet(index);
            if (store)
            {
                LocalGet(1);
                code.Gc(14, arrayHeap); // array.set
            }
            else
            {
                code.Gc(11, arrayHeap); // array.get
                if (frontend.CovariantArrays && type.IsRef && type.Heap != Frontend.EqHeap)
                {
                    // An array of the covariant family holds references.
                    code.RefCast(type);
                }
            }

            code.Byte(0x0f); // return
            CloseBlock();
        }

        code.Byte(0x00); // unreachable
        CloseBlock();
        var fields = frontend.ReferencedFields(type);
        for (int number = 0; number < fields.Count; number++)
        {
            var field = fields[number];
            LocalGet(index);
            code.I32(-2 - number);
            code.Byte(0x46); // i32.eq
            OpenBlock(0x04, WType.Void, new object());
            if (field.IsStatic)
            {
                if (store)
                {
                    LocalGet(1);
                    CastToShape(type, frontend.MapType(Frontend.StorageType(field)));
                    GlobalSet(frontend.GlobalIndex(field));
                }
                else
                {
                    GlobalGet(frontend.GlobalIndex(field));
                }
            }
            else
            {
                int heap;
                int position;
                if (Frontend.IsStruct(field.ContainingType))
                {
                    var layout = frontend.StructOf(field.ContainingType);
                    heap = layout.Box;
                    position = frontend.FieldPosition(layout, (IFieldSymbol)field);
                }
                else
                {
                    heap = frontend.MapType(field.ContainingType).Heap;
                    position = frontend.FieldIndex(field);
                }

                LocalGet(reference);
                code.Gc(2, handle, 0); // struct.get: the object
                code.RefCast(WType.NonNullRef(heap));
                if (store)
                {
                    LocalGet(1);
                    CastToShape(type, frontend.MapType(frontend.FieldStorageType(field)));
                    code.Gc(5, heap, position); // struct.set
                }
                else
                {
                    code.Gc(2, heap, position); // struct.get
                }
            }

            code.Byte(0x0f); // return
            CloseBlock();
        }

        code.Byte(0x00); // unreachable
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }
}
