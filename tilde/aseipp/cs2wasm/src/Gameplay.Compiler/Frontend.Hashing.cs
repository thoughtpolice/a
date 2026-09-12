// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Identity hashes. Wasm GC has no identity hash for references, so when a
// module hashes a reference (a class or interface instance used as a
// Dictionary key or HashSet element) every class object gets one: a
// mutable i32 field, assigned from a module-wide counter the first time the
// object is hashed. Polymorphic classes hold it in the root $Object, after
// the vtable; other classes as their last field. Modules that hash no
// reference keep their layouts. Hash codes only choose buckets, so they need
// not match the CLR's: Dictionary and HashSet enumerate in insertion order.
internal sealed partial class Frontend
{
    private bool identityHash;

    public bool IdentityHash => identityHash;

    // Called for every type the runtime's Hash intrinsic is instantiated
    // over, during discovery.
    private void RequireHash(ITypeSymbol type)
    {
        DemandHash(type);
        if (type.IsRecord)
        {
            // Its GetHashCode hashes it.
            return;
        }

        var mapped = MapType(type);
        if (mapped.IsTuple)
        {
            foreach (var fieldType in ExactFieldTypes(type))
            {
                RequireHash(fieldType);
            }

            return;
        }

        // Strings hash by their contents.
        if (!mapped.IsRef || type.SpecialType == SpecialType.System_String)
        {
            return;
        }

        if (type is IArrayTypeSymbol || IsSupportedDelegate(type))
        {
            // Arrays hash by length, delegates by type and method.
            return;
        }

        identityHash = true;
    }

    // Where a reference of this type keeps its identity hash: the root
    // object's field 1, or a plain class's last field.
    public (int Heap, int Field) HashField(WType type)
    {
        if (!identityHash)
        {
            throw new InternalCompilerError("identity hash without the field.");
        }

        if (IsObject(type))
        {
            return (objectHeap, 1);
        }

        return (type.Heap, types[type.Heap]!.Fields.Length - 1);
    }

    // The global counter identity hashes come from, first after the runtime
    // globals.
    public int NextHashGlobal => ModuleWriter.RuntimeGlobals.Length;

    // The handler stack of a module with two-pass exception handling, after
    // the counter (see Frontend.Filters): its top, its base, its records.
    public int HandlersGlobal => ModuleWriter.RuntimeGlobals.Length + (identityHash ? 1 : 0);

    public int HandlerBaseGlobal => HandlersGlobal + 1;

    public int HandlerPoolGlobal => HandlersGlobal + 2;

    private int FirstStaticGlobal => HandlersGlobal + (twoPass ? 3 : 0);

    private static WField HashFieldDefinition => new(WType.I32);
}
