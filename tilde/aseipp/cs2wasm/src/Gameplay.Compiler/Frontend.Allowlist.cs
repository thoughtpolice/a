// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Text;

namespace Gameplay.Compiler;

// API control (docs/IMPORTER.md): the member references of every imported
// assembly, checked against checked-in lists. The user's assembly is
// checked against corelib/allowlist.txt's rules, each reference located at
// the first instruction that makes it; an imported framework assembly
// against corelib/framework/<name>.txt, every member it references
// elsewhere by signature, so that a new SDK cannot widen what it reaches
// without the list saying so.
internal sealed partial class Frontend
{
    private const string AllowlistResource = "Gameplay.Compiler.Allowlist.txt";

    // A member reference: the metadata name of its type (the generic
    // definition's, a nested type's with '+'), its name, and its signature.
    internal readonly record struct MemberKey(string Type, string Name, string Signature)
    {
        public override string ToString() => $"{Type}::{Name}{Signature}";
    }

    // The external member references of an image, each with the handle it
    // is known by: those of another assembly than the image and the
    // `owned` ones (the libraries a module is compiled with).
    private static List<(MemberReferenceHandle Handle, MemberKey Key)> MemberReferences(MetadataReader reader, IReadOnlySet<string>? owned = null)
    {
        var provider = new SignatureNames(reader);
        var references = new List<(MemberReferenceHandle, MemberKey)>();
        foreach (var handle in reader.MemberReferences)
        {
            var reference = reader.GetMemberReference(handle);
            if (ReferencedTypeName(reader, reference.Parent) is not { } type
                || (owned is { Count: > 0 } && owned.Contains(ReferencedAssemblyName(reader, reference.Parent) ?? "")))
            {
                // A member of the image's own type (a generic instance of
                // it, say), or of a library's.
                continue;
            }

            string signature = reference.GetKind() == MemberReferenceKind.Field
                ? ":" + reference.DecodeFieldSignature(provider, null)
                : MethodSignatureText(reference.DecodeMethodSignature(provider, null));
            references.Add((handle, new MemberKey(type, reader.GetString(reference.Name), signature)));
        }

        return references;
    }

    private static string MethodSignatureText(MethodSignature<string> signature) =>
        (signature.GenericParameterCount > 0 ? $"<{signature.GenericParameterCount}>" : "")
        + "(" + string.Join(", ", signature.ParameterTypes) + "):" + signature.ReturnType;

    // The type a member reference's parent names, when it is another
    // assembly's: null for the image's own.
    private static string? ReferencedTypeName(MetadataReader reader, EntityHandle parent)
    {
        switch (parent.Kind)
        {
            case HandleKind.TypeReference:
                return TypeReferenceName(reader, (TypeReferenceHandle)parent);
            case HandleKind.TypeSpecification:
                var blob = reader.GetBlobReader(reader.GetTypeSpecification((TypeSpecificationHandle)parent).Signature);
                if (blob.ReadSignatureTypeCode() != SignatureTypeCode.GenericTypeInstance)
                {
                    // An array's own members (a multidimensional array's
                    // Get, Set and Address).
                    return null;
                }

                blob.ReadSignatureTypeCode();
                var definition = blob.ReadTypeHandle();
                return definition.Kind == HandleKind.TypeReference ? TypeReferenceName(reader, (TypeReferenceHandle)definition) : null;
            default:
                return null;
        }
    }

    // The assembly a member reference's parent type is defined in, by its
    // reference's name: null for the image's own.
    private static string? ReferencedAssemblyName(MetadataReader reader, EntityHandle parent)
    {
        if (parent.Kind == HandleKind.TypeSpecification)
        {
            var blob = reader.GetBlobReader(reader.GetTypeSpecification((TypeSpecificationHandle)parent).Signature);
            if (blob.ReadSignatureTypeCode() != SignatureTypeCode.GenericTypeInstance)
            {
                return null;
            }

            blob.ReadSignatureTypeCode();
            parent = blob.ReadTypeHandle();
        }

        if (parent.Kind != HandleKind.TypeReference)
        {
            return null;
        }

        var scope = reader.GetTypeReference((TypeReferenceHandle)parent).ResolutionScope;
        while (scope.Kind == HandleKind.TypeReference)
        {
            scope = reader.GetTypeReference((TypeReferenceHandle)scope).ResolutionScope;
        }

        return scope.Kind == HandleKind.AssemblyReference
            ? reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)scope).Name)
            : null;
    }

    private static string TypeReferenceName(MetadataReader reader, TypeReferenceHandle handle)
    {
        var reference = reader.GetTypeReference(handle);
        string name = reader.GetString(reference.Name);
        if (reference.ResolutionScope.Kind == HandleKind.TypeReference)
        {
            return TypeReferenceName(reader, (TypeReferenceHandle)reference.ResolutionScope) + "+" + name;
        }

        string space = reader.GetString(reference.Namespace);
        return space.Length == 0 ? name : space + "." + name;
    }

    // The rules of corelib/allowlist.txt: `allow` or `deny` a pattern of
    // `Type::Member`, where `*` matches any run of characters; the first
    // rule that matches a reference decides it, and one no rule matches is
    // denied.
    private static List<(bool Allow, string Pattern)> AllowlistRules()
    {
        var rules = new List<(bool, string)>();
        foreach (string raw in Encoding.UTF8.GetString(ReadResource(AllowlistResource)).Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            string[] parts = line.Split(' ', 2, StringSplitOptions.TrimEntries);
            if (parts.Length != 2 || parts[0] is not ("allow" or "deny"))
            {
                throw new InternalCompilerError($"allowlist line '{line}' is neither `allow PATTERN` nor `deny PATTERN`.");
            }

            rules.Add((parts[0] == "allow", parts[1]));
        }

        return rules;
    }

    private static bool Matches(string pattern, string text)
    {
        // Glob matching of `*` over the whole text.
        string[] pieces = pattern.Split('*');
        if (pieces.Length == 1)
        {
            return pattern == text;
        }

        if (!text.StartsWith(pieces[0], StringComparison.Ordinal) || !text.EndsWith(pieces[^1], StringComparison.Ordinal)
            || text.Length < pieces[0].Length + pieces[^1].Length)
        {
            return false;
        }

        int at = pieces[0].Length;
        int end = text.Length - pieces[^1].Length;
        for (int piece = 1; piece < pieces.Length - 1; piece++)
        {
            int found = text.IndexOf(pieces[piece], at, end - at, StringComparison.Ordinal);
            if (found < 0)
            {
                return false;
            }

            at = found + pieces[piece].Length;
        }

        return true;
    }

    // Checks the user's assembly (or a library of it): each member
    // reference its code makes that the rules do not allow is an error at
    // the first instruction making it. The libraries' own members are
    // theirs to check.
    private static void CheckUserReferences(IlModule module, IReadOnlySet<string> libraries)
    {
        var rules = AllowlistRules();
        var denied = new Dictionary<int, MemberKey>();
        foreach (var (handle, key) in MemberReferences(module.Reader, libraries))
        {
            string text = key.Type + "::" + key.Name;
            bool allowed = rules.FirstOrDefault(rule => Matches(rule.Pattern, text)) is { Pattern: not null } rule && rule.Allow;
            if (!allowed)
            {
                denied.Add(MetadataTokens.GetToken(handle), key);
            }
        }

        if (denied.Count == 0)
        {
            return;
        }

        foreach (var (method, offset, token) in module.MemberTokenUses())
        {
            int reference = token;
            if (MetadataTokens.EntityHandle(token).Kind == HandleKind.MethodSpecification)
            {
                reference = MetadataTokens.GetToken(module.Reader.GetMethodSpecification((MethodSpecificationHandle)MetadataTokens.EntityHandle(token)).Method);
            }

            if (denied.TryGetValue(reference, out var key))
            {
                string at = module.Location(method, offset) ?? $"{method.ToDisplayString()}+IL_{offset:X4}";
                throw new CompileError($"{at}: GP1000: '{key.Type}::{key.Name}' is not in the gameplay API (corelib/allowlist.txt).");
            }
        }

        var first = denied.Values.First();
        throw new CompileError($"GP1000: '{first.Type}::{first.Name}' is not in the gameplay API (corelib/allowlist.txt).");
    }

    // Checks an imported framework assembly: every member it references
    // elsewhere must be on its list.
    private static void CheckFrameworkReferences(string name, byte[] image)
    {
        using var pe = new PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image));
        var reader = pe.GetMetadataReader();
        var listed = Encoding.UTF8.GetString(ReadResource($"Gameplay.Compiler.FrameworkReferences.{name}.txt"))
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length != 0 && !line.StartsWith('#'))
            .ToHashSet(StringComparer.Ordinal);
        var unlisted = MemberReferences(reader).Select(reference => reference.Key.ToString())
            .Where(key => !listed.Contains(key))
            .Distinct()
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToList();
        if (unlisted.Count != 0)
        {
            throw new CompileError(
                $"The framework assembly {name} references what corelib/framework/{name}.txt does not list "
                + $"(a new SDK?): {string.Join("; ", unlisted.Take(8))}{(unlisted.Count > 8 ? $"; and {unlisted.Count - 8} more" : "")}.");
        }
    }

    // For the compiler's own maintenance: the member references of an
    // image, one per line, as corelib/framework/<name>.txt lists them.
    private static void DumpReferences(string name, byte[] image)
    {
        if (Environment.GetEnvironmentVariable("GAMEPLAYC_DUMP_REFERENCES") is not { } directory)
        {
            return;
        }

        using var pe = new PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image));
        var keys = MemberReferences(pe.GetMetadataReader()).Select(reference => reference.Key.ToString())
            .Distinct()
            .OrderBy(key => key, StringComparer.Ordinal);
        File.WriteAllLines(Path.Combine(directory, name + ".txt"), keys);
    }

    // Type names in signatures, for the lists.
    private sealed class SignatureNames(MetadataReader reader) : ISignatureTypeProvider<string, object?>
    {
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[" + new string(',', shape.Rank - 1) + "]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetFunctionPointerType(MethodSignature<string> signature) => "method" + MethodSignatureText(signature);

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) =>
            genericType + "<" + string.Join(", ", typeArguments) + ">";

        public string GetGenericMethodParameter(object? genericContext, int index) => "!!" + index;

        public string GetGenericTypeParameter(object? genericContext, int index) => "!" + index;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(MetadataReader metadata, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            var definition = reader.GetTypeDefinition(handle);
            string name = reader.GetString(definition.Name);
            string space = reader.GetString(definition.Namespace);
            return space.Length == 0 ? name : space + "." + name;
        }

        public string GetTypeFromReference(MetadataReader metadata, TypeReferenceHandle handle, byte rawTypeKind) =>
            TypeReferenceName(reader, handle);

        public string GetTypeFromSpecification(MetadataReader metadata, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
    }
}
