// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Text;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// A piece of a composite format: literal text, or an argument's item with
// its alignment and format string.
internal sealed record CompositePart(string? Text, int Index = -1, int? Alignment = null, string? Format = null);

// string.Format with a constant format string is lowered like an
// interpolated string: its items formatted by their arguments' static
// types, after the arguments are evaluated in order. Other formats go to
// the runtime's composite formatting (runtime/Text.cs).
internal sealed partial class Frontend
{
    // The format's pieces as .NET's composite formatting parses them, or
    // null for a format it rejects with a FormatException.
    public static List<CompositePart>? ParseComposite(string format, int arguments)
    {
        var parts = new List<CompositePart>();
        var text = new StringBuilder();
        int position = 0;
        while (position < format.Length)
        {
            char c = format[position++];
            if (c == '}')
            {
                if (position < format.Length && format[position] == '}')
                {
                    text.Append('}');
                    position++;
                    continue;
                }

                return null;
            }

            if (c != '{')
            {
                text.Append(c);
                continue;
            }

            if (position < format.Length && format[position] == '{')
            {
                text.Append('{');
                position++;
                continue;
            }

            if (text.Length != 0)
            {
                parts.Add(new(text.ToString()));
                text.Clear();
            }

            // index, [ws], [',' [ws] ['-'] width [ws]], [':' format], '}'
            if (position >= format.Length || !char.IsAsciiDigit(format[position]))
            {
                return null;
            }

            int index = 0;
            while (position < format.Length && char.IsAsciiDigit(format[position]))
            {
                index = index * 10 + (format[position++] - '0');
                if (index >= 1_000_000)
                {
                    return null;
                }
            }

            while (position < format.Length && format[position] == ' ')
            {
                position++;
            }

            int? alignment = null;
            if (position < format.Length && format[position] == ',')
            {
                position++;
                while (position < format.Length && format[position] == ' ')
                {
                    position++;
                }

                bool left = position < format.Length && format[position] == '-';
                if (left)
                {
                    position++;
                }

                if (position >= format.Length || !char.IsAsciiDigit(format[position]))
                {
                    return null;
                }

                int width = 0;
                while (position < format.Length && char.IsAsciiDigit(format[position]))
                {
                    width = width * 10 + (format[position++] - '0');
                    if (width >= 1_000_000)
                    {
                        return null;
                    }
                }

                alignment = left ? -width : width;
                while (position < format.Length && format[position] == ' ')
                {
                    position++;
                }
            }

            string? itemFormat = null;
            if (position < format.Length && format[position] == ':')
            {
                position++;
                int start = position;
                while (position < format.Length && format[position] != '}')
                {
                    if (format[position] == '{')
                    {
                        return null;
                    }

                    position++;
                }

                itemFormat = position > start ? format[start..position] : null;
            }

            if (position >= format.Length || format[position] != '}' || index >= arguments)
            {
                return null;
            }

            position++;
            parts.Add(new(null, index, alignment, itemFormat));
        }

        if (text.Length != 0)
        {
            parts.Add(new(text.ToString()));
        }

        return parts;
    }

    // What formatting a value of this type with or without a format and
    // alignment needs.
    private void DemandFormatted(ITypeSymbol? type, bool formatted, bool aligned)
    {
        DemandPrinting(type);
        if (formatted && ScalarOf(type) is { } scalar && scalar is not (Scalar.Bool or Scalar.Char))
        {
            EnsureRuntimeMethod(
                "Number",
                scalar switch { Scalar.F32 => "FormatSingle", Scalar.F64 => "FormatDouble", _ => "FormatInteger" },
                scalar is Scalar.F32 or Scalar.F64 ? 2 : 4);
        }

        if (formatted && CoreLibFormattable(type) is { } toString)
        {
            EnsureMethod(toString, Substitution.Empty);
        }

        if (aligned)
        {
            EnsureRuntimeMethod("Number", "Align", 2);
        }
    }

    // The ToString(string, IFormatProvider) of one of the CoreLib's own
    // IFormattable structs (BigInteger, Complex, DateTime, ...), which an
    // interpolation hole with a format calls, as .NET's handler does.
    public static IMethodSymbol? CoreLibFormattable(ITypeSymbol? type) =>
        type is INamedTypeSymbol named && IsStruct(type) && InCoreLibrary(type) && ScalarOf(type) is null && !IsSurfaceType(named)
        && type.AllInterfaces.Any(face => face is { Name: "IFormattable", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } })
            ? type.GetMembers("ToString").OfType<IMethodSymbol>().FirstOrDefault(method =>
                method is { IsStatic: false, Parameters: [{ Type.SpecialType: SpecialType.System_String }, { Type.Name: "IFormatProvider" }] })
            : null;
}
