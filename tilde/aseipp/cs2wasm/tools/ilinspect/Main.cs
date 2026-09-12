// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

// Prints what an assembly's metadata says: its assembly references, the
// types it defines and forwards, its type and member references, or the IL
// of its methods. See README.md.
public static class Program
{
    private static readonly string[] Modes = ["all", "refs", "types", "typerefs", "memberrefs", "il"];

    public static int Main(string[] args)
    {
        string mode = args.Length > 1 ? args[1] : "all";
        if (args.Length == 0 || !Modes.Contains(mode) || (mode == "il") != (args.Length == 3))
        {
            Console.Error.WriteLine("usage: ilinspect ASSEMBLY [all|refs|types|typerefs|memberrefs]");
            Console.Error.WriteLine("       ilinspect ASSEMBLY il METHOD-SUBSTRING");
            return 2;
        }

        using var pe = new PEReader(File.OpenRead(args[0]));
        var reader = pe.GetMetadataReader();
        if (mode is "all" or "refs")
        {
            foreach (var handle in reader.AssemblyReferences)
            {
                var reference = reader.GetAssemblyReference(handle);
                Console.WriteLine($"asmref {reader.GetString(reference.Name)} {reference.Version}");
            }
        }

        if (mode is "all" or "types")
        {
            foreach (var handle in reader.TypeDefinitions)
            {
                var type = reader.GetTypeDefinition(handle);
                var visibility = type.Attributes & TypeAttributes.VisibilityMask;
                Console.WriteLine($"type {visibility} {DefinitionName(reader, handle)} methods={type.GetMethods().Count}");
            }

            foreach (var handle in reader.ExportedTypes)
            {
                var type = reader.GetExportedType(handle);
                Console.WriteLine($"exported {reader.GetString(type.Namespace)}.{reader.GetString(type.Name)}");
            }
        }

        if (mode is "all" or "typerefs")
        {
            foreach (var handle in reader.TypeReferences)
            {
                Console.WriteLine($"typeref {ReferenceName(reader, handle)}");
            }
        }

        if (mode is "all" or "memberrefs")
        {
            foreach (var handle in reader.MemberReferences)
            {
                var member = reader.GetMemberReference(handle);
                Console.WriteLine($"memberref {ParentName(reader, member.Parent)}::{reader.GetString(member.Name)}");
            }
        }

        if (mode == "il")
        {
            PrintIl(pe, reader, args[2]);
        }

        return 0;
    }

    // The IL of each method whose `Type::Method` contains the filter, an
    // instruction a line, tokens by name.
    private static void PrintIl(PEReader pe, MetadataReader reader, string filter)
    {
        var opcodes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Select(field => (OpCode)field.GetValue(null)!)
            .ToDictionary(opcode => (ushort)opcode.Value);
        foreach (var handle in reader.MethodDefinitions)
        {
            var method = reader.GetMethodDefinition(handle);
            string name = DefinitionName(reader, method.GetDeclaringType()) + "::" + reader.GetString(method.Name);
            if (!name.Contains(filter, StringComparison.Ordinal) || method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            Console.WriteLine("== " + name);
            var body = pe.GetMethodBody(method.RelativeVirtualAddress);
            foreach (var region in body.ExceptionRegions)
            {
                Console.WriteLine($"  .try IL_{region.TryOffset:X4}+{region.TryLength} {region.Kind} IL_{region.HandlerOffset:X4}+{region.HandlerLength}");
            }

            var il = body.GetILReader();
            while (il.RemainingBytes > 0)
            {
                int offset = il.Offset;
                int first = il.ReadByte();
                ushort value = first == 0xFE ? (ushort)(0xFE00 | il.ReadByte()) : (ushort)first;
                var opcode = opcodes[value];
                string operand = opcode.OperandType switch
                {
                    OperandType.InlineNone => "",
                    OperandType.ShortInlineBrTarget => $"IL_{il.ReadSByte() + il.Offset:X4}",
                    OperandType.InlineBrTarget => $"IL_{il.ReadInt32() + il.Offset:X4}",
                    OperandType.ShortInlineI => il.ReadSByte().ToString(),
                    OperandType.ShortInlineVar => il.ReadByte().ToString(),
                    OperandType.InlineVar => il.ReadUInt16().ToString(),
                    OperandType.InlineI => il.ReadInt32().ToString(),
                    OperandType.InlineI8 => il.ReadInt64().ToString(),
                    OperandType.ShortInlineR => il.ReadSingle().ToString(),
                    OperandType.InlineR => il.ReadDouble().ToString(),
                    OperandType.InlineSwitch => SwitchTargets(ref il),
                    OperandType.InlineString => '"' + reader.GetUserString(MetadataTokens.UserStringHandle(il.ReadInt32())) + '"',
                    _ => TokenName(reader, MetadataTokens.EntityHandle(il.ReadInt32())),
                };
                Console.WriteLine($"  IL_{offset:X4}: {opcode.Name} {operand}");
            }
        }
    }

    private static string SwitchTargets(ref BlobReader il)
    {
        int count = il.ReadInt32();
        var offsets = new int[count];
        for (int index = 0; index < count; index++)
        {
            offsets[index] = il.ReadInt32();
        }

        int end = il.Offset;
        return "(" + string.Join(", ", offsets.Select(offset => $"IL_{offset + end:X4}")) + ")";
    }

    private static string TokenName(MetadataReader reader, EntityHandle handle)
    {
        switch (handle.Kind)
        {
            case HandleKind.MemberReference:
                var member = reader.GetMemberReference((MemberReferenceHandle)handle);
                return ParentName(reader, member.Parent) + "::" + reader.GetString(member.Name);
            case HandleKind.MethodDefinition:
                var method = reader.GetMethodDefinition((MethodDefinitionHandle)handle);
                return DefinitionName(reader, method.GetDeclaringType()) + "::" + reader.GetString(method.Name);
            case HandleKind.FieldDefinition:
                var field = reader.GetFieldDefinition((FieldDefinitionHandle)handle);
                return DefinitionName(reader, field.GetDeclaringType()) + "::" + reader.GetString(field.Name);
            case HandleKind.MethodSpecification:
                return "spec:" + TokenName(reader, reader.GetMethodSpecification((MethodSpecificationHandle)handle).Method);
            default:
                return ParentName(reader, handle);
        }
    }

    private static string ParentName(MetadataReader reader, EntityHandle handle) => handle.Kind switch
    {
        HandleKind.TypeReference => ReferenceName(reader, (TypeReferenceHandle)handle),
        HandleKind.TypeDefinition => DefinitionName(reader, (TypeDefinitionHandle)handle),
        HandleKind.TypeSpecification => SpecificationName(reader, (TypeSpecificationHandle)handle),
        _ => $"{handle.Kind} {MetadataTokens.GetToken(handle):X8}",
    };

    // A generic instance by its definition; other specifications (arrays,
    // pointers) by their kind.
    private static string SpecificationName(MetadataReader reader, TypeSpecificationHandle handle)
    {
        var blob = reader.GetBlobReader(reader.GetTypeSpecification(handle).Signature);
        var code = blob.ReadSignatureTypeCode();
        if (code != SignatureTypeCode.GenericTypeInstance)
        {
            return "spec:" + code;
        }

        blob.ReadSignatureTypeCode();
        return "spec:" + ParentName(reader, blob.ReadTypeHandle());
    }

    private static string DefinitionName(MetadataReader reader, TypeDefinitionHandle handle)
    {
        var type = reader.GetTypeDefinition(handle);
        if (type.IsNested)
        {
            return DefinitionName(reader, type.GetDeclaringType()) + "/" + reader.GetString(type.Name);
        }

        string space = reader.GetString(type.Namespace);
        return space.Length == 0 ? reader.GetString(type.Name) : space + "." + reader.GetString(type.Name);
    }

    // A type reference with the assembly (or the enclosing type) it
    // resolves through.
    private static string ReferenceName(MetadataReader reader, TypeReferenceHandle handle)
    {
        var type = reader.GetTypeReference(handle);
        string name = reader.GetString(type.Namespace) is { Length: > 0 } space ? space + "." + reader.GetString(type.Name) : reader.GetString(type.Name);
        return type.ResolutionScope.Kind switch
        {
            HandleKind.AssemblyReference => $"[{reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)type.ResolutionScope).Name)}]{name}",
            HandleKind.TypeReference => ReferenceName(reader, (TypeReferenceHandle)type.ResolutionScope) + "/" + name,
            var kind => $"[{kind}]{name}",
        };
    }
}
