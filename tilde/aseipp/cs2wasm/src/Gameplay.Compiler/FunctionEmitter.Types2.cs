// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Gameplay.Compiler;

// System.Type objects (see Frontend.Types): typeof, GetType, and the
// functions making each type's object.
internal sealed partial class FunctionEmitter
{

    // A type's object: made once, then kept in its global.
    private WasmFunction EmitTypeObject()
    {
        var type = plan.Receiver!;
        int global = frontend.TypeObjectGlobal(type);
        GlobalGet(global);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.Void, new object());
        var (text, name, space, flags) = frontend.TypeObjectData(type);
        EmitLiteral(text);
        int textLocal = Save(Text);
        EmitLiteral(name);
        int nameLocal = Save(Text);
        if (space is null)
        {
            Text.Default(code);
        }
        else
        {
            EmitLiteral(space);
        }

        int spaceLocal = Save(Text);
        code.I32(flags);
        int flagsLocal = Save(WType.I32);
        var typeClass = Map(frontend.RuntimeTypeClass);
        if (frontend.BaseTypeOf(type) is { } baseType)
        {
            Call(frontend.TypeObject(baseType));
        }
        else
        {
            typeClass.Default(code);
        }

        int baseLocal = Save(typeClass);
        EmitAllocation(
            frontend.RuntimeTypeClass,
            frontend.RuntimeTypeConstructor,
            [textLocal, nameLocal, spaceLocal, flagsLocal, baseLocal]);
        GlobalSet(global);
        CloseBlock();
        GlobalGet(global);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // GetType of an object: its class's (or box's, array's, string's)
    // object, tested most derived first; `new object()` is an object.
    private WasmFunction EmitObjectType()
    {
        var candidates = plan.Receiver is { } receiver ? frontend.ObjectTypeCandidates(receiver) : frontend.ObjectTypeCandidates();
        foreach (var (type, heap) in candidates)
        {
            EmitHeapTest(0, type, heap);
            OpenBlock(0x04, WType.Void, new object());
            Call(frontend.TypeObject(type));
            code.Byte(0x0f); // return
            CloseBlock();
        }

        Trap(FaultCode.Unsupported);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }
}
