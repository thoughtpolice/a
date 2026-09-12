// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Exceptions. System.Exception and the BCL exceptions the runtime throws are
// classes of the module like any other, deriving from $Object: Exception
// holds the fault code an exception ends an entry with when nothing catches
// it, set when it is created (its class's code, or the code of the check
// that threw it). User exceptions derive from them. A module that reads
// Message or InnerException, or constructs an exception with a message,
// gives Exception two more fields, the message and the inner exception,
// and TypeInitializationException a third, the type name. An exception
// created without a message has the CLR's for an exception without one:
// "Exception of type 'T' was thrown."
//
// A module that contains a try statement throws Wasm exceptions: one tag,
// whose payload is the exception object, thrown by `throw` and by the
// checks the CLR would throw from, caught with try_table (the standard
// exnref encoding); a module with `when` filters chooses the clause before
// throwing (see Frontend.Filters). Every exported entry catches what
// escapes and ends as a trap with the exception's fault code, as before. A
// module without a try
// statement can catch nothing, so it keeps faulting in place: a throw
// traps with the exception's code. Faults the CLR has no exception for, or
// cannot catch (fuel, call depth, allocation, abandoned entries, and
// arrays above the maximum length), always trap.
internal sealed partial class Frontend
{
    // The BCL exceptions, by metadata name, and the fault code of each; a
    // class deriving from one has its code, one deriving from another has
    // 17.
    private static readonly (string Name, int Fault)[] FrameworkExceptionCodes =
    [
        ("System.Exception", 17),
        ("System.SystemException", 17),
        ("System.ApplicationException", 17),
        ("System.NotSupportedException", 17),
        ("System.NotImplementedException", 17),
        ("System.FormatException", 17),
        ("System.TypeInitializationException", 17),
        ("System.MemberAccessException", 17),
        ("System.MissingMemberException", 17),
        ("System.MissingMethodException", 17),
        // What the imported framework assemblies throw.
        ("System.OutOfMemoryException", 17),
        ("System.RankException", 17),
        ("System.ArrayTypeMismatchException", 17),
        ("System.PlatformNotSupportedException", 17),
        // What Task.WaitAsync faults with.
        ("System.TimeoutException", 17),
        ("System.InvalidOperationException", 14),
        ("System.ArgumentException", 10),
        ("System.ArgumentNullException", 10),
        ("System.ArgumentOutOfRangeException", 16),
        ("System.NullReferenceException", 5),
        ("System.IndexOutOfRangeException", 6),
        ("System.ArithmeticException", 8),
        ("System.DivideByZeroException", 7),
        ("System.OverflowException", 8),
        ("System.InvalidCastException", 13),
        ("System.Collections.Generic.KeyNotFoundException", 15),
        ("System.Runtime.CompilerServices.SwitchExpressionException", 11),
    ];

    public const int UnhandledExceptionFault = 17;

    private bool exceptionMessages;

    public bool ExceptionMessages => exceptionMessages;

    public int MessageField => FaultField + 1;

    public int InnerField => FaultField + 2;

    // ArgumentException's ParamName: a field of every exception, after the
    // inner exception, once code names a parameter.
    public int ParamNameField => FaultField + 3;

    public int TypeNameField => FaultField + 3 + (exceptionParamNames ? 1 : 0);

    // The fields exceptions have after their fault code.
    public int ExceptionTextFields => exceptionMessages ? 2 + (exceptionParamNames ? 1 : 0) : 0;

    private bool exceptionParamNames;

    private Dictionary<INamedTypeSymbol, int>? frameworkExceptions;
    private bool exceptions;
    private int exceptionTag = -1;
    private int throwHelper = -1;

    private Dictionary<INamedTypeSymbol, int> FrameworkExceptions => frameworkExceptions ??= FrameworkExceptionCodes
        .Select(entry => (Type: TypeNamed(entry.Name), entry.Fault))
        .Where(entry => entry.Type is not null)
        .ToDictionary(entry => entry.Type!, entry => entry.Fault, (IEqualityComparer<INamedTypeSymbol>)SymbolEqualityComparer.Default);

    // Whether the module throws Wasm exceptions (see above).
    public bool Exceptions => exceptions;

    public bool IsFrameworkException(ITypeSymbol? type) =>
        type is INamedTypeSymbol named && FrameworkExceptions.ContainsKey(named);

    public INamedTypeSymbol ExceptionType => TypeNamed("System.Exception")!;

    // The code of an exception class: its own, or its nearest BCL ancestor's.
    public int ExceptionFault(ITypeSymbol type)
    {
        for (var current = type as INamedTypeSymbol; current is not null; current = current.BaseType)
        {
            if (FrameworkExceptions.TryGetValue(current, out int fault))
            {
                return fault;
            }
        }

        return UnhandledExceptionFault;
    }

    public bool IsException(ITypeSymbol? type)
    {
        for (var current = type as INamedTypeSymbol; current is not null; current = current.BaseType)
        {
            if (IsFrameworkException(current))
            {
                return true;
            }
        }

        return false;
    }

    // A BCL exception class: a polymorphic class without slots, whose only
    // field (in System.Exception) is the fault code.
    private ClassLayout RegisterFrameworkClass(INamedTypeSymbol type)
    {
        if (layouts.TryGetValue(type, out var existing))
        {
            return existing;
        }

        ClassLayout? parent = null;
        if (IsFrameworkException(type.BaseType))
        {
            parent = RegisterFrameworkClass(type.BaseType!);
        }
        else
        {
            EnsureObjectRoot();
        }

        int heap = AddHeap(type);
        var layout = new ClassLayout(type, parent, heap, AddType(null));
        layouts.Add(type, layout);
        nextFieldIndex[type] = parent is null ? 2 : nextFieldIndex[parent.Symbol];
        membersRegistered.Add(type);
        return layout;
    }

    // The exception's field holding its fault code, after the vtable and the
    // identity hash, if any.
    public int FaultField => 1 + (identityHash ? 1 : 0);

    public int ExceptionHeap => heapIds[ExceptionType];

    public int ThrowHelper => imports.Count + throwHelper;

    // The exception class a check throws, by its fault code.
    public INamedTypeSymbol CheckException(int fault) => TypeNamed(fault switch
    {
        4 or 8 or 9 => "System.OverflowException",
        5 => "System.NullReferenceException",
        6 => "System.IndexOutOfRangeException",
        7 => "System.DivideByZeroException",
        10 => "System.ArgumentException",
        11 => "System.Runtime.CompilerServices.SwitchExpressionException",
        13 => "System.InvalidCastException",
        14 => "System.InvalidOperationException",
        15 => "System.Collections.Generic.KeyNotFoundException",
        16 => "System.ArgumentOutOfRangeException",
        _ => throw new InternalCompilerError($"fault {fault} throws no exception."),
    })!;

    public static readonly int[] CatchableFaults = [4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16];

    // Called once discovery has seen all code: a try statement anywhere
    // turns exceptions on, with the checks' exception classes, the tag and
    // the helper that throws for a check.
    private void FinishExceptions()
    {
        if (!exceptions)
        {
            return;
        }

        foreach (int fault in CatchableFaults)
        {
            RegisterFrameworkClass(CheckException(fault));
        }

        RegisterFrameworkClass(ExceptionType);
        exceptionTag = SignatureType([WType.Ref(ExceptionHeap)], WType.Void);
        throwHelper = methods.Count;
        methods.Add(new(
            null, "<throw>", [WType.I32], WType.Void, true, null, MethodPlanKind.ThrowHelper, Substitution.Empty));
    }

    private void RequireMessages()
    {
        exceptionMessages = true;
        StringType();
        RegisterFrameworkClass(ExceptionType);
    }

    private void RequireParamNames()
    {
        exceptionParamNames = true;
        EnsureRuntimeMethod("ExceptionText", "WithParameter", 2);
        EnsureRuntimeMethod("ExceptionText", "WithActualValue", 2);
    }

    private bool ExceptionPropertyName(IPropertySymbol property) =>
        IsFrameworkException(property.ContainingType)
        && (property.Name is "Message" or "InnerException"
            || (property.Name == "TypeName"
                && SymbolEqualityComparer.Default.Equals(property.ContainingType, TypeInitializationException))
            || (property.Name == "ParamName" && FullName(property.ContainingType) == "System.ArgumentException"));

    // The argument exceptions' constructors that take a parameter's name.
    public static bool IsParamNameConstructor(IMethodSymbol constructor)
    {
        string[] names = [.. constructor.Parameters.Select(parameter => parameter.Name)];
        return FullName(constructor.ContainingType) switch
        {
            "System.ArgumentException" => names is ["message", "paramName"] or ["message", "paramName", "innerException"],
            "System.ArgumentNullException" => names is ["paramName"] or ["paramName", "message"],
            "System.ArgumentOutOfRangeException" => names is ["paramName"] or ["paramName", "message"]
                or ["paramName", "actualValue", "message"],
            _ => false,
        };
    }

    public static bool IsSupportedExceptionConstructor(IMethodSymbol constructor) =>
        constructor.Parameters.Length == 0 || IsMessageConstructor(constructor) || IsParamNameConstructor(constructor);

    // The messages the CLR's BCL exceptions have from their parameterless
    // constructors (and the checks' exceptions here): its resources'
    // English text. System.Exception has none: its message names the class.
    private static readonly Dictionary<string, string> OwnDefaultMessages = new()
    {
        ["System.SystemException"] = "System error.",
        ["System.ApplicationException"] = "Error in the application.",
        ["System.InvalidOperationException"] = "Operation is not valid due to the current state of the object.",
        ["System.ArgumentException"] = "Value does not fall within the expected range.",
        ["System.ArgumentNullException"] = "Value cannot be null.",
        ["System.ArgumentOutOfRangeException"] = "Specified argument was out of the range of valid values.",
        ["System.NullReferenceException"] = "Object reference not set to an instance of an object.",
        ["System.IndexOutOfRangeException"] = "Index was outside the bounds of the array.",
        ["System.ArithmeticException"] = "Overflow or underflow in the arithmetic operation.",
        ["System.DivideByZeroException"] = "Attempted to divide by zero.",
        ["System.OverflowException"] = "Arithmetic operation resulted in an overflow.",
        ["System.InvalidCastException"] = "Specified cast is not valid.",
        ["System.NotSupportedException"] = "Specified method is not supported.",
        ["System.NotImplementedException"] = "The method or operation is not implemented.",
        ["System.FormatException"] = "One of the identified items was in an invalid format.",
        ["System.MemberAccessException"] = "Cannot access member.",
        ["System.MissingMemberException"] = "Attempted to access a missing member.",
        ["System.MissingMethodException"] = "Attempted to access a missing method.",
        ["System.Collections.Generic.KeyNotFoundException"] = "The given key was not present in the dictionary.",
        ["System.Runtime.CompilerServices.SwitchExpressionException"] =
            "Non-exhaustive switch expression failed to match its input.",
        ["System.ArrayTypeMismatchException"] = "Attempted to access an element as a type incompatible with the array.",
        ["System.OutOfMemoryException"] = "Insufficient memory to continue the execution of the program.",
        ["System.RankException"] = "Attempted to operate on an array with the incorrect number of dimensions.",
        ["System.PlatformNotSupportedException"] = "Operation is not supported on this platform.",
        ["System.TimeoutException"] = "The operation has timed out.",
    };

    public static string? OwnDefaultMessage(INamedTypeSymbol type) => OwnDefaultMessages.GetValueOrDefault(FullName(type));

    // The message of an exception the module creates for a check.
    public static string CheckMessage(INamedTypeSymbol type) => OwnDefaultMessage(type) ?? DefaultMessage(type);

    public static bool IsMessageConstructor(IMethodSymbol constructor) =>
        constructor.Parameters.Select(parameter => parameter.Name).SequenceEqual(
            constructor.Parameters.Length == 1 ? ["message"] : ["message", "innerException"])
        && constructor.Parameters[0].Type.SpecialType == SpecialType.System_String;

    // The field of an exception property the module lowers, or null.
    public int? ExceptionPropertyField(IPropertySymbol property)
    {
        if (!ExceptionPropertyName(property))
        {
            return null;
        }

        return property.Name switch
        {
            "Message" => MessageField,
            "InnerException" => InnerField,
            "ParamName" => ParamNameField,
            _ => TypeNameField,
        };
    }

    // A type's name as the CLR's Type.FullName spells a non-generic one:
    // nested types after a `+`.
    // A constructed type's is its definition's, which is kept.
    public static string FullName(INamedTypeSymbol type) =>
        fullNames.GetValue(type.OriginalDefinition, definition =>
            definition.ContainingType is { } outer
                ? FullName(outer) + "+" + definition.MetadataName
                : definition.ContainingNamespace is { IsGlobalNamespace: false } space
                    ? space.ToDisplayString() + "." + definition.MetadataName
                    : definition.MetadataName);

    private static readonly ConditionalWeakTable<INamedTypeSymbol, string> fullNames = [];

    public static string DefaultMessage(INamedTypeSymbol type) => $"Exception of type '{FullName(type)}' was thrown.";
}
