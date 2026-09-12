// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The CIL importer's calls, object creation and delegates (see
// FunctionEmitter.Il): the module's own methods, and the framework members
// the compiler lowers itself (strings, object members, scalars' members,
// intrinsics, shims, exceptions, delegates), their arguments already in
// locals.
internal sealed partial class FunctionEmitter
{
    // The values a call takes, `this` first, removed from the stack, with
    // their stack types.
    private (List<IlValue> Values, List<IlSlot> Types) PopArguments(int count)
    {
        var values = ilStack.GetRange(ilStack.Count - count, count);
        ilStack.RemoveRange(ilStack.Count - count, count);
        var before = flow.Before[ilIndex];
        var types = before.Skip(before.Length - count).Take(count).ToList();
        return (values, types);
    }

    // An argument for a parameter, in a local of the parameter's Wasm type:
    // a value, or for `ref` and `out` the reference; `in` parameters take
    // the value.
    private int ArgumentLocal(IlValue value, IParameterSymbol parameter)
    {
        if (Frontend.IsReferenceParameter(parameter))
        {
            return GetLocal(value, frontend.RefParameterType(parameter.Type));
        }

        var type = frontend.MapType(parameter.Type);
        if (parameter.RefKind != RefKind.None && value is IlRefValue or IlLocalValue { Type.Kind: IlKind.ByRef })
        {
            LoadAs(PlaceOf(value), type);
            return Save(type);
        }

        return GetLocal(value, type);
    }

    private int[] ArgumentLocals(IMethodSymbol method, List<IlValue> values, int first) =>
        [.. method.Parameters.Select((parameter, index) => ArgumentLocal(values[first + index], parameter))];

    // The value a scalar or struct receiver holds: through the reference IL
    // passes, or the value itself.
    private int ReceiverValue(IlValue receiver, ITypeSymbol type)
    {
        var mapped = frontend.MapType(type);
        if (receiver is IlRefValue or IlLocalValue { Type.Kind: IlKind.ByRef })
        {
            LoadAs(PlaceOf(receiver), mapped);
            return Save(mapped);
        }

        return GetLocal(receiver, mapped);
    }

    // Leaves a call's result where the IL stack has it.
    private void FinishCall(WType produced)
    {
        if (flow.After[ilIndex] is not { } after || after.Length <= ilStack.Count
            || flow.Instructions[ilIndex].OpCode is not (ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj))
        {
            if (produced != WType.Void)
            {
                Drop(produced);
            }

            return;
        }

        var result = after[^1];
        if (result.Kind == IlKind.Null)
        {
            Drop(produced);
            ilStack.Add(new IlNullValue());
            return;
        }

        Coerce(produced, IlWType(result));
        PushResult(result);
    }

    private void EmitIlCall(int index)
    {
        var instruction = flow.Instructions[index];
        if (flow.Operands[index] is IlArrayMethod accessor)
        {
            EmitMdArrayMethod(accessor);
            return;
        }

        if (flow.Operands[index] is IlExactTypeTest exact)
        {
            EmitExactTypeTest(exact);
            return;
        }

        var method = (IMethodSymbol)flow.Operands[index]!;
        CheckUserCall(method);
        var constrained = flow.Constrained[index];
        if (constrained is null && frontend.AutoGetterField(method) is { } backing)
        {
            // An auto-property's getter: its field, read in place.
            LoadIlField(backing);
            return;
        }

        int count = method.Parameters.Length + (method.IsStatic ? 0 : 1);
        var (values, types) = PopArguments(count);
        if (constrained is not null)
        {
            EmitConstrainedCall(method, constrained, values, types);
            return;
        }

        if (method.MethodKind == MethodKind.Constructor && Frontend.IsStruct(method.ContainingType)
            && frontend.InlinedConstruction(method) is { } inline && values[0] is IlRefValue or IlLocalValue { Type.Kind: IlKind.ByRef })
        {
            // A struct constructed into a variable, made in place
            // (Frontend.Construction) and stored whole.
            var place = PlaceOf(values[0]);
            var made = frontend.StructOf(frontend.MapType(method.ContainingType));
            PushConstruction(method, inline, made, values.GetRange(1, values.Count - 1));
            Store(place, Save(made.Type));
            return;
        }

        EmitIlCallCore(method, values, types, instruction.OpCode == ILOpCode.Callvirt);
    }

    // `x.GetType() == typeof(X)`: GetType's null check, then whether x's
    // heap type is X's own and none of its subclasses' (a closed world).
    private void EmitExactTypeTest(IlExactTypeTest exact)
    {
        var value = ilStack[^1];
        ilStack.RemoveAt(ilStack.Count - 1);
        var slot = flow.Before[ilIndex][^1];
        int local = GetLocal(value, IlWType(slot));
        CheckNull(local);
        var heaps = frontend.ExactHeaps(exact.Type);
        if (frontend.TryLayout(exact.Type, out var shared) && frontend.SharesHeap(shared))
        {
            // Its own class id (Frontend.Sharing).
            EmitClassIdTest(local, shared, exact: true);
        }
        else if (heaps is null)
        {
            code.I32(0);
        }
        else
        {
            LocalGet(local);
            code.RefTest(WType.NonNullRef(heaps.Value.Own));
            foreach (int derived in heaps.Value.Derived)
            {
                LocalGet(local);
                code.RefTest(WType.NonNullRef(derived));
                code.Byte(0x45); // i32.eqz
                code.Byte(0x71); // i32.and
            }
        }

        if (exact.Negated)
        {
            code.Byte(0x45); // i32.eqz
        }

        FinishCall(WType.I32);
    }

    // The policy on the user's own calls that the CoreLib's and the
    // framework's may make: none orders by a default order its type does
    // not have (strings' is the culture's on the CLR).
    private void CheckUserCall(IMethodSymbol method)
    {
        if (plan.Symbol is { } caller && (Frontend.InCoreLibrary(caller) || Frontend.InFramework(caller)))
        {
            return;
        }

        if (frontend.DefaultOrderingError(method, plan.Generic) is { } error)
        {
            throw IlError(error);
        }
    }

    // `constrained. T` on a call through `this` of type T&.
    private void EmitConstrainedCall(IMethodSymbol method, ITypeSymbol constrained, List<IlValue> values, List<IlSlot> types)
    {
        if (method.IsStatic)
        {
            // A static abstract or virtual interface member: T's.
            var implementation = frontend.StaticImplementation(constrained, method);
            EmitIlCallCore(implementation, values, types, virtualCall: false);
            return;
        }

        if (Frontend.VectorLane(constrained) is not null)
        {
            // A Vector128's own member, on the reference (FunctionEmitter.Simd).
            EmitIlCallCore(Frontend.VectorMember(constrained, method) ?? method, values, types, virtualCall: false);
            return;
        }

        if (constrained.IsReferenceType)
        {
            // The reference the receiver points to, then a virtual call.
            LoadAs(PlaceOf(values[0]), frontend.MapType(constrained));
            var type = new IlSlot(IlKind.Ref, constrained);
            values[0] = new IlLocalValue(type, Save(frontend.MapType(constrained)));
            types[0] = type;
            EmitIlCallCore(method, values, types, virtualCall: true);
            return;
        }

        var definition = method.IsGenericMethod ? method.ConstructedFrom : method;
        var implemented = method.ContainingType.TypeKind == TypeKind.Interface
            ? constrained.FindImplementationForInterfaceMember(definition) as IMethodSymbol
            : constrained is INamedTypeSymbol named && Frontend.IsModuleDefined(named)
                ? Frontend.ObjectOverride(named, method)
                : null;
        if (implemented is not null && method.IsGenericMethod)
        {
            implemented = implemented.Construct([.. method.TypeArguments]);
        }

        if (implemented is not null && Frontend.IsModuleDefined(implemented))
        {
            // The value type's own member, on the reference.
            EmitIlCallCore(implemented, values, types, virtualCall: false);
            return;
        }

        if (Frontend.ScalarOf(constrained) is not null)
        {
            // A scalar's member, on its value.
            int value = ReceiverValue(values[0], constrained);
            var scalarType = flow.SlotOf(constrained);
            values[0] = new IlLocalValue(scalarType, value);
            types[0] = scalarType;
            EmitIlCallCore(implemented ?? method, values, types, virtualCall: false);
            return;
        }

        if (Frontend.IsObjectMember(method))
        {
            // ValueType's members run on a box of the value.
            int value = ReceiverValue(values[0], constrained);
            LocalGet(value);
            EmitBox(constrained);
            var boxed = new IlSlot(IlKind.Ref, frontend.ObjectSymbol);
            values[0] = new IlLocalValue(boxed, Save(ObjectRef));
            types[0] = boxed;
            EmitIlCallCore(method, values, types, virtualCall: true);
            return;
        }

        throw IlError($"'{constrained.ToDisplayString()}' does not implement '{method.ToDisplayString()}' here.");
    }

    private void EmitIlCallCore(IMethodSymbol method, List<IlValue> values, List<IlSlot> types, bool virtualCall)
    {
        int first = method.IsStatic ? 0 : 1;
        if (Frontend.IsRecordNullComparison(method, types))
        {
            var other = values[0] is IlNullValue ? values[1] : values[0];
            if (other is IlNullValue)
            {
                code.I32(method.Name == "op_Equality" ? 1 : 0);
            }
            else
            {
                Get(other, ObjectRef);
                code.Byte(0xd1); // ref.is_null
                if (method.Name == "op_Inequality")
                {
                    code.Byte(0x45); // i32.eqz
                }
            }

            FinishCall(WType.I32);
            return;
        }

        if (EmitIlSimdCall(method, values, types) || EmitIlSpecialCall(method, values, types))
        {
            return;
        }

        if (frontend.IntrinsicOf(method) is { } intrinsic)
        {
            int[] arguments = ArgumentLocals(method, values, first);
            FinishCall(EmitIlIntrinsic(intrinsic, method, arguments));
            return;
        }

        if (method.MethodKind == MethodKind.DelegateInvoke && Frontend.IsSupportedDelegate(method.ContainingType))
        {
            int target = GetLocal(values[0], frontend.MapType(method.ContainingType));
            int[] arguments = ArgumentLocals(method, values, 1);
            CheckNull(target);
            LocalGet(target);
            PushArguments(arguments);
            EmitCallTarget(frontend.ResolveCall(method, method.ContainingType, false, generic), target);
            FinishCall(frontend.DelegateOf(method.ContainingType).Invoke.Result);
            return;
        }

        if (method.ContainingType.SpecialType == SpecialType.System_String && EmitIlStringCall(method, values, types))
        {
            return;
        }

        if (!virtualCall && !method.IsStatic && types[0].Kind == IlKind.Ref && Frontend.IsObjectMember(method)
            && method.ContainingType.SpecialType == SpecialType.System_Object)
        {
            // A base call of object's own (`base.GetHashCode()`): identity;
            // ToString's runtime type name is not kept.
            if (method.Name == "ToString")
            {
                throw IlError("base.ToString() of System.Object is unsupported: the runtime type's name is not kept.");
            }

            var selfType = frontend.MapType(types[0].Type!);
            int self = GetLocal(values[0], selfType);
            if (method.Name == "GetHashCode")
            {
                EmitIdentityHash(selfType, self);
            }
            else
            {
                LocalGet(self);
                Get(values[1], ObjectRef);
                code.Byte(0xd3); // ref.eq
            }

            FinishCall(WType.I32);
            return;
        }

        if (Frontend.IsObjectMember(method) || Frontend.IsGetType(method))
        {
            EmitIlObjectMember(method, values, types);
            return;
        }

        if (frontend.ShimOf(method) is { } shim)
        {
            int receiver = method.IsStatic ? -1 : ReceiverValue(values[0], method.ContainingType);
            int[] arguments = ArgumentLocals(method, values, first);
            if (receiver >= 0)
            {
                LocalGet(receiver);
            }

            // A shim's parameters are the framework member's (a params
            // span may be an array).
            for (int index = 0; index < arguments.Length; index++)
            {
                var wanted = frontend.ParameterType(shim.Parameters[index + (receiver >= 0 ? 1 : 0)], Substitution.Empty);
                var given = IlLocalType(arguments[index]);
                if (given.IsTuple && !wanted.IsTuple && Frontend.IsFrameworkSpan((INamedTypeSymbol)method.Parameters[index].Type))
                {
                    // A params span, as the shim's array: its elements.
                    var span = (INamedTypeSymbol)frontend.Substitute(Substitution.Empty, method.Parameters[index].Type);
                    var layout = frontend.StructOf(given);
                    EmitNewBox(given);
                    int box = Save(WType.Ref(layout.Box));
                    WriteBox(box, layout, arguments[index]);
                    LocalGet(box);
                    Call(frontend.BoxMethodIndex(Frontend.SpanToArray(span)));
                    continue;
                }

                LocalGet(arguments[index]);
                Coerce(given, wanted);
            }

            Call(frontend.MethodIndex(shim));
            FinishCall(frontend.PlanOfFunction(frontend.MethodIndex(shim)).Result);
            return;
        }

        if (!method.IsStatic && Frontend.ScalarOf(method.ContainingType) is not null && method.Name == "ToString"
            && method.Parameters.Length == 0)
        {
            LocalGet(ReceiverValue(values[0], method.ContainingType));
            FormatScalar(method.ContainingType);
            FinishCall(Text);
            return;
        }

        if (frontend.IsFrameworkException(method.ContainingType) && method.AssociatedSymbol is IPropertySymbol property
            && frontend.ExceptionPropertyField(property) is int exceptionField)
        {
            int exception = GetLocal(values[0], frontend.MapType(method.ContainingType));
            CheckNull(exception);
            LocalGet(exception);
            code.Gc(2, frontend.MapType(method.ContainingType).Heap, exceptionField); // struct.get
            FinishCall(frontend.MapType(property.Type));
            return;
        }

        if (!Frontend.IsModuleDefined(method) && !Frontend.IsAdoptedInterface(method.ContainingType))
        {
            throw IlError(Frontend.UnsupportedCall(method));
        }

        EmitModuleCall(method, values, types, virtualCall);
    }

    // A call of one of the module's methods.
    private void EmitModuleCall(IMethodSymbol method, List<IlValue> values, List<IlSlot> types, bool virtualCall)
    {
        if (method.IsStatic)
        {
            int[] arguments = ArgumentLocals(method, values, 0);
            PushArguments(arguments);
            var staticTarget = frontend.ResolveCall(method, null, false, generic);
            EmitCallTarget(staticTarget, -1);
            if (frontend.IsImport(method) && !method.ReturnsVoid)
            {
                Canonicalize(code, Frontend.ScalarOf(method.ReturnType)!.Value);
            }

            FinishCall(frontend.IsImport(method) ? frontend.MapType(method.ReturnType) : frontend.PlanOfFunction(staticTarget.Function).Result);
            return;
        }

        if (Frontend.IsStruct(method.ContainingType))
        {
            // `this` is the struct's box: the storage's own, or a copy
            // that a flattened place takes back.
            var place = PlaceOf(values[0]);
            int[] arguments = ArgumentLocals(method, values, 1);
            var layout = frontend.StructOf(method.ContainingType);
            if (place.Boxed)
            {
                LocalGet(Materialize(new IlRefValue(types[0], place, null)));
                PushArguments(arguments);
                Call(frontend.BoxMethodIndex(method));
                FinishCall(frontend.PlanOfFunction(frontend.BoxMethodIndex(method)).Result);
                return;
            }

            EmitNewBox(layout.Type);
            int box = Save(WType.Ref(layout.Box));
            Load(place);
            WriteBox(box, layout, Save(layout.Type));
            LocalGet(box);
            PushArguments(arguments);
            Call(frontend.BoxMethodIndex(method));
            var result = frontend.PlanOfFunction(frontend.BoxMethodIndex(method)).Result;
            int saved = result == WType.Void ? -1 : Save(result);
            if (!place.ReadOnly && !Frontend.IsReadOnlyMember(method))
            {
                ReadBox(box, layout);
                Store(place, Save(layout.Type));
            }

            if (saved >= 0)
            {
                LocalGet(saved);
            }

            FinishCall(result);
            return;
        }

        // A class or interface: a virtual call finds the function in the
        // receiver's vtable or itable.
        var receiverType = types[0].Type is INamedTypeSymbol staticType
                           && (method.ContainingType.TypeKind == TypeKind.Interface
                               ? staticType.TypeKind == TypeKind.Interface || staticType.AllInterfaces.Contains(method.ContainingType, SymbolEqualityComparer.Default)
                               : DerivesFromClass(staticType, method.ContainingType))
            ? staticType
            : method.ContainingType;
        CallTarget target;
        WType receiverWType;
        if (virtualCall || method.IsAbstract)
        {
            target = frontend.ResolveCall(method, receiverType, false, generic);
            receiverWType = target.IsVirtual
                ? target.Interface >= 0 || target.EnumerableElement is not null
                    ? WType.Ref(frontend.ObjectHeap)
                    : frontend.MapType(receiverType)
                : frontend.PlanOfFunction(target.Function).Parameters[0];
        }
        else
        {
            target = new(frontend.MethodIndex(method, generic));
            receiverWType = frontend.PlanOfFunction(target.Function).Parameters[0];
        }

        if (target.EnumerableElement is not null || target.ArrayCall is not null || target.ObjectArrayCall is not null)
        {
            // An object or an array.
            receiverWType = WType.Ref(Frontend.EqHeap);
        }

        int self = GetLocal(values[0], receiverWType);
        int[] argumentLocals = ArgumentLocals(method, values, 1);
        if (virtualCall)
        {
            CheckNull(self);
        }

        LocalGet(self);
        if (target.IsVirtual && target.Interface < 0 && target.EnumerableElement is null)
        {
            Coerce(receiverWType, frontend.MapType(Frontend.SlotRootOf(method).ContainingType));
        }

        PushArguments(argumentLocals);
        EmitCallTarget(target, self);
        // What the function returns: a shared instantiation's is its
        // canonical form's (Frontend.Sharing).
        var produced = frontend.Sharing
            ? TargetShape(target, method).Result
            : target.IsVirtual && target.Interface >= 0
                ? frontend.MapType(method.ReturnType)
                : target.IsVirtual
                    ? frontend.MapType(Frontend.SlotRootOf(method).ReturnType)
                    : frontend.PlanOfFunction(target.Function).Result;
        if (method.ReturnsByRef || method.ReturnsByRefReadonly)
        {
            produced = frontend.RefParameterType(method.ReturnType);
        }

        FinishCall(produced);
    }

    private static bool DerivesFromClass(INamedTypeSymbol type, INamedTypeSymbol baseType)
    {
        for (INamedTypeSymbol? current = type; current is not null; current = current.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(current, baseType))
            {
                return true;
            }
        }

        return false;
    }

    // The intrinsics, their arguments in locals.
    private WType EmitIlIntrinsic(Intrinsic intrinsic, IMethodSymbol method, int[] arguments) => intrinsic switch
    {
        Intrinsic.Equal or Intrinsic.Hash => EmitRuntimeIntrinsic(intrinsic, method, arguments),
        Intrinsic.LessThan or Intrinsic.GreaterThan or Intrinsic.IsNaNOf or Intrinsic.Compare =>
            EmitOrderingIntrinsic(intrinsic, method, arguments),
        Intrinsic.SortsByComparer => EmitConstant(frontend.SortsByComparer(Sub(method.TypeArguments[0])) ? 1 : 0),
        Intrinsic.EnumNames or Intrinsic.EnumValues or Intrinsic.EnumFromBits or Intrinsic.EnumToBits
            or Intrinsic.EnumKind => EmitEnumIntrinsic(intrinsic, method, arguments),
        Intrinsic.StringAllocate or Intrinsic.StringSet or Intrinsic.StringSame => EmitStringIntrinsic(intrinsic, arguments),
        Intrinsic.Memory => EmitMemoryIntrinsic(method, arguments),
        Intrinsic.Trap => EmitTrapIntrinsic(arguments[0]),
        Intrinsic.CallDepth => EmitCallDepthIntrinsic(),
        Intrinsic.CallDepthLimit => EmitConstant(frontend.Limits.CallDepth),
        Intrinsic.FlowsExecutionContext or Intrinsic.HasTaskSchedulers => EmitConstant(frontend.FoldedCall(method)!.Value),
        _ => EmitMathIntrinsic(intrinsic, method, arguments),
    };

    private WType EmitConstant(int value)
    {
        code.I32(value);
        return WType.I32;
    }

    private WType EmitCallDepthIntrinsic()
    {
        GlobalGet(ModuleWriter.CallDepthGlobal);
        return WType.I32;
    }

    private WType EmitTrapIntrinsic(int fault)
    {
        LocalGet(fault);
        GlobalSet(ModuleWriter.FaultGlobal);
        code.Byte(0x00); // unreachable
        return WType.Void;
    }

    // Framework members the IL of C#'s lowering calls, which have no
    // counterpart of their own: true when lowered.
    private bool EmitIlSpecialCall(IMethodSymbol method, List<IlValue> values, List<IlSlot> types)
    {
        if (frontend.ArrayRedirect(method, types) is { } redirect)
        {
            EmitModuleCall(redirect, values, types, false);
            return true;
        }

        string type = method.ContainingType.ToDisplayString();
        if (type == "System.Runtime.CompilerServices.Unsafe" && method.TypeArguments is [var from, var to]
            && EmitUnsafeReinterpretation(method, from, to, values))
        {
            return true;
        }

        if (type == "System.Runtime.CompilerServices.Unsafe" && method.TypeArguments is [var referenced])
        {
            switch (method.Name)
            {
                case "AsRef" when method.Parameters is [{ RefKind: not RefKind.None }]:
                    // The same reference, writable.
                    ilStack.Add(values[0]);
                    return true;
                case "SkipInit":
                    // Every local starts out zero here.
                    return true;
                case "Add" when method.Parameters is [{ RefKind: RefKind.Ref }, { Type.SpecialType: SpecialType.System_Int32 }]
                                && !frontend.MapType(referenced).IsTuple:
                    EmitUnsafeAdd(referenced, values);
                    return true;
                case "NullRef":
                    // A null reference (see Frontend.References): no box or
                    // cell.
                    var reference = frontend.RefParameterType(referenced);
                    code.Byte(0xd0); // ref.null
                    code.Signed(reference.Heap);
                    FinishCall(reference);
                    return true;
                case "IsNullRef":
                    Get(values[0], frontend.RefParameterType(referenced));
                    code.Byte(0xd1); // ref.is_null
                    FinishCall(WType.I32);
                    return true;
                case "As" when method.Parameters is [{ RefKind: RefKind.None, Type.SpecialType: SpecialType.System_Object }]:
                    // A reference the code has already tested: a cast.
                    ilStack.AddRange(values);
                    EmitIlCast(referenced, isinst: false);
                    return true;
            }
        }

        if (method.MethodKind == MethodKind.Constructor && !Frontend.IsModuleDefined(method))
        {
            // A constructor's base constructor call: object's does nothing;
            // a BCL exception's stores its message.
            if (method.ContainingType.SpecialType == SpecialType.System_Object)
            {
                return true;
            }

            if (frontend.IsFrameworkException(method.ContainingType))
            {
                int self = GetLocal(values[0], frontend.MapType(method.ContainingType));
                EmitExceptionConstructor(self, method, ArgumentLocals(method, values, 1));
                return true;
            }
        }

        if (Frontend.IsInterpolationHandler(method.ContainingType))
        {
            EmitInterpolationHandlerCall(method, values);
            return true;
        }

        if (method is { ContainingType.SpecialType: SpecialType.System_Enum, IsStatic: false })
        {
            return EmitIlEnumCall(method, values);
        }

        if (method is { ContainingType.SpecialType: SpecialType.System_Array, IsStatic: false }
            && types[0].Type is INamedTypeSymbol mdArray && Frontend.IsMdArrayClass(mdArray))
        {
            // System.Array's members on a multidimensional array: MdArray's.
            var member = frontend.MdArrayMember(mdArray, method);
            var target = member is IPropertySymbol property ? property.GetMethod! : (IMethodSymbol)member;
            int receiver = GetLocal(values[0], frontend.MapType(mdArray));
            int[] memberArguments = ArgumentLocals(target, values, 1);
            CheckNull(receiver);
            LocalGet(receiver);
            PushArguments(memberArguments);
            var mdTarget = frontend.ResolveCall(target, mdArray, false, generic);
            EmitCallTarget(mdTarget, receiver);
            FinishCall(frontend.Sharing ? TargetShape(mdTarget, target).Result : frontend.MapType(target.ReturnType));
            return true;
        }

        if (method.ContainingType.Name == "<PrivateImplementationDetails>" && method.Name.StartsWith("InlineArray", StringComparison.Ordinal))
        {
            EmitInlineArrayHelper(method, values);
            return true;
        }

        if ((method is { Name: "GetPinnableReference", Parameters.Length: 0 }
             || (method.Name == "get_Item" && values.Count == 2 && ConstantOf(values[1]) == 0))
            && method.ContainingType.MetadataName is "ReadOnlySpan`1" or "Span`1"
            && values[0] is IlRefValue { Place: { Kind: LocationKind.Local } pinned }
            && Array.IndexOf(ilLocals, pinned.Local) is int pinnedLocal and >= 0
            && ilLocalData.TryGetValue(pinnedLocal, out var pinnedData))
        {
            // A reference to constant data, which only a stackalloc
            // initializer's cpblk copies.
            ilStack.Add(new IlDataValue(pinnedData));
            return true;
        }

        if (method is { Name: "op_Implicit", ContainingType.SpecialType: SpecialType.System_String })
        {
            // A string as a span of its chars: AsSpan's.
            var asSpan = frontend.StringAsSpan();
            PushArguments(ArgumentLocals(asSpan, values, 0));
            Call(frontend.MethodIndex(asSpan));
            FinishCall(frontend.MapType(asSpan.ReturnType));
            return true;
        }

        switch (type, method.Name)
        {
            case ("System.Activator", "CreateInstance") when method.IsGenericMethod && method.Parameters.Length == 0:
                // `new T()`: its parameterless constructor, or its zero.
                var created = method.TypeArguments[0];
                var createdType = frontend.MapType(created);
                var parameterless = Frontend.DefaultConstructor(created);
                if (Frontend.LacksPublicParameterless(created))
                {
                    var missing = frontend.MissingMethodException;
                    int thrown = Save(EmitAllocation(missing, Frontend.DefaultConstructor(missing)!, []));
                    ThrowLocal(thrown);
                    PushDefault(createdType);
                    FinishCall(createdType);
                }
                else if (createdType.IsRef)
                {
                    FinishCall(EmitAllocation(created, parameterless!, []));
                }
                else if (createdType.IsTuple && parameterless is { MetadataToken: not 0 })
                {
                    var createdLayout = frontend.StructOf(created);
                    EmitNewBox(createdLayout.Type);
                    int box = Save(WType.Ref(createdLayout.Box));
                    LocalGet(box);
                    Call(frontend.BoxMethodIndex(parameterless));
                    ReadBox(box, createdLayout);
                    FinishCall(createdLayout.Type);
                }
                else
                {
                    PushDefault(createdType);
                    FinishCall(createdType);
                }

                return true;
            case ("System.Runtime.CompilerServices.RuntimeHelpers", "EnsureSufficientExecutionStack"):
                return true;
            case ("System.Runtime.CompilerServices.RuntimeHelpers", "CreateSpan"):
                // A span of constant data (`ReadOnlySpan<int> s = [1, 2]`):
                // over a new array of it.
                var dataElement = method.TypeArguments[0];
                var bytes = FieldBytes((IFieldSymbol)((IlTokenValue)values[0]).Symbol);
                int elementWidth = Frontend.ScalarOf(dataElement) switch
                {
                    Scalar.Bool or Scalar.I8 or Scalar.U8 => 1,
                    Scalar.I16 or Scalar.U16 or Scalar.Char => 2,
                    Scalar.I32 or Scalar.U32 or Scalar.F32 => 4,
                    _ => 8,
                };
                code.I32(bytes.Length / elementWidth);
                int dataCount = Save(WType.I32);
                int dataArray = Save(EmitNewArray(frontend.ArrayOf(dataElement), dataCount));
                var dataBlock = new IlStackBlock { Data = bytes };
                EmitStackInitializer(dataBlock, dataElement, dataArray);
                var dataSpan = (INamedTypeSymbol)frontend.Substitute(Substitution.Empty, method.ReturnType);
                var dataSpanType = frontend.MapType(dataSpan);
                var dataLayout = frontend.StructOf(dataSpanType);
                EmitNewBox(dataSpanType);
                int dataBox = Save(WType.Ref(dataLayout.Box));
                LocalGet(dataBox);
                LocalGet(dataArray);
                code.I32(0);
                LocalGet(dataCount);
                Call(frontend.BoxMethodIndex(SpanConstructor(dataSpan)));
                ReadBox(dataBox, dataLayout);
                FinishCall(dataSpanType);
                ilStack[^1] = ((IlLocalValue)ilStack[^1]) with { Constant = bytes };
                return true;
            case ("System.Environment", "get_CurrentManagedThreadId"):
                // One thread (what iterators' state machines ask).
                code.I32(1);
                FinishCall(WType.I32);
                return true;
            case ("System.Runtime.CompilerServices.RuntimeHelpers", "GetSubArray"):
                // `array[range]`: the runtime's slice.
                var subArray = frontend.RuntimeMethod("Ranges", "SubArray", 2).Construct(method.TypeArguments[0]);
                PushArguments(ArgumentLocals(subArray, values, 0));
                Call(frontend.MethodIndex(subArray));
                FinishCall(frontend.MapType(subArray.ReturnType));
                return true;
            case ("System.Runtime.CompilerServices.RuntimeHelpers", "InitializeArray"):
                EmitInitializeArray(values[0], types[0], (IFieldSymbol)((IlTokenValue)values[1]).Symbol);
                return true;
            case ("System.Type", "GetTypeFromHandle") or ("Gameplay.Runtime.Type", "GetTypeFromHandle"):
                var typeToken = (ITypeSymbol)((IlTokenValue)values[0]).Symbol;
                Call(frontend.TypeObject(typeToken));
                FinishCall(frontend.MapType(method.ReturnType));
                return true;
            case ("System.Delegate", "Combine" or "Remove") when method.Parameters.Length == 2:
                var delegateType = types[0].Kind == IlKind.Ref ? types[0].Type! : types[1].Type!;
                var layout = frontend.DelegateOf(delegateType);
                var mapped = frontend.MapType(delegateType);
                Get(values[0], mapped);
                Get(values[1], mapped);
                Call(method.Name == "Combine" ? layout.Combine : layout.Remove);
                FinishCall(WType.Ref(layout.Heap));
                return true;
            case ("<PrivateImplementationDetails>", "ThrowSwitchExpressionException" or "ThrowInvalidOperationException"):
                Fault(method.Name == "ThrowSwitchExpressionException" ? FaultCode.UnmatchedSwitch : FaultCode.InvalidOperation);
                return true;
        }

        if (method.ContainingType.SpecialType == SpecialType.System_Delegate
            || method.ContainingType.SpecialType == SpecialType.System_MulticastDelegate)
        {
            if (method.Name is "op_Equality" or "op_Inequality")
            {
                var delegateType = types[0].Kind == IlKind.Ref ? types[0].Type! : types[1].Type!;
                var layout = frontend.DelegateOf(delegateType);
                var mapped = frontend.MapType(delegateType);
                Get(values[0], mapped);
                Get(values[1], mapped);
                Call(layout.Equal);
                if (method.Name == "op_Inequality")
                {
                    code.Byte(0x45); // i32.eqz
                }

                FinishCall(WType.I32);
                return true;
            }
        }

        return false;
    }

    // Unsafe.Add of a reference and an element count: a reference to an
    // array element is a handle naming the array and the index (see
    // Frontend.References), which moves; any reference moved by nothing is
    // itself. Other references (a variable's cell, a field) have no
    // neighbours here: moving one faults with Unsupported. A reference to a
    // struct is its box, which knows no array, so the call is refused.
    private void EmitUnsafeAdd(ITypeSymbol referenced, List<IlValue> values)
    {
        var referenceType = frontend.RefParameterType(referenced);
        int handle = frontend.HandleHeap(frontend.MapType(referenced));
        int reference = GetLocal(values[0], referenceType);
        int offset = GetLocal(values[1], WType.I32);
        LocalGet(offset);
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, referenceType, new object());
        LocalGet(reference);
        code.Byte(0x05); // else
        LocalGet(reference);
        code.RefTest(WType.NonNullRef(handle));
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        Fault(FaultCode.Unsupported);
        CloseBlock();
        LocalGet(reference);
        code.RefCast(WType.NonNullRef(handle));
        int element = Save(WType.Ref(handle));
        LocalGet(element);
        code.Gc(2, handle, 1); // struct.get: the index, negative for a field
        code.I32(0);
        code.Byte(0x48); // i32.lt_s
        OpenBlock(0x04, WType.Void, new object());
        Fault(FaultCode.Unsupported);
        CloseBlock();
        LocalGet(element);
        code.Gc(2, handle, 0); // struct.get: the array
        LocalGet(element);
        code.Gc(2, handle, 1); // struct.get
        LocalGet(offset);
        code.Byte(0x6a); // i32.add
        StructNew(handle);
        CloseBlock();
        FinishCall(referenceType);
    }

    // Unsafe.BitCast of a value, and Unsafe.As of a reference, between
    // types whose bits are alike here: structs of the same leaves (a
    // Vector4 and a Plane), a System.Numerics vector and a Vector128<float>
    // (FunctionEmitter.Simd's packing), and references to structs that share
    // one box (a matrix and its Impl, see Frontend.Structs).
    private bool EmitUnsafeReinterpretation(IMethodSymbol method, ITypeSymbol from, ITypeSymbol to, List<IlValue> values)
    {
        if (method.Name == "BitCast")
        {
            var source = frontend.MapType(from);
            var target = frontend.MapType(to);
            int value = GetLocal(values[0], source);
            if (frontend.Leaves(source).AsSpan().SequenceEqual(frontend.Leaves(target)))
            {
                LocalGet(value);
                FinishCall(target);
                return true;
            }

            if (source == WType.V128 && Frontend.NumericsVectorLanes(to) is int unpacked
                && Frontend.VectorLane(from) == Lane.F32)
            {
                for (int index = 0; index < unpacked; index++)
                {
                    LocalGet(value);
                    code.SimdLane(SimdExtract[(int)Lane.F32], index);
                }

                FinishCall(target);
                return true;
            }

            if (target == WType.V128 && Frontend.NumericsVectorLanes(from) is int packed && Frontend.VectorLane(to) == Lane.F32)
            {
                EmitPackVector(value, packed, zeroUpper: true);
                FinishCall(target);
                return true;
            }

            throw IlError($"Unsafe.BitCast from '{from.ToDisplayString()}' to '{to.ToDisplayString()}' has no representation here.");
        }

        if (method is { Name: "As", Parameters: [{ RefKind: not RefKind.None }] })
        {
            var source = frontend.RefParameterType(from);
            var target = frontend.RefParameterType(to);
            if (source != target)
            {
                throw IlError($"Unsafe.As from a reference to '{from.ToDisplayString()}' to one to '{to.ToDisplayString()}' "
                              + "has no representation here.");
            }

            Get(values[0], source);
            FinishCall(target);
            return true;
        }

        return false;
    }

    // The helpers C# reaches a params span's buffer with: an element's
    // reference, and the span over the first elements.
    private void EmitInlineArrayHelper(IMethodSymbol method, List<IlValue> values)
    {
        var element = method.TypeArguments[1];
        var arrayType = frontend.MapType(frontend.ArrayOf(element));
        // The buffer, by its storage: what the items stored in it are.
        int buffer = PlaceOf(values[0]).Local;
        Load(PlaceOf(values[0]));
        int array = Save(arrayType);
        switch (method.Name)
        {
            case "InlineArrayElementRef" or "InlineArrayFirstElementRef":
                int index = method.Name == "InlineArrayFirstElementRef" ? -1 : GetLocal(values[1], WType.I32);
                if (index < 0)
                {
                    code.I32(0);
                    index = Save(WType.I32);
                }

                CheckArray(array, index);
                var elementType = frontend.MapType(element);
                var location = new Location(
                    LocationKind.ArrayElement, elementType, element, Receiver: array, Index: index, Container: arrayType,
                    Boxed: elementType.IsTuple, NonNull: true);
                var reference = new IlRefValue(new IlSlot(IlKind.ByRef, element), location, null);
                if (location.Boxed)
                {
                    LocalGet(Materialize(reference));
                    FinishCall(frontend.RefParameterType(element));
                    return;
                }

                var pinned = reference with { Place = Pinned(reference.Place) };
                if (values.Count > 1 && values[1] is IlLocalValue { Constant: int constantIndex })
                {
                    inlineItemRefs[pinned] = (buffer, constantIndex);
                }
                else if (method.Name == "InlineArrayFirstElementRef")
                {
                    inlineItemRefs[pinned] = (buffer, 0);
                }

                ilStack.Add(pinned);
                return;
            case "InlineArrayAsReadOnlySpan" or "InlineArrayAsSpan":
                var span = (INamedTypeSymbol)method.ReturnType;
                var spanType = frontend.MapType(span);
                var constructor = SpanConstructor(span);
                var layout = frontend.StructOf(spanType);
                int length = GetLocal(values[1], WType.I32);
                code.I32(0);
                int start = Save(WType.I32);
                EmitNewBox(spanType);
                int box = Save(WType.Ref(layout.Box));
                LocalGet(box);
                LocalGet(array);
                LocalGet(start);
                LocalGet(length);
                Call(frontend.BoxMethodIndex(constructor));
                ReadBox(box, layout);
                FinishCall(spanType);
                if (values[1] is IlLocalValue { Constant: int count } && inlineItems.TryGetValue(buffer, out var stored)
                    && Enumerable.Range(0, count).All(stored.ContainsKey))
                {
                    // What each element was before it was boxed, for a
                    // string.Format of a constant format.
                    ilStack[^1] = ((IlLocalValue)ilStack[^1]) with
                    {
                        Constant = new IlSpanItems([.. Enumerable.Range(0, count).Select(position => stored[position])]),
                    };
                }

                return;
            default:
                throw IlError($"'{method.ToDisplayString()}' is unsupported.");
        }
    }

    // The parts of a constant composite format, each item formatted by its
    // value's own type.
    private void EmitComposite(List<CompositePart> parts, IReadOnlyList<(int Local, ITypeSymbol? Type)> items)
    {
        EmitLiteral("");
        foreach (var part in parts)
        {
            if (part.Text is { } piece)
            {
                EmitLiteral(piece);
            }
            else
            {
                EmitFormatItem(items[part.Index].Local, items[part.Index].Type, part.Format, part.Alignment);
            }

            CallString("Concat", 2);
        }
    }

    // The data a field of <PrivateImplementationDetails> holds: its type's
    // size of bytes.
    private byte[] FieldBytes(IFieldSymbol field)
    {
        var module = frontend.IlModuleOf(field)!;
        var reader = module.Reader;
        var fieldType = (INamedTypeSymbol)field.Type;
        int size = fieldType.SpecialType switch
        {
            SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Double => 8,
            SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Single => 4,
            SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Char => 2,
            SpecialType.System_Byte or SpecialType.System_SByte or SpecialType.System_Boolean => 1,
            _ => reader.GetTypeDefinition((TypeDefinitionHandle)MetadataTokens.EntityHandle(fieldType.OriginalDefinition.MetadataToken))
                .GetLayout().Size,
        };
        return module.FieldData(field, size);
    }

    // A stackalloc initializer's elements, stored into the span's array:
    // its constant data, then the elements it stores, by their offsets.
    private void EmitStackInitializer(IlStackBlock block, ITypeSymbol element, int array)
    {
        if (block.Data is null && block.Stores.Count == 0)
        {
            return;
        }

        var scalar = Frontend.ScalarOf(element) ?? throw IlError($"A stackalloc initializer of '{element.ToDisplayString()}' is unsupported.");
        int width = scalar switch
        {
            Scalar.Bool or Scalar.I8 or Scalar.U8 => 1,
            Scalar.I16 or Scalar.U16 or Scalar.Char => 2,
            Scalar.I32 or Scalar.U32 or Scalar.F32 => 4,
            _ => 8,
        };
        var arrayType = frontend.MapType(frontend.ArrayOf(element));
        var elementType = frontend.MapType(element);
        if (block.Data is { } data)
        {
            for (int index = 0; index * width < data.Length; index++)
            {
                var bytes = data.AsSpan(index * width, width);
                LocalGet(array);
                code.I32(index);
                switch (scalar)
                {
                    case Scalar.Bool or Scalar.U8:
                        code.I32(bytes[0]);
                        break;
                    case Scalar.I8:
                        code.I32((sbyte)bytes[0]);
                        break;
                    case Scalar.I16:
                        code.I32(BitConverter.ToInt16(bytes));
                        break;
                    case Scalar.U16 or Scalar.Char:
                        code.I32(BitConverter.ToUInt16(bytes));
                        break;
                    case Scalar.I32 or Scalar.U32:
                        code.I32(BitConverter.ToInt32(bytes));
                        break;
                    case Scalar.I64 or Scalar.U64:
                        code.I64(BitConverter.ToInt64(bytes));
                        break;
                    case Scalar.F32:
                        code.Const(WType.F32, BitConverter.ToSingle(bytes));
                        break;
                    default:
                        code.Const(WType.F64, BitConverter.ToDouble(bytes));
                        break;
                }

                code.Gc(14, arrayType.Heap); // array.set
            }
        }

        foreach (var (offset, local, type) in block.Stores)
        {
            LocalGet(array);
            code.I32(offset / width);
            LocalGet(local);
            Coerce(type, elementType);
            Narrow(scalar);
            code.Gc(14, arrayType.Heap); // array.set
        }
    }

    // A new local holding 0.
    private int Save0()
    {
        code.I32(0);
        return Save(WType.I32);
    }

    // The runtime span's constructor of an array, a start and a length.
    private IMethodSymbol SpanConstructor(INamedTypeSymbol span) =>
        ((INamedTypeSymbol)frontend.Substitute(Substitution.Empty, span)).InstanceConstructors.First(constructor =>
            constructor.Parameters.Length == 3 && constructor.DeclaredAccessibility == Accessibility.Public);

    // A multidimensional array's constructor and element accessors.
    private void EmitMdArrayMethod(IlArrayMethod accessor)
    {
        var mdType = accessor.Type;
        if (accessor.Name == ".ctor")
        {
            var sizes = ilStack.GetRange(ilStack.Count - accessor.Rank, accessor.Rank);
            var sizeTypes = flow.Before[ilIndex].Skip(flow.Before[ilIndex].Length - accessor.Rank).ToList();
            ilStack.RemoveRange(ilStack.Count - accessor.Rank, accessor.Rank);
            var lengths = sizes.Select((size, index) => IlIndex(size, sizeTypes[index])).ToArray();
            var intArray = frontend.MapType(frontend.ArrayOf(frontend.IntType));
            code.I64(16L + 8L * lengths.Length);
            ChargeAllocation();
            foreach (int length in lengths)
            {
                LocalGet(length);
            }

            code.Gc(8, intArray.Heap, lengths.Length); // array.new_fixed
            int lengthsArray = Save(intArray);
            LocalGet(lengthsArray);
            EmitCallTarget(frontend.ResolveCall(frontend.MdArrayNew(mdType), mdType, false, generic), lengthsArray);
            code.RefCast(frontend.MapType(mdType)); // New makes the rank's class
            PushResult();
            return;
        }

        IlValue? value = accessor.Name == "Set" ? Pop() : null;
        var indexValues = ilStack.GetRange(ilStack.Count - accessor.Rank, accessor.Rank);
        var indexTypes = flow.Before[ilIndex].Skip(flow.Before[ilIndex].Length - accessor.Rank - (value is null ? 0 : 1))
            .Take(accessor.Rank)
            .ToList();
        ilStack.RemoveRange(ilStack.Count - accessor.Rank, accessor.Rank);
        int array = GetLocal(Pop(), frontend.MapType(mdType));
        var indices = indexValues.Select((index, position) => IlIndex(index, indexTypes[position])).ToArray();
        var element = accessor.Element;
        var type = frontend.MapType(element);
        var itemsType = frontend.MapType(frontend.ArrayOf(element));
        var location = new Location(
            LocationKind.ArrayElement,
            type,
            element,
            Receiver: NewLocal(itemsType),
            Index: NewLocal(WType.I32),
            Container: itemsType,
            Boxed: type.IsTuple,
            MdArray: array,
            MdIndices: indices,
            MdType: mdType);
        if (value is not null)
        {
            int stored = GetLocal(value, type);
            CheckLocation(location);
            Store(location, stored);
            return;
        }

        CheckLocation(location);
        if (accessor.Name == "Get")
        {
            Load(location);
            PushResult();
            return;
        }

        var reference = new IlRefValue(flow.After[ilIndex]!.Value[^1], location, null);
        if (location.Boxed)
        {
            LocalGet(Materialize(reference));
            PushResult();
            return;
        }

        ilStack.Add(reference with { Place = Pinned(reference.Place) });
    }

    // Enum's members, on a boxed enum value: HasFlag and a formatted
    // ToString; the rest are object members.
    private bool EmitIlEnumCall(IMethodSymbol method, List<IlValue> values)
    {
        if (values[0] is not IlBoxedValue { Type: INamedTypeSymbol { TypeKind: TypeKind.Enum } type } receiver)
        {
            return false;
        }

        switch (method.Name)
        {
            case "HasFlag" when values[1] is IlBoxedValue flag && SymbolEqualityComparer.Default.Equals(flag.Type, type):
                bool wide = frontend.MapType(type) == WType.I64;
                LocalGet(receiver.Value);
                LocalGet(flag.Value);
                code.Byte(wide ? (byte)0x83 : (byte)0x71); // and
                LocalGet(flag.Value);
                code.Byte(wide ? (byte)0x51 : (byte)0x46); // eq
                FinishCall(WType.I32);
                return true;
            case "HasFlag":
                throw IlError("HasFlag takes a flag of the enum's own type.");
            case "ToString" when method.Parameters.Length == 1
                                 && method.Parameters[0].Type.SpecialType == SpecialType.System_String:
                if (values[1] is not (IlNullValue or IlLocalValue { Constant: string }))
                {
                    throw IlError("An enum's format string must be a constant.");
                }

                EmitEnumFormatted(() => LocalGet(receiver.Value), type, (values[1] as IlLocalValue)?.Constant as string);
                FinishCall(Text);
                return true;
            default:
                return false;
        }
    }

    // DefaultInterpolatedStringHandler, whose storage is the string built so
    // far: each part appended as interpolation formats it.
    private void EmitInterpolationHandlerCall(IMethodSymbol method, List<IlValue> values)
    {
        var text = Text;
        var place = PlaceOf(values[0]);
        switch (method.Name)
        {
            case ".ctor":
                EmitLiteral("");
                Store(place, Save(text));
                return;
            case "ToStringAndClear" or "ToString":
                Load(place);
                FinishCall(text);
                return;
            case "AppendLiteral":
                Load(place);
                Get(values[1], text);
                CallString("Concat", 2);
                Store(place, Save(text));
                return;
            case "AppendFormatted":
                var type = frontend.Substitute(Substitution.Empty, method.IsGenericMethod ? method.TypeArguments[0] : method.Parameters[0].Type);
                if (!Frontend.InCoreLibrary(type) && type.TypeKind != TypeKind.Enum
                    && type.AllInterfaces.Any(face => face is { Name: "IFormattable", ContainingNamespace.Name: "System" }))
                {
                    // .NET's handler calls its ToString(format, provider),
                    // which formatting here does not.
                    throw IlError($"Interpolating '{type.ToDisplayString()}', an IFormattable of the module's own, is unsupported.");
                }

                int value = GetLocal(values[1], frontend.MapType(type));
                string? format = null;
                int? alignment = null;
                for (int index = 2; index < values.Count; index++)
                {
                    object? constant = (values[index] as IlLocalValue)?.Constant;
                    switch (method.Parameters[index - 1].Name)
                    {
                        case "format" when constant is string or null && values[index] is IlLocalValue or IlNullValue:
                            format = (string?)constant;
                            break;
                        case "alignment" when constant is int width:
                            alignment = width;
                            break;
                        default:
                            throw IlError($"An interpolation hole's {method.Parameters[index - 1].Name} must be a constant.");
                    }
                }

                Load(place);
                EmitFormatItem(value, type, format, alignment);
                CallString("Concat", 2);
                Store(place, Save(text));
                return;
            default:
                throw IlError($"'{method.ToDisplayString()}' is unsupported.");
        }
    }

    // `RuntimeHelpers.InitializeArray(array, field)`: the elements the
    // field's data spells, stored one by one.
    private void EmitInitializeArray(IlValue array, IlSlot arrayType, IFieldSymbol field)
    {
        IArrayTypeSymbol symbol;
        int local;
        if (arrayType.Type is INamedTypeSymbol mdArray && Frontend.IsMdArrayClass(mdArray))
        {
            // A multidimensional array's elements are its flat array's.
            symbol = frontend.ArrayOf(mdArray.TypeArguments[0]);
            int md = GetLocal(array, frontend.MapType(mdArray));
            LocalGet(md);
            code.Gc(2, frontend.MapType(mdArray).Heap, frontend.FieldIndex(frontend.MdArrayField(mdArray, "items"))); // struct.get
            local = Save(frontend.MapType(symbol));
        }
        else
        {
            symbol = (IArrayTypeSymbol)arrayType.Type!;
            local = GetLocal(array, frontend.MapType(symbol));
        }

        var element = symbol.ElementType;
        var mapped = frontend.MapType(symbol);
        byte[] data = FieldBytes(field);
        var scalar = Frontend.ScalarOf(element) ?? throw IlError($"An array of '{element.ToDisplayString()}' has no initializer here.");
        int width = scalar switch
        {
            Scalar.Bool or Scalar.I8 or Scalar.U8 => 1,
            Scalar.I16 or Scalar.U16 or Scalar.Char => 2,
            Scalar.I32 or Scalar.U32 or Scalar.F32 => 4,
            _ => 8,
        };
        for (int index = 0; index * width < data.Length; index++)
        {
            var bytes = data.AsSpan(index * width, width);
            LocalGet(local);
            code.I32(index);
            switch (scalar)
            {
                case Scalar.Bool or Scalar.U8:
                    code.I32(bytes[0]);
                    break;
                case Scalar.I8:
                    code.I32((sbyte)bytes[0]);
                    break;
                case Scalar.I16:
                    code.I32(BitConverter.ToInt16(bytes));
                    break;
                case Scalar.U16 or Scalar.Char:
                    code.I32(BitConverter.ToUInt16(bytes));
                    break;
                case Scalar.I32 or Scalar.U32:
                    code.I32(BitConverter.ToInt32(bytes));
                    break;
                case Scalar.I64 or Scalar.U64:
                    code.I64(BitConverter.ToInt64(bytes));
                    break;
                case Scalar.F32:
                    code.Const(WType.F32, BitConverter.ToSingle(bytes));
                    break;
                default:
                    code.Const(WType.F64, BitConverter.ToDouble(bytes));
                    break;
            }

            code.Gc(14, mapped.Heap); // array.set
        }
    }

    // String members: Length, the indexer, and the runtime's helpers; the
    // rest are shims.
    private bool EmitIlStringCall(IMethodSymbol method, List<IlValue> values, List<IlSlot> types)
    {
        bool Is(string name, params SpecialType[] parameters) =>
            method.Name == name && method.Parameters.Select(parameter => parameter.Type.SpecialType).SequenceEqual(parameters);

        var text = WType.Ref(frontend.StringHeap);
        if (method is { Name: "get_Length", IsStatic: false })
        {
            int self = GetLocal(values[0], text);
            CheckNull(self);
            LocalGet(self);
            code.Gc(15); // array.len
            FinishCall(WType.I32);
            return true;
        }

        if (method is { Name: "get_Chars", IsStatic: false })
        {
            int self = GetLocal(values[0], text);
            int index = GetLocal(values[1], WType.I32);
            CheckArray(self, index);
            LocalGet(self);
            LocalGet(index);
            code.Gc(13, frontend.StringHeap); // array.get_u
            FinishCall(WType.I32);
            return true;
        }

        if (method is { Name: "Format", IsStatic: true, Parameters: [{ Type.SpecialType: SpecialType.System_String }, _] }
            && values[0] is IlLocalValue { Constant: string spanFormat }
            && values[1] is IlLocalValue { Constant: IlSpanItems spanItems }
            && Frontend.ParseComposite(spanFormat, spanItems.Items.Count) is { } spanParts)
        {
            EmitComposite(spanParts, spanItems.Items);
            FinishCall(text);
            return true;
        }

        if (method is { Name: "Format", IsStatic: true } && method.Parameters.Length is >= 2 and <= 4
            && method.Parameters[0].Type.SpecialType == SpecialType.System_String
            && method.Parameters.Skip(1).All(parameter => parameter.Type.SpecialType == SpecialType.System_Object)
            && values[0] is IlLocalValue { Constant: string format }
            && Frontend.ParseComposite(format, values.Count - 1) is { } parts)
        {
            // A constant format: each item formatted by its argument's own
            // type.
            var items = values.Skip(1).Select((value, index) => value switch
            {
                IlNullValue => (Local: -1, Type: (ITypeSymbol?)null),
                IlBoxedValue boxed => (Local: boxed.Value, Type: (ITypeSymbol?)boxed.Type),
                _ => (Local: GetLocal(value, frontend.MapType(types[index + 1].Type)), Type: types[index + 1].Type),
            }).ToList();
            EmitComposite(parts, items);
            FinishCall(text);
            return true;
        }

        string? helper = null;
        if (method.IsStatic)
        {
            helper = method.Name switch
            {
                "Concat" when Is("Concat", SpecialType.System_String, SpecialType.System_String)
                              || Is("Concat", SpecialType.System_String, SpecialType.System_String, SpecialType.System_String)
                              || Is("Concat", SpecialType.System_String, SpecialType.System_String, SpecialType.System_String,
                                  SpecialType.System_String) => "Concat",
                "op_Equality" or "Equals" when Is(method.Name, SpecialType.System_String, SpecialType.System_String) => "Equal",
                "op_Inequality" when Is(method.Name, SpecialType.System_String, SpecialType.System_String) => "NotEqual",
                "IsNullOrEmpty" when Is("IsNullOrEmpty", SpecialType.System_String) => "IsNullOrEmpty",
                "CompareOrdinal" when Is("CompareOrdinal", SpecialType.System_String, SpecialType.System_String) =>
                    "CompareOrdinal",
                _ => null,
            };
            if (helper is null)
            {
                return false;
            }

            foreach (var value in values)
            {
                Get(value, text);
            }

            CallString(helper, values.Count);
            FinishCall(frontend.MapType(method.ReturnType));
            return true;
        }

        helper = method.Name switch
        {
            "Equals" when Is("Equals", SpecialType.System_String) => "Equal",
            "Substring" when Is("Substring", SpecialType.System_Int32)
                             || Is("Substring", SpecialType.System_Int32, SpecialType.System_Int32) => "Substring",
            "IndexOf" when Is("IndexOf", SpecialType.System_Char) => "IndexOf",
            "Contains" when Is("Contains", SpecialType.System_Char) => "Contains",
            _ => null,
        };
        if (helper is null)
        {
            return false;
        }

        int receiver = GetLocal(values[0], text);
        int[] arguments = ArgumentLocals(method, values, 1);
        CheckNull(receiver);
        LocalGet(receiver);
        PushArguments(arguments);
        CallString(helper, arguments.Length + 1);
        FinishCall(frontend.MapType(method.ReturnType));
        return true;
    }

    // object's members, and the ones scalars override: a scalar's own, a
    // struct's through its box, anything else's through the object helpers.
    private void EmitIlObjectMember(IMethodSymbol method, List<IlValue> values, List<IlSlot> types)
    {
        if (method.IsStatic)
        {
            // ReferenceEquals, or the static Equals.
            Get(values[0], ObjectRef);
            int left = Save(ObjectRef);
            Get(values[1], ObjectRef);
            int right = Save(ObjectRef);
            LocalGet(left);
            LocalGet(right);
            code.Byte(0xd3); // ref.eq
            if (method.Name == "Equals")
            {
                OpenBlock(0x04, WType.I32, new object());
                code.I32(1);
                code.Byte(0x05); // else
                LocalGet(left);
                code.Byte(0xd1); // ref.is_null
                LocalGet(right);
                code.Byte(0xd1); // ref.is_null
                code.Byte(0x72); // i32.or
                OpenBlock(0x04, WType.I32, new object());
                code.I32(0);
                code.Byte(0x05); // else
                LocalGet(left);
                LocalGet(right);
                Call(frontend.ObjectHelper("Equals"));
                CloseBlock();
                CloseBlock();
            }

            FinishCall(WType.I32);
            return;
        }

        var receiverType = types[0].Kind is IlKind.ByRef or IlKind.Value || types[0].IsScalar
            ? types[0].Type!
            : Frontend.ScalarOf(method.ContainingType) is not null
                ? method.ContainingType
                : types[0].Type ?? frontend.ObjectSymbol;
        if (types[0].Kind == IlKind.ByRef && Frontend.ScalarOf(method.ContainingType) is not null)
        {
            receiverType = method.ContainingType;
        }

        if (Frontend.ScalarOf(receiverType) is { } scalar)
        {
            int value = ReceiverValue(values[0], receiverType);
            var mapped = frontend.MapType(receiverType);
            switch (method.Name)
            {
                case "ToString":
                    LocalGet(value);
                    FormatScalar(receiverType);
                    FinishCall(Text);
                    return;
                case "GetHashCode":
                    EmitLeafHash(mapped, value, scalar);
                    FinishCall(WType.I32);
                    return;
                case "Equals" when !Frontend.IsObjectType(method.Parameters[0].Type):
                    int other = GetLocal(values[1], mapped);
                    EmitLeafEqual(mapped, value, other);
                    FinishCall(WType.I32);
                    return;
                default:
                    int argument = GetLocal(values[1], ObjectRef);
                    EmitBoxTest(argument, receiverType);
                    OpenBlock(0x04, WType.I32, new object());
                    LocalGet(argument);
                    code.RefCast(WType.NonNullRef(frontend.BoxOf(receiverType).Heap));
                    int boxed = Save(WType.NonNullRef(frontend.BoxOf(receiverType).Heap));
                    EmitBoxValue(frontend.BoxOf(receiverType), boxed);
                    int otherValue = Save(mapped);
                    EmitLeafEqual(mapped, value, otherValue);
                    code.Byte(0x05); // else
                    code.I32(0);
                    CloseBlock();
                    FinishCall(WType.I32);
                    return;
            }
        }

        if (method.Name == "GetType")
        {
            if ((receiverType is IArrayTypeSymbol && Frontend.ClrName(receiverType) is null)
                || receiverType is INamedTypeSymbol mdArray && Frontend.IsMdArrayClass(mdArray))
            {
                // A multidimensional array's, whose CLR name is not kept.
                throw IlError($"A Type object for '{receiverType.ToDisplayString()}' is unsupported.");
            }

            if (Frontend.FixesClass(receiverType))
            {
                int fixedReceiver = GetLocal(values[0], frontend.MapType(receiverType));
                if (frontend.MapType(receiverType).IsRef)
                {
                    CheckNull(fixedReceiver);
                }

                Call(frontend.TypeObject(receiverType));
                FinishCall(frontend.MapType(method.ReturnType));
                return;
            }

            int any = GetLocal(values[0], ObjectRef);
            CheckNull(any);
            LocalGet(any);
            Call(frontend.ObjectTypeHelperOf(receiverType));
            FinishCall(frontend.MapType(method.ReturnType));
            return;
        }

        int receiver;
        if (types[0].Kind is IlKind.Value or IlKind.ByRef)
        {
            // ValueType's members run on a box of the value.
            int value = ReceiverValue(values[0], receiverType);
            LocalGet(value);
            EmitBox(receiverType);
            receiver = Save(ObjectRef);
        }
        else
        {
            receiver = GetLocal(values[0], ObjectRef);
            CheckNull(receiver);
        }

        var arguments = new List<int>();
        for (int index = 1; index < values.Count; index++)
        {
            arguments.Add(GetLocal(values[index], ObjectRef));
        }

        LocalGet(receiver);
        PushArguments([.. arguments]);
        Call(frontend.ObjectHelper(method.Name));
        FinishCall(frontend.MapType(method.ReturnType));
    }

    // MARK: Object creation

    private void EmitIlNewObject(int index)
    {
        if (flow.Operands[index] is IlArrayMethod accessor)
        {
            EmitMdArrayMethod(accessor);
            return;
        }

        var constructor = (IMethodSymbol)flow.Operands[index]!;
        CheckUserCall(constructor);
        var type = constructor.ContainingType;
        var (values, types) = PopArguments(constructor.Parameters.Length);
        if (IlAnalysis.IsSpanOfStack(constructor))
        {
            // A span of stackalloc'd memory: over a new array (zeroed, as
            // C#'s locals-init stackalloc is), charged like one. A span of
            // an initializer's bytes (`ReadOnlySpan<byte> s = new byte[] { 1,
            // 2 }`, which C# compiles to one over the data's address) is
            // over a new array of them the same way.
            var memory = values[0] switch
            {
                IlStackValue { Offset: 0 } stack => stack,
                IlDataValue { Bytes: var initial } => new IlStackValue(new IlStackBlock { Data = initial }, 0),
                _ => throw IlError("A span over a pointer other than stackalloc's is unsupported."),
            };

            var stackElement = ((INamedTypeSymbol)constructor.ContainingType).TypeArguments[0];
            var stackSpan = (INamedTypeSymbol)frontend.Substitute(Substitution.Empty, constructor.ContainingType);
            var stackSpanType = frontend.MapType(stackSpan);
            int count = GetLocal(values[1], WType.I32);
            LocalGet(count);
            code.I32(frontend.Limits.ArrayLength);
            code.Byte(0x4b); // i32.gt_u: negative too
            FaultIf(FaultCode.InvalidArrayLength);
            int stackArray = Save(EmitNewArray(frontend.ArrayOf(stackElement), count));
            EmitStackInitializer(memory.Block, stackElement, stackArray);
            var stackLayout = frontend.StructOf(stackSpanType);
            EmitNewBox(stackSpanType);
            int stackBox = Save(WType.Ref(stackLayout.Box));
            LocalGet(stackBox);
            LocalGet(stackArray);
            code.I32(0);
            LocalGet(count);
            Call(frontend.BoxMethodIndex(SpanConstructor(stackSpan)));
            ReadBox(stackBox, stackLayout);
            FinishCall(stackSpanType);
            return;
        }

        if (IlAnalysis.IsSpanOfOne(constructor))
        {
            // A span of one element: over an array of a copy of it (spans
            // here are over arrays).
            var element = ((INamedTypeSymbol)constructor.ContainingType).TypeArguments[0];
            var span = (INamedTypeSymbol)frontend.Substitute(Substitution.Empty, constructor.ContainingType);
            var spanType = frontend.MapType(span);
            LoadAs(PlaceOf(values[0]), frontend.MapType(element));
            int value = Save(frontend.MapType(element));
            code.I32(1);
            int one = Save(WType.I32);
            int array = Save(EmitNewArray(frontend.ArrayOf(element), one));
            Store(
                new Location(
                    LocationKind.ArrayElement, frontend.MapType(element), element, Receiver: array, Index: Save0(),
                    Container: frontend.MapType(frontend.ArrayOf(element)), Boxed: frontend.MapType(element).IsTuple, NonNull: true),
                value);
            var layout = frontend.StructOf(spanType);
            EmitNewBox(spanType);
            int box = Save(WType.Ref(layout.Box));
            LocalGet(box);
            LocalGet(array);
            code.I32(0);
            LocalGet(one);
            Call(frontend.BoxMethodIndex(SpanConstructor(span)));
            ReadBox(box, layout);
            FinishCall(spanType);
            return;
        }

        if (type.TypeKind == TypeKind.Delegate)
        {
            EmitIlDelegateCreation(type, values, types);
            return;
        }

        if (Frontend.IsInterpolationHandler(type))
        {
            // An interpolated string's handler as a value: nothing built yet.
            EmitLiteral("");
            FinishCall(Text);
            return;
        }

        if (type.SpecialType == SpecialType.System_String)
        {
            var shim = frontend.ShimOf(constructor) ?? throw IlError($"'{constructor.ToDisplayString()}' is unsupported.");
            PushArguments(ArgumentLocals(constructor, values, 0));
            Call(frontend.MethodIndex(shim));
            FinishCall(Text);
            return;
        }

        if (type.SpecialType == SpecialType.System_Object)
        {
            var plain = frontend.PlainObjectType;
            FinishCall(EmitAllocation(plain, plain.InstanceConstructors.Single(), []));
            return;
        }

        if (type.ToDisplayString() is "System.Runtime.CompilerServices.SwitchExpressionException"
            && constructor.Parameters is [{ Type.SpecialType: SpecialType.System_Object }])
        {
            Fault(FaultCode.UnmatchedSwitch);
            ilStack.Add(new IlNullValue());
            return;
        }

        if (Frontend.IsStruct(type) && frontend.InlinedConstruction(constructor) is { } inline)
        {
            // Made in place (Frontend.Construction).
            var made = frontend.StructOf(type);
            PushConstruction(constructor, inline, made, values);
            FinishCall(made.Type);
            return;
        }

        if (Frontend.IsStruct(type))
        {
            // A new zeroed box the constructor fills, then its value.
            var layout = frontend.StructOf(type);
            int[] structArguments = ArgumentLocals(constructor, values, 0);
            EmitNewBox(layout.Type);
            int box = Save(WType.Ref(layout.Box));
            LocalGet(box);
            PushArguments(structArguments);
            Call(frontend.BoxMethodIndex(constructor));
            ReadBox(box, layout);
            FinishCall(layout.Type);
            return;
        }

        if (type.TypeKind != TypeKind.Class || !(Frontend.IsModuleDefined(type) || frontend.IsFrameworkException(type)))
        {
            throw IlError($"Creating '{type.ToDisplayString()}' is unsupported.");
        }

        int[] arguments = ArgumentLocals(constructor, values, 0);
        FinishCall(EmitAllocation(type, constructor, arguments));
    }

    // A struct made in place from its constructor's arguments: its
    // factory's value, or its fields' arguments and constants, in its
    // layout's order.
    private void PushConstruction(IMethodSymbol constructor, InlineConstruction inline, StructLayout made, List<IlValue> values)
    {
        int[] parts = ArgumentLocals(constructor, values, 0);
        if (inline.Factory is { } factory)
        {
            PushArguments(parts);
            int function = frontend.MethodIndex(factory);
            Call(function);
            CastToShape(frontend.PlanOfFunction(function).Result, made.Type);
            return;
        }

        for (int position = 0; position < made.Fields.Count; position++)
        {
            var fieldType = frontend.MapType(made.Fields[position].Type);
            var source = inline.Fields![position];
            if (source.Argument > 0)
            {
                LocalGet(parts[source.Argument - 1]);
            }
            else if (source.Constant is { } constant)
            {
                PushConstant(constant, fieldType);
            }
            else
            {
                PushDefault(fieldType);
            }
        }
    }

    // A constant a constructor stores in a field, as the field's type
    // holds it.
    private void PushConstant(IlInstruction constant, WType type)
    {
        if (constant.OpCode == ILOpCode.Ldnull || type.IsRef)
        {
            type.Default(code);
            return;
        }

        double real = constant.OpCode is ILOpCode.Ldc_r4 or ILOpCode.Ldc_r8 ? constant.Real : constant.Operand;
        if (type == WType.I32)
        {
            code.I32(unchecked((int)constant.Operand));
        }
        else if (type == WType.I64)
        {
            code.I64(constant.Operand);
        }
        else if (type == WType.F32)
        {
            code.F32Const((float)real);
        }
        else if (type == WType.F64)
        {
            code.F64Const(real);
        }
        else
        {
            throw new InternalCompilerError($"a constant of {type} in a constructor made in place.");
        }
    }

    // `newobj D(object, native int)` after `ldftn` or `ldvirtftn`: a
    // method group's delegate.
    private void EmitIlDelegateCreation(INamedTypeSymbol delegateType, List<IlValue> values, List<IlSlot> types)
    {
        if (values[1] is not IlMethodValue pointer)
        {
            throw IlError("A delegate is created from a method pointer loaded just before.");
        }

        var method = pointer.Method;
        bool baseAccess = !pointer.Virtual && (method.IsVirtual || method.IsOverride || method.IsAbstract);
        // ldftn of a virtual method is `base.M`: the receiver as that class.
        var receiverType = method.IsStatic ? null : baseAccess ? method.ContainingType : types[0].Type ?? method.ContainingType;
        var layout = frontend.DelegateOf(delegateType);
        int typeId = frontend.DelegateTypeId(delegateType);
        var (function, bound) = frontend.MethodGroupThunk(method, receiverType, baseAccess, delegateType, generic);
        int methodId = frontend.MethodGroupId(method, baseAccess, generic);
        int target = -1;
        if (!method.IsStatic)
        {
            // The target (its heap type's, or any object's for an object
            // member, whose bound is eq's).
            target = GetLocal(values[0], WType.Ref(bound));
            LocalGet(target);
            code.Byte(0xd1); // ref.is_null
            FaultIf(pointer.Virtual ? FaultCode.NullReference : FaultCode.InvalidArgument);
        }

        code.I64(24);
        ChargeAllocation();
        FunctionReference(function);
        code.I32(typeId);
        code.I32(methodId);
        if (target >= 0)
        {
            LocalGet(target);
        }
        else
        {
            WType.Ref(Frontend.EqHeap).Default(code);
        }

        StructNew(layout.Heap);
        FinishCall(WType.Ref(layout.Heap));
    }
}
