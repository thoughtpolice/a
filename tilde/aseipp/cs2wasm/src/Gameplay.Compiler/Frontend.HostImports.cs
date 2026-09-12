// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Gameplay.Compiler;

// The module boundary: typed function imports declared with WasmImport, and
// the names WasmExport gives exports. Both name strings follow the same rules,
// so a WIT world's `ns:pkg/iface@1.0.0` module names and `[method]res.f`
// function names pass through unchanged.
internal sealed partial class Frontend
{
    private readonly List<WasmImport> imports = [];
    private readonly Dictionary<IMethodSymbol, int> importIds = new(SymbolEqualityComparer.Default);
    private readonly HashSet<(string Module, string Name)> importNames = [];

    public bool IsImport(IMethodSymbol method) => importIds.ContainsKey(method.PartialDefinitionPart ?? method);

    private bool TryRegisterHostImport(MethodDeclarationSyntax syntax, IMethodSymbol method)
    {
        var attributes = method.GetAttributes();
        var importAttribute = attributes.FirstOrDefault(attribute => IsWasmImport(attribute.AttributeClass));
        if (importAttribute is null)
        {
            return false;
        }

        if (attributes.Length != 1 || method.GetReturnTypeAttributes().Length != 0
            || !method.IsStatic || !method.IsExtern
            || method.IsGenericMethod || method.ReturnsByRef || method.ReturnsByRefReadonly
            || HasUnsupportedParameters(method) || syntax.Body is not null || syntax.ExpressionBody is not null)
        {
            throw CompileError.At(syntax,
                "WasmImport requires an ordinary static extern method with value parameters and no other attributes.");
        }

        if (importAttribute.ConstructorArguments.Length != 2
            || importAttribute.NamedArguments.Length != 0
            || importAttribute.ConstructorArguments[0].Value is not string module
            || importAttribute.ConstructorArguments[1].Value is not string name
            || !ValidBoundaryName(module) || !ValidBoundaryName(name))
        {
            throw CompileError.At(syntax,
                "WasmImport requires nonempty, valid Unicode module/name strings of at most 256 characters without control characters.");
        }

        if (!HasScalarSignature(method))
        {
            throw CompileError.At(syntax,
                "Host imports accept only scalar parameters (integers, bool, char, enums, float, double) "
                + "and scalar/void results. Use integer handles for host objects.");
        }

        if (!importNames.Add((module, name)))
        {
            throw CompileError.At(syntax, $"Duplicate host import '{module}.{name}'.");
        }

        if (imports.Count >= 1024)
        {
            throw CompileError.At(syntax, "Host import limit is 1024.");
        }

        WType result = MapType(method.ReturnType);
        WType[] parameters = method.Parameters.Select(parameter => MapType(parameter.Type)).ToArray();
        importIds.Add(method, imports.Count);
        imports.Add(new(module, name, parameters, result));
        return true;
    }

    private static string ExportAttributeName(AttributeData attribute, MethodDeclarationSyntax syntax)
    {
        if (attribute.ConstructorArguments.Length != 1
            || attribute.NamedArguments.Length != 0
            || attribute.ConstructorArguments[0].Value is not string name
            || !ValidBoundaryName(name))
        {
            throw CompileError.At(syntax,
                "WasmExport requires a nonempty, valid Unicode name of at most 256 characters without control characters.");
        }

        if (ModuleWriter.ReservedExports.Contains(name, StringComparer.Ordinal))
        {
            throw CompileError.At(syntax, $"WasmExport name '{name}' is reserved for the runtime.");
        }

        return name;
    }

    private static bool ValidBoundaryName(string value)
    {
        if (value.Length is 0 or > 256 || string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (char.IsControl(character) || char.IsLowSurrogate(character))
            {
                return false;
            }

            // Reject malformed UTF-16 instead of letting UTF-8 replacement
            // silently change a capability name or merge distinct imports.
            if (char.IsHighSurrogate(character)
                && (++index == value.Length || !char.IsLowSurrogate(value[index])))
            {
                return false;
            }
        }

        return true;
    }
}
