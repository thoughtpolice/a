// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Strings. A string is a GC array of UTF-16 code units (packed i16), null
// for a null string; nothing but the runtime writes one after creating it,
// so it is immutable to the program. A literal is an immutable global,
// built once by a constant expression (array.new_fixed), so evaluating it
// allocates nothing and equal literals are one object, as interned
// literals are in the CLR. What strings do beyond Length and the indexer is
// C# (runtime/Strings.cs), compiled with a module that uses strings.
// Strings never cross the module boundary.
internal sealed partial class Frontend
{
    // Constant expressions of this many operands stay well inside every
    // engine's limits.
    private const int MaximumLiteralLength = 10_000;

    private int stringHeap = -1;
    // Whether code uses strings, rather than only a record's synthesized
    // ToString, which nothing calls unless code does.
    private bool stringsUsed;
    private bool stringHelpersEnsured;
    private readonly Dictionary<string, int> literalIds = new(StringComparer.Ordinal);
    private readonly List<string> literals = [];

    public int StringHeap => stringHeap >= 0 ? stringHeap : throw new InternalCompilerError("strings are unused.");

    public bool StringUsed => stringHeap >= 0;

    public bool StringsUsed => stringsUsed;

    private WType StringType(bool used = true)
    {
        stringsUsed |= used;
        if (stringHeap < 0)
        {
            if (frozen)
            {
                throw new InternalCompilerError("strings were not discovered.");
            }

            stringHeap = AddType(TypeDefinition.Array("string", new(WType.I16)));
        }

        return WType.Ref(stringHeap);
    }

    private INamedTypeSymbol StringsClass => TypeNamed("Gameplay.Runtime.Strings")!;

    // A runtime string method, by name and parameter count.
    public IMethodSymbol StringHelper(string name, int parameters) => StringsClass.GetMembers(name)
        .OfType<IMethodSymbol>()
        .First(method => method.Parameters.Length == parameters);

    // Every runtime string method gets its function once code uses strings;
    // pruning keeps the ones it calls.
    private void EnsureStringHelpers()
    {
        if (!stringsUsed || stringHelpersEnsured)
        {
            return;
        }

        stringHelpersEnsured = true;
        foreach (var method in StringsClass.GetMembers().OfType<IMethodSymbol>())
        {
            if (method.MethodKind == MethodKind.Ordinary)
            {
                EnsureMethod(method, Substitution.Empty);
            }
        }
    }

    // A literal's number; its global is emitted when a function kept in the
    // module uses it.
    public int Literal(string text)
    {
        if (text.Length > MaximumLiteralLength)
        {
            throw Error($"String literals are limited to {MaximumLiteralLength} characters.");
        }

        if (!literalIds.TryGetValue(text, out int id))
        {
            id = literals.Count;
            literals.Add(text);
            literalIds.Add(text, id);
        }

        return id;
    }

    // A literal as a constant expression.
    private byte[] LiteralInitializer(string text)
    {
        var code = new WasmWriter();
        foreach (char character in text)
        {
            code.I32(character);
        }

        code.Gc(8, stringHeap, text.Length); // array.new_fixed
        return code.ToArray();
    }
}
