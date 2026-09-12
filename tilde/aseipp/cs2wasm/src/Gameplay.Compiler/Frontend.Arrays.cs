// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Arrays. A one-dimensional array is a Wasm GC array of its elements. A
// multidimensional `T[,]` (ranks 2 to 8) is the runtime's MdArray2<T> (to
// MdArray8<T>; runtime/Arrays.cs): a flat array of the elements in
// row-major order and the dimensions' lengths. An element access checks
// the array for null and each index against its dimension, then reads or
// writes the flat array; System.Array's members on such an array are
// MdArray's.
internal sealed partial class Frontend
{
    // The abstract heap type of every struct and array, as its negative s33
    // code: `eq`.
    public const int EqHeap = -0x13;

    // The abstract heap type of every array.
    public const int ArrayHeap = -0x16;

    // Array covariance: once a module converts an array to an
    // array of a type E its elements convert to (object[] from string[]),
    // or tests an object for E[] that other arrays convert to, discovery
    // starts again with the one-dimensional arrays of the references that
    // convert to E in one family: arrays of eqref, the exact type of each a
    // final subtype of the family's (for type tests and allocation), each
    // typed as the family's. A load casts to the element's type; a store
    // into an array whose elements have subtypes checks the value against
    // the array's exact element type and throws
    // ArrayTypeMismatchException, as the CLR's stelem.ref does. Other
    // arrays keep their exact types.
    private readonly IReadOnlySet<ITypeSymbol> covariantElements;

    private sealed class ArrayCovarianceFound(ITypeSymbol element) : Exception
    {
        public ITypeSymbol Element { get; } = element;
    }

    // With shared generics, every array of references is of the family: a
    // shared instantiation's T[] is any of them (Frontend.Sharing).
    public bool CovariantArrays => covariantElements.Count != 0 || sharing;

    public bool IsCovariantArray(IArrayTypeSymbol array) =>
        CovariantArrays && array.IsSZArray && array.ElementType.IsReferenceType
        && (sharing
            || covariantElements.Any(element => SymbolEqualityComparer.Default.Equals(array.ElementType, element)
                                                || ClassifyConversion(array.ElementType, element) is { IsImplicit: true, IsReference: true }));

    private int refArrayHeap = -1;

    // The family's type: an array of references, of any element type.
    public int RefArrayHeap
    {
        get
        {
            if (refArrayHeap < 0)
            {
                refArrayHeap = AddType(TypeDefinition.Array("array of references", new(WType.Ref(EqHeap), Mutable: true), final: false));
            }

            return refArrayHeap;
        }
    }

    // With shared generics, arrays of a shared struct's instantiations
    // (KeyValuePair<string, int>[], KeyValuePair<Enemy, int>[]) are a family
    // of their own too: arrays of the canonical form's boxes, each exact
    // array type a final subtype of the family's (Frontend.Sharing).
    public bool IsFamilyArray(IArrayTypeSymbol array) =>
        IsCovariantArray(array)
        || (sharing && array.IsSZArray && array.ElementType is INamedTypeSymbol { TypeKind: TypeKind.Struct } element
            && IsShareable(element) && HasReferenceArgument(element));

    private readonly Dictionary<ITypeSymbol, int> structArrayFamilies = new(SymbolEqualityComparer.Default);

    // The heap type a family array is typed as.
    public int FamilyHeap(IArrayTypeSymbol array)
    {
        if (IsCovariantArray(array))
        {
            return RefArrayHeap;
        }

        var element = Canonical((INamedTypeSymbol)array.ElementType);
        if (!structArrayFamilies.TryGetValue(element, out int heap))
        {
            heap = AddType(TypeDefinition.Array(
                "array of " + element.ToDisplayString(), StorageField(element, nullable: true), final: false));
            structArrayFamilies.Add(element, heap);
        }

        return heap;
    }

    // An array type's own definition: a family's final subtype, or its own.
    private TypeDefinition ArrayDefinition(IArrayTypeSymbol array) =>
        IsCovariantArray(array)
            ? TypeDefinition.Array(array.ToDisplayString(), new(WType.Ref(EqHeap), Mutable: true), RefArrayHeap)
            : IsFamilyArray(array)
                ? TypeDefinition.Array(array.ToDisplayString(), StorageField(array.ElementType, nullable: true), FamilyHeap(array))
                : TypeDefinition.Array(array.ToDisplayString(), StorageField(array.ElementType, nullable: true));

    // Whether a type's type arguments, or theirs, include a reference type.
    private static bool HasReferenceArgument(INamedTypeSymbol type)
    {
        for (var current = type; current is not null; current = current.ContainingType)
        {
            if (current.TypeArguments.Any(argument => argument.IsReferenceType
                                                      || (argument is INamedTypeSymbol named && HasReferenceArgument(named))))
            {
                return true;
            }
        }

        return false;
    }

    private int storeCheck = -1;

    // The function a store into an array of the family calls where the
    // array's elements may be of a type its static type's subtypes: it
    // tests the array for each of the module's arrays of the family (whose
    // element types are not object) and the value for that array's element
    // type, and throws ArrayTypeMismatchException, as stelem.ref does.
    private void RegisterStoreCheck()
    {
        if (storeCheck >= 0)
        {
            return;
        }

        storeCheck = methods.Count;
        methods.Add(new(
            null, "<array store check>", [WType.Ref(RefArrayHeap), WType.Ref(EqHeap)], WType.Void, true, null,
            MethodPlanKind.StoreCheck, Substitution.Empty));
    }

    public int StoreCheck => imports.Count + storeCheck;

    // The module's arrays of the family, with element types a store may
    // violate.
    public List<(IArrayTypeSymbol Array, int Heap)> CheckedArrays() =>
        [.. heapIds.Where(entry => entry.Key is IArrayTypeSymbol { IsSZArray: true } array && IsCovariantArray(array)
                                    && array.ElementType.SpecialType != SpecialType.System_Object && Escapes(array))
            .Select(entry => ((IArrayTypeSymbol)entry.Key, entry.Value))];

    // Whether a heap type is the family's (without making it).
    public bool IsRefArrayHeap(int heap) => refArrayHeap >= 0 && heap == refArrayHeap;

    // What emission found: an array converted by covariance, or
    // tested for an array type other arrays convert to, before the family.
    public void NoteArrayCovariance(ITypeSymbol element)
    {
        if (!sharing && !covariantElements.Contains(element))
        {
            throw new ArrayCovarianceFound(element);
        }
    }

    // The array type a heap type is the exact type of, or null.
    public IArrayTypeSymbol? ArraySymbolOfHeap(int heap) =>
        heap >= 0 && heap < typeSymbols.Count && typeSymbols[heap] is IArrayTypeSymbol { IsSZArray: true } array ? array : null;

    // The heap type an array is made of: its own, exact.
    public int ArrayAllocationHeap(IArrayTypeSymbol array) => heapIds[array];

    // The module's arrays of the family whose exact element type is a
    // proper subtype of an element type: what a store must check against.
    public List<(IArrayTypeSymbol Array, int Heap)> StrictSubtypeArrays(ITypeSymbol element) =>
        [.. heapIds.Where(entry => entry.Key is IArrayTypeSymbol { IsSZArray: true } array && IsCovariantArray(array)
                                    && !SymbolEqualityComparer.Default.Equals(array.ElementType, element)
                                    && ClassifyConversion(array.ElementType, element) is { IsImplicit: true, IsReference: true })
            .Select(entry => ((IArrayTypeSymbol)entry.Key, entry.Value))];

    // One of the runtime's classes of multidimensional arrays.
    public static bool IsMdArrayClass(INamedTypeSymbol type) =>
        type.Name.StartsWith("MdArray", StringComparison.Ordinal) && IsRuntimeType(type);

    private const int MaximumArrayRank = 8;

    private INamedTypeSymbol MdArrayClass(IArrayTypeSymbol array, ITypeSymbol element)
    {
        if (array.Rank > MaximumArrayRank)
        {
            throw new CompileError(
                $"Array type '{array.ToDisplayString()}' of rank {array.Rank} is unsupported; ranks up to {MaximumArrayRank} are.");
        }

        return TypeNamed($"Gameplay.Runtime.MdArray{array.Rank}`1")!.Construct(element);
    }

    // A member of MdArray, which the rank's class inherits.
    private static IEnumerable<ISymbol> MdArrayMembers(ITypeSymbol mdArray, string name)
    {
        for (var type = (INamedTypeSymbol?)mdArray; type is not null; type = type.BaseType)
        {
            foreach (var member in type.GetMembers(name))
            {
                yield return member;
            }
        }
    }

    // The MdArray member standing for a System.Array member called on a
    // multidimensional array (the array's type substituted and unnamed).
    public ISymbol MdArrayMember(ITypeSymbol mdArray, ISymbol member)
    {
        var type = (INamedTypeSymbol)mdArray;
        if (member is IMethodSymbol { MethodKind: MethodKind.PropertyGet, AssociatedSymbol: IPropertySymbol property })
        {
            member = property;
        }

        return MdArrayMembers(type, member.Name).FirstOrDefault(candidate =>
                   candidate.DeclaredAccessibility == Accessibility.Public && SameSignature(candidate, member))
               ?? throw Error($"'{member.ToDisplayString()}' of a multidimensional array is unsupported.");
    }

    public IMethodSymbol MdArrayNew(ITypeSymbol mdArray) => MdArrayMembers(mdArray, "New").OfType<IMethodSymbol>().Single();

    public IFieldSymbol MdArrayField(ITypeSymbol mdArray, string name) =>
        MdArrayMembers(mdArray, name).OfType<IFieldSymbol>().Single();

    public ITypeSymbol IntType => compilation.GetSpecialType(SpecialType.System_Int32);
}

internal sealed partial class FunctionEmitter
{

    // The null and per-dimension checks of a multidimensional element, and
    // its flat array and index.
    private void CheckMdElement(Location location)
    {
        var mdType = location.MdType!;
        var heap = Map(mdType).Heap;
        int array = location.MdArray;
        CheckNull(array);
        var intArray = frontend.MapType(frontend.ArrayOf(frontend.IntType));
        LocalGet(array);
        code.Gc(2, heap, frontend.FieldIndex(frontend.MdArrayField(mdType, "lengths"))); // struct.get
        int lengths = Save(intArray);
        var indices = location.MdIndices!;
        code.I32(0);
        LocalSet(location.Index);
        for (int dimension = 0; dimension < indices.Length; dimension++)
        {
            LocalGet(lengths);
            code.I32(dimension);
            code.Gc(11, intArray.Heap); // array.get
            int length = Save(WType.I32);
            LocalGet(indices[dimension]);
            LocalGet(length);
            code.Byte(0x4f); // i32.ge_u
            FaultIf(FaultCode.ArrayIndexOutOfRange);
            LocalGet(location.Index);
            LocalGet(length);
            code.Byte(0x6c); // i32.mul
            LocalGet(indices[dimension]);
            code.Byte(0x6a); // i32.add
            LocalSet(location.Index);
        }

        LocalGet(array);
        code.Gc(2, heap, frontend.FieldIndex(frontend.MdArrayField(mdType, "items"))); // struct.get
        LocalSet(location.Receiver);
    }
}
