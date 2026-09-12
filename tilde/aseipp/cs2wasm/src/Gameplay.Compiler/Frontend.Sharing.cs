// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Shared generics (docs/IMPORTER.md, "Shared generics"). An
// instantiation over reference type arguments has its canonical form's
// representation: every reference type argument is `object` (whose values
// are eqrefs), a value type argument keeps its own type with its type
// arguments canonical in turn. So `List<string>` and `List<Enemy>` are one
// heap type and one vtable type, `Func<string, bool>` and
// `Func<object, bool>` one delegate layout, `KeyValuePair<string, int>` and
// `KeyValuePair<Enemy, int>` one flattened struct, and an array of any
// reference type an array of eqref (the covariant family of
// Frontend.Arrays). What tells exact instantiations apart is kept beside
// the representation: each exact class instantiation has its own vtable
// global and class id (a DFS number every vtable holds, so a type test is
// a range check), each exact interface its own itable id (an itable's type
// is its canonical interface's), each array type its own final subtype,
// each boxed value type its own box, each delegate type its own id.
//
// Functions take and return their canonical forms' types too: a member of
// `List<string>` has the signature of `List<object>`'s, an override has its
// slot's, so vtable, itable and delegate functions line up however their
// code is instantiated; callers cast what comes back to its exact type
// (a value of a type parameter's type is an eqref there), and a body casts
// the arguments it declares more exactly on entry.
internal sealed partial class Frontend
{
    // Whether instantiations over reference types share representations
    // (and, where their code allows, code), unless GAMEPLAYC_SHARING=0
    // turns it off.
    private readonly bool sharing;

    public bool Sharing => sharing;

    private static bool SharingEnabled() => Environment.GetEnvironmentVariable("GAMEPLAYC_SHARING") != "0";

    private readonly Dictionary<ITypeSymbol, ITypeSymbol> canonicalTypes = new(SymbolEqualityComparer.Default);

    // A closed type argument's canonical form: object for a reference type;
    // a value type's own, its type arguments canonical.
    private ITypeSymbol CanonicalArgument(ITypeSymbol argument)
    {
        argument = Unnamed(argument);
        if (argument.IsReferenceType)
        {
            return ObjectSymbol;
        }

        return argument is INamedTypeSymbol named ? Canonical(named) : argument;
    }

    // Whether a type's instantiations over reference types share their
    // representation: a generic class, struct, interface or delegate but
    // for exceptions (which catch clauses test by heap type) and the
    // framework types the module layer stands in for exactly.
    private bool IsShareable(INamedTypeSymbol type)
    {
        if (!type.IsGenericType && type.ContainingType is not { IsGenericType: true })
        {
            return false;
        }

        if (type.TypeKind == TypeKind.Delegate)
        {
            return IsSupportedDelegate(type);
        }

        return type.TypeKind is TypeKind.Class or TypeKind.Struct or TypeKind.Interface
               && (IsModuleDefined(type) || IsAdoptedInterface(type))
               && !IsException(type);
    }

    // A closed named type's canonical form: itself when it is not shareable
    // or has no reference type arguments.
    public INamedTypeSymbol Canonical(INamedTypeSymbol type)
    {
        if (!sharing)
        {
            return type;
        }

        if (canonicalTypes.TryGetValue(type, out var known))
        {
            return (INamedTypeSymbol)known;
        }

        var canonical = type;
        if (IsShareable(type) && !ContainsTypeParameters(type))
        {
            var pairs = ImmutableArray.CreateBuilder<(ITypeParameterSymbol, ITypeSymbol)>();
            bool changed = false;
            for (var current = type; current is not null; current = current.ContainingType)
            {
                var parameters = current.OriginalDefinition.TypeParameters;
                for (int index = 0; index < parameters.Length; index++)
                {
                    var argument = CanonicalArgument(current.TypeArguments[index]);
                    changed |= !SymbolEqualityComparer.Default.Equals(argument, current.TypeArguments[index]);
                    pairs.Add((parameters[index], argument));
                }
            }

            if (changed)
            {
                canonical = (INamedTypeSymbol)Substitute(Intern(new Substitution(pairs.ToImmutable())), type.OriginalDefinition);
            }
        }

        canonicalTypes[type] = canonical;
        if (!SymbolEqualityComparer.Default.Equals(canonical, type))
        {
            canonicalForms.Add(canonical);
        }

        return canonical;
    }

    // The canonical forms of the module's shared instantiations: code of
    // theirs that cannot be lowered (a `new T()` of object's, say) is an
    // error only where the module keeps it, as the framework's is.
    private readonly HashSet<INamedTypeSymbol> canonicalForms = new(SymbolEqualityComparer.Default);

    public bool IsCanonicalForm(INamedTypeSymbol? type) => type is not null && canonicalForms.Contains(type);

    // Whether a type's representation is its canonical form's, which is
    // another type.
    public bool IsSharedInstance(ITypeSymbol? type) =>
        sharing && type is INamedTypeSymbol named && !SymbolEqualityComparer.Default.Equals(Canonical(named), named);

    // A member of a closed type as the member of its canonical form, a
    // generic method's own type arguments canonical too.
    public T CanonicalMember<T>(T member)
        where T : class, ISymbol
    {
        if (!sharing || member.ContainingType is not { } containing)
        {
            return member;
        }

        var canonical = Canonical(containing);
        var method = member as IMethodSymbol;
        bool genericMethod = method is { IsGenericMethod: true };
        if (SymbolEqualityComparer.Default.Equals(canonical, containing) && !genericMethod)
        {
            return member;
        }

        T found = member;
        if (!SymbolEqualityComparer.Default.Equals(canonical, containing))
        {
            var definition = method is not null ? method.ConstructedFrom.OriginalDefinition : member.OriginalDefinition;
            found = canonical.GetMembers(member.Name).OfType<T>()
                .First(candidate => SymbolEqualityComparer.Default.Equals(
                    candidate is IMethodSymbol candidateMethod ? candidateMethod.ConstructedFrom.OriginalDefinition : candidate.OriginalDefinition,
                    definition));
        }

        if (genericMethod)
        {
            var arguments = method!.TypeArguments.Select(CanonicalArgument).ToArray();
            var constructed = ((IMethodSymbol)(ISymbol)found).ConstructedFrom;
            return (T)(ISymbol)constructed.Construct(arguments);
        }

        return found;
    }

    // The method whose canonical signature a method's function has: its
    // own canonical form's, or for a virtual method its slot's.
    public IMethodSymbol SignatureOf(IMethodSymbol method)
    {
        if (!sharing)
        {
            return method;
        }

        var shaped = IsDispatched(method) && !method.IsStatic && method.ContainingType.TypeKind != TypeKind.Interface
                     && !method.IsGenericMethod
            ? SlotRoot(method)
            : method;
        return CanonicalMember(shaped);
    }

    private readonly HashSet<INamedTypeSymbol> sharedStructs = new(SymbolEqualityComparer.Default);

    // Whether a class is laid out as its canonical form's representation:
    // an instantiation of a shareable class over a reference type, its
    // canonical form (List<object>) included.
    public bool UsesRepresentation(ITypeSymbol? type) =>
        sharing && type is INamedTypeSymbol { TypeKind: TypeKind.Class } named && IsShareable(named)
        && !ContainsTypeParameters(named) && HasReferenceArgument(named);

    // The representations of shared classes, by canonical form: the heap
    // type (the canonical form's fields), the vtable type (its slots) and
    // the slots' function types, which the exact instantiations' layouts
    // share. A representation is no class of its own: it has no vtable
    // global and no functions.
    private readonly Dictionary<INamedTypeSymbol, ClassLayout> representationLayouts = new(SymbolEqualityComparer.Default);

    public ClassLayout RepresentationOf(INamedTypeSymbol type)
    {
        var canonical = Canonical(type);
        if (representationLayouts.TryGetValue(canonical, out var known))
        {
            return known;
        }

        if (frozen)
        {
            throw new InternalCompilerError($"'{canonical.ToDisplayString()}' has no representation.");
        }

        ClassLayout? parent = null;
        if (SourceBase(canonical) is { } baseType)
        {
            if (UsesRepresentation(baseType))
            {
                parent = RepresentationOf(baseType);
            }
            else
            {
                if (IsGenericInstance(baseType))
                {
                    EnsureClassInstance(baseType);
                }
                else
                {
                    RegisterClass(baseType);
                }

                // Its fields and slots first.
                RegisterMembers(baseType);
                parent = layouts[baseType];
            }
        }
        else
        {
            EnsureObjectRoot();
        }

        // Not the canonical form's own heap id, which its exact layout
        // does not have either.
        int heap = AddType(null);
        var layout = new ClassLayout(canonical, parent, heap, AddType(null)) { IsRepresentation = true };
        representationLayouts.Add(canonical, layout);

        // Its fields, after its base's, and its slots.
        nextFieldIndex[canonical] = parent is null ? 1 : nextFieldIndex[parent.Symbol];
        if (parent is not null)
        {
            layout.Slots.AddRange(parent.Slots.Select(_ => (IMethodSymbol?)null));
            layout.SlotTypes.AddRange(parent.SlotTypes);
        }

        foreach (var member in canonical.GetMembers())
        {
            switch (member)
            {
                case IFieldSymbol { IsStatic: false, IsConst: false } field when !(InFramework(field) && !CanRepresent(field.Type)):
                    MapType(field.Type);
                    fieldIds.Add(field, nextFieldIndex[canonical]++);
                    break;
                case IEventSymbol { IsStatic: false } eventSymbol when HasBackingField(eventSymbol):
                    MapType(eventSymbol.Type);
                    fieldIds.Add(eventSymbol, nextFieldIndex[canonical]++);
                    break;
                case IMethodSymbol method when IsDispatched(method) && !method.IsStatic && !method.IsGenericMethod
                                               && !(InFramework(method) && NamesMissingType(method)):
                    var root = CanonicalMember(SlotRoot(method));
                    if (!IsSourceClass(root.ContainingType))
                    {
                        break;
                    }

                    if (!slotIds.TryGetValue(root, out int slot))
                    {
                        slot = layout.Slots.Count;
                        slotIds.Add(root, slot);
                        layout.Slots.Add(null);
                        layout.SlotTypes.Add(SignatureType([WType.Ref(RepresentationOf(root.ContainingType).Heap), .. PlanParameters(root)], PlanResult(root)));
                    }

                    break;
            }
        }

        return layout;
    }

    // Whether a framework class's field has a type this representation
    // has (see RegisterImportedMembers).
    private bool CanRepresent(ITypeSymbol type)
    {
        try
        {
            MapType(type);
            return true;
        }
        catch (CompileError)
        {
            return false;
        }
    }

    // An exact instantiation of a shared class: a layout of its own, for
    // its vtable (its methods and itables) and class id, over its canonical
    // form's heap and vtable types, and its base's exact layout.
    private void RegisterSharedClass(INamedTypeSymbol type)
    {
        var representation = RepresentationOf(type);
        ClassLayout? parent = null;
        if (SourceBase(type) is { } baseType)
        {
            if (IsGenericInstance(baseType))
            {
                EnsureClassInstance(baseType);
            }
            else
            {
                RegisterClass(baseType);
            }

            parent = layouts[baseType];
        }

        layouts.Add(type, new ClassLayout(type, parent, representation.Heap, representation.VTable) { Representation = representation });
    }

    // The type a field's storage has: a shared instantiation's field is its
    // canonical form's, of the canonical type.
    public ITypeSymbol FieldStorageType(ISymbol field) =>
        StorageType(IsSharedInstance(field.ContainingType) || UsesRepresentation(field.ContainingType) ? CanonicalMember(field) : field);

    // Numbers the classes depth first, each class's subclasses after it,
    // so that deriving from a class is an id in its range. Boxes follow.
    private void AssignClassIds()
    {
        if (!sharing)
        {
            return;
        }

        var children = new Dictionary<ClassLayout, List<ClassLayout>>();
        var roots = new List<ClassLayout>();
        foreach (var layout in layouts.Values)
        {
            if (layout.Base is { } parent)
            {
                if (!children.TryGetValue(parent, out var list))
                {
                    children.Add(parent, list = []);
                }

                list.Add(layout);
            }
            else
            {
                roots.Add(layout);
            }
        }

        int next = 0;
        void Number(ClassLayout layout)
        {
            layout.ClassId = next++;
            foreach (var child in children.GetValueOrDefault(layout) ?? [])
            {
                Number(child);
            }

            layout.LastDerivedId = next - 1;
        }

        foreach (var root in roots)
        {
            Number(root);
        }

        foreach (var box in boxes.Values)
        {
            box.ClassId = box.LastDerivedId = next++;
        }
    }

    // Whether other classes share a class's heap type, so that a type test
    // of it compares class ids.
    public bool SharesHeap(ClassLayout layout) =>
        sharing && !layout.IsBox
        && layout.Representation is not null;

    // The parameters and result a virtual call target's function takes and
    // gives, structs whole: an itable member's (its canonical form's), a
    // delegate's, a slot's (its root's canonical form's).
    public (WType[] Parameters, WType Result) CallShape(CallTarget target, IMethodSymbol method)
    {
        if (target.Interface >= 0 || method.ContainingType.TypeKind == TypeKind.Interface)
        {
            var shaped = CanonicalMember(method);
            return ([WType.Ref(objectHeap), .. shaped.Parameters.Select(ParameterType)], MapType(shaped.ReturnType));
        }

        if (method.MethodKind == MethodKind.DelegateInvoke && IsSupportedDelegate(method.ContainingType))
        {
            var layout = DelegateOf(method.ContainingType);
            return ([WType.Ref(layout.Heap), .. layout.Invoke.Parameters], layout.Invoke.Result);
        }

        if (IsDispatched(method) && !method.IsStatic && ObjectSlot(SlotRoot(method)) < 0)
        {
            var root = SlotRoot(method);
            return ([ReceiverType(root), .. PlanParameters(root)], PlanResult(root));
        }

        return SignatureShape(target.Signature);
    }
}
