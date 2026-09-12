// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;

namespace Gameplay.Compiler;

// Shared code's part of the body layer (see Frontend.SharedCode): a shared
// method's Thunk sites call through its dictionary; an ExactStep lowers one
// instruction as its exact instantiation does; a SharedEntry passes an
// exact instantiation's dictionary to the shared function.
internal sealed partial class FunctionEmitter
{
    // The local holding the dictionary, in shared code with Thunk sites.
    private int dictionaryLocal = -1;

    // Shared code's dictionary, at entry: its last parameter, or its
    // class's from `this`'s vtable.
    private void OpenDictionary()
    {
        if (plan.Shared is not { Owner: { } owner } shared)
        {
            return;
        }

        var type = WType.Ref(owner.Type);
        if (shared.HiddenDictionary)
        {
            dictionaryLocal = parameterBases[^1];
            return;
        }

        LocalGet(0);
        code.RefCast(WType.NonNullRef(frontend.ObjectHeap));
        code.Gc(2, frontend.ObjectHeap, 0); // struct.get: the vtable
        code.Gc(2, frontend.ObjectVTable, frontend.DictionaryField); // struct.get: the dictionary
        code.RefCast(type);
        dictionaryLocal = Save(type);
    }

    // A Thunk site: the values it takes, then its exact instantiation's
    // function for it, from the dictionary.
    private void EmitSiteCall(SharedCode shared, SharedSite site)
    {
        var before = flow.Before[ilIndex];
        var values = ilStack.GetRange(ilStack.Count - site.Pops, site.Pops);
        ilStack.RemoveRange(ilStack.Count - site.Pops, site.Pops);
        for (int position = 0; position < site.Pops; position++)
        {
            var slot = before[before.Length - site.Pops + position];
            if (frontend.SlotWType(slot) is { } type && slot.Kind != IlKind.Null)
            {
                Get(values[position], type);
            }
        }

        var owner = shared.Owner!;
        LocalGet(dictionaryLocal);
        code.Gc(2, owner.Type, owner.First + shared.EntryOf[site.Index]); // struct.get: the function
        CallReference(shared.SignatureOf[site.Index]);
        if (site.Pushes)
        {
            PushResult(flow.After[ilIndex]!.Value[^1]);
        }
    }

    // One instruction of shared code as an exact instantiation runs it:
    // what it takes arrives as parameters of their canonical types (a null,
    // a token or a method pointer is made again), what it leaves is
    // returned.
    private WasmFunction EmitExactStep()
    {
        flow = frontend.ExactFlow(plan);
        int index = plan.IlGroup;
        int pops = plan.Bound;
        var before = flow.Before[index];
        // What the instruction does not take stands in for the stack below,
        // which it counts but never touches.
        ilStack = [.. Enumerable.Range(0, before.Length - pops).Select(_ => (IlValue)new IlNullValue())];
        int parameter = 0;
        for (int depth = before.Length - pops; depth < before.Length; depth++)
        {
            var slot = before[depth];
            switch (slot.Kind)
            {
                case IlKind.Null:
                    ilStack.Add(new IlNullValue());
                    break;
                case IlKind.Token:
                    ilStack.Add(new IlTokenValue((Microsoft.CodeAnalysis.ISymbol)flow.Operands[index - 1]!));
                    break;
                case IlKind.Method:
                    ilStack.Add(new IlMethodValue(
                        (Microsoft.CodeAnalysis.IMethodSymbol)flow.Operands[index - 1]!,
                        flow.Instructions[index - 1].OpCode == ILOpCode.Ldvirtftn));
                    break;
                default:
                    ilStack.Add(new IlLocalValue(slot, parameterBases[parameter++]));
                    break;
            }
        }

        ilIndex = index;
        EmitIlInstruction(null!, 0, index);
        if (plan.Result != WType.Void)
        {
            Get(ilStack[^1], plan.Result);
        }

        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // An exact instantiation's entry into shared code that takes a
    // dictionary: its arguments, then its dictionary.
    private WasmFunction EmitSharedEntry()
    {
        for (int parameter = 0; parameter < plan.Parameters.Length; parameter++)
        {
            LocalGet(parameterBases[parameter]);
        }

        code.Byte(0x23); // global.get
        Relocations.Add(new(code.Length, RelocationKind.Dictionary, plan.Bound));
        Call(frontend.ImportCount + plan.IlGroup);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // A Function site: the call as EmitModuleCall makes it of a class's
    // method or a static one, of the exact instantiation's function from
    // the dictionary.
    private void EmitFunctionSite(SharedCode shared, SharedSite site)
    {
        var method = (Microsoft.CodeAnalysis.IMethodSymbol)flow.Operands[ilIndex]!;
        int count = method.Parameters.Length + (method.IsStatic ? 0 : 1);
        var (values, _) = PopArguments(count);
        var (parameters, result) = frontend.FunctionShape(method);
        int first = method.IsStatic ? 0 : 1;
        int self = -1;
        if (!method.IsStatic)
        {
            self = GetLocal(values[0], parameters[0]);
        }

        int[] arguments = ArgumentLocals(method, values, first);
        if (self >= 0 && flow.Instructions[ilIndex].OpCode == ILOpCode.Callvirt)
        {
            CheckNull(self);
        }

        if (self >= 0)
        {
            LocalGet(self);
        }

        for (int index = 0; index < arguments.Length; index++)
        {
            LocalGet(arguments[index]);
            CastToShape(IlLocalType(arguments[index]), parameters[index + first]);
        }

        var owner = shared.Owner!;
        LocalGet(dictionaryLocal);
        code.Gc(2, owner.Type, owner.First + shared.EntryOf[site.Index]); // struct.get: the function
        CallReference(shared.SignatureOf[site.Index]);
        FinishCall(result);
    }
}
