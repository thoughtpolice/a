// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// What an imported body needs registered before emission (WalkOperations'
// counterpart): the types its stack, locals and operands name, the
// functions its calls reach, and the boxes, delegates, handles and helpers
// the lowering in FunctionEmitter.Il uses.
internal sealed partial class Frontend
{
    private void WalkIl(MethodPlan plan)
    {
        if (plan.Kind == MethodPlanKind.ExactStep)
        {
            WalkExactStep(plan);
            return;
        }

        // Shared code's own analysis (Frontend.SharedCode).
        IlAnalysis flow;
        try
        {
            flow = plan.Shared?.Flow ?? new IlAnalysis(this, plan);
        }
        catch (InternalCompilerError error) when (Environment.GetEnvironmentVariable("GAMEPLAYC_TRACE") is not null)
        {
            throw new InternalCompilerError($"{plan.Name}: {error.Message}");
        }

        var generic = plan.Generic;
        RegisterIlSelectors(plan, flow);
        RegisterRuntimeAsync(plan, flow);
        if (flow.Groups.Count != 0)
        {
            exceptions = true;
            foreach (var group in flow.Groups)
            {
                foreach (var clause in group.Clauses.Where(clause => clause.Kind == ExceptionRegionKind.Catch))
                {
                    var caught = flow.CatchType(clause);
                    if (caught.SpecialType != SpecialType.System_Object)
                    {
                        MapType(caught);
                    }
                }
            }
        }

        var addressed = new HashSet<(bool Argument, int Index)>();
        foreach (var instruction in flow.Instructions)
        {
            if (instruction.OpCode is ILOpCode.Ldloca or ILOpCode.Ldarga)
            {
                addressed.Add((instruction.OpCode == ILOpCode.Ldarga, (int)instruction.Operand));
            }
        }

        for (int index = 0; index < flow.Locals.Length; index++)
        {
            var local = flow.Locals[index];
            if (!flow.HasLocal(index))
            {
                continue;
            }

            if (local.ByRef)
            {
                RefParameterType(local.Type);
            }
            else
            {
                try
                {
                    MapType(local.Type);
                }
                catch (CompileError error) when (!error.Message.Contains(": GP", StringComparison.Ordinal))
                {
                    // Where: the method's local.
                    throw new CompileError($"{plan.Symbol?.ToDisplayString() ?? plan.Name}: {error.Message}");
                }

                if (addressed.Contains((false, index)))
                {
                    ReferenceType(local.Type);
                    RefParameterType(local.Type);
                }
            }
        }

        for (int index = 0; index < flow.Arguments.Length; index++)
        {
            var argument = flow.Arguments[index];
            if (argument.Kind == IlKind.ByRef)
            {
                RefParameterType(argument.Type!);
            }
            else if (addressed.Contains((true, index)) && argument.Type is { } type)
            {
                ReferenceType(type);
                RefParameterType(type);
            }
        }

        for (int index = 0; index < flow.Instructions.Length; index++)
        {
            if (flow.After[index] is not { } after)
            {
                // Unreachable.
                continue;
            }

            foreach (var slot in after)
            {
                switch (slot.Kind)
                {
                    case IlKind.Ref or IlKind.Value:
                        MapType(slot.Type);
                        break;
                    case IlKind.ByRef:
                        RefParameterType(slot.Type!);
                        break;
                }
            }

            if (plan.Shared is null)
            {
                NoteEscapes(flow, index);
            }

            if (plan.Shared is { } shared && shared.SiteAt.TryGetValue(index, out var site))
            {
                // What each exact instantiation reaches is found for it
                // (DrainSharedUses); a Direct call reaches shared code.
                if (site.Kind == SiteKind.Direct && flow.Operands[index] is IMethodSymbol callee
                    && SharedCodeOf(CanonicalMember(callee)) is { } calleeCode)
                {
                    EnsureSharedPlan(calleeCode);
                }

                continue;
            }

            WalkIlInstruction(flow, index, generic);
        }

        if (plan.Shared is null)
        {
            foreach (var array in flow.JoinedArrays)
            {
                escapingArrays.Add(array);
            }
        }
    }

    private void WalkIlInstruction(IlAnalysis flow, int index, Substitution generic)
    {
        var instruction = flow.Instructions[index];
        var before = flow.Before[index];
        switch (instruction.OpCode)
        {
            case ILOpCode.Call when flow.Operands[index] is IlExactTypeTest:
                // Of the module's own types, as it has them.
                break;
            case ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj when flow.Operands[index] is IlArrayMethod accessor:
                MapType(ArrayOf(IntType));
                MapType(ArrayOf(accessor.Element));
                MapType(accessor.Type);
                if (accessor.Name == ".ctor")
                {
                    EnsureMethod(MdArrayNew(accessor.Type), Substitution.Empty);
                }
                else if (accessor.Name == "Address" && !MapType(accessor.Element).IsTuple)
                {
                    HandleHeap(MapType(accessor.Element));
                }

                break;
            case ILOpCode.Call or ILOpCode.Callvirt:
                var method = (IMethodSymbol)flow.Operands[index]!;
                NoteIlBoundaryMemory(method, flow.Method, flow, index);
                int count = method.Parameters.Length + (method.IsStatic ? 0 : 1);
                var types = before.Skip(before.Length - count).ToList();
                if (flow.Constrained[index] is null && AutoGetterField(method) is not null)
                {
                    // A read of its backing field.
                    break;
                }

                if (IsRecordNullComparison(method, types))
                {
                    // `record == null`: a reference test.
                    break;
                }

                if (instruction.OpCode == ILOpCode.Call && flow.Constrained[index] is null && types is [{ Kind: IlKind.Ref }, ..]
                    && method is { Name: "GetHashCode", IsStatic: false, ContainingType.SpecialType: SpecialType.System_Object })
                {
                    // `base.GetHashCode()`: the identity hash.
                    identityHash = true;
                    break;
                }

                if (instruction.OpCode == ILOpCode.Call && flow.Constrained[index] is null && types is [{ Kind: IlKind.Ref }, ..]
                    && method is { Name: "Equals", IsStatic: false, ContainingType.SpecialType: SpecialType.System_Object })
                {
                    break;
                }

                if (flow.Constrained[index] is { } constrained)
                {
                    WalkConstrainedCall(method, constrained, types, generic);
                }
                else
                {
                    WalkIlCall(method, types, generic);
                }

                break;
            case ILOpCode.Newobj:
                WalkIlNewObject(flow, index, generic);
                break;
            case ILOpCode.Ldfld or ILOpCode.Stfld or ILOpCode.Ldflda or ILOpCode.Ldsfld or ILOpCode.Stsfld or ILOpCode.Ldsflda:
                var field = (ISymbol)flow.Operands[index]!;
                var storageType = StorageType(field);
                if (UsesRepresentation(field.ContainingType) && !field.IsStatic)
                {
                    // An instance field of a shared class: its representation's.
                    MapType(field.ContainingType);
                }
                else if (IsGenericInstance(field.ContainingType) || IsOnDemandType(field.ContainingType))
                {
                    EnsureInstance(field.ContainingType);
                    DrainInstances();
                }

                if (field is IFieldSymbol { IsStatic: true, IsConst: false } used && InFramework(used)
                    && !globalIds.ContainsKey(used) && !HasData(used))
                {
                    // A framework assembly's static field, where code
                    // first uses it.
                    RegisterField(used);
                }

                MapType(storageType);
                if (instruction.OpCode is ILOpCode.Ldflda or ILOpCode.Ldsflda && !MapType(storageType).IsTuple)
                {
                    NoteReferencedField(field);
                }

                break;
            case ILOpCode.Ldelema:
                var element = MapType((ITypeSymbol)flow.Operands[index]!);
                if (!element.IsTuple)
                {
                    HandleHeap(element);
                }

                break;
            case ILOpCode.Box:
                var boxed = (ITypeSymbol)flow.Operands[index]!;
                if (IsRuntimeNullable(boxed))
                {
                    var underlying = ((INamedTypeSymbol)boxed).TypeArguments[0];
                    if (IsBoxable(underlying))
                    {
                        EnsureBox(underlying);
                    }
                }
                else if (boxed.IsValueType)
                {
                    EnsureBox(boxed);
                    if (ScalarOf(boxed) is not null || IsDecimalType(boxed))
                    {
                        // What string.Format of the box, or Enum's
                        // ToString(format) on it, may need.
                        DemandFormatted(boxed, formatted: true, aligned: true);
                        EnsureRuntimeMethod("Number", "FormatInteger", 4);
                        if (IsDecimalType(boxed))
                        {
                            EnsureRuntimeMethod("Number", "FormatDecimal", 2);
                        }
                    }
                }

                break;
            case ILOpCode.Unbox_any or ILOpCode.Unbox or ILOpCode.Isinst or ILOpCode.Castclass:
                var tested = (ITypeSymbol)flow.Operands[index]!;
                MapType(tested);
                if (UsesRepresentation(tested))
                {
                    // Its identity, its class id (Frontend.Sharing).
                    EnsureInstance((INamedTypeSymbol)tested);
                }

                if (IsRuntimeNullable(tested) && IsBoxable(((INamedTypeSymbol)tested).TypeArguments[0]))
                {
                    EnsureBox(((INamedTypeSymbol)tested).TypeArguments[0]);
                }

                if (IsBoxable(tested))
                {
                    EnsureBox(tested);
                }

                break;
            case ILOpCode.Rem or ILOpCode.Rem_un when before[^1].Kind is IlKind.F32 or IlKind.F64:
                // IEEE fmod, as runtime C# (runtime/Math.cs).
                EnsureRuntimeMethod("Transcendental", before[^1].Kind == IlKind.F32 ? "FmodF" : "Fmod", 2);
                break;
            case ILOpCode.Ldstr:
                StringType();
                break;
            case ILOpCode.Initobj or ILOpCode.Ldobj or ILOpCode.Stobj or ILOpCode.Cpobj or ILOpCode.Newarr
                or ILOpCode.Ldelem or ILOpCode.Stelem:
                MapType((ITypeSymbol)flow.Operands[index]!);
                break;
            case ILOpCode.Ldtoken when flow.Operands[index] is ITypeSymbol token:
                // typeof: the type's object.
                EnsureTypeObject(token);
                break;
        }
    }

    // object's GetType, and Exception's, which .NET declares again (`new`)
    // for the COM interface it once had.
    public static bool IsGetType(IMethodSymbol method) =>
        method is { Name: "GetType", IsStatic: false, Parameters.Length: 0 }
        && (method.ContainingType.SpecialType == SpecialType.System_Object
            || method.ContainingType is { Name: "Exception", ContainingNamespace: { Name: "System", ContainingNamespace.IsGlobalNamespace: true } });

    // System.Array's Clear and Copy of one-dimensional arrays of one
    // element type, as IL's stack types show them: the CoreLib's generic
    // methods of the element type (corelib/Array.cs).
    public IMethodSymbol? ArrayRedirect(IMethodSymbol method, List<IlSlot> types)
    {
        if (method is not { IsStatic: true, Name: "Clear" or "Copy", ContainingType.SpecialType: SpecialType.System_Array }
            || types.Count != method.Parameters.Length)
        {
            return null;
        }

        ITypeSymbol? element = null;
        for (int index = 0; index < types.Count; index++)
        {
            var parameter = method.Parameters[index].Type;
            if (parameter.SpecialType == SpecialType.System_Array)
            {
                if (types[index] is not { Kind: IlKind.Ref, Type: IArrayTypeSymbol { IsSZArray: true } array }
                    || (element is not null && !SymbolEqualityComparer.Default.Equals(element, array.ElementType)))
                {
                    return null;
                }

                element = array.ElementType;
            }
            else if (parameter.SpecialType != SpecialType.System_Int32)
            {
                return null;
            }
        }

        if (element is null || TypeNamed("Gameplay.Runtime.ArrayMethods") is not { } helpers)
        {
            return null;
        }

        return helpers.GetMembers(method.Name).OfType<IMethodSymbol>()
            .FirstOrDefault(candidate => candidate.Parameters.Length == method.Parameters.Length)
            ?.Construct(element);
    }

    // A record class's synthesized == or != with a null operand: C#'s
    // `record == null`, which is true of a null and nothing else.
    public static bool IsRecordNullComparison(IMethodSymbol method, List<IlSlot> types) =>
        method is { Name: "op_Equality" or "op_Inequality", IsStatic: true, ContainingType: { IsRecord: true, TypeKind: TypeKind.Class } }
        && types.Count == 2 && types.Any(type => type.Kind == IlKind.Null) && IsCompilerGenerated(method);

    private void WalkConstrainedCall(IMethodSymbol method, ITypeSymbol constrained, List<IlSlot> types, Substitution generic)
    {
        if (method.IsStatic)
        {
            // T's own member, reached as any call of it is (a framework
            // numeric type's may be a shim or an intrinsic).
            WalkIlCall(StaticImplementation(constrained, method), types, generic);
            return;
        }

        if (constrained.IsReferenceType)
        {
            WalkIlCall(method, [new IlSlot(IlKind.Ref, constrained), .. types.Skip(1)], generic);
            return;
        }

        if (VectorLane(constrained) is not null)
        {
            // A Vector128's own member (Frontend.Simd).
            WalkIlCall(VectorMember(constrained, method) ?? method, types, generic);
            return;
        }

        var definition = method.IsGenericMethod ? method.ConstructedFrom : method;
        var implemented = method.ContainingType.TypeKind == TypeKind.Interface
            ? constrained.FindImplementationForInterfaceMember(definition) as IMethodSymbol
            : constrained is INamedTypeSymbol named && IsModuleDefined(named)
                ? ObjectOverride(named, method)
                : null;
        if (implemented is not null && method.IsGenericMethod)
        {
            implemented = implemented.Construct([.. method.TypeArguments]);
        }

        if (implemented is not null && IsModuleDefined(implemented))
        {
            EnsureMethod(implemented, generic);
            return;
        }

        if (ScalarOf(constrained) is not null)
        {
            WalkIlCall(implemented ?? method, [new IlSlot(IlKind.I32, constrained), .. types.Skip(1)], generic);
            return;
        }

        if (IsObjectMember(method))
        {
            EnsureBox(constrained);
            DemandObjectMember(method.Name);
        }
    }

    private void WalkIlCall(IMethodSymbol method, List<IlSlot> types, Substitution generic)
    {
        if (WalkSimdCall(method, generic))
        {
            return;
        }

        if (ArrayRedirect(method, types) is { } redirect)
        {
            EnsureMethod(redirect, Substitution.Empty);
            return;
        }

        string type = method.ContainingType.ToDisplayString();
        if (method.MethodKind == MethodKind.Constructor && !IsModuleDefined(method))
        {
            if (IsFrameworkException(method.ContainingType))
            {
                NoteExceptionConstructor(method);
            }

            if (method.ContainingType.SpecialType == SpecialType.System_Object || IsFrameworkException(method.ContainingType))
            {
                return;
            }
        }

        if (IsInterpolationHandler(method.ContainingType))
        {
            StringType();
            if (method.Name == "AppendFormatted")
            {
                DemandFormatted(
                    method.IsGenericMethod ? method.TypeArguments[0] : method.Parameters[0].Type,
                    method.Parameters.Any(parameter => parameter.Name == "format"),
                    method.Parameters.Any(parameter => parameter.Name == "alignment"));
            }

            return;
        }

        if (method is { Name: "op_Implicit", ContainingType.SpecialType: SpecialType.System_String })
        {
            EnsureMethod(StringAsSpan(), Substitution.Empty);
            return;
        }

        if (method.ContainingType.Name == "<PrivateImplementationDetails>" && method.Name.StartsWith("InlineArray", StringComparison.Ordinal))
        {
            // A params span's buffer is an array (see FunctionEmitter.IlCalls).
            MapType(ArrayOf(method.TypeArguments[1]));
            if (method.Name is "InlineArrayAsReadOnlySpan" or "InlineArrayAsSpan")
            {
                var span = (INamedTypeSymbol)Substitute(Substitution.Empty, method.ReturnType);
                MapType(span);
                EnsureMethod(span.InstanceConstructors.First(constructor =>
                    constructor.Parameters.Length == 3 && constructor.DeclaredAccessibility == Accessibility.Public), Substitution.Empty);
            }
            else if (!MapType(method.TypeArguments[1]).IsTuple)
            {
                HandleHeap(MapType(method.TypeArguments[1]));
            }

            return;
        }

        switch (type, method.Name)
        {
            case ("System.Activator", "CreateInstance") when method.IsGenericMethod && method.Parameters.Length == 0:
                var created = method.TypeArguments[0];
                MapType(created);
                if (LacksPublicParameterless(created))
                {
                    MapType(MissingMethodException);
                    NoteExceptionConstructor(DefaultConstructor(MissingMethodException)!);
                    return;
                }

                if (DefaultConstructor(created) is { } parameterless && IsModuleDefined(parameterless)
                    && parameterless.MetadataToken != 0)
                {
                    EnsureMethod(parameterless, generic);
                }

                return;
            case ("System.Environment", "get_CurrentManagedThreadId"):
                return;
            case ("System.Runtime.CompilerServices.RuntimeHelpers", "CreateSpan"):
                var dataSpan = (INamedTypeSymbol)Substitute(Substitution.Empty, method.ReturnType);
                MapType(dataSpan);
                MapType(ArrayOf(method.TypeArguments[0]));
                EnsureMethod(dataSpan.InstanceConstructors.First(constructor =>
                    constructor.Parameters.Length == 3 && constructor.DeclaredAccessibility == Accessibility.Public), Substitution.Empty);
                return;
            case ("System.Runtime.CompilerServices.RuntimeHelpers", "GetSubArray"):
                EnsureMethod(RuntimeMethod("Ranges", "SubArray", 2).Construct(method.TypeArguments[0]), Substitution.Empty);
                return;
            case ("System.Runtime.CompilerServices.RuntimeHelpers", "EnsureSufficientExecutionStack" or "InitializeArray"):
                return;
            case ("System.Type", "GetTypeFromHandle") or ("Gameplay.Runtime.Type", "GetTypeFromHandle"):
                // The token is the type (ldtoken, just before).
                return;
            case ("System.Delegate", "Combine" or "Remove") when method.Parameters.Length == 2:
                var combined = types[0].Kind == IlKind.Ref ? types[0].Type! : types[1].Type!;
                var layout = DelegateOf(combined);
                if (method.Name == "Combine")
                {
                    EnsureMulticast(layout);
                }
                else
                {
                    EnsureDelegateRemove(layout);
                }

                return;
            case ("<PrivateImplementationDetails>", "ThrowSwitchExpressionException" or "ThrowInvalidOperationException"):
                return;
            case ("System.Runtime.CompilerServices.Unsafe", "BitCast" or "As" or "AsRef" or "SkipInit")
                when method.Name != "As" || method.Parameters is [{ RefKind: not RefKind.None }]:
                foreach (var argument in method.TypeArguments)
                {
                    RefParameterType(Substitute(generic, argument));
                }

                return;
            case ("System.Runtime.CompilerServices.Unsafe", "Add")
                when method is { TypeArguments: [var moved], Parameters: [{ RefKind: RefKind.Ref }, { Type.SpecialType: SpecialType.System_Int32 }] }
                     && !MapType(Substitute(generic, moved)).IsTuple:
                RefParameterType(Substitute(generic, moved));
                HandleHeap(MapType(Substitute(generic, moved)));
                return;
            case ("System.Runtime.CompilerServices.Unsafe", "NullRef" or "IsNullRef") when method.TypeArguments is [var referenced]:
                RefParameterType(referenced);
                return;
            case ("System.Runtime.CompilerServices.Unsafe", "As")
                when method is { TypeArguments: [var asType], Parameters: [{ RefKind: RefKind.None, Type.SpecialType: SpecialType.System_Object }] }:
                MapType(asType);
                return;
        }

        if (method.ContainingType.SpecialType is SpecialType.System_Delegate or SpecialType.System_MulticastDelegate
            && method.Name is "op_Equality" or "op_Inequality")
        {
            EnsureDelegateEqual(DelegateOf(types[0].Kind == IlKind.Ref ? types[0].Type! : types[1].Type!));
            return;
        }

        if (IntrinsicOf(method) is { } intrinsic)
        {
            switch (intrinsic)
            {
                case Intrinsic.Equal:
                    DemandEquality(method.TypeArguments[0]);
                    break;
                case Intrinsic.Hash:
                    RequireHash(method.TypeArguments[0]);
                    break;
                case Intrinsic.Compare or Intrinsic.LessThan or Intrinsic.GreaterThan:
                    DemandOrdering(method.TypeArguments[0]);
                    break;
            }

            return;
        }

        if (method is { ContainingType.SpecialType: SpecialType.System_Array, IsStatic: false }
            && types[0].Type is INamedTypeSymbol mdArray && IsMdArrayClass(mdArray))
        {
            var member = MdArrayMember(mdArray, method);
            EnsureMethod(member is IPropertySymbol arrayProperty ? arrayProperty.GetMethod! : (IMethodSymbol)member, Substitution.Empty);
            return;
        }

        if (method.MethodKind == MethodKind.DelegateInvoke && IsSupportedDelegate(method.ContainingType))
        {
            DelegateOf(method.ContainingType);
            return;
        }

        if (method.ContainingType.SpecialType == SpecialType.System_String)
        {
            StringType();
            if (method.Name is "get_Length" or "get_Chars" or "Concat" or "op_Equality" or "op_Inequality" or "Equals"
                or "IsNullOrEmpty" or "CompareOrdinal" or "Substring" or "IndexOf" or "Contains"
                && ShimOf(method) is null)
            {
                return;
            }
        }

        if (IsObjectMember(method) || IsGetType(method))
        {
            if (method.IsStatic)
            {
                if (method.Name == "Equals")
                {
                    DemandObjectMember("Equals");
                }

                return;
            }

            var receiver = types[0].Kind is IlKind.ByRef or IlKind.Value || types[0].IsScalar
                ? types[0].Type!
                : ScalarOf(method.ContainingType) is not null ? method.ContainingType : types[0].Type ?? ObjectSymbol;
            if (types[0].Kind == IlKind.ByRef && ScalarOf(method.ContainingType) is not null)
            {
                receiver = method.ContainingType;
            }

            if (ScalarOf(receiver) is not null)
            {
                if (method.Name == "Equals" && IsObjectType(method.Parameters[0].Type))
                {
                    EnsureBox(receiver);
                }

                if (method.Name == "ToString")
                {
                    DemandPrinting(receiver);
                }

                return;
            }

            if (method.Name == "GetType")
            {
                if (FixesClass(receiver))
                {
                    EnsureTypeObject(receiver);
                }
                else
                {
                    DemandObjectTypeHelper(receiver);
                }

                return;
            }

            if (types[0].Kind is IlKind.Value or IlKind.ByRef)
            {
                EnsureBox(receiver);
            }

            DemandObjectMember(method.Name);
            return;
        }

        if (ShimOf(method) is { } shim)
        {
            EnsureMethod(shim, generic);
            foreach (var parameter in method.Parameters.Where(parameter => parameter.Type is INamedTypeSymbol named && IsFrameworkSpan(named)))
            {
                // A params span the shim takes as an array.
                var span = (INamedTypeSymbol)Substitute(Substitution.Empty, parameter.Type);
                EnsureMethod(SpanToArray(span), Substitution.Empty);
            }

            return;
        }

        if (!method.IsStatic && ScalarOf(method.ContainingType) is not null && method.Name == "ToString"
            && method.Parameters.Length == 0)
        {
            DemandPrinting(method.ContainingType);
            return;
        }

        if (IsFrameworkException(method.ContainingType) && method.AssociatedSymbol is IPropertySymbol property
            && ExceptionPropertyName(property))
        {
            RequireMessages();
            if (property.Name == "ParamName")
            {
                RequireParamNames();
            }

            return;
        }

        if (IsAdoptedInterface(method.ContainingType))
        {
            MapType(method.ContainingType);
            if (ArrayImplementation(method) is { } onArrays)
            {
                // What an array runs for the member, as the arrays code
                // converts to the interface turn up (DrainCovariantArrays).
                MapType(onArrays.Parameters[0].Type);
                arrayMembers.Add(method);
            }
            else if (ObjectArrayHelper(method) is { } helper)
            {
                objectArrayMembers.Add(helper);
            }
        }
        else if (IsModuleDefined(method))
        {
            EnsureMethod(method, generic);
            if (method.MethodKind == MethodKind.Constructor && IsStruct(method.ContainingType))
            {
                // `ldloca s; ...; call S::.ctor`, C#'s construction of a
                // struct into a variable, made in place as `new` is.
                NoteStructConstruction(method, generic);
            }
        }
    }

    private void WalkIlNewObject(IlAnalysis flow, int index, Substitution generic)
    {
        var constructor = (IMethodSymbol)flow.Operands[index]!;
        var type = constructor.ContainingType;
        var before = flow.Before[index];
        if (IlAnalysis.IsSpanOfOne(constructor) || IlAnalysis.IsSpanOfStack(constructor))
        {
            var span = (INamedTypeSymbol)Substitute(Substitution.Empty, constructor.ContainingType);
            MapType(span);
            MapType(ArrayOf(((INamedTypeSymbol)constructor.ContainingType).TypeArguments[0]));
            EnsureMethod(span.InstanceConstructors.First(candidate =>
                candidate.Parameters.Length == 3 && candidate.DeclaredAccessibility == Accessibility.Public), Substitution.Empty);
            return;
        }

        if (type.TypeKind == TypeKind.Delegate)
        {
            if (before[^1] is { Kind: IlKind.Method, Symbol: IMethodSymbol target } pointer)
            {
                bool baseAccess = !pointer.Virtual && (target.IsVirtual || target.IsOverride || target.IsAbstract);
                if (IsModuleDefined(target))
                {
                    EnsureMethod(target, generic);
                }

                MethodGroupThunk(target, target.IsStatic ? null : baseAccess ? target.ContainingType : before[^2].Type ?? target.ContainingType, baseAccess, type, generic);
            }

            return;
        }

        if (type.SpecialType == SpecialType.System_String)
        {
            StringType();
            if (ShimOf(constructor) is { } shim)
            {
                EnsureMethod(shim, generic);
            }

            return;
        }

        if (type.SpecialType == SpecialType.System_Object)
        {
            var plain = PlainObjectType;
            MapType(plain);
            EnsureMethod(plain.InstanceConstructors.Single(), Substitution.Empty);
            return;
        }

        if (type.ToDisplayString() == "System.Runtime.CompilerServices.SwitchExpressionException"
            && constructor.Parameters is [{ Type.SpecialType: SpecialType.System_Object }])
        {
            return;
        }

        MapType(type);
        if (IsFrameworkException(type))
        {
            NoteExceptionConstructor(constructor);
            return;
        }

        if (IsModuleDefined(constructor))
        {
            EnsureMethod(constructor, generic);
            if (IsStruct(type))
            {
                NoteStructConstruction(constructor, generic);
            }
        }
    }

    // What a BCL exception constructor needs: its message and parameter
    // name fields.
    private void NoteExceptionConstructor(IMethodSymbol constructor)
    {
        if (constructor.Parameters.Length == 0)
        {
            return;
        }

        if (!IsMessageConstructor(constructor) && !IsParamNameConstructor(constructor))
        {
            throw new CompileError(
                $"'{constructor.ToDisplayString()}' is unsupported; BCL exceptions take no arguments, "
                + "(string message) or (string message, Exception innerException), and the argument "
                + "exceptions a parameter's name too.");
        }

        RequireMessages();
        if (IsParamNameConstructor(constructor))
        {
            RequireParamNames();
        }
    }

    // A field a reference is taken to: its number among its type's.
    private void NoteReferencedField(ISymbol field)
    {
        var type = ReferenceKey(MapType(StorageType(field)));
        HandleHeap(type);
        if (!referencedFields.TryGetValue(type, out var fields))
        {
            fields = [];
            referencedFields.Add(type, fields);
        }

        if (!fields.Contains(field, SymbolEqualityComparer.Default))
        {
            fields.Add(field);
        }
    }
}
