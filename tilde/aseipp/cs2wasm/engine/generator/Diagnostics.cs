// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln.Generator;

using Microsoft.CodeAnalysis;

// Everything the generator reports, as the compiler reports it.
internal static class Diagnostics
{
    private const string Category = "Kiln";

    public static readonly DiagnosticDescriptor ComponentShape = Error(
        "KILN001", "Components are partial, non-generic structs", "Component '{0}' must be a partial, non-generic struct{1}");

    public static readonly DiagnosticDescriptor SystemClass = Error(
        "KILN003", "Systems live in partial classes", "System '{0}' must be declared in a partial class (and every class around it partial)");

    public static readonly DiagnosticDescriptor SystemShape = Error(
        "KILN004", "Systems are static void methods", "System '{0}' must be a static, non-generic method returning void");

    public static readonly DiagnosticDescriptor ParameterType = Error(
        "KILN005", "Unsupported system parameter", "Parameter '{0}' of system '{1}' has type '{2}', which is not a component, resource, event reader or writer, Entity or World");

    public static readonly DiagnosticDescriptor ParameterKind = Error(
        "KILN006", "Unsupported parameter passing", "Parameter '{0}' of system '{1}' is passed {2}; components are passed by ref (written) or by value or in (read)");

    public static readonly DiagnosticDescriptor TagParameter = Error(
        "KILN007", "Tags are not parameters", "Parameter '{0}' of system '{1}' is the tag '{2}', which has no value; use [With<{2}>] instead");

    public static readonly DiagnosticDescriptor DeclarationShape = Error(
        "KILN008", "Declaration shape", "'{0}' must be {1}");

    public static readonly DiagnosticDescriptor DuplicateParameter = Error(
        "KILN009", "Component taken twice", "System '{0}' takes '{1}' more than once");

    public static readonly DiagnosticDescriptor OrderCycle = Error(
        "KILN010", "Systems ordered in a cycle", "The [After]/[Before] ordering of phase {0} has a cycle through {1}");

    public static readonly DiagnosticDescriptor UnknownSystem = Error(
        "KILN011", "Unknown system", "System '{0}' is ordered against '{1}', which is {2}");

    public static readonly DiagnosticDescriptor RunIf = Error(
        "KILN013", "Invalid run condition", "The run condition '{0}' of system '{1}' must be a static bool method of its class whose parameters are resources or the World");

    public static readonly DiagnosticDescriptor LibraryDeclaration = Error(
        "KILN014", "Kiln library declaration", "{0} '{1}' of {2} cannot join a program's schedule: {3}");

    public static readonly DiagnosticDescriptor Ambiguous = new(
        "KILN020",
        "Ambiguous system order",
        "Systems '{0}' and '{1}' of phase {2} both use '{3}' and one of them writes it, but nothing orders them; they run by name. Give them different Orders, or [After]/[Before].",
        Category,
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    private static DiagnosticDescriptor Error(string id, string title, string message) =>
        new(id, title, message, Category, DiagnosticSeverity.Error, isEnabledByDefault: true);
}
