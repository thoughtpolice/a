using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Gameplay.Compiler;

internal sealed partial class Frontend
{
    // Only Roslyn binding sees this declaration. It is never emitted as a heap
    // type or loaded into the compiled Wasm module.
    private const string HostImportAttributeSource = """
        namespace Gameplay
        {
            [System.AttributeUsage(System.AttributeTargets.Method, AllowMultiple = false)]
            public sealed class WasmImportAttribute : System.Attribute
            {
                public WasmImportAttribute(string module, string name) { }
            }
        }
        """;

    private readonly List<WasmImport> imports = [];
    private readonly Dictionary<IMethodSymbol, int> importIds = new(SymbolEqualityComparer.Default);
    private readonly HashSet<(string Module, string Name)> importNames = [];

    public bool IsImport(IMethodSymbol method) => importIds.ContainsKey(method);

    private bool TryRegisterHostImport(MethodDeclarationSyntax syntax, IMethodSymbol method)
    {
        var attributeType = compilation.GetTypeByMetadataName("Gameplay.WasmImportAttribute");
        var attributes = method.GetAttributes();
        var importAttribute = attributes.FirstOrDefault(attribute =>
            SymbolEqualityComparer.Default.Equals(attribute.AttributeClass, attributeType));
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
            || !ValidImportName(module) || !ValidImportName(name))
        {
            throw CompileError.At(syntax,
                "WasmImport requires nonempty, valid Unicode module/name strings of at most 256 characters without control characters.");
        }

        WType result = MapType(method.ReturnType);
        WType[] parameters = method.Parameters.Select(parameter => MapType(parameter.Type)).ToArray();
        if (result.IsRef || parameters.Any(parameter => parameter.IsRef))
        {
            throw CompileError.At(syntax,
                "Host imports accept only int, bool, float and double parameters and primitive/void results. "
                + "Use integer handles for host objects.");
        }

        if (!importNames.Add((module, name)))
        {
            throw CompileError.At(syntax, $"Duplicate host import '{module}.{name}'.");
        }

        if (imports.Count >= 256)
        {
            throw CompileError.At(syntax, "Host import limit is 256.");
        }

        importIds.Add(method, imports.Count);
        imports.Add(new(module, name, parameters, result));
        return true;
    }

    private static bool ValidImportName(string value)
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
