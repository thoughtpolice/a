// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Gameplay.Compiler;

// A type in an IL signature: Roslyn's symbol for it, and whether the
// signature takes it by reference (a byref local, parameter, return or
// stack value) or pins it.
internal sealed record IlType(ITypeSymbol Type, bool ByRef = false, bool Pinned = false)
{
    public override string ToString() => Type.ToDisplayString() + (ByRef ? "&" : "") + (Pinned ? " pinned" : "");
}

// The type parameters a signature's `!n` and `!!n` name: those of the
// definition whose IL is being read (its containing types' first, outermost
// first, as metadata flattens them) and of its method. Two contexts of the
// same parameters are equal, however they were made, so what IlModule
// resolves in one it has resolved in the other.
internal sealed record IlGenericContext(ImmutableArray<ITypeParameterSymbol> TypeParameters, ImmutableArray<ITypeParameterSymbol> MethodTypeParameters)
{
    public bool Equals(IlGenericContext? other) =>
        other is not null && Same(TypeParameters, other.TypeParameters) && Same(MethodTypeParameters, other.MethodTypeParameters);

    private static bool Same(ImmutableArray<ITypeParameterSymbol> left, ImmutableArray<ITypeParameterSymbol> right)
    {
        if (left.Length != right.Length)
        {
            return false;
        }

        for (int index = 0; index < left.Length; index++)
        {
            if (!ReferenceEquals(left[index], right[index]))
            {
                return false;
            }
        }

        return true;
    }

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var parameter in TypeParameters)
        {
            hash.Add(RuntimeHelpers.GetHashCode(parameter));
        }

        hash.Add(-1);
        foreach (var parameter in MethodTypeParameters)
        {
            hash.Add(RuntimeHelpers.GetHashCode(parameter));
        }

        return hash.ToHashCode();
    }

    public static IlGenericContext Of(INamedTypeSymbol? type, IMethodSymbol? method = null) =>
        new(type is null ? [] : AllTypeParameters(type), method is null ? [] : method.OriginalDefinition.TypeParameters);

    public static ImmutableArray<ITypeParameterSymbol> AllTypeParameters(INamedTypeSymbol type)
    {
        var chain = new List<INamedTypeSymbol>();
        for (INamedTypeSymbol? current = type.OriginalDefinition; current is not null; current = current.ContainingType)
        {
            chain.Insert(0, current.OriginalDefinition);
        }

        return [.. chain.SelectMany(part => part.TypeParameters)];
    }
}

// An assembly the importer reads IL from: its metadata, its portable PDB
// (for source locations), and the map from its definitions' tokens to the
// symbols Roslyn reads from the same metadata. Tokens that refer elsewhere
// (TypeRef, MemberRef, TypeSpec, MethodSpec) resolve through their
// signatures, in the context of the definition whose IL names them, so the
// symbols they yield are open over that definition's type parameters, as
// the symbols Roslyn's own semantic model yields are.
internal sealed class IlModule : ISignatureTypeProvider<IlType, IlGenericContext>
{
    private readonly PEReader pe;
    private readonly CSharpCompilation compilation;
    private readonly Dictionary<int, ISymbol> definitions = [];
    private readonly Dictionary<(EntityHandle Handle, IlGenericContext Context), ISymbol> resolved = [];
    private readonly Dictionary<string, IAssemblySymbol> assembliesByName = new(StringComparer.Ordinal);
    private readonly MetadataReaderProvider? pdbProvider;

    public IlModule(byte[] image, byte[]? pdb, CSharpCompilation compilation, IAssemblySymbol assembly)
    {
        pe = new PEReader(ImmutableArray.Create(image));
        Reader = pe.GetMetadataReader();
        this.compilation = compilation;
        Assembly = assembly;
        if (pdb is not null)
        {
            pdbProvider = MetadataReaderProvider.FromPortablePdbImage(ImmutableArray.Create(pdb));
            Pdb = pdbProvider.GetMetadataReader();
        }

        foreach (var reference in compilation.References)
        {
            if (compilation.GetAssemblyOrModuleSymbol(reference) is IAssemblySymbol referenced)
            {
                assembliesByName[referenced.Identity.Name] = referenced;
            }
        }
    }

    public MetadataReader Reader { get; }

    public MetadataReader? Pdb { get; }

    public IAssemblySymbol Assembly { get; }

    // The symbol of a definition token, found on first use: a type by its
    // name (a nested one among its containing type's), a method or field
    // among its type's members.
    private ISymbol? Definition(EntityHandle handle)
    {
        int token = MetadataTokens.GetToken(handle);
        if (definitions.TryGetValue(token, out var known))
        {
            return known;
        }

        switch (handle.Kind)
        {
            case HandleKind.TypeDefinition:
                var type = TypeOf((TypeDefinitionHandle)handle);
                if (type is not null)
                {
                    definitions[token] = type;
                }

                return type;
            case HandleKind.MethodDefinition:
                IndexMembers(Reader.GetMethodDefinition((MethodDefinitionHandle)handle).GetDeclaringType());
                break;
            case HandleKind.FieldDefinition:
                IndexMembers(Reader.GetFieldDefinition((FieldDefinitionHandle)handle).GetDeclaringType());
                break;
            default:
                return null;
        }

        return definitions.GetValueOrDefault(token);
    }

    private readonly HashSet<TypeDefinitionHandle> indexedTypes = [];

    private void IndexMembers(TypeDefinitionHandle handle)
    {
        if (!indexedTypes.Add(handle) || Definition(handle) is not INamedTypeSymbol type)
        {
            return;
        }

        foreach (var member in type.GetMembers())
        {
            if (member is IMethodSymbol or IFieldSymbol && member.MetadataToken != 0)
            {
                definitions[member.MetadataToken] = member;
            }
        }
    }

    private INamedTypeSymbol? TypeOf(TypeDefinitionHandle handle)
    {
        var row = Reader.GetTypeDefinition(handle);
        int token = MetadataTokens.GetToken(handle);
        IEnumerable<INamedTypeSymbol> candidates;
        if (row.IsNested)
        {
            candidates = Definition(row.GetDeclaringType()) is INamedTypeSymbol outer ? outer.GetTypeMembers() : [];
        }
        else
        {
            string space = Reader.GetString(row.Namespace);
            string name = Reader.GetString(row.Name);
            var named = Assembly.GetTypeByMetadataName(space.Length == 0 ? name : space + "." + name);
            if (named is not null && named.MetadataToken == token)
            {
                return named;
            }

            INamespaceSymbol? container = Assembly.GlobalNamespace;
            foreach (string part in space.Length == 0 ? [] : space.Split('.'))
            {
                container = container?.GetNamespaceMembers().FirstOrDefault(member => member.Name == part);
            }

            candidates = container?.GetTypeMembers() ?? [];
        }

        return candidates.FirstOrDefault(candidate => candidate.MetadataToken == token);
    }

    // Every type the assembly defines, nested ones included.
    public IEnumerable<INamedTypeSymbol> Types() =>
        Reader.TypeDefinitions.Select(handle => Definition(handle)).OfType<INamedTypeSymbol>();

    public bool Defines(ISymbol symbol) =>
        SymbolEqualityComparer.Default.Equals(symbol.OriginalDefinition.ContainingAssembly, Assembly);

    // Each instruction of the assembly's bodies whose operand is a member
    // token (a call's, a field access's, ldftn's, ldtoken's): its method,
    // offset and token, in metadata order.
    public IEnumerable<(IMethodSymbol Method, int Offset, int Token)> MemberTokenUses()
    {
        foreach (var handle in Reader.MethodDefinitions)
        {
            int rva = Reader.GetMethodDefinition(handle).RelativeVirtualAddress;
            if (rva == 0 || Definition(handle) is not IMethodSymbol method)
            {
                continue;
            }

            var code = new IlCode(pe.GetMethodBody(rva), this);
            foreach (var instruction in code.Instructions)
            {
                if (instruction.OpCode is ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj or ILOpCode.Ldftn
                        or ILOpCode.Ldvirtftn or ILOpCode.Ldfld or ILOpCode.Ldflda or ILOpCode.Stfld or ILOpCode.Ldsfld
                        or ILOpCode.Ldsflda or ILOpCode.Stsfld or ILOpCode.Ldtoken or ILOpCode.Jmp
                    && MetadataTokens.EntityHandle(instruction.Token).Kind is HandleKind.MemberReference or HandleKind.MethodSpecification)
                {
                    yield return (method, instruction.Offset, instruction.Token);
                }
            }
        }
    }

    // Whether the assembly names a type of another's.
    public bool ReferencesType(string space, string name) =>
        Reader.TypeReferences.Select(Reader.GetTypeReference)
            .Any(reference => Reader.StringComparer.Equals(reference.Name, name) && Reader.StringComparer.Equals(reference.Namespace, space));

    // Whether any body has an exception filter.
    public bool HasFilters()
    {
        foreach (var handle in Reader.MethodDefinitions)
        {
            int rva = Reader.GetMethodDefinition(handle).RelativeVirtualAddress;
            if (rva != 0 && pe.GetMethodBody(rva).ExceptionRegions.Any(region => region.Kind == ExceptionRegionKind.Filter))
            {
                return true;
            }
        }

        return false;
    }

    // A method definition's body, or null for one without IL.
    public MethodBodyBlock? Body(IMethodSymbol method)
    {
        var definition = method.OriginalDefinition;
        if (!Defines(definition) || definition.MetadataToken == 0)
        {
            return null;
        }

        var handle = (MethodDefinitionHandle)MetadataTokens.EntityHandle(definition.MetadataToken);
        var row = Reader.GetMethodDefinition(handle);
        return row.RelativeVirtualAddress == 0 ? null : pe.GetMethodBody(row.RelativeVirtualAddress);
    }

    // Whether a method definition of this assembly has IL.
    public bool HasBody(IMethodSymbol method)
    {
        var definition = method.OriginalDefinition;
        if (definition.IsGenericMethod)
        {
            definition = definition.ConstructedFrom;
        }

        return Defines(definition) && definition.MetadataToken != 0
               && Reader.GetMethodDefinition((MethodDefinitionHandle)MetadataTokens.EntityHandle(definition.MetadataToken))
                   .RelativeVirtualAddress != 0;
    }

    // A field's initial data, for RuntimeHelpers.InitializeArray.
    public byte[] FieldData(IFieldSymbol field, int length)
    {
        var handle = (FieldDefinitionHandle)MetadataTokens.EntityHandle(field.OriginalDefinition.MetadataToken);
        int rva = Reader.GetFieldDefinition(handle).GetRelativeVirtualAddress();
        var block = pe.GetSectionData(rva);
        return block.GetContent(0, length).ToArray();
    }

    private Dictionary<string, string>? resourceStrings;

    // The strings of the assembly's embedded .resources (a framework
    // assembly's SR messages), by key.
    public IReadOnlyDictionary<string, string> ResourceStrings
    {
        get
        {
            if (resourceStrings is not null)
            {
                return resourceStrings;
            }

            resourceStrings = new(StringComparer.Ordinal);
            var directory = pe.PEHeaders.CorHeader?.ResourcesDirectory;
            foreach (var handle in Reader.ManifestResources)
            {
                var resource = Reader.GetManifestResource(handle);
                if (!resource.Implementation.IsNil || directory is not { Size: > 0 } resources
                    || !Reader.GetString(resource.Name).EndsWith(".resources", StringComparison.Ordinal))
                {
                    continue;
                }

                var block = pe.GetSectionData(resources.RelativeVirtualAddress + (int)resource.Offset);
                var blob = block.GetReader();
                int length = blob.ReadInt32();
                using var stream = new MemoryStream(blob.ReadBytes(length));
                using var reader = new System.Resources.ResourceReader(stream);
                var entries = reader.GetEnumerator();
                while (entries.MoveNext())
                {
                    if (entries.Key is string key && entries.Value is string value)
                    {
                        resourceStrings[key] = value;
                    }
                }
            }

            return resourceStrings;
        }
    }

    public string UserString(int token) => Reader.GetUserString(MetadataTokens.UserStringHandle(token & 0xFFFFFF));

    // The source position of an IL offset in a method, from the PDB's
    // sequence points: the last point at or before it.
    public string? Location(IMethodSymbol method, int offset)
    {
        if (Pdb is null || !Defines(method) || method.OriginalDefinition.MetadataToken == 0)
        {
            return null;
        }

        var handle = (MethodDefinitionHandle)MetadataTokens.EntityHandle(method.OriginalDefinition.MetadataToken);
        var debug = Pdb.GetMethodDebugInformation(handle.ToDebugInformationHandle());
        SequencePoint? best = null;
        foreach (var point in debug.GetSequencePoints())
        {
            if (point.IsHidden)
            {
                continue;
            }

            if (point.Offset <= offset && (best is null || point.Offset >= best.Value.Offset))
            {
                best = point;
            }
        }

        if (best is not { } found)
        {
            return null;
        }

        string document = Pdb.GetString(Pdb.GetDocument(found.Document).Name);
        return $"{document}({found.StartLine},{found.StartColumn})";
    }

    // MARK: Tokens

    public ISymbol Resolve(int token, IlGenericContext context) => Resolve(MetadataTokens.EntityHandle(token), context);

    public ISymbol Resolve(EntityHandle handle, IlGenericContext context)
    {
        if (handle.Kind is HandleKind.TypeDefinition or HandleKind.MethodDefinition or HandleKind.FieldDefinition
            && Definition(handle) is { } definition)
        {
            return definition;
        }

        if (resolved.TryGetValue((handle, context), out var cached))
        {
            return cached;
        }

        if (handle.Kind == HandleKind.FieldDefinition)
        {
            // A field Roslyn's symbols leave out of their members.
            var row = Reader.GetFieldDefinition((FieldDefinitionHandle)handle);
            string name = Reader.GetString(row.Name);
            var owner = Definition(row.GetDeclaringType());
            // A field-like event's backing field: the event stands for it.
            return (owner as INamedTypeSymbol)?.GetMembers(name).OfType<IEventSymbol>().FirstOrDefault()
                   ?? throw new CompileError($"GP1001: Field '{owner?.ToDisplayString()}.{name}' has no symbol.");
        }

        ISymbol result = handle.Kind switch
        {
            HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification => ResolveType(handle, context),
            HandleKind.MemberReference => ResolveMember((MemberReferenceHandle)handle, context),
            HandleKind.MethodSpecification => ResolveMethodSpecification((MethodSpecificationHandle)handle, context),
            _ => throw new CompileError($"GP1001: IL token kind {handle.Kind} is unsupported."),
        };
        resolved[(handle, context)] = result;
        return result;
    }

    public ITypeSymbol ResolveType(EntityHandle handle, IlGenericContext context)
    {
        if (!resolvedTypes.TryGetValue((handle, context), out var resolvedType))
        {
            resolvedType = DecodeType(handle, context);
            resolvedTypes.Add((handle, context), resolvedType);
        }

        return resolvedType;
    }

    private readonly Dictionary<(EntityHandle Handle, IlGenericContext Context), ITypeSymbol> resolvedTypes = [];

    private ITypeSymbol DecodeType(EntityHandle handle, IlGenericContext context)
    {
        var type = handle.Kind switch
        {
            HandleKind.TypeDefinition => GetTypeFromDefinition(Reader, (TypeDefinitionHandle)handle, 0),
            HandleKind.TypeReference => GetTypeFromReference(Reader, (TypeReferenceHandle)handle, 0),
            HandleKind.TypeSpecification => GetTypeFromSpecification(Reader, context, (TypeSpecificationHandle)handle, 0),
            _ => throw new CompileError($"GP1001: IL type token kind {handle.Kind} is unsupported."),
        };
        if (type.ByRef || type.Pinned)
        {
            throw new CompileError("GP1001: A by-reference type token is unsupported.");
        }

        return type.Type;
    }

    // A body's locals. A local of a type no imported assembly defines (a
    // framework method's Vector<T>, on a path folding removes) is of an
    // error type: an error only where code uses it (IlAnalysis).
    public ImmutableArray<IlType> Locals(StandaloneSignatureHandle handle, IlGenericContext context)
    {
        if (handle.IsNil)
        {
            return [];
        }

        lenient = true;
        try
        {
            return Reader.GetStandaloneSignature(handle).DecodeLocalSignature(this, context);
        }
        finally
        {
            lenient = false;
        }
    }

    private bool lenient;

    // The array type and method name of a reference to one of the methods
    // the runtime gives a multidimensional array type (.ctor, Get, Set,
    // Address), or null.
    public (IArrayTypeSymbol Array, string Name)? ArrayMethod(int token, IlGenericContext context)
    {
        var handle = MetadataTokens.EntityHandle(token);
        if (handle.Kind != HandleKind.MemberReference)
        {
            return null;
        }

        var reference = Reader.GetMemberReference((MemberReferenceHandle)handle);
        if (reference.Parent.Kind != HandleKind.TypeSpecification
            || GetTypeFromSpecification(Reader, context, (TypeSpecificationHandle)reference.Parent, 0).Type is not IArrayTypeSymbol array)
        {
            return null;
        }

        return (array, Reader.GetString(reference.Name));
    }

    private ISymbol ResolveMember(MemberReferenceHandle handle, IlGenericContext context)
    {
        var reference = Reader.GetMemberReference(handle);
        string name = Reader.GetString(reference.Name);
        if (reference.Parent.Kind is not (HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification))
        {
            throw new CompileError($"GP1001: Member reference '{name}' has an unsupported parent.");
        }

        var parent = (INamedTypeSymbol)ResolveType(reference.Parent, context);
        var definition = parent.OriginalDefinition;
        // The signature is written against the parent's definition: `!n` is
        // its type parameter, `!!n` the member's own.
        var parentContext = IlGenericContext.Of(definition);
        if (reference.GetKind() == MemberReferenceKind.Field)
        {
            var fieldType = reference.DecodeFieldSignature(this, parentContext);
            var field = definition.GetMembers(name).OfType<IFieldSymbol>()
                .FirstOrDefault(candidate => SameType(candidate.Type, fieldType.Type))
                ?? throw new CompileError($"GP1001: Field '{definition.ToDisplayString()}.{name}' "
                                          + "is not in the gameplay CoreLib.");
            return InConstructed(parent, field);
        }

        // The signature's generic arity picks the candidates it can be
        // decoded against.
        var signatureReader = Reader.GetBlobReader(reference.Signature);
        var header = signatureReader.ReadSignatureHeader();
        int arity = header.IsGeneric ? signatureReader.ReadCompressedInteger() : 0;
        var candidates = definition.GetMembers(name).OfType<IMethodSymbol>()
            .Where(candidate => candidate.Arity == arity)
            .ToList();
        foreach (var candidate in candidates)
        {
            var signature = reference.DecodeMethodSignature(this, new IlGenericContext(parentContext.TypeParameters, candidate.TypeParameters));
            if (Matches(candidate, signature))
            {
                return InConstructed(parent, candidate);
            }
        }

        // The parameters shown, but for a generic method's, whose own type
        // parameters there is no candidate to take from.
        string parameters = arity == 0
            ? string.Join(", ", reference.DecodeMethodSignature(this, new IlGenericContext(parentContext.TypeParameters, [])).ParameterTypes)
            : "...";
        throw new CompileError($"GP1001: '{definition.ToDisplayString()}.{name}({parameters})' "
                               + "is not in the gameplay CoreLib.");
    }

    // A method reference's namespace, type (metadata) name and name, read
    // from metadata alone, for a reference that may not resolve.
    public (string Namespace, string Type, string Name)? MemberName(int token)
    {
        var handle = MetadataTokens.EntityHandle(token);
        if (handle.Kind == HandleKind.MethodSpecification)
        {
            handle = Reader.GetMethodSpecification((MethodSpecificationHandle)handle).Method;
        }

        if (handle.Kind != HandleKind.MemberReference)
        {
            return null;
        }

        var reference = Reader.GetMemberReference((MemberReferenceHandle)handle);
        var parent = reference.Parent;
        if (parent.Kind == HandleKind.TypeSpecification)
        {
            // A generic instantiation: its definition's name.
            var blob = Reader.GetBlobReader(Reader.GetTypeSpecification((TypeSpecificationHandle)parent).Signature);
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

        var type = Reader.GetTypeReference((TypeReferenceHandle)parent);
        if (type.ResolutionScope.Kind == HandleKind.TypeReference)
        {
            return null;
        }

        return (Reader.GetString(type.Namespace), Reader.GetString(type.Name), Reader.GetString(reference.Name));
    }

    private ISymbol ResolveMethodSpecification(MethodSpecificationHandle handle, IlGenericContext context)
    {
        var specification = Reader.GetMethodSpecification(handle);
        var method = (IMethodSymbol)Resolve(specification.Method, context);
        var arguments = specification.DecodeSignature(this, context);
        return method.Construct([.. arguments.Select(argument => argument.Type)]);
    }

    private static ISymbol InConstructed(INamedTypeSymbol parent, ISymbol definitionMember)
    {
        if (SymbolEqualityComparer.Default.Equals(parent, parent.OriginalDefinition))
        {
            return definitionMember;
        }

        return parent.GetMembers(definitionMember.Name).FirstOrDefault(member =>
                   SymbolEqualityComparer.Default.Equals(member.OriginalDefinition, definitionMember))
               ?? throw new CompileError($"'{definitionMember.ToDisplayString()}' of '{parent.ToDisplayString()}' is not in the gameplay CoreLib.");
    }

    private static bool Matches(IMethodSymbol candidate, MethodSignature<IlType> signature)
    {
        if (candidate.Parameters.Length != signature.ParameterTypes.Length
            || candidate.TypeParameters.Length != signature.GenericParameterCount
            || candidate.IsStatic == signature.Header.IsInstance)
        {
            return false;
        }

        if (!SameType(candidate.ReturnType, signature.ReturnType.Type)
            || (candidate.ReturnsByRef || candidate.ReturnsByRefReadonly) != signature.ReturnType.ByRef)
        {
            return false;
        }

        for (int index = 0; index < candidate.Parameters.Length; index++)
        {
            var parameter = candidate.Parameters[index];
            var type = signature.ParameterTypes[index];
            if (!SameType(parameter.Type, type.Type) || (parameter.RefKind != RefKind.None) != type.ByRef)
            {
                return false;
            }
        }

        return true;
    }

    // The same type, element names of tuples aside, and a nested type of a
    // generic one constructed of its own type parameters its definition.
    private static bool SameType(ITypeSymbol left, ITypeSymbol right)
    {
        if (SymbolEqualityComparer.Default.Equals(left, right))
        {
            return true;
        }

        static ITypeSymbol Untupled(ITypeSymbol type) =>
            type is INamedTypeSymbol { IsTupleType: true, TupleUnderlyingType: { } underlying } ? underlying : type;

        switch (Untupled(left), Untupled(right))
        {
            case (IArrayTypeSymbol leftArray, IArrayTypeSymbol rightArray):
                return leftArray.Rank == rightArray.Rank && SameType(leftArray.ElementType, rightArray.ElementType);
            case (INamedTypeSymbol leftNamed, INamedTypeSymbol rightNamed):
                return SymbolEqualityComparer.Default.Equals(leftNamed.OriginalDefinition, rightNamed.OriginalDefinition)
                       && (leftNamed.ContainingType is null || rightNamed.ContainingType is null
                           || SameType(leftNamed.ContainingType, rightNamed.ContainingType))
                       && leftNamed.TypeArguments.Zip(rightNamed.TypeArguments).All(pair => SameType(pair.First, pair.Second));
            case (IPointerTypeSymbol leftPointer, IPointerTypeSymbol rightPointer):
                return SameType(leftPointer.PointedAtType, rightPointer.PointedAtType);
            default:
                return false;
        }
    }

    // MARK: Signatures

    private ITypeSymbol Special(SpecialType type) => compilation.GetSpecialType(type);

    public IlType GetPrimitiveType(PrimitiveTypeCode typeCode) => new(typeCode switch
    {
        PrimitiveTypeCode.Boolean => Special(SpecialType.System_Boolean),
        PrimitiveTypeCode.Byte => Special(SpecialType.System_Byte),
        PrimitiveTypeCode.Char => Special(SpecialType.System_Char),
        PrimitiveTypeCode.Double => Special(SpecialType.System_Double),
        PrimitiveTypeCode.Int16 => Special(SpecialType.System_Int16),
        PrimitiveTypeCode.Int32 => Special(SpecialType.System_Int32),
        PrimitiveTypeCode.Int64 => Special(SpecialType.System_Int64),
        PrimitiveTypeCode.IntPtr => Special(SpecialType.System_IntPtr),
        PrimitiveTypeCode.Object => Special(SpecialType.System_Object),
        PrimitiveTypeCode.SByte => Special(SpecialType.System_SByte),
        PrimitiveTypeCode.Single => Special(SpecialType.System_Single),
        PrimitiveTypeCode.String => Special(SpecialType.System_String),
        PrimitiveTypeCode.TypedReference => throw new CompileError("GP1001: TypedReference is unsupported."),
        PrimitiveTypeCode.UInt16 => Special(SpecialType.System_UInt16),
        PrimitiveTypeCode.UInt32 => Special(SpecialType.System_UInt32),
        PrimitiveTypeCode.UInt64 => Special(SpecialType.System_UInt64),
        PrimitiveTypeCode.UIntPtr => Special(SpecialType.System_UIntPtr),
        PrimitiveTypeCode.Void => Special(SpecialType.System_Void),
        _ => throw new CompileError($"GP1001: IL primitive type {typeCode} is unsupported."),
    });

    public IlType GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) =>
        new(Definition(handle) is ITypeSymbol type
            ? type
            : throw new InternalCompilerError($"type definition {MetadataTokens.GetToken(handle):X8} has no symbol."));

    public IlType GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
    {
        var reference = reader.GetTypeReference(handle);
        string name = reader.GetString(reference.Name);
        string space = reader.GetString(reference.Namespace);
        var scope = reference.ResolutionScope;
        if (scope.Kind == HandleKind.TypeReference)
        {
            var outer = (INamedTypeSymbol)GetTypeFromReference(reader, (TypeReferenceHandle)scope, rawTypeKind).Type;
            return new(Nested(outer, name));
        }

        if (scope.Kind != HandleKind.AssemblyReference)
        {
            throw new CompileError($"GP1001: Type reference '{space}.{name}' has an unsupported scope.");
        }

        string assemblyName = reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)scope).Name);
        string metadataName = space.Length == 0 ? name : space + "." + name;
        var type = (assembliesByName.TryGetValue(assemblyName, out var assembly)
                       ? assembly.GetTypeByMetadataName(metadataName) ?? assembly.ResolveForwardedType(metadataName)
                       : null)
                   ?? compilation.GetTypeByMetadataName(metadataName);
        if (type is null && lenient)
        {
            int tick = name.IndexOf('`');
            return new(compilation.CreateErrorTypeSymbol(
                null, tick < 0 ? name : name[..tick], tick < 0 ? 0 : int.Parse(name[(tick + 1)..], System.Globalization.CultureInfo.InvariantCulture)));
        }

        return new(type ?? throw new CompileError($"GP1001: Type '{metadataName}' of '{assemblyName}' was not found."));
    }

    private static INamedTypeSymbol Nested(INamedTypeSymbol outer, string metadataName)
    {
        int tick = metadataName.IndexOf('`');
        string name = tick < 0 ? metadataName : metadataName[..tick];
        int arity = tick < 0 ? 0 : int.Parse(metadataName[(tick + 1)..], System.Globalization.CultureInfo.InvariantCulture);
        return outer.GetTypeMembers(name, arity).FirstOrDefault()
               ?? throw new CompileError($"GP1001: Nested type '{outer.ToDisplayString()}.{metadataName}' was not found.");
    }

    public IlType GetTypeFromSpecification(MetadataReader reader, IlGenericContext genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
        reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

    public IlType GetSZArrayType(IlType elementType) => new(compilation.CreateArrayTypeSymbol(elementType.Type));

    public IlType GetArrayType(IlType elementType, ArrayShape shape) =>
        new(compilation.CreateArrayTypeSymbol(elementType.Type, shape.Rank));

    public IlType GetByReferenceType(IlType elementType) => elementType with { ByRef = true };

    public IlType GetPointerType(IlType elementType) => new(compilation.CreatePointerTypeSymbol(elementType.Type));

    public IlType GetPinnedType(IlType elementType) => elementType with { Pinned = true };

    public IlType GetModifiedType(IlType modifier, IlType unmodifiedType, bool isRequired) => unmodifiedType;

    public IlType GetFunctionPointerType(MethodSignature<IlType> signature) =>
        throw new CompileError("GP1001: Function pointers are unsupported.");

    public IlType GetGenericMethodParameter(IlGenericContext genericContext, int index) =>
        index < genericContext.MethodTypeParameters.Length
            ? new(genericContext.MethodTypeParameters[index])
            : throw new InternalCompilerError($"method type parameter !!{index} is out of context.");

    public IlType GetGenericTypeParameter(IlGenericContext genericContext, int index) =>
        index < genericContext.TypeParameters.Length
            ? new(genericContext.TypeParameters[index])
            : throw new InternalCompilerError($"type parameter !{index} is out of context.");

    // An instantiation, with metadata's flattened arguments (a nested
    // generic type takes its containing types' arguments first) split back
    // over Roslyn's nesting.
    public IlType GetGenericInstantiation(IlType genericType, ImmutableArray<IlType> typeArguments)
    {
        if (genericType.Type is IErrorTypeSymbol)
        {
            return genericType;
        }

        var definition = (INamedTypeSymbol)genericType.Type;
        var chain = new List<INamedTypeSymbol>();
        for (INamedTypeSymbol? current = definition; current is not null; current = current.ContainingType)
        {
            chain.Insert(0, current);
        }

        int next = 0;
        INamedTypeSymbol? built = null;
        foreach (var part in chain)
        {
            var current = built is null ? part : built.GetTypeMembers(part.Name, part.Arity).First();
            if (part.Arity != 0)
            {
                current = current.Construct([.. typeArguments.Skip(next).Take(part.Arity).Select(argument => argument.Type)]);
                next += part.Arity;
            }

            built = current;
        }

        if (next != typeArguments.Length)
        {
            throw new InternalCompilerError($"instantiation of '{definition.ToDisplayString()}' has {typeArguments.Length} arguments.");
        }

        return new(built!);
    }
}
