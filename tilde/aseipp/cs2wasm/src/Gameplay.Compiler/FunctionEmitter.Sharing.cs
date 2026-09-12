// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Shared generics' part of the body layer (see Frontend.Sharing): what a
// function's shape and a call target's differ by is only how exactly a
// reference is typed, which a cast settles.
internal sealed partial class FunctionEmitter
{
    // The parameters and result of what a call target runs: a function's
    // plan, or the function type a slot, itable member or delegate holds.
    private (WType[] Parameters, WType Result) TargetShape(CallTarget target, IMethodSymbol method) =>
        target.IsVirtual
            ? frontend.CallShape(target, method)
            : target.Function < frontend.ImportCount
                ? ([], WType.Void)
                : (frontend.PlanOfFunction(target.Function).Parameters, frontend.PlanOfFunction(target.Function).Result);

    // Converts the reference on the stack from one shape's type to another
    // by a cast where the first is not a subtype of the second: what a
    // shared function gives back is an eqref where its caller has a string.
    private void CastToShape(WType from, WType to)
    {
        // A struct of one reference is that reference: function types
        // intern by their flattened parameters, so a shape read back from
        // one may have the struct where the call has the reference (an
        // IEqualityComparer<Union>'s and an IEqualityComparer<string>'s).
        from = frontend.Leaves(from) is [{ IsRef: true } fromLeaf] ? fromLeaf : from;
        to = frontend.Leaves(to) is [{ IsRef: true } toLeaf] ? toLeaf : to;
        if (from == to || !from.IsRef || !to.IsRef || frontend.IsSubtypeHeap(from.Heap, to.Heap))
        {
            return;
        }

        code.RefCast(to.IsNullable ? to : WType.Ref(to.Heap));
    }

    // Pushes the thunk's parameters from `first` on, each value as the
    // target's corresponding one takes it. They are paired leaf by leaf:
    // function types intern by their flattened parameters, so the thunk's
    // shape, read back from its type, may group them differently from the
    // target's (an IEqualityComparer<KeyValuePair<string, string>>'s one
    // struct of two references where an IComparer<string>'s has two).
    private void PushParametersFor(CallTarget target, IMethodSymbol method, int first, int targetFirst)
    {
        var (parameters, _) = TargetShape(target, method);
        var targetLeaves = parameters.Skip(targetFirst).SelectMany(frontend.Leaves).ToList();
        int at = 0;
        for (int parameter = first; parameter < plan.Parameters.Length; parameter++)
        {
            var leaves = frontend.Leaves(plan.Parameters[parameter]);
            for (int leaf = 0; leaf < leaves.Length; leaf++, at++)
            {
                code.OpIndex(0x20, parameterBases[parameter] + leaf); // local.get
                if (at < targetLeaves.Count)
                {
                    CastToShape(leaves[leaf], targetLeaves[at]);
                }
            }
        }
    }

    // Leaves 1 when the reference in a local is an object of a class whose
    // heap type other classes share, or of one deriving from it (or, exact,
    // of the class itself): its class id is in the class's range.
    private void EmitClassIdTest(int value, ClassLayout layout, bool exact = false)
    {
        LocalGet(value);
        code.RefTest(WType.NonNullRef(layout.Heap));
        OpenBlock(0x04, WType.I32, new object());
        LocalGet(value);
        code.RefCast(WType.NonNullRef(layout.Heap));
        code.Gc(2, layout.Heap, 0); // struct.get: the vtable
        code.Gc(2, layout.VTable, frontend.ClassIdField); // struct.get: the class id
        code.I32(layout.ClassId);
        code.Byte(0x6b); // i32.sub
        code.I32(exact ? 0 : layout.LastDerivedId - layout.ClassId);
        code.Byte(0x4d); // i32.le_u
        code.Byte(0x05); // else
        code.I32(0);
        CloseBlock();
    }

    // The test of an exact class, an exact array or anything else by its
    // heap type, for a type test's closed world.
    private void EmitHeapTest(int value, ITypeSymbol type, int heap)
    {
        if (frontend.TryLayout(type, out var layout) && frontend.SharesHeap(layout))
        {
            EmitClassIdTest(value, layout);
            return;
        }

        LocalGet(value);
        code.RefTest(WType.NonNullRef(heap));
    }

    // Loads a place's value as a type: a shared instantiation's storage
    // holds its canonical type's values.
    private void LoadAs(Location place, WType wanted)
    {
        Load(place);
        CastToShape(place.Type, wanted);
    }
}
