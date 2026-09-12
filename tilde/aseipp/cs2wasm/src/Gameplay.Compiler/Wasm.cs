// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Buffers.Binary;
using System.Text;

namespace Gameplay.Compiler;

// Binary encoding follows the WebAssembly 3.0 core specification. The module
// binary version remains 1; GC is a feature of the instruction/type vocabulary.
internal sealed class WasmWriter
{
    private readonly MemoryStream stream = new();

    public byte[] ToArray() => stream.ToArray();

    public int Length => (int)stream.Length;

    public ReadOnlySpan<byte> Written => stream.GetBuffer().AsSpan(0, Length);

    public void Byte(byte value) => stream.WriteByte(value);

    public void Bytes(ReadOnlySpan<byte> value) => stream.Write(value);

    public void U32(uint value)
    {
        // Unsigned LEB128 stores seven value bits per byte. The high bit means
        // another byte follows.
        do
        {
            byte chunk = (byte)(value & 0x7f);
            value >>= 7;
            Byte(value == 0 ? chunk : (byte)(chunk | 0x80));
        }
        while (value != 0);
    }

    public void Index(int value)
    {
        if (value < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(value));
        }

        U32((uint)value);
    }

    public void Signed(long value)
    {
        while (true)
        {
            byte chunk = (byte)(value & 0x7f);
            value >>= 7;

            // Signed LEB128 can stop once the remaining bits are only sign
            // extension and the last chunk has the matching sign bit.
            bool complete = (value == 0 && (chunk & 0x40) == 0)
                || (value == -1 && (chunk & 0x40) != 0);
            Byte(complete ? chunk : (byte)(chunk | 0x80));

            if (complete)
            {
                return;
            }
        }
    }

    public void Name(string value)
    {
        byte[] data = Encoding.UTF8.GetBytes(value);
        Index(data.Length);
        Bytes(data);
    }

    public void F32(float value)
    {
        Span<byte> data = stackalloc byte[4];
        BinaryPrimitives.WriteSingleLittleEndian(data, value);
        Bytes(data);
    }

    public void F64(double value)
    {
        Span<byte> data = stackalloc byte[8];
        BinaryPrimitives.WriteDoubleLittleEndian(data, value);
        Bytes(data);
    }

    public void Section(byte id, Action<WasmWriter> emit)
    {
        var payload = new WasmWriter();
        emit(payload);

        Byte(id);
        Sized(payload);
    }

    // Another writer's bytes, prefixed with their length, copied straight
    // from its buffer.
    public void Sized(WasmWriter payload)
    {
        Index(payload.Length);
        Bytes(payload.Written);
    }

    public void OpIndex(byte opcode, int index)
    {
        Byte(opcode);
        Index(index);
    }

    public void Gc(uint opcode, params int[] operands)
    {
        Byte(0xfb);
        U32(opcode);
        foreach (int operand in operands)
        {
            Index(operand);
        }
    }

    // The 0xfc prefix: saturating float-to-integer conversions here.
    public void Misc(uint opcode)
    {
        Byte(0xfc);
        U32(opcode);
    }

    public void I32(int value)
    {
        Byte(0x41);
        Signed(value);
    }

    public void I64(long value)
    {
        Byte(0x42);
        Signed(value);
    }

    public void F32Const(float value)
    {
        Byte(0x43);
        F32(value);
    }

    public void F64Const(double value)
    {
        Byte(0x44);
        F64(value);
    }

    // A numeric constant of the given representation. Integers wrap to the
    // width of an i32; floating-point types take the nearest value.
    public void Const(WType type, long value)
    {
        if (type == WType.I32)
        {
            I32(unchecked((int)value));
        }
        else if (type == WType.I64)
        {
            I64(value);
        }
        else
        {
            Const(type, (double)value);
        }
    }

    public void Const(WType type, double value)
    {
        if (type == WType.F32)
        {
            F32Const((float)value);
        }
        else if (type == WType.F64)
        {
            F64Const(value);
        }
        else
        {
            throw new InvalidOperationException($"No floating-point constant of type 0x{type.Code:x2}.");
        }
    }
}

internal readonly record struct WType(byte Code, int Heap = -1)
{
    public static WType Void => new(0x40);
    public static WType I32 => new(0x7f);
    public static WType I64 => new(0x7e);
    public static WType F32 => new(0x7d);
    public static WType F64 => new(0x7c);

    // All typed references in this subset are nullable.
    public static WType Ref(int heap) => new(0x63, heap);

    public bool IsRef => Code == 0x63;

    public void Write(WasmWriter writer)
    {
        writer.Byte(Code);
        if (IsRef)
        {
            // Heap types use signed s33 encoding, including positive type indices.
            writer.Signed(Heap);
        }
    }

    public void Default(WasmWriter writer)
    {
        if (IsRef)
        {
            writer.Byte(0xd0); // ref.null
            writer.Signed(Heap);
        }
        else if (this == Void)
        {
            throw new InvalidOperationException("Cannot initialize void.");
        }
        else
        {
            writer.Const(this, 0L);
        }
    }
}

internal sealed record WasmFunction(
    string Name,
    WType[] Parameters,
    WType Result,
    WType[] Locals,
    byte[] Instructions);

internal sealed record HeapDefinition(string Name, bool IsArray, WType[] Fields);

internal sealed record WasmExport(string Name, int FunctionIndex);

internal sealed record WasmImport(string Module, string Name, WType[] Parameters, WType Result);

// A function type. Equality compares the parameter lists element by element,
// so identical signatures intern to one type index.
internal readonly record struct Signature(WType[] Parameters, WType Result)
{
    public bool Equals(Signature other) =>
        Result == other.Result && Parameters.AsSpan().SequenceEqual(other.Parameters);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.Add(Result);
        foreach (var parameter in Parameters)
        {
            hash.Add(parameter);
        }

        return hash.ToHashCode();
    }
}

// A mutable global, initialized to the zero value of its type.
internal sealed record WasmGlobal(string Name, WType Type);

internal static class ModuleWriter
{
    // Control-step fuel, active call depth, logical allocation units, and the
    // last fault code, in this order. Static fields follow them.
    public static readonly WasmGlobal[] RuntimeGlobals =
    [
        new("__fuel", WType.I32),
        new("__depth", WType.I32),
        new("__allocation_budget", WType.I64),
        new("__fault", WType.I32),
    ];

    public const int FuelGlobal = 0;
    public const int CallDepthGlobal = 1;
    public const int AllocationBudgetGlobal = 2;
    public const int FaultGlobal = 3;

    // Every module exports the fault global under this name, besides the
    // functions the source exports; no source export may take it.
    public const string FaultExport = "__fault";

    public static readonly string[] ReservedExports = [FaultExport];

    public static byte[] Write(
        IReadOnlyList<HeapDefinition> heaps,
        IReadOnlyList<WasmImport> imports,
        IReadOnlyList<WasmFunction> functions,
        IReadOnlyList<WasmExport> exports,
        IReadOnlyList<WasmGlobal> globals)
    {
        var writer = new WasmWriter();
        writer.Bytes(new byte[] { 0, 0x61, 0x73, 0x6d, 1, 0, 0, 0 });

        // Identical signatures share one function type, numbered after the heap types.
        var signatures = new List<Signature>();
        var signatureIds = new Dictionary<Signature, int>();
        int SignatureIndex(WType[] parameters, WType result)
        {
            var signature = new Signature(parameters, result);
            if (!signatureIds.TryGetValue(signature, out int index))
            {
                index = heaps.Count + signatures.Count;
                signatureIds.Add(signature, index);
                signatures.Add(signature);
            }

            return index;
        }

        int[] importTypes = imports.Select(import => SignatureIndex(import.Parameters, import.Result)).ToArray();
        int[] functionTypes = functions.Select(function => SignatureIndex(function.Parameters, function.Result)).ToArray();
        var allGlobals = RuntimeGlobals.Concat(globals).ToArray();

        WriteTypeSection(writer, heaps, signatures);
        WriteImportSection(writer, imports, importTypes);
        WriteFunctionSection(writer, functionTypes);
        WriteGlobalSection(writer, allGlobals);
        WriteExportSection(writer, exports);
        WriteCodeSection(writer, functions);
        WriteNameSection(writer, imports, functions, allGlobals);

        // Deliberately no memory, data, table, start or element sections.
        return writer.ToArray();
    }

    private static void WriteTypeSection(
        WasmWriter writer,
        IReadOnlyList<HeapDefinition> heaps,
        IReadOnlyList<Signature> signatures)
    {
        writer.Section(1, section =>
        {
            // One explicit recursive group for all heap types permits forward
            // and mutually recursive class/array references. Functions follow it.
            section.Index(signatures.Count + (heaps.Count == 0 ? 0 : 1));
            if (heaps.Count != 0)
            {
                section.Byte(0x4e); // rec
                section.Index(heaps.Count);
                foreach (var heap in heaps)
                {
                    section.Byte(heap.IsArray ? (byte)0x5e : (byte)0x5f);
                    if (!heap.IsArray)
                    {
                        section.Index(heap.Fields.Length);
                    }

                    foreach (var field in heap.Fields)
                    {
                        field.Write(section);
                        section.Byte(1); // mutable field
                    }
                }
            }

            foreach (var signature in signatures)
            {
                section.Byte(0x60); // func
                section.Index(signature.Parameters.Length);
                foreach (var parameter in signature.Parameters)
                {
                    parameter.Write(section);
                }

                section.Index(signature.Result == WType.Void ? 0 : 1);
                if (signature.Result != WType.Void)
                {
                    signature.Result.Write(section);
                }
            }
        });
    }

    private static void WriteImportSection(WasmWriter writer, IReadOnlyList<WasmImport> imports, int[] types)
    {
        if (imports.Count == 0)
        {
            return;
        }

        writer.Section(2, section =>
        {
            section.Index(imports.Count);
            for (int index = 0; index < imports.Count; index++)
            {
                section.Name(imports[index].Module);
                section.Name(imports[index].Name);
                section.Byte(0); // function import
                section.Index(types[index]);
            }
        });
    }

    private static void WriteFunctionSection(WasmWriter writer, int[] types)
    {
        writer.Section(3, section =>
        {
            section.Index(types.Length);
            foreach (int type in types)
            {
                section.Index(type);
            }
        });
    }

    private static void WriteGlobalSection(WasmWriter writer, IReadOnlyList<WasmGlobal> globals)
    {
        // The runtime globals come first; only the fault global is exported.
        // They aren't a substitute for the embedding's physical heap/CPU
        // resource limits. Static fields follow, initialized to constants.
        writer.Section(6, section =>
        {
            section.Index(globals.Count);
            foreach (var global in globals)
            {
                global.Type.Write(section);
                section.Byte(1); // mutable global
                global.Type.Default(section);
                section.Byte(0x0b); // end initializer expression
            }
        });
    }

    private static void WriteExportSection(WasmWriter writer, IReadOnlyList<WasmExport> exports)
    {
        writer.Section(7, section =>
        {
            section.Index(exports.Count + 1);
            foreach (var export in exports)
            {
                section.Name(export.Name);
                section.Byte(0); // function export
                section.Index(export.FunctionIndex);
            }

            section.Name(FaultExport);
            section.Byte(3); // global export
            section.Index(FaultGlobal);
        });
    }

    private static void WriteCodeSection(WasmWriter writer, IReadOnlyList<WasmFunction> functions)
    {
        writer.Section(10, section =>
        {
            section.Index(functions.Count);
            foreach (var function in functions)
            {
                var body = new WasmWriter();
                body.Index(function.Locals.Length);
                foreach (var local in function.Locals)
                {
                    body.Index(1); // one local per declaration group
                    local.Write(body);
                }

                body.Bytes(function.Instructions);
                section.Sized(body);
            }
        });
    }

    private static void WriteNameSection(
        WasmWriter writer,
        IReadOnlyList<WasmImport> imports,
        IReadOnlyList<WasmFunction> functions,
        IReadOnlyList<WasmGlobal> globals)
    {
        writer.Section(0, section =>
        {
            section.Name("name");
            section.Section(1, names =>
            {
                names.Index(imports.Count + functions.Count);
                for (int index = 0; index < imports.Count; index++)
                {
                    names.Index(index);
                    names.Name(imports[index].Module + "." + imports[index].Name);
                }

                for (int index = 0; index < functions.Count; index++)
                {
                    names.Index(imports.Count + index);
                    names.Name(functions[index].Name);
                }
            });

            // Global names (subsection 7) make static fields legible in
            // disassemblies; the runtime globals keep their documented names.
            section.Section(7, names =>
            {
                names.Index(globals.Count);
                for (int index = 0; index < globals.Count; index++)
                {
                    names.Index(index);
                    names.Name(globals[index].Name);
                }
            });
        });
    }
}
