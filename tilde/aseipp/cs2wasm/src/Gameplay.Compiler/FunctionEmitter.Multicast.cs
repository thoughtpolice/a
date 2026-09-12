// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Gameplay.Compiler;

// Combined delegates (see Frontend.Delegates): the function a multicast
// delegate runs, and Delegate.Combine, Remove and op_Equality as the CLR
// has them, for one delegate layout (plan.Bound). Like the thunks, they
// spend no depth; a multicast call spends a unit of fuel per delegate.
internal sealed partial class FunctionEmitter
{
    private DelegateLayout Layout => frontend.DelegateLayoutOfHeap(plan.Bound)
        ?? throw new InternalCompilerError("a delegate helper without its layout.");

    private WasmFunction Finish()
    {
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // A delegate converted by variance (see Frontend.DelegateVariance): a
    // new one of the target layout, of the original's type and method,
    // whose target is the original; null stays null.
    private WasmFunction EmitDelegateVariance()
    {
        var from = frontend.DelegateLayoutOfHeap(plan.VarianceSource)!;
        var to = Layout;
        LocalGet(0);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.Ref(to.Heap), new object());
        code.Byte(0xd0); // ref.null
        code.Signed(to.Heap);
        code.Byte(0x05); // else
        code.Byte(0xd2); // ref.func: the forwarding function
        Relocations.Add(new(code.Length, RelocationKind.FunctionReference, frontend.ImportCount + plan.IlGroup));
        LocalGet(0);
        code.Gc(2, from.Heap, Frontend.DelegateTypeField); // struct.get
        LocalGet(0);
        code.Gc(2, from.Heap, Frontend.DelegateMethodField); // struct.get
        LocalGet(0);
        code.Gc(0, to.Heap); // struct.new
        CloseBlock();
        return Finish();
    }

    // The converted delegate's function: the original's, on the original,
    // with the arguments, whose types and result are subtypes of those
    // the original takes and a supertype of what it gives.
    private WasmFunction EmitDelegateForward()
    {
        var from = frontend.DelegateLayoutOfHeap(plan.VarianceSource)!;
        LocalGet(0);
        code.Gc(2, Layout.Heap, Frontend.DelegateTargetField); // struct.get
        code.RefCast(WType.NonNullRef(from.Heap));
        int original = Save(WType.Ref(from.Heap));
        LocalGet(original);
        for (int parameter = 1; parameter < plan.Parameters.Length; parameter++)
        {
            LocalGet(parameterBases[parameter]);
        }

        LocalGet(original);
        code.Gc(2, from.Heap, 0); // struct.get: fn
        CallReference(from.Function);
        return Finish();
    }

    // Calls each delegate of the list in order with the arguments; the
    // result is the last one's.
    private WasmFunction EmitDelegateInvoker()
    {
        var layout = Layout;
        int list = ListOf(0, layout);
        int length = NewLocal(WType.I32);
        LocalGet(list);
        code.Gc(15); // array.len
        LocalSet(length);
        int index = NewLocal(WType.I32);
        int result = plan.Result == WType.Void ? -1 : NewLocal(plan.Result);
        var done = new object();
        var repeat = new object();
        OpenBlock(0x02, WType.Void, done);
        OpenBlock(0x03, WType.Void, repeat);
        ConsumeFuel();
        LocalGet(index);
        LocalGet(length);
        code.Byte(0x4f); // i32.ge_u
        Branch(done, true);
        int element = ElementOf(list, index, layout);
        LocalGet(element);
        for (int parameter = 1; parameter < plan.Parameters.Length; parameter++)
        {
            LocalGet(parameterBases[parameter]);
        }

        LocalGet(element);
        code.Gc(2, layout.Heap, 0); // struct.get: fn
        CallReference(layout.Function);
        if (result >= 0)
        {
            LocalSet(result);
        }

        LocalGet(index);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(index);
        Branch(repeat);
        CloseBlock();
        CloseBlock();
        if (result >= 0)
        {
            LocalGet(result);
        }

        return Finish();
    }

    // The list of a multicast delegate in a local.
    private int ListOf(int multicast, DelegateLayout layout)
    {
        LocalGet(multicast);
        code.RefCast(WType.NonNullRef(layout.Multi));
        code.Gc(2, layout.Multi, Frontend.DelegateListField); // struct.get
        return Save(WType.NonNullRef(layout.List));
    }

    private int ElementOf(int list, int index, DelegateLayout layout)
    {
        LocalGet(list);
        LocalGet(index);
        code.Gc(11, layout.List); // array.get
        code.RefCast(WType.NonNullRef(layout.Heap));
        return Save(WType.NonNullRef(layout.Heap));
    }

    // 1 when the delegate in a local is a combined one.
    private void IsMulticast(int value, DelegateLayout layout)
    {
        LocalGet(value);
        code.RefTest(WType.NonNullRef(layout.Multi));
    }

    // The number of delegates a non-null delegate in a local stands for.
    private int CountOf(int value, DelegateLayout layout)
    {
        IsMulticast(value, layout);
        OpenBlock(0x04, WType.I32, new object());
        int list = ListOf(value, layout);
        LocalGet(list);
        code.Gc(15); // array.len
        code.Byte(0x05); // else
        code.I32(1);
        CloseBlock();
        return Save(WType.I32);
    }

    // The index-th delegate a non-null delegate in a local stands for.
    private int NthOf(int value, int index, DelegateLayout layout)
    {
        // Set in either branch, so nullable for validation.
        int nth = NewLocal(WType.Ref(layout.Heap));
        IsMulticast(value, layout);
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(ElementOf(ListOf(value, layout), index, layout));
        LocalSet(nth);
        code.Byte(0x05); // else
        LocalGet(value);
        code.RefCast(WType.NonNullRef(layout.Heap));
        LocalSet(nth);
        CloseBlock();
        return nth;
    }

    // A multicast delegate of the type of the delegate in `typeOf`, whose
    // list is new, of `count` delegates; `fill` stores them at an index.
    private void NewMulticast(int typeOf, int count, DelegateLayout layout, Action<int> fill)
    {
        LocalGet(count);
        code.Byte(0xad); // i64.extend_i32_u
        code.I64(8);
        code.Byte(0x7e); // i64.mul
        code.I64(48);
        code.Byte(0x7c); // i64.add
        ChargeAllocation();
        LocalGet(count);
        code.Gc(7, layout.List); // array.new_default
        int list = Save(WType.NonNullRef(layout.List));
        fill(list);
        FunctionReference(layout.Invoker);
        LocalGet(typeOf);
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField); // struct.get
        code.I32(-1);
        WType.Ref(Frontend.EqHeap).Default(code);
        LocalGet(list);
        StructNew(layout.Multi);
    }

    // Copies the delegates a delegate stands for into a list from `at`,
    // which advances.
    private void CopyInto(int list, int at, int value, DelegateLayout layout, int start = -1, int end = -1)
    {
        int count = CountOf(value, layout);
        int index = NewLocal(WType.I32);
        if (start >= 0)
        {
            LocalGet(start);
            LocalSet(index);
        }

        var done = new object();
        var repeat = new object();
        OpenBlock(0x02, WType.Void, done);
        OpenBlock(0x03, WType.Void, repeat);
        LocalGet(index);
        LocalGet(end >= 0 ? end : count);
        code.Byte(0x4e); // i32.ge_s
        Branch(done, true);
        int element = NthOf(value, index, layout);
        LocalGet(list);
        LocalGet(at);
        LocalGet(element);
        code.Gc(14, layout.List); // array.set
        LocalGet(at);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(at);
        LocalGet(index);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(index);
        Branch(repeat);
        CloseBlock();
        CloseBlock();
    }

    // Delegate.Combine(a, b): the other when one is null, else a
    // multicast delegate of a's delegates, then b's.
    private WasmFunction EmitDelegateCombine()
    {
        var layout = Layout;
        ReturnOtherIfNull(0, 1);
        ReturnOtherIfNull(1, 0);
        CheckSameTypes(layout);
        int first = CountOf(0, layout);
        int second = CountOf(1, layout);
        LocalGet(first);
        LocalGet(second);
        code.Byte(0x6a); // i32.add
        int count = Save(WType.I32);
        NewMulticast(0, count, layout, list =>
        {
            int at = NewLocal(WType.I32);
            CopyInto(list, at, 0, layout);
            CopyInto(list, at, 1, layout);
        });
        return Finish();
    }

    // Delegates of two types (one converted by variance) do
    // not combine: the CLR throws.
    private void CheckSameTypes(DelegateLayout layout)
    {
        if (frontend.DelegateTypeMismatch is not int mismatch)
        {
            return;
        }

        LocalGet(0);
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField); // struct.get
        LocalGet(1);
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField); // struct.get
        code.Byte(0x47); // i32.ne
        OpenBlock(0x04, WType.Void, new object());
        Call(mismatch);
        code.Byte(0x00); // unreachable
        CloseBlock();
    }

    private void ReturnOtherIfNull(int value, int other)
    {
        LocalGet(value);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(other);
        code.Byte(0x0f); // return
        CloseBlock();
    }

    // Delegate.Remove(source, value): source without the last run of
    // value's delegates in it; null when nothing is left, the one left, or
    // source itself when the run is not there.
    private WasmFunction EmitDelegateRemove()
    {
        var layout = Layout;
        LocalGet(0);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.Void, new object());
        WType.Ref(layout.Heap).Default(code);
        code.Byte(0x0f); // return
        CloseBlock();
        ReturnOtherIfNull(1, 0);
        CheckSameTypes(layout);
        int sourceCount = CountOf(0, layout);
        int valueCount = CountOf(1, layout);
        int start = NewLocal(WType.I32);
        LocalGet(sourceCount);
        LocalGet(valueCount);
        code.Byte(0x6b); // i32.sub
        LocalSet(start);
        var done = new object();
        var repeat = new object();
        OpenBlock(0x02, WType.Void, done);
        OpenBlock(0x03, WType.Void, repeat);
        LocalGet(start);
        code.I32(0);
        code.Byte(0x48); // i32.lt_s
        Branch(done, true);

        // Does value's run match at start?
        int matched = NewLocal(WType.I32);
        code.I32(1);
        LocalSet(matched);
        int offset = NewLocal(WType.I32);
        code.I32(0);
        LocalSet(offset);
        var compared = new object();
        var next = new object();
        OpenBlock(0x02, WType.Void, compared);
        OpenBlock(0x03, WType.Void, next);
        LocalGet(offset);
        LocalGet(valueCount);
        code.Byte(0x4e); // i32.ge_s
        Branch(compared, true);
        LocalGet(start);
        LocalGet(offset);
        code.Byte(0x6a); // i32.add
        int at = Save(WType.I32);
        int left = NthOf(0, at, layout);
        int right = NthOf(1, offset, layout);
        EmitSingleEqual(left, right, layout);
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        code.I32(0);
        LocalSet(matched);
        Branch(compared);
        CloseBlock();
        LocalGet(offset);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(offset);
        Branch(next);
        CloseBlock();
        CloseBlock();

        LocalGet(matched);
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(sourceCount);
        LocalGet(valueCount);
        code.Byte(0x6b); // i32.sub
        int remaining = Save(WType.I32);
        LocalGet(remaining);
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        WType.Ref(layout.Heap).Default(code);
        code.Byte(0x0f); // return
        CloseBlock();
        LocalGet(remaining);
        code.I32(1);
        code.Byte(0x46); // i32.eq
        OpenBlock(0x04, WType.Void, new object());
        // The one left: the first, or the last when the run was first.
        LocalGet(start);
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Ref(layout.Heap), new object());
        LocalGet(NthOf(0, valueCount, layout));
        code.Byte(0x05); // else
        code.I32(0);
        int first = Save(WType.I32);
        LocalGet(NthOf(0, first, layout));
        CloseBlock();
        code.Byte(0x0f); // return
        CloseBlock();
        LocalGet(start);
        LocalGet(valueCount);
        code.Byte(0x6a); // i32.add
        int after = Save(WType.I32);
        NewMulticast(0, remaining, layout, list =>
        {
            int position = NewLocal(WType.I32);
            code.I32(0);
            int from = Save(WType.I32);
            CopyInto(list, position, 0, layout, from, start);
            CopyInto(list, position, 0, layout, after, sourceCount);
        });
        code.Byte(0x0f); // return
        CloseBlock();

        LocalGet(start);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        LocalSet(start);
        Branch(repeat);
        CloseBlock();
        CloseBlock();
        LocalGet(0);
        return Finish();
    }

    // Two single delegates in locals are equal: type, method and target.
    private void EmitSingleEqual(int left, int right, DelegateLayout layout)
    {
        LocalGet(left);
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField); // struct.get
        LocalGet(right);
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField);
        code.Byte(0x46); // i32.eq
        LocalGet(left);
        code.Gc(2, layout.Heap, Frontend.DelegateMethodField);
        LocalGet(right);
        code.Gc(2, layout.Heap, Frontend.DelegateMethodField);
        code.Byte(0x46); // i32.eq
        code.Byte(0x71); // i32.and
        LocalGet(left);
        code.Gc(2, layout.Heap, Frontend.DelegateTargetField);
        LocalGet(right);
        code.Gc(2, layout.Heap, Frontend.DelegateTargetField);
        code.Byte(0xd3); // ref.eq
        code.Byte(0x71); // i32.and
    }

    // op_Equality: both null, or equal delegates, one by one when combined.
    private WasmFunction EmitDelegateEqual()
    {
        var layout = Layout;
        LocalGet(0);
        LocalGet(1);
        code.Byte(0xd3); // ref.eq
        OpenBlock(0x04, WType.Void, new object());
        code.I32(1);
        code.Byte(0x0f); // return
        CloseBlock();
        LocalGet(0);
        code.Byte(0xd1); // ref.is_null
        LocalGet(1);
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x72); // i32.or
        OpenBlock(0x04, WType.Void, new object());
        code.I32(0);
        code.Byte(0x0f); // return
        CloseBlock();
        if (layout.Multi < 0)
        {
            LocalGet(0);
            code.RefCast(WType.NonNullRef(layout.Heap));
            int single = Save(WType.NonNullRef(layout.Heap));
            LocalGet(1);
            code.RefCast(WType.NonNullRef(layout.Heap));
            EmitSingleEqual(single, Save(WType.NonNullRef(layout.Heap)), layout);
            return Finish();
        }

        int leftCount = CountOf(0, layout);
        int rightCount = CountOf(1, layout);
        IsMulticast(0, layout);
        IsMulticast(1, layout);
        code.Byte(0x47); // i32.ne
        LocalGet(leftCount);
        LocalGet(rightCount);
        code.Byte(0x47); // i32.ne
        code.Byte(0x72); // i32.or
        OpenBlock(0x04, WType.Void, new object());
        code.I32(0);
        code.Byte(0x0f); // return
        CloseBlock();
        int index = NewLocal(WType.I32);
        var done = new object();
        var repeat = new object();
        OpenBlock(0x02, WType.Void, done);
        OpenBlock(0x03, WType.Void, repeat);
        LocalGet(index);
        LocalGet(leftCount);
        code.Byte(0x4e); // i32.ge_s
        Branch(done, true);
        EmitSingleEqual(NthOf(0, index, layout), NthOf(1, index, layout), layout);
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        code.I32(0);
        code.Byte(0x0f); // return
        CloseBlock();
        LocalGet(index);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(index);
        Branch(repeat);
        CloseBlock();
        CloseBlock();

        // Combined ones of different delegate types differ.
        IsMulticast(0, layout);
        OpenBlock(0x04, WType.I32, new object());
        LocalGet(0);
        code.RefCast(WType.NonNullRef(layout.Heap));
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField);
        LocalGet(1);
        code.RefCast(WType.NonNullRef(layout.Heap));
        code.Gc(2, layout.Heap, Frontend.DelegateTypeField);
        code.Byte(0x46); // i32.eq
        code.Byte(0x05); // else
        code.I32(1);
        CloseBlock();
        return Finish();
    }
}
