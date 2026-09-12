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

        byte[] data = payload.ToArray();
        Byte(id);
        Index(data.Length);
        Bytes(data);
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
        else if (this == I32)
        {
            writer.I32(0);
        }
        else if (this == I64)
        {
            writer.I64(0);
        }
        else if (this == F32)
        {
            writer.Byte(0x43); // f32.const
            writer.F32(0);
        }
        else if (this == F64)
        {
            writer.Byte(0x44); // f64.const
            writer.F64(0);
        }
        else
        {
            throw new InvalidOperationException("Cannot initialize void.");
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

internal static class ModuleWriter
{
    public static byte[] Write(
        IReadOnlyList<HeapDefinition> heaps,
        IReadOnlyList<WasmImport> imports,
        IReadOnlyList<WasmFunction> functions,
        IReadOnlyList<WasmExport> exports)
    {
        var writer = new WasmWriter();
        writer.Bytes(new byte[] { 0, 0x61, 0x73, 0x6d, 1, 0, 0, 0 });

        WriteTypeSection(writer, heaps, imports, functions);
        WriteImportSection(writer, heaps.Count, imports);
        WriteFunctionSection(writer, heaps.Count + imports.Count, functions.Count);
        WriteGlobalSection(writer);
        WriteExportSection(writer, exports);
        WriteCodeSection(writer, functions);
        WriteNameSection(writer, imports, functions);

        // Deliberately no memory, data, table, start or element sections.
        return writer.ToArray();
    }

    private static void WriteTypeSection(
        WasmWriter writer,
        IReadOnlyList<HeapDefinition> heaps,
        IReadOnlyList<WasmImport> imports,
        IReadOnlyList<WasmFunction> functions)
    {
        writer.Section(1, section =>
        {
            // One explicit recursive group for all heap types permits forward
            // and mutually recursive class/array references. Functions follow it.
            section.Index(imports.Count + functions.Count + (heaps.Count == 0 ? 0 : 1));
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

            foreach (var import in imports)
            {
                WriteSignature(section, import.Parameters, import.Result);
            }

            foreach (var function in functions)
            {
                WriteSignature(section, function.Parameters, function.Result);
            }
        });
    }

    private static void WriteSignature(WasmWriter writer, WType[] parameters, WType result)
    {
        writer.Byte(0x60); // func
        writer.Index(parameters.Length);
        foreach (var parameter in parameters)
        {
            parameter.Write(writer);
        }

        writer.Index(result == WType.Void ? 0 : 1);
        if (result != WType.Void)
        {
            result.Write(writer);
        }
    }

    private static void WriteImportSection(WasmWriter writer, int heapCount, IReadOnlyList<WasmImport> imports)
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
                section.Index(heapCount + index);
            }
        });
    }

    private static void WriteFunctionSection(WasmWriter writer, int firstTypeIndex, int functionCount)
    {
        writer.Section(3, section =>
        {
            section.Index(functionCount);
            for (int index = 0; index < functionCount; index++)
            {
                section.Index(firstTypeIndex + index);
            }
        });
    }

    private static void WriteGlobalSection(WasmWriter writer)
    {
        // Globals: control-step fuel, active call depth, logical allocation units,
        // and last fault code. Only the fault global is exported. These aren't
        // a substitute for the embedding's physical heap/CPU resource limits.
        writer.Section(6, section =>
        {
            section.Index(4);
            foreach (var type in new[] { WType.I32, WType.I32, WType.I64, WType.I32 })
            {
                type.Write(section);
                section.Byte(1); // mutable global
                type.Default(section);
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

            section.Name("__fault");
            section.Byte(3); // global export
            section.Index(3);
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
                byte[] bytes = body.ToArray();
                section.Index(bytes.Length);
                section.Bytes(bytes);
            }
        });
    }

    private static void WriteNameSection(
        WasmWriter writer, IReadOnlyList<WasmImport> imports, IReadOnlyList<WasmFunction> functions)
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
        });
    }
}
