// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Boxing and object values (see Frontend.Boxing): boxes, unboxing and type
// tests of boxes, the object members of values of unknown type, and the
// functions boxes and classes answer them with.
internal sealed partial class FunctionEmitter
{
    private WType ObjectRef => WType.Ref(Frontend.EqHeap);

    private WType Text => WType.Ref(frontend.StringHeap);

    // Boxes the value of `type` on the stack: a new box every time.
    private void EmitBox(ITypeSymbol type)
    {
        var box = frontend.BoxOf(type);
        var mapped = frontend.MapType(type);
        int value = Save(mapped);
        code.I64(24);
        ChargeAllocation();
        code.Byte(0x23); // global.get: the vtable
        Relocations.Add(new(code.Length, RelocationKind.VTable, box.Global));
        if (frontend.IdentityHash)
        {
            code.I32(0);
        }

        if (mapped.IsTuple)
        {
            // The struct's storage, a copy of the value.
            var layout = frontend.StructOf(mapped);
            EmitNewBox(mapped);
            int storage = Save(WType.Ref(layout.Box));
            WriteBox(storage, layout, value);
            LocalGet(storage);
            code.RefCast(WType.NonNullRef(layout.Box));
        }
        else
        {
            LocalGet(value);
        }

        StructNew(box.Heap);
    }

    // Pushes the value a box holds, from a local known to hold the box.
    private void EmitBoxValue(ClassLayout box, int boxed)
    {
        LocalGet(boxed);
        code.Gc(2, box.Heap, frontend.BoxValueField); // struct.get
        var mapped = frontend.MapType(box.Symbol);
        if (mapped.IsTuple)
        {
            // A copy out of the storage.
            var layout = frontend.StructOf(mapped);
            ReadBox(Save(WType.Ref(layout.Box)), layout);
        }
    }

    // `(V)o`: the value of the box an object reference holds; null faults
    // with NullReferenceException, a box of another type (but an enum's
    // and its underlying integer's) with InvalidCastException.
    private WType EmitUnbox(ITypeSymbol target, int value)
    {
        var mapped = frontend.MapType(target);
        CheckNull(value);
        int result = NewLocal(mapped);
        var done = new object();
        OpenBlock(0x02, WType.Void, done);
        foreach (var box in frontend.UnboxSources(target))
        {
            LocalGet(value);
            code.RefTest(WType.NonNullRef(box.Heap));
            OpenBlock(0x04, WType.Void, new object());
            LocalGet(value);
            code.RefCast(WType.NonNullRef(box.Heap));
            int boxed = Save(WType.NonNullRef(box.Heap));
            EmitBoxValue(box, boxed);
            LocalSet(result);
            Branch(done);
            CloseBlock();
        }

        Fault(FaultCode.InvalidCast);
        CloseBlock();
        LocalGet(result);
        return mapped;
    }

    // Leaves 1 when the reference in a local is a box of exactly `type`.
    private void EmitBoxTest(int value, ITypeSymbol type)
    {
        if (!frontend.TryBox(type, out var box))
        {
            // Nothing boxes the type.
            code.I32(0);
            return;
        }

        LocalGet(value);
        code.RefTest(WType.NonNullRef(box.Heap));
    }

    // EqualityComparer<object>.Default.Equals of references in locals.
    private void EmitHelperEqual(int left, int right)
    {
        code.OpIndex(0x20, left); // local.get
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.OpIndex(0x20, right);
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x05); // else
        code.OpIndex(0x20, left);
        code.OpIndex(0x20, right);
        Call(frontend.ObjectHelper("Equals"));
        CloseBlock();
    }

    // Its hash: 0 for null.
    private void EmitHelperHash(int value)
    {
        code.OpIndex(0x20, value); // local.get
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(0);
        code.Byte(0x05); // else
        code.OpIndex(0x20, value);
        Call(frontend.ObjectHelper("GetHashCode"));
        CloseBlock();
    }

    // string.Concat(object)'s: "" for null.
    private void EmitHelperToString(int value)
    {
        code.OpIndex(0x20, value); // local.get
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, Text, new object());
        EmitLiteral("");
        code.Byte(0x05); // else
        code.OpIndex(0x20, value);
        Call(frontend.ObjectHelper("ToString"));
        CloseBlock();
    }

    // An object member of any object value, not null: a $Object's slot; a
    // string's contents; an array's identity. Printing or hashing an array
    // or a delegate, or comparing two delegates, faults with Unsupported.
    private WasmFunction EmitObjectHelper()
    {
        string name = plan.Symbol!.Name;
        LocalGet(0);
        code.RefTest(WType.NonNullRef(frontend.ObjectHeap));
        OpenBlock(0x04, plan.Result, new object());
        LocalGet(0);
        code.RefCast(WType.NonNullRef(frontend.ObjectHeap));
        int self = Save(WType.Ref(frontend.ObjectHeap));
        LocalGet(self);
        if (name == "Equals")
        {
            LocalGet(1);
        }

        EmitCallTarget(frontend.ObjectSlotCall(name, frontend.ObjectSymbol), self);
        code.Byte(0x05); // else
        // A string compares and hashes by the runtime's helpers, which a
        // module has when its code uses strings; only such code makes one
        // an object.
        bool strings = name == "ToString" ? frontend.StringUsed : frontend.StringsUsed;
        if (strings)
        {
            LocalGet(0);
            code.RefTest(WType.NonNullRef(frontend.StringHeap));
            OpenBlock(0x04, plan.Result, new object());
            switch (name)
            {
                case "Equals":
                    LocalGet(1);
                    code.RefTest(WType.NonNullRef(frontend.StringHeap));
                    OpenBlock(0x04, WType.I32, new object());
                    LocalGet(0);
                    code.RefCast(Text);
                    LocalGet(1);
                    code.RefCast(Text);
                    CallString("Equal", 2);
                    code.Byte(0x05); // else
                    code.I32(0);
                    CloseBlock();
                    break;
                case "GetHashCode":
                    LocalGet(0);
                    code.RefCast(Text);
                    CallString("Hash", 1);
                    break;
                default:
                    LocalGet(0);
                    code.RefCast(Text);
                    break;
            }

            code.Byte(0x05); // else
        }

        if (name == "Equals")
        {
            // Arrays by identity; delegates by type, method and target.
            LocalGet(0);
            LocalGet(1);
            code.Byte(0xd3); // ref.eq
            OpenBlock(0x04, WType.I32, new object());
            code.I32(1);
            code.Byte(0x05); // else
            foreach (var layout in frontend.DelegateLayouts)
            {
                LocalGet(0);
                code.RefTest(WType.NonNullRef(layout.Heap));
                OpenBlock(0x04, WType.Void, new object());
                LocalGet(1);
                code.RefTest(WType.NonNullRef(layout.Heap));
                OpenBlock(0x04, WType.I32, new object());
                LocalGet(0);
                code.RefCast(WType.NonNullRef(layout.Heap));
                LocalGet(1);
                code.RefCast(WType.NonNullRef(layout.Heap));
                Call(layout.Equal);
                code.Byte(0x05); // else
                code.I32(0);
                CloseBlock();
                code.Byte(0x0f); // return
                CloseBlock();
            }

            code.I32(0);
            CloseBlock();
        }
        else if (name == "ToString")
        {
            // An array prints its type's name, a delegate its type's.
            foreach (var (heap, arrayName) in frontend.ArrayNames)
            {
                LocalGet(0);
                code.RefTest(WType.NonNullRef(heap));
                OpenBlock(0x04, WType.Void, new object());
                EmitLiteral(arrayName);
                code.Byte(0x0f); // return
                CloseBlock();
            }

            foreach (var layout in frontend.DelegateLayouts)
            {
                LocalGet(0);
                code.RefTest(WType.NonNullRef(layout.Heap));
                OpenBlock(0x04, WType.Void, new object());
                LocalGet(0);
                code.RefCast(WType.NonNullRef(layout.Heap));
                code.Gc(2, layout.Heap, Frontend.DelegateTypeField); // struct.get
                int typeId = Save(WType.I32);
                for (int id = 0; id < frontend.DelegateTypes.Count; id++)
                {
                    if (Frontend.ClrName((INamedTypeSymbol)frontend.DelegateTypes[id]) is not { } typeName
                        || frontend.DelegateOf(frontend.DelegateTypes[id]).Heap != layout.Heap)
                    {
                        continue;
                    }

                    LocalGet(typeId);
                    code.I32(id);
                    code.Byte(0x46); // i32.eq
                    OpenBlock(0x04, WType.Void, new object());
                    EmitLiteral(typeName);
                    code.Byte(0x0f); // return
                    CloseBlock();
                }

                CloseBlock();
            }

            Trap(FaultCode.Unsupported);
        }
        else
        {
            // GetHashCode: a delegate's or an array's, as Equal has them.
            int value = 0;
            foreach (var layout in frontend.DelegateLayouts)
            {
                LocalGet(0);
                code.RefTest(WType.NonNullRef(layout.Heap));
                OpenBlock(0x04, WType.Void, new object());
                EmitDelegateHash(value, layout);
                code.Byte(0x0f); // return
                CloseBlock();
            }

            LocalGet(0);
            code.RefTest(WType.NonNullRef(Frontend.ArrayHeap));
            OpenBlock(0x04, WType.Void, new object());
            EmitArrayHash(value);
            code.Byte(0x0f); // return
            CloseBlock();
            Trap(FaultCode.Unsupported);
        }

        if (strings)
        {
            CloseBlock();
        }

        CloseBlock();
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // A box's object member: its value's, as the CLR's ValueType, the
    // scalars and a record struct have them, or the struct's override
    // called on the box's storage. Like a thunk, no call of its own.
    private WasmFunction EmitBoxMember()
    {
        var type = plan.ContainingType!;
        var box = frontend.BoxOf(type);
        var mapped = frontend.MapType(type);
        string name = plan.Symbol!.Name;
        if (name == "ToString" && Frontend.ObjectOverride(type, plan.Symbol!) is null && !BoxPrints(type))
        {
            // Code cannot know an object's type, so what does not print
            // faults when printed.
            Trap(FaultCode.Unsupported);
            code.Byte(0x0b); // end
            return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
        }

        LocalGet(0);
        code.RefCast(WType.NonNullRef(box.Heap));
        int self = Save(WType.NonNullRef(box.Heap));
        if (Frontend.ObjectOverride(type, plan.Symbol!) is { } overriding)
        {
            // On the storage itself, which the override may mutate.
            if (mapped.IsTuple)
            {
                LocalGet(self);
                code.Gc(2, box.Heap, frontend.BoxValueField); // struct.get: the storage
                if (name == "Equals")
                {
                    LocalGet(1);
                }

                Call(frontend.BoxMethodIndex(overriding));
            }
            else
            {
                EmitBoxValue(box, self);
                if (name == "Equals")
                {
                    LocalGet(1);
                }

                Call(frontend.MethodIndex(overriding));
            }

            code.Byte(0x0b); // end
            return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
        }

        EmitBoxValue(box, self);
        int value = Save(mapped);
        switch (name)
        {
            case "Equals":
                // A box of the same type with an equal value.
                LocalGet(1);
                code.RefTest(WType.NonNullRef(box.Heap));
                OpenBlock(0x04, WType.I32, new object());
                LocalGet(1);
                code.RefCast(WType.NonNullRef(box.Heap));
                int other = Save(WType.NonNullRef(box.Heap));
                EmitBoxValue(box, other);
                int otherValue = Save(mapped);
                EmitEqual(type, value, otherValue, byObject: true);
                code.Byte(0x05); // else
                code.I32(0);
                CloseBlock();
                break;
            case "GetHashCode":
                EmitHash(type, value);
                break;
            default:
                EmitFormattedLocal(type, value);
                break;
        }

        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // Whether a boxed value prints: not a union, whose CLR text is not
    // reproduced.
    private static bool BoxPrints(ITypeSymbol type) => Frontend.FormatProblem(type) is null;

    // A class's default ToString: its type's full name; an exception's
    // Exception.ToString, but for the stack trace a thrown one has in the
    // CLR: "Type: message", then " ---> " and the inner exception's, then
    // the end of the inner exception's trace.
    private WasmFunction EmitDefaultToString()
    {
        var type = plan.ContainingType!;
        string name = Frontend.ClrName(type)!;
        if (!frontend.IsException(type))
        {
            EmitLiteral(name);
            code.Byte(0x0b); // end
            return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
        }

        int heap = frontend.ExceptionHeap;
        LocalGet(0);
        code.RefCast(WType.Ref(heap));
        int self = Save(WType.Ref(heap));

        LocalGet(self);
        code.Gc(2, heap, frontend.MessageField); // struct.get: the message
        int message = Save(Text);
        LocalGet(message);
        code.Byte(0xd1); // ref.is_null
        LocalGet(message);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(1);
        code.Byte(0x05); // else
        LocalGet(message);
        code.Gc(15); // array.len
        code.Byte(0x45); // i32.eqz
        CloseBlock();
        code.Byte(0x72); // i32.or
        OpenBlock(0x04, Text, new object());
        EmitLiteral(name);
        code.Byte(0x05); // else
        EmitLiteral(name + ": ");
        LocalGet(message);
        CallString("Concat", 2);
        CloseBlock();
        int text = Save(Text);
        LocalGet(self);
        code.Gc(2, heap, frontend.InnerField); // struct.get: the inner exception
        int inner = Save(WType.Ref(heap));
        LocalGet(inner);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, Text, new object());
        LocalGet(text);
        code.Byte(0x05); // else
        LocalGet(text);
        EmitLiteral("\n ---> ");
        CallString("Concat", 2);
        LocalGet(inner);
        EmitCallTarget(frontend.ObjectSlotCall("ToString", frontend.ObjectSymbol), inner);
        CallString("Concat", 2);
        EmitLiteral("\n   --- End of inner exception stack trace ---");
        CallString("Concat", 2);
        CloseBlock();
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // An itable slot of a box: the struct's implementation, called on the
    // storage the box holds.
    private WasmFunction EmitBoxThunk()
    {
        var box = frontend.BoxOf(plan.ContainingType!);
        if (Frontend.VectorLane(plan.ContainingType) is { } lane && plan.Symbol is { Name: "Equals", Parameters.Length: 1 })
        {
            // A boxed Vector128's IEquatable<Vector128<T>>.Equals.
            LocalGet(0);
            code.RefCast(WType.NonNullRef(box.Heap));
            code.Gc(2, box.Heap, frontend.BoxValueField); // struct.get
            int self = Save(WType.V128);
            EmitVectorEquals(self, 1, lane);
            code.Byte(0x0b); // end
            return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
        }

        // A boxed number's member is its shim, over the value.
        var shim = Frontend.ScalarOf(plan.ContainingType) is not null ? frontend.ShimOf(plan.Symbol!) : null;
        if (Frontend.ScalarOf(plan.ContainingType) is not null && shim is null)
        {
            throw new CompileError($"'{plan.Symbol!.ToDisplayString()}' of a boxed number is unsupported.");
        }

        LocalGet(0);
        code.RefCast(WType.NonNullRef(box.Heap));
        code.Gc(2, box.Heap, frontend.BoxValueField); // struct.get: the storage
        int called = shim is not null ? frontend.MethodIndex(shim) : frontend.BoxMethodIndex(plan.Symbol!);
        PushParametersFor(new CallTarget(called), plan.Symbol!, 1, 1);
        Call(called);
        CastToShape(frontend.PlanOfFunction(called).Result, plan.Result);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }
}
