// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Structs (see Frontend.Structs). A struct expression's value is its leaves
// on the stack. A struct that a call may mutate, or that is passed by
// reference, is reached through its place: flattened locals, or the box of
// its storage. A local or parameter used that way lives in a box (or, for a
// scalar passed by reference, a cell) for the whole call, allocated on entry,
// so a callee that mutates it through `this` or a `ref` writes the variable
// itself, even when it goes on to fault or throw.
internal sealed partial class FunctionEmitter
{

    // A field of a struct at a place: leaves of its flattened locals, or a
    // field of its box.
    private Location FieldOfPlace(Location place, IFieldSymbol field, bool readOnly)
    {
        var layout = frontend.StructOf(field.ContainingType);
        int position = frontend.FieldPosition(layout, field);
        var type = frontend.MapType(frontend.FieldStorageType(field));
        readOnly |= place.ReadOnly;
        if (!place.Boxed)
        {
            return new(LocationKind.Local, type, field.Type, Local: place.Local + layout.Offsets[position], ReadOnly: readOnly);
        }

        return new(
            LocationKind.Field,
            type,
            field.Type,
            Receiver: place.Local,
            Container: WType.Ref(layout.Box),
            Field: position,
            Boxed: type.IsTuple,
            NonNull: true,
            ReadOnly: readOnly);
    }

    // Calls a struct member on a place, with the arguments already in
    // locals. A readonly member takes a flattened place's leaves, read at
    // the call, or a box. Another member takes the box of the storage; a
    // flattened value or a place C# only lets it mutate a copy of goes
    // through a new box, whose contents a flattened value takes back.
    private void CallOnPlace(Location place, IMethodSymbol method, int[] arguments)
    {
        if (Frontend.IsReadOnlyMember(method))
        {
            if (place.Boxed)
            {
                code.OpIndex(0x20, place.Local); // local.get: the box
                PushArguments(arguments);
                Call(frontend.BoxMethodIndex(method));
            }
            else
            {
                // Imported struct members take `this` as a box only.
                CallThroughBox(place with { ReadOnly = true }, method, arguments);
            }

            return;
        }

        CallThroughBox(place, method, arguments);
    }

    // A struct member on the box of a place: its own, or a copy.
    private void CallThroughBox(Location place, IMethodSymbol method, int[] arguments)
    {

        if (place.Boxed && !place.ReadOnly)
        {
            code.OpIndex(0x20, place.Local); // local.get: the box
            PushArguments(arguments);
            Call(frontend.BoxMethodIndex(method));
            return;
        }

        var layout = frontend.StructOf(place.Type);
        EmitNewBox(place.Type);
        int box = Save(WType.Ref(layout.Box));
        if (place.Boxed)
        {
            Load(place);
            WriteBox(box, layout, Save(place.Type));
        }
        else
        {
            WriteBox(box, layout, place.Local);
        }

        code.OpIndex(0x20, box); // local.get
        PushArguments(arguments);
        Call(frontend.BoxMethodIndex(method));
        if (!place.Boxed && !place.ReadOnly)
        {
            ReadBox(box, layout);
            PopLocal(place.Local, place.Type);
        }
    }

    private void PushArguments(int[] arguments)
    {
        foreach (int argument in arguments)
        {
            LocalGet(argument);
        }
    }

    // Allocates a zeroed box for a struct, or a cell for anything else,
    // charged like an object of that many fields.
    private void EmitNewBox(WType type)
    {
        code.I64(16L + frontend.BoxCharge(type) * 8L);
        ChargeAllocation();
        if (type.IsTuple)
        {
            frontend.WriteNewBox(code, frontend.StructOf(type));
            return;
        }

        type.Default(code);
        StructNew(frontend.CellHeap(type));
    }

    // With a box or cell reference on the stack, pushes the value it holds.
    private void Unbox(WType type)
    {
        if (type.IsTuple)
        {
            var layout = frontend.StructOf(type);
            ReadBox(Save(WType.Ref(layout.Box)), layout);
            return;
        }

        code.Gc(2, frontend.CellHeap(type), 0); // struct.get
        CastToShape(frontend.ReferenceKey(type), type);
    }

    // With a box or cell reference on the stack, stores the value in local
    // `value` into it.
    private void WriteThrough(WType type, int value)
    {
        if (type.IsTuple)
        {
            var layout = frontend.StructOf(type);
            WriteBox(Save(WType.Ref(layout.Box)), layout, value);
            return;
        }

        int cell = Save(WType.Ref(frontend.CellHeap(type)));
        LocalGet(cell);
        LocalGet(value);
        code.Gc(5, frontend.CellHeap(type), 0); // struct.set
    }

    // Pushes the leaves a box holds, reading nested boxes in place.
    private void ReadBox(int box, StructLayout layout)
    {
        for (int position = 0; position < layout.Fields.Count; position++)
        {
            code.OpIndex(0x20, box); // local.get
            code.Gc(2, layout.Box, position); // struct.get
            var type = frontend.MapType(layout.Fields[position].Type);
            if (type.IsTuple)
            {
                var inner = frontend.StructOf(type);
                ReadBox(Save(WType.Ref(inner.Box)), inner);
            }
        }
    }

    // Writes the leaves in the locals from `value` on into a box.
    private void WriteBox(int box, StructLayout layout, int value)
    {
        for (int position = 0; position < layout.Fields.Count; position++)
        {
            var type = frontend.MapType(layout.Fields[position].Type);
            int leaf = value + layout.Offsets[position];
            code.OpIndex(0x20, box); // local.get
            if (type.IsTuple)
            {
                var inner = frontend.StructOf(type);
                code.Gc(2, layout.Box, position); // struct.get
                WriteBox(Save(WType.Ref(inner.Box)), inner, leaf);
                continue;
            }

            code.OpIndex(0x20, leaf); // local.get
            code.Gc(5, layout.Box, position); // struct.set
        }
    }
}
