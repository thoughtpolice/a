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

    // Where the last instruction written, a local.set, starts and ends
    // (OpIndex); -1 when the last instruction was anything else.
    private long setAt = -1;
    private long setEnd = -1;
    private int setIndex;

    public byte[] ToArray() => stream.ToArray();

    // A position read may be where code is later spliced in, so a
    // local.set before it is not merged with a local.get after it.
    public int Length
    {
        get
        {
            setAt = -1;
            return (int)stream.Length;
        }
    }

    public ReadOnlySpan<byte> Written => stream.GetBuffer().AsSpan(0, (int)stream.Length);

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
        // local.set x then local.get x is local.tee x: the same value left
        // on the stack and in the local, two bytes shorter. The set is
        // rewritten in place, so no recorded position moves.
        if (opcode == 0x20 && setAt >= 0 && setIndex == index && setEnd == stream.Length)
        {
            stream.GetBuffer()[setAt] = 0x22;
            setAt = -1;
            return;
        }

        long start = stream.Length;
        Byte(opcode);
        Index(index);
        if (opcode == 0x21)
        {
            (setAt, setEnd, setIndex) = (start, stream.Length, index);
        }
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

    // ref.test and ref.cast take a heap type, a signed s33 like a
    // reference's; a nullable target lets null through.
    public void RefTest(WType type) => HeapOperand(type.IsNullable ? 21u : 20u, type);

    public void RefCast(WType type) => HeapOperand(type.IsNullable ? 23u : 22u, type);

    private void HeapOperand(uint opcode, WType type)
    {
        Byte(0xfb);
        U32(opcode);
        Signed(type.Heap);
    }

    // The 0xfc prefix: saturating float-to-integer conversions here.
    public void Misc(uint opcode)
    {
        Byte(0xfc);
        U32(opcode);
    }

    // The 0xfd prefix: SIMD's v128 instructions (see FunctionEmitter.Simd),
    // with a lane index where the instruction takes one.
    public void Simd(uint opcode)
    {
        Byte(0xfd);
        U32(opcode);
    }

    public void SimdLane(uint opcode, int lane)
    {
        Simd(opcode);
        Byte((byte)lane);
    }

    // v128.const of 16 bytes, little-endian lane order.
    public void V128Const(ReadOnlySpan<byte> bytes)
    {
        Simd(12);
        Bytes(bytes);
    }

    // i8x16.shuffle of two vectors by 16 constant byte indices.
    public void Shuffle(ReadOnlySpan<byte> lanes)
    {
        Simd(13);
        Bytes(lanes);
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

    // Wasm SIMD's 128-bit vector, System.Runtime.Intrinsics.Vector128<T>'s
    // representation (see Frontend.Simd).
    public static WType V128 => new(0x7b);

    // The abstract heap type of every struct, as its negative s33 code.
    public const int StructHeap = -0x15;

    // Values of source types are nullable references. Non-null references
    // type the immutable fields that hold vtables and function references.
    public static WType Ref(int heap) => new(0x63, heap);

    public static WType NonNullRef(int heap) => new(0x64, heap);

    // A struct value, flattened: the leaves of struct layout `layout`, which
    // take one Wasm value (local, parameter or result) each. It is never
    // written to a module; the frontend lowers it.
    public static WType Tuple(int layout) => new(0x01, layout);

    // A caught exception, as try_table's catch_all_ref hands it over.
    public static WType ExnRef => new(0x69);

    // A packed 16-bit array element (a string's code units); only a storage
    // type, read as an i32.
    public static WType I16 => new(0x77);

    public bool IsRef => Code is 0x63 or 0x64;

    public bool IsNullable => Code == 0x63;

    public bool IsTuple => Code == 0x01;

    public void Write(WasmWriter writer)
    {
        if (IsTuple)
        {
            throw new InternalCompilerError("a flattened struct reached the binary writer.");
        }

        writer.Byte(Code);
        if (IsRef)
        {
            // Heap types use signed s33 encoding, including positive type indices.
            writer.Signed(Heap);
        }
    }

    public void Default(WasmWriter writer)
    {
        if (Code == 0x64 || IsTuple)
        {
            throw new InvalidOperationException("A non-null reference or struct has no single default.");
        }

        if (IsRef)
        {
            writer.Byte(0xd0); // ref.null
            writer.Signed(Heap);
        }
        else if (this == ExnRef)
        {
            writer.Byte(0xd0); // ref.null
            writer.Byte(0x69); // exn
        }
        else if (this == V128)
        {
            writer.V128Const(stackalloc byte[16]);
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

// Type is the function's signature in the recursive group, or -1 for a
// signature of its own after the group (see ModuleWriter.Write).
internal sealed record WasmFunction(
    string Name,
    WType[] Parameters,
    WType Result,
    WType[] Locals,
    byte[] Instructions,
    int Type = -1);

internal enum DefinitionKind
{
    Struct,
    Array,
    Function,
}

internal readonly record struct WField(WType Type, bool Mutable = true);

// A type of the module's recursive group: a struct or array (a heap type),
// or a function signature. A struct may name a supertype, which the group
// declares before it; one that is not final may itself be a supertype.
internal sealed record TypeDefinition(
    string Name,
    DefinitionKind Kind,
    WField[] Fields,
    FunctionType Signature = default,
    int Supertype = -1,
    bool Final = true)
{
    public static TypeDefinition Struct(string name, WField[] fields, int supertype = -1, bool final = true) =>
        new(name, DefinitionKind.Struct, fields, default, supertype, final);

    public static TypeDefinition Array(string name, WField element, int supertype = -1, bool final = true) =>
        new(name, DefinitionKind.Array, [element], default, supertype, final);

    public static TypeDefinition Function(FunctionType signature) => new("func", DefinitionKind.Function, [], signature);

    public bool IsHeap => Kind != DefinitionKind.Function;
}

// A patch site in a function body or a global's initializer: the final index
// of a function (called or referenced) or of a class's vtable global goes at
// Offset once pruning has fixed it.
internal enum RelocationKind
{
    Call,
    FunctionReference,
    VTable,
    // A string literal's global.
    Literal,
    // A shared generic instantiation's dictionary's global (see
    // Frontend.SharedCode).
    Dictionary,
}

internal readonly record struct Relocation(int Offset, RelocationKind Kind, int Target);

// A function export, or (Kind 2) the memory.
internal sealed record WasmExport(string Name, int FunctionIndex, byte Kind = 0);

internal sealed record WasmImport(string Module, string Name, WType[] Parameters, WType Result);

// A function's signature in C# terms: its parameters and result may be
// flattened structs. Equality compares the parameter lists element by
// element, so identical signatures intern to one type index.
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

// A Wasm function type, with every struct flattened: several results when
// a function returns a struct.
internal readonly record struct FunctionType(WType[] Parameters, WType[] Results)
{
    public bool Equals(FunctionType other) =>
        Parameters.AsSpan().SequenceEqual(other.Parameters) && Results.AsSpan().SequenceEqual(other.Results);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var parameter in Parameters)
        {
            hash.Add(parameter);
        }

        hash.Add(Parameters.Length);
        foreach (var result in Results)
        {
            hash.Add(result);
        }

        return hash.ToHashCode();
    }

    public static FunctionType Of(Signature signature) => new(
        signature.Parameters,
        signature.Result == WType.Void ? [] : [signature.Result]);
}

// A global, mutable and initialized to the zero value of its type unless it
// carries a constant expression (without its final `end`).
internal sealed record WasmGlobal(string Name, WType Type, bool Mutable = true, byte[]? Initializer = null);

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

    public static readonly string[] ReservedExports = [FaultExport, "memory", "cabi_realloc"];

    // `declared` lists the functions that code names with ref.func; the
    // declarative element segment is what lets it do so. `tags` are the
    // function types of the exception tags, if any. `memory` gives the
    // module one linear memory of a page, the canonical ABI's.
    public static byte[] Write(
        IReadOnlyList<TypeDefinition> types,
        IReadOnlyList<WasmImport> imports,
        IReadOnlyList<WasmFunction> functions,
        IReadOnlyList<WasmExport> exports,
        IReadOnlyList<WasmGlobal> globals,
        IReadOnlyList<int> declared,
        IReadOnlyList<int> tags,
        bool memory = false)
    {
        var writer = new WasmWriter();
        writer.Bytes(new byte[] { 0, 0x61, 0x73, 0x6d, 1, 0, 0, 0 });

        // Host imports and exported entries keep signatures of their own,
        // after the recursive group: a type inside a group is only ever
        // equivalent to the same type in an identical group, and a component
        // matches these against standalone types. Identical ones share a type.
        var signatures = new List<Signature>();
        var signatureIds = new Dictionary<Signature, int>();
        int SignatureIndex(WType[] parameters, WType result)
        {
            var signature = new Signature(parameters, result);
            if (!signatureIds.TryGetValue(signature, out int index))
            {
                index = types.Count + signatures.Count;
                signatureIds.Add(signature, index);
                signatures.Add(signature);
            }

            return index;
        }

        int[] importTypes = imports.Select(import => SignatureIndex(import.Parameters, import.Result)).ToArray();
        int[] functionTypes = functions
            .Select(function => function.Type >= 0 ? function.Type : SignatureIndex(function.Parameters, function.Result))
            .ToArray();
        var allGlobals = RuntimeGlobals.Concat(globals).ToArray();

        // Stackification (Wasm.Locals), which reads the signatures of what
        // bodies call.
        var packing = new LocalPacking.Module(types, signatures, [.. importTypes, .. functionTypes], tags);
        functions = functions
            .Select((function, index) => LocalPacking.Optimize(
                function, packing.FunctionAt(imports.Count + index), packing))
            .ToList();

        WriteTypeSection(writer, types, signatures);
        WriteImportSection(writer, imports, importTypes);
        WriteFunctionSection(writer, functionTypes);
        if (memory)
        {
            writer.Section(5, section =>
            {
                section.Index(1);
                section.Byte(0x00); // no maximum
                section.Index(1);
            });
        }

        WriteTagSection(writer, tags);
        WriteGlobalSection(writer, allGlobals);
        WriteExportSection(writer, exports);
        WriteElementSection(writer, declared);
        WriteCodeSection(writer, functions);
        WriteNameSection(writer, imports, functions, allGlobals);

        // Deliberately no data, table or start sections; a memory only for
        // the canonical ABI.
        return writer.ToArray();
    }

    private static void WriteTypeSection(
        WasmWriter writer,
        IReadOnlyList<TypeDefinition> types,
        IReadOnlyList<Signature> signatures)
    {
        writer.Section(1, section =>
        {
            // One explicit recursive group for every heap type and internal
            // signature permits forward and mutually recursive references
            // among classes, arrays, vtables and function references.
            section.Index(signatures.Count + (types.Count == 0 ? 0 : 1));
            if (types.Count != 0)
            {
                section.Byte(0x4e); // rec
                section.Index(types.Count);
                foreach (var type in types)
                {
                    WriteSubtype(section, type);
                }
            }

            foreach (var signature in signatures)
            {
                WriteSignature(section, FunctionType.Of(signature));
            }
        });
    }

    // A final type without a supertype takes the short form, the bare
    // composite type; the others are `sub` (0x50) or `sub final` (0x4f).
    private static void WriteSubtype(WasmWriter section, TypeDefinition type)
    {
        if (!type.Final || type.Supertype >= 0)
        {
            section.Byte(type.Final ? (byte)0x4f : (byte)0x50);
            section.Index(type.Supertype >= 0 ? 1 : 0);
            if (type.Supertype >= 0)
            {
                section.Index(type.Supertype);
            }
        }

        switch (type.Kind)
        {
            case DefinitionKind.Function:
                WriteSignature(section, type.Signature);
                return;
            case DefinitionKind.Array:
                section.Byte(0x5e);
                break;
            default:
                section.Byte(0x5f);
                section.Index(type.Fields.Length);
                break;
        }

        foreach (var field in type.Fields)
        {
            field.Type.Write(section);
            section.Byte(field.Mutable ? (byte)1 : (byte)0);
        }
    }

    private static void WriteSignature(WasmWriter section, FunctionType signature)
    {
        section.Byte(0x60); // func
        section.Index(signature.Parameters.Length);
        foreach (var parameter in signature.Parameters)
        {
            parameter.Write(section);
        }

        section.Index(signature.Results.Length);
        foreach (var result in signature.Results)
        {
            result.Write(section);
        }
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

    // Section 13, between the memory and global sections: each tag's
    // attribute (0, an exception) and function type.
    private static void WriteTagSection(WasmWriter writer, IReadOnlyList<int> tags)
    {
        if (tags.Count == 0)
        {
            return;
        }

        writer.Section(13, section =>
        {
            section.Index(tags.Count);
            foreach (int type in tags)
            {
                section.Byte(0x00);
                section.Index(type);
            }
        });
    }

    private static void WriteGlobalSection(WasmWriter writer, IReadOnlyList<WasmGlobal> globals)
    {
        // The runtime globals come first; only the fault global is exported.
        // They aren't a substitute for the embedding's physical heap/CPU
        // resource limits. Static fields follow, initialized to constants,
        // then the immutable vtables, built by constant expressions.
        writer.Section(6, section =>
        {
            section.Index(globals.Count);
            foreach (var global in globals)
            {
                global.Type.Write(section);
                section.Byte(global.Mutable ? (byte)1 : (byte)0);
                if (global.Initializer is not null)
                {
                    section.Bytes(global.Initializer);
                }
                else
                {
                    global.Type.Default(section);
                }

                section.Byte(0x0b); // end initializer expression
            }
        });
    }

    // One declarative segment (flags 3, element kind funcref) declares the
    // functions code references; nothing is written to a table.
    private static void WriteElementSection(WasmWriter writer, IReadOnlyList<int> declared)
    {
        if (declared.Count == 0)
        {
            return;
        }

        writer.Section(9, section =>
        {
            section.Index(1);
            section.Index(3);
            section.Byte(0x00);
            section.Index(declared.Count);
            foreach (int function in declared)
            {
                section.Index(function);
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
                section.Byte(export.Kind);
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
                // Each run of locals of one type is one declaration (but
                // with GAMEPLAYC_STACKIFY=0, which writes the lowering's
                // locals as they were).
                var body = new WasmWriter();
                var runs = new List<(int Count, WType Type)>();
                foreach (var local in function.Locals)
                {
                    if (runs.Count != 0 && runs[^1].Type == local && LocalPacking.Enabled)
                    {
                        runs[^1] = (runs[^1].Count + 1, local);
                    }
                    else
                    {
                        runs.Add((1, local));
                    }
                }

                body.Index(runs.Count);
                foreach (var (count, type) in runs)
                {
                    body.Index(count);
                    type.Write(body);
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
                // A function without a name (shared code's ExactSteps and
                // entries) has none in the map.
                names.Index(imports.Count + functions.Count(function => function.Name.Length != 0));
                for (int index = 0; index < imports.Count; index++)
                {
                    names.Index(index);
                    names.Name(imports[index].Module + "." + imports[index].Name);
                }

                for (int index = 0; index < functions.Count; index++)
                {
                    if (functions[index].Name.Length == 0)
                    {
                        continue;
                    }

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
