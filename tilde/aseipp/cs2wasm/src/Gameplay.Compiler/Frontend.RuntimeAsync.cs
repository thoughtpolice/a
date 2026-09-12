// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Runtime-async methods (Il.RuntimeAsync): which methods are, their split
// bodies, and the frame and step of each instantiation.
internal sealed partial class Frontend
{
    private const System.Reflection.MethodImplAttributes AsyncImplementation = (System.Reflection.MethodImplAttributes)0x2000;

    private readonly Dictionary<IMethodSymbol, RuntimeAsyncCode> runtimeAsyncBodies = new(SymbolEqualityComparer.Default);

    // A type of the CoreLib's, by metadata name.
    public INamedTypeSymbol CoreType(string metadataName) =>
        coreLibrary?.GetTypeByMetadataName(metadataName)
        ?? throw new InternalCompilerError($"the CoreLib has no {metadataName}.");

    // Whether a method of the module's IL has MethodImplAttributes.Async.
    public bool IsRuntimeAsync(IMethodSymbol method)
    {
        var definition = method.OriginalDefinition;
        if (definition.IsGenericMethod)
        {
            definition = definition.ConstructedFrom;
        }

        if (definition.MetadataToken == 0 || IlModuleOf(definition) is not { } module)
        {
            return false;
        }

        var handle = MetadataTokens.EntityHandle(definition.MetadataToken);
        return handle.Kind == HandleKind.MethodDefinition
               && (module.Reader.GetMethodDefinition((MethodDefinitionHandle)handle).ImplAttributes & AsyncImplementation) != 0;
    }

    // A runtime-async method's kickoff and step, split once per definition
    // from its IL as the definition types it.
    public RuntimeAsyncCode RuntimeAsyncOf(IMethodSymbol method)
    {
        var definition = method.OriginalDefinition;
        if (definition.IsGenericMethod)
        {
            definition = definition.ConstructedFrom;
        }

        if (!runtimeAsyncBodies.TryGetValue(definition, out var code))
        {
            var original = IlOf(definition) ?? throw new InternalCompilerError($"{definition.ToDisplayString()} has no IL.");
            var plan = new MethodPlan(
                definition, definition.ToDisplayString(), [], WType.Void, definition.IsStatic, definition.ContainingType,
                MethodPlanKind.Ordinary, Substitution.Empty, Il: original);
            code = RuntimeAsyncSplitter.Split(this, definition, original, new IlAnalysis(this, plan));
            runtimeAsyncBodies.Add(definition, code);
        }

        return code;
    }

    // A runtime-async method's frame: the cells of its arguments and
    // locals (or, for `this` and references, their values), which its
    // kickoff makes and each step reads.
    internal sealed record RuntimeAsyncFrame(int Heap, List<(bool Argument, int Index, WType Type)> Variables, int Step);

    private readonly Dictionary<Instance, RuntimeAsyncFrame> runtimeAsyncFrames = [];

    public RuntimeAsyncFrame RuntimeAsyncFrameOf(IMethodSymbol method, Substitution generic) =>
        runtimeAsyncFrames[new(method, generic)];

    // The kickoff's frame and the step's plan, under an instantiation.
    private void RegisterRuntimeAsync(MethodPlan plan, IlAnalysis flow)
    {
        if (plan.Il?.Kind != IlCodeKind.RuntimeAsyncKickoff)
        {
            return;
        }

        var key = new Instance(plan.Symbol!, plan.Generic);
        if (runtimeAsyncFrames.ContainsKey(key))
        {
            return;
        }

        var variables = new List<(bool Argument, int Index, WType Type)>();
        for (int index = 0; index < flow.Arguments.Length; index++)
        {
            var slot = flow.Arguments[index];
            variables.Add((true, index, slot.Kind == IlKind.ByRef
                ? RefParameterType(slot.Type!)
                : !plan.Symbol!.IsStatic && index == 0 ? MapType(slot.Type) : ReferenceType(slot.Type!)));
        }

        for (int index = 0; index < flow.Locals.Length; index++)
        {
            var local = flow.Locals[index];
            if (flow.HasLocal(index) && !local.ByRef)
            {
                variables.Add((false, index, ReferenceType(local.Type)));
            }
        }

        int heap = AddType(TypeDefinition.Struct(
            "runtime-async frame",
            [.. variables.Select(variable => new WField(variable.Type, Mutable: false))]));
        var action = CoreType("System.Action");
        var layout = DelegateOf(action);
        DelegateTypeId(action);
        MethodGroupId(plan.Symbol!, false, plan.Generic);
        int step = methods.Count;
        methods.Add(new(
            plan.Symbol,
            $"{plan.Name} <step>",
            [WType.Ref(layout.Heap)],
            WType.Void,
            true,
            plan.ContainingType,
            MethodPlanKind.RuntimeAsyncStep,
            plan.Generic,
            Il: RuntimeAsyncOf(plan.Symbol!).Resume));
        runtimeAsyncFrames.Add(key, new(heap, variables, step));
    }

    public int RuntimeAsyncStepIndex(IMethodSymbol method, Substitution generic) =>
        imports.Count + RuntimeAsyncFrameOf(method, generic).Step;
}
