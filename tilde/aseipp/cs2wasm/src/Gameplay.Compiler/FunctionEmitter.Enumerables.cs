// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The adopted framework interfaces (see Frontend.Enumerables): an
// IEnumerable<T> that is an array or a string enumerates as the CLR's.
internal sealed partial class FunctionEmitter
{
    // IEnumerable<T>.GetEnumerator with the receiver (checked for null) on
    // the stack: an object's through its itable, an array's or string's
    // the runtime's enumerator of it.
    private void EmitEnumerableGetEnumerator(CallTarget target, int receiver, ITypeSymbol element)
    {
        code.Byte(0x1a); // drop: the receiver is in its local
        var result = WType.Ref(frontend.ObjectHeap);
        LocalGet(receiver);
        code.RefTest(WType.NonNullRef(frontend.ObjectHeap));
        EmitChoice(result, () =>
        {
            LocalGet(receiver);
            code.RefCast(WType.NonNullRef(frontend.ObjectHeap));
            int self = Save(WType.Ref(frontend.ObjectHeap));
            LocalGet(self);
            EmitCallTarget(target with { EnumerableElement = null }, self);
        }, () => EnumerateArrays(frontend.ArraysConvertingTo(element), 0));

        void EnumerateArrays(List<IArrayTypeSymbol> arrays, int next)
        {
            if (next == arrays.Count)
            {
                if (element.SpecialType == SpecialType.System_Char)
                {
                    LocalGet(receiver);
                    code.RefCast(Text);
                    Call(frontend.MethodIndex(frontend.RuntimeMethod("Enumerables", "OfString", 1)));
                }
                else
                {
                    code.Byte(0x00); // unreachable: nothing else is one
                }

                return;
            }

            // An array of the elements, or by covariance of a type that
            // converts to them.
            var arrayType = Map(arrays[next]);
            LocalGet(receiver);
            code.RefTest(WType.NonNullRef(frontend.ArrayAllocationHeap(arrays[next])));
            EmitChoice(result, () =>
            {
                LocalGet(receiver);
                code.RefCast(arrayType);
                Call(frontend.MethodIndex(frontend.RuntimeMethod("Enumerables", "OfArray", 1).Construct(arrays[next].ElementType)));
            }, () => EnumerateArrays(arrays, next + 1));
        }
    }

    // A collection interface's member with the receiver (checked for
    // null) and the arguments on the stack: an object's through its
    // itable, an array's the CoreLib's implementation of it
    // (Frontend.ArrayImplementation).
    private void EmitArrayInterfaceCall(CallTarget target, int receiver, IMethodSymbol member)
    {
        // The itable member's shape, which is its canonical form's
        // (Frontend.Sharing).
        var (shape, result) = frontend.CallShape(target, member);
        var parameters = shape[1..];
        var arguments = new int[parameters.Length];
        for (int index = parameters.Length - 1; index >= 0; index--)
        {
            arguments[index] = Save(parameters[index]);
        }

        code.Byte(0x1a); // drop: the receiver is in its local
        var arrays = frontend.ArraysConvertingTo(((INamedTypeSymbol)member.ContainingType).TypeArguments[0])
            .Select(array => (Array: array, Method: frontend.ArrayMember(member, array)))
            .Where(entry => entry.Method is not null)
            .ToList();

        void Arrays(int next)
        {
            if (next == arrays.Count)
            {
                code.Byte(0x00); // unreachable: nothing else is one
                return;
            }

            var arrayType = Map(arrays[next].Array);
            LocalGet(receiver);
            code.RefTest(WType.NonNullRef(frontend.ArrayAllocationHeap(arrays[next].Array)));
            EmitChoice(result, () =>
            {
                LocalGet(receiver);
                code.RefCast(arrayType);
                int called = frontend.MethodIndex(arrays[next].Method!);
                var calledShape = frontend.PlanOfFunction(called);
                for (int index = 0; index < arguments.Length; index++)
                {
                    LocalGet(arguments[index]);
                    CastToShape(parameters[index], calledShape.Parameters[index + 1]);
                }

                Call(called);
                CastToShape(calledShape.Result, result);
            }, () => Arrays(next + 1));
        }

        LocalGet(receiver);
        code.RefTest(WType.NonNullRef(frontend.ObjectHeap));
        EmitChoice(result, () =>
        {
            LocalGet(receiver);
            code.RefCast(WType.NonNullRef(frontend.ObjectHeap));
            int self = Save(WType.Ref(frontend.ObjectHeap));
            LocalGet(self);
            foreach (int argument in arguments)
            {
                LocalGet(argument);
            }

            EmitCallTarget(target with { ArrayCall = null }, self);
        }, () => Arrays(0));
    }

    // A non-generic collection interface's member with the receiver
    // (checked for null) and the arguments on the stack: an object's
    // through its itable, an array's its element type's method (as each of
    // the module's array types is tested for), a string's enumerator.
    private void EmitObjectArrayInterfaceCall(CallTarget target, int receiver, string helper)
    {
        var methods = frontend.ArrayTypes()
            .Select(array => (Array: array, Method: frontend.ObjectArrayMethod(helper, array.ElementType)))
            .ToList();
        var parameters = methods.Count == 0
            ? []
            : methods[0].Method.Parameters.Skip(1).Select(parameter => frontend.ParameterType(parameter, Substitution.Empty)).ToArray();
        var arguments = new int[parameters.Length];
        for (int index = parameters.Length - 1; index >= 0; index--)
        {
            arguments[index] = Save(parameters[index]);
        }

        code.Byte(0x1a); // drop: the receiver is in its local
        // What the member returns, whatever the element type.
        var result = frontend.MapType(frontend.ObjectArrayMethod(helper, frontend.ObjectSymbol).ReturnType);

        void Arrays(int next)
        {
            if (next == methods.Count)
            {
                if (helper == "ObjectGetEnumerator" && frontend.StringUsed)
                {
                    LocalGet(receiver);
                    code.RefCast(Text);
                    Call(frontend.MethodIndex(frontend.RuntimeMethod("Enumerables", "OfString", 1)));
                    return;
                }

                code.Byte(0x00); // unreachable: nothing else is one
                return;
            }

            var arrayType = Map(methods[next].Array);
            LocalGet(receiver);
            code.RefTest(WType.NonNullRef(frontend.ArrayAllocationHeap(methods[next].Array)));
            EmitChoice(result, () =>
            {
                LocalGet(receiver);
                code.RefCast(arrayType);
                foreach (int argument in arguments)
                {
                    LocalGet(argument);
                }

                Call(frontend.MethodIndex(methods[next].Method));
            }, () => Arrays(next + 1));
        }

        LocalGet(receiver);
        code.RefTest(WType.NonNullRef(frontend.ObjectHeap));
        EmitChoice(result, () =>
        {
            LocalGet(receiver);
            code.RefCast(WType.NonNullRef(frontend.ObjectHeap));
            int self = Save(WType.Ref(frontend.ObjectHeap));
            LocalGet(self);
            foreach (int argument in arguments)
            {
                LocalGet(argument);
            }

            EmitCallTarget(target with { ObjectArrayCall = null }, self);
        }, () => Arrays(0));
    }

    // Whether a reference in a local, tested for an IEnumerable<T> already,
    // is also one as an array (or string) of its elements.
    private void EmitEnumerableSourceTest(int value, ITypeSymbol enumerable)
    {
        if (Frontend.IsObjectArrayInterface(enumerable))
        {
            // Any array; a string only as an IEnumerable.
            foreach (var array in frontend.ArrayTypes())
            {
                LocalGet(value);
                code.RefTest(WType.NonNullRef(frontend.ArrayAllocationHeap(array)));
                code.Byte(0x72); // i32.or
            }

            if (enumerable.Name == "IEnumerable" && frontend.StringUsed)
            {
                LocalGet(value);
                code.RefTest(WType.NonNullRef(frontend.StringHeap));
                code.Byte(0x72); // i32.or
            }

            return;
        }

        var element = ((INamedTypeSymbol)enumerable).TypeArguments[0];
        foreach (var array in frontend.ArraysConvertingTo(element))
        {
            LocalGet(value);
            code.RefTest(WType.NonNullRef(frontend.ArrayAllocationHeap(array)));
            code.Byte(0x72); // i32.or
        }
        if (element.SpecialType == SpecialType.System_Char && frontend.StringUsed && Frontend.IsEnumerableInterface(enumerable))
        {
            LocalGet(value);
            code.RefTest(WType.NonNullRef(frontend.StringHeap));
            code.Byte(0x72); // i32.or
        }
    }
}
