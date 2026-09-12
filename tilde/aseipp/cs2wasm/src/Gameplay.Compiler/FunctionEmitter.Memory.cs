// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The boundary memory (see Frontend.Memory): Gameplay.Runtime.Memory's
// loads, stores and arena, and cabi_realloc. An address outside the memory
// traps in the engine, like any out-of-bounds access.
internal sealed partial class FunctionEmitter
{

    private WType EmitMemoryIntrinsic(IMethodSymbol method, int[] arguments)
    {
        switch (method.Name)
        {
            case "Allocate":
                // cabi_realloc(0, 0, alignment, size), in the arena: the
                // host's blocks' chain is set aside around the call, so that
                // the glue's own memory is never the host's.
                int chain = -1;
                if (frontend.HostChainGlobal >= 0)
                {
                    GlobalGet(frontend.HostChainGlobal);
                    chain = Save(WType.I32);
                    code.I32(0);
                    GlobalSet(frontend.HostChainGlobal);
                }

                code.I32(0);
                code.I32(0);
                LocalGet(arguments[1]);
                LocalGet(arguments[0]);
                Call(frontend.Realloc);
                if (chain >= 0)
                {
                    LocalGet(chain);
                    GlobalSet(frontend.HostChainGlobal);
                }

                return WType.I32;
            case "Top":
                GlobalGet(frontend.HeapTopGlobal);
                return WType.I32;
            case "Release":
                LocalGet(arguments[0]);
                if (frontend.HeapFloorGlobal >= 0)
                {
                    // Never below the floor, which the host's blocks may have
                    // raised during the call the mark was taken before.
                    GlobalGet(frontend.HeapFloorGlobal);
                    LocalGet(arguments[0]);
                    GlobalGet(frontend.HeapFloorGlobal);
                    code.Byte(0x4b); // i32.gt_u
                    code.Byte(0x1b); // select: the higher
                }

                GlobalSet(frontend.HeapTopGlobal);
                return WType.Void;
            case "HostChain":
                GlobalGet(frontend.HostChainGlobal);
                return WType.I32;
            case "SetHostChain":
                LocalGet(arguments[0]);
                GlobalSet(frontend.HostChainGlobal);
                return WType.Void;
            case "Floor":
                GlobalGet(frontend.HeapFloorGlobal);
                return WType.I32;
            case "SetFloor":
                LocalGet(arguments[0]);
                GlobalSet(frontend.HeapFloorGlobal);
                return WType.Void;
            case "F32Bits":
                LocalGet(arguments[0]);
                code.Byte(0xbc); // i32.reinterpret_f32
                return WType.I32;
            case "F32FromBits":
                LocalGet(arguments[0]);
                code.Byte(0xbe); // f32.reinterpret_i32
                return WType.F32;
            case "F64Bits":
                LocalGet(arguments[0]);
                code.Byte(0xbd); // i64.reinterpret_f64
                return WType.I64;
            case "F64FromBits":
                LocalGet(arguments[0]);
                code.Byte(0xbf); // f64.reinterpret_i64
                return WType.F64;
        }

        (byte Opcode, int Alignment, WType Result) access = method.Name switch
        {
            "Load8U" => (0x2d, 0, WType.I32),
            "Load8S" => (0x2c, 0, WType.I32),
            "Load16U" => (0x2f, 1, WType.I32),
            "Load16S" => (0x2e, 1, WType.I32),
            "Load32" => (0x28, 2, WType.I32),
            "Load64" => (0x29, 3, WType.I64),
            "LoadF32" => (0x2a, 2, WType.F32),
            "LoadF64" => (0x2b, 3, WType.F64),
            "Store8" => (0x3a, 0, WType.Void),
            "Store16" => (0x3b, 1, WType.Void),
            "Store32" => (0x36, 2, WType.Void),
            "Store64" => (0x37, 3, WType.Void),
            "StoreF32" => (0x38, 2, WType.Void),
            "StoreF64" => (0x39, 3, WType.Void),
            _ => throw new CompileError($"'{method.ToDisplayString()}' has no lowering."),
        };
        PushArguments(arguments);
        code.Byte(access.Opcode);
        code.Index(access.Alignment);
        code.Index(0); // offset
        return access.Result;
    }

    // cabi_realloc(old, oldSize, alignment, newSize): a block of newSize
    // bytes at the arena's end, aligned, holding the first bytes of the old
    // block. The memory grows as needed; when it cannot, the call faults
    // like an exhausted allocation budget.
    //
    // While the CoreLib holds what the host allocates (a module whose async
    // imports return strings or lists, or whose futures and streams carry
    // them: see corelib/ComponentTasks.cs, HeldMemory), a block goes below
    // the arena's floor instead, which it raises over it, after a header of
    // its address, its end, the previous such block's header and whether
    // an entry is running (the arena below it is that entry's), chained
    // from __host_chain for the CoreLib to adopt; the glue's own calls set
    // the chain aside (EmitMemoryIntrinsic).
    private WasmFunction EmitRealloc()
    {
        int pointer = NewLocal(WType.I32);
        int end = NewLocal(WType.I32);
        int alignment = NewLocal(WType.I32);
        int header = frontend.HostChainGlobal >= 0 ? NewLocal(WType.I32) : -1;
        // An alignment of 0 is 1.
        LocalGet(2);
        code.I32(1);
        LocalGet(2);
        code.Byte(0x1b); // select
        LocalSet(alignment);
        if (header >= 0)
        {
            // The header at the arena's end, 8-aligned, the block past it.
            GlobalGet(frontend.HeapTopGlobal);
            code.I32(7);
            code.Byte(0x6a); // i32.add
            code.I32(-8);
            code.Byte(0x71); // i32.and
            LocalSet(header);
            LocalGet(header);
            code.I32(16);
            code.Byte(0x6a); // i32.add
            GlobalGet(frontend.HeapTopGlobal);
            GlobalGet(frontend.HostChainGlobal);
            code.Byte(0x1b); // select: past the header when held
        }
        else
        {
            GlobalGet(frontend.HeapTopGlobal);
        }

        LocalGet(alignment);
        code.Byte(0x6a); // i32.add
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        code.I32(0);
        LocalGet(alignment);
        code.Byte(0x6b); // i32.sub
        code.Byte(0x71); // i32.and
        LocalSet(pointer);

        // Sizes stay within 2 GiB, so the end cannot wrap.
        LocalGet(3);
        code.I32(int.MaxValue);
        LocalGet(pointer);
        code.Byte(0x6b); // i32.sub
        code.Byte(0x4b); // i32.gt_u
        TrapIf(FaultCode.AllocationBudgetExceeded);
        LocalGet(pointer);
        LocalGet(3);
        code.Byte(0x6a); // i32.add
        LocalSet(end);

        code.Byte(0x3f); // memory.size
        code.Byte(0x00);
        code.I32(16);
        code.Byte(0x74); // i32.shl
        LocalGet(end);
        code.Byte(0x49); // i32.lt_u
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(end);
        code.Byte(0x3f); // memory.size
        code.Byte(0x00);
        code.I32(16);
        code.Byte(0x74); // i32.shl
        code.Byte(0x6b); // i32.sub
        code.I32(0xffff);
        code.Byte(0x6a); // i32.add
        code.I32(16);
        code.Byte(0x76); // i32.shr_u
        code.Byte(0x40); // memory.grow
        code.Byte(0x00);
        code.I32(-1);
        code.Byte(0x46); // i32.eq
        TrapIf(FaultCode.AllocationBudgetExceeded);
        CloseBlock();

        LocalGet(end);
        GlobalSet(frontend.HeapTopGlobal);
        if (header >= 0)
        {
            GlobalGet(frontend.HostChainGlobal);
            OpenBlock(0x04, WType.Void, new object());
            LocalGet(header);
            LocalGet(pointer);
            code.Byte(0x36); // i32.store
            code.Index(2);
            code.Index(0);
            LocalGet(header);
            LocalGet(end);
            code.Byte(0x36); // i32.store offset=4
            code.Index(2);
            code.Index(4);
            LocalGet(header);
            GlobalGet(frontend.HostChainGlobal);
            code.Byte(0x36); // i32.store offset=8
            code.Index(2);
            code.Index(8);
            // Whether an entry is running: the arena below the block is
            // its, else the last one's, which is over.
            LocalGet(header);
            GlobalGet(frontend.EntriesGlobal);
            code.Byte(0x36); // i32.store offset=12
            code.Index(2);
            code.Index(12);
            LocalGet(header);
            GlobalSet(frontend.HostChainGlobal);
            LocalGet(end);
            GlobalSet(frontend.HeapFloorGlobal);
            CloseBlock();
        }

        LocalGet(1);
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(pointer);
        LocalGet(0);
        LocalGet(1);
        LocalGet(3);
        LocalGet(1);
        LocalGet(3);
        code.Byte(0x49); // i32.lt_u
        code.Byte(0x1b); // select: the smaller size
        code.Misc(10); // memory.copy
        code.Byte(0x00);
        code.Byte(0x00);
        CloseBlock();
        LocalGet(pointer);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }
}
