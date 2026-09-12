// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The splitter of runtime-async methods (docs/IMPORTER.md, "Async as
// built"): a method with MethodImplAttributes.Async (0x2000) is written as
// if it ran to its end, awaiting with AsyncHelpers.Await (and AwaitAwaiter
// and UnsafeAwaitAwaiter for other awaiters), and returns its result
// rather than a task; the runtime suspends it where an awaited operation
// has not completed. Here it becomes two functions over IL of the
// compiler's (IlCode's rewritten bodies):
//
// - the kickoff, which its callers call: its locals and arguments live in
//   cells (FunctionEmitter's escaping storage) that a frame holds; it makes
//   the frame and the continuation that resumes it (an Action whose target
//   is the frame), a RuntimeAsyncTask, runs the first step, and returns
//   what an async method's builder would (corelib/RuntimeAsync.cs);
// - the step, which the continuation runs: the method's own IL over the
//   frame's cells, entered at the await it suspended at by a dispatch on a
//   state (at the start of the body and of each try block around an await,
//   since a try block is entered at its start, as C#'s state machines do),
//   left by `leave` when it suspends (every finally block first skipping
//   itself then), its return completing the task and what escapes it
//   faulting or canceling it.
//
// Each await: the awaitable's awaiter (GetAwaiter) in a local of the
// frame, and what the evaluation stack holds below it too; if the awaiter
// has not completed, its continuation is registered (Suspend, as
// AwaitUnsafeOnCompleted) and the step suspends; either way it goes on at
// the await's label, where the stack is reloaded and GetResult called.
// Awaits in handlers are not split.
internal sealed record RuntimeAsyncCode(IlCode Kickoff, IlCode Resume);

internal sealed class RuntimeAsyncSplitter
{
    // Offsets of the rewritten body: the IL's shifted past the entry's, so
    // that what the compiler puts before an instruction has offsets below
    // it and above the one before.
    private const int Scale = 256;

    private readonly Frontend frontend;
    private readonly IMethodSymbol method;
    private readonly IlCode original;
    private readonly IlAnalysis flow;
    private readonly INamedTypeSymbol taskType;
    private readonly INamedTypeSymbol helpers;
    private readonly ITypeSymbol resultType;
    private readonly bool returnsValue;
    private readonly List<IlType> extraLocals = [];
    private readonly Dictionary<int, IlSymbolOperand> synthetic = [];

    // The frame's own locals.
    private readonly int state;
    private readonly int suspending;
    private readonly int context;
    private readonly int executionContext;
    private readonly int resume;
    private readonly int task;
    private readonly int result = -1;
    private readonly int exception;

    private RuntimeAsyncSplitter(Frontend frontend, IMethodSymbol method, IlCode original, IlAnalysis flow)
    {
        this.frontend = frontend;
        this.method = method;
        this.original = original;
        this.flow = flow;
        var returned = (INamedTypeSymbol)method.ReturnType;
        returnsValue = returned.TypeArguments.Length == 1;
        resultType = returnsValue ? returned.TypeArguments[0] : frontend.CoreType("System.Threading.Tasks.VoidTaskResult");
        taskType = frontend.CoreType("Gameplay.Runtime.RuntimeAsyncTask`1").Construct(resultType);
        helpers = frontend.CoreType("Gameplay.Runtime.RuntimeAsync");
        state = Local(frontend.SpecialTypeOf(SpecialType.System_Int32));
        suspending = Local(frontend.SpecialTypeOf(SpecialType.System_Int32));
        context = Local(frontend.CoreType("System.Threading.SynchronizationContext"));
        executionContext = Local(frontend.SpecialTypeOf(SpecialType.System_Object));
        resume = Local(frontend.CoreType("System.Action"));
        task = Local(taskType);
        if (returnsValue)
        {
            result = Local(resultType);
        }

        exception = Local(frontend.ExceptionType);
    }

    // Whether a method's return is a task an async method may have.
    public static bool Returns(IMethodSymbol method) =>
        method.ReturnType is INamedTypeSymbol { Name: "Task" or "ValueTask", ContainingNamespace: { Name: "Tasks", ContainingNamespace.Name: "Threading" } } named
        && named.TypeArguments.Length <= 1;

    public static RuntimeAsyncCode Split(Frontend frontend, IMethodSymbol method, IlCode original, IlAnalysis flow)
    {
        if (!Returns(method))
        {
            throw frontend.ErrorAt(method, 0, "A runtime-async method must return Task, Task<T>, ValueTask or ValueTask<T>.");
        }

        // The step first: its locals are the kickoff's too, and the frame's.
        var splitter = new RuntimeAsyncSplitter(frontend, method, original, flow);
        var resume = splitter.Resume();
        return new(splitter.Kickoff(), resume);
    }

    private int Local(ITypeSymbol type)
    {
        extraLocals.Add(new IlType(type));
        return flow.Locals.Length + extraLocals.Count - 1;
    }

    private IMethodSymbol Helper(string name, params ITypeSymbol[] typeArguments)
    {
        var found = helpers.GetMembers(name).OfType<IMethodSymbol>().Single();
        return typeArguments.Length == 0 ? found : found.Construct(typeArguments);
    }

    // A parameterless instance member of a type, the most derived one
    // (Task<T>'s GetAwaiter, not Task's).
    private static IMethodSymbol Member(ITypeSymbol type, string name)
    {
        for (var current = type; current is not null; current = current.BaseType)
        {
            if (current.GetMembers(name).OfType<IMethodSymbol>().FirstOrDefault(member => member is { IsStatic: false, Parameters.Length: 0 }) is { } found)
            {
                return found;
            }
        }

        throw new InternalCompilerError($"'{type.ToDisplayString()}' has no {name}.");
    }

    private static IMethodSymbol Getter(ITypeSymbol type, string name) =>
        type.GetMembers(name).OfType<IPropertySymbol>().Single().GetMethod!;

    // MARK: Writing

    // An instruction of the rewritten body: its opcode and operand, the
    // labels it branches to, and its symbol.
    private sealed class Item(ILOpCode opcode, long operand = 0, ISymbol? symbol = null)
    {
        public ILOpCode OpCode { get; } = opcode;

        public long Operand { get; } = operand;

        public ISymbol? Symbol { get; } = symbol;

        public Label[]? Targets { get; init; }

        public Label? Target { get; init; }

        public double Real { get; init; }

        public int Offset { get; set; }
    }

    private sealed class Label
    {
        public Item? Item { get; set; }
    }

    private static Item Op(ILOpCode opcode, long operand = 0) => new(opcode, operand);

    // A struct's members by `call` on its reference, others' by `callvirt`.
    private static Item Call(IMethodSymbol target) =>
        new(target.IsStatic || target.ContainingType.IsValueType ? ILOpCode.Call : ILOpCode.Callvirt, 0, target);

    // The instructions that store what the stack holds below `depth` in
    // new locals, and reload them.
    private (List<Item> Spill, List<Item> Reload) Spill(int index, int depth)
    {
        var spill = new List<Item>();
        var reload = new List<Item>();
        var stack = flow.Before[index];
        var locals = new int[depth];
        for (int level = 0; level < depth; level++)
        {
            var slot = stack[level];
            if (slot.Kind is IlKind.ByRef or IlKind.Method or IlKind.Token)
            {
                throw flow.Error(index, "A reference on the evaluation stack across an await is unsupported.");
            }

            locals[level] = Local(slot.Kind == IlKind.Null || slot.Type is null ? frontend.ObjectSymbol : slot.Type);
        }

        for (int level = depth - 1; level >= 0; level--)
        {
            spill.Add(Op(ILOpCode.Stloc, locals[level]));
        }

        for (int level = 0; level < depth; level++)
        {
            reload.Add(Op(ILOpCode.Ldloc, locals[level]));
        }

        return (spill, reload);
    }

    // MARK: The kickoff

    private IlCode Kickoff()
    {
        var items = new List<Item>
        {
            Op(IlPseudo.NewResume),
            Op(ILOpCode.Stloc, resume),
            new(ILOpCode.Newobj, 0, taskType.InstanceConstructors.Single(constructor => constructor.Parameters.Length == 0)),
            Op(ILOpCode.Stloc, task),
            Op(ILOpCode.Ldloc, resume),
            Call(Member(frontend.CoreType("System.Action"), "Invoke")),
            Op(ILOpCode.Ldloc, task),
            Call(((INamedTypeSymbol)method.ReturnType).Name == "Task"
                ? returnsValue ? Helper("ReturnTask", resultType) : Helper("ReturnVoidTask")
                : returnsValue ? Helper("ReturnValueTask", resultType) : Helper("ReturnVoidValueTask")),
            Op(ILOpCode.Ret),
        };
        for (int index = 0; index < items.Count; index++)
        {
            items[index].Offset = index;
        }

        return Build(items, [], IlCodeKind.RuntimeAsyncKickoff, offset => 0);
    }

    // MARK: The step

    private sealed record AwaitSite(int Index, int Number, Label Resume, List<IlGroup> Groups);

    private IlCode Resume()
    {
        var instructions = original.Instructions;
        int end = original.Body.Size;
        // Each await, in order, with the try blocks around it (outermost
        // first).
        var awaits = new List<AwaitSite>();
        for (int index = 0; index < instructions.Length; index++)
        {
            if (IsAwait(index) is not null && !flow.Before[index].IsDefault)
            {
                var groups = new List<IlGroup>();
                for (var area = flow.AreaOf(instructions[index].Offset); area.Group is { } group; area = group.Parent)
                {
                    if (area != group.Try)
                    {
                        throw flow.Error(index, "An await in a catch, finally or filter block of a runtime-async method is unsupported.");
                    }

                    groups.Insert(0, group);
                }

                awaits.Add(new(index, awaits.Count + 1, new Label(), groups));
            }
        }

        // What goes before an original instruction: the guard of the
        // finally block starting there (it skips itself when the step
        // suspends), then the dispatch of each try block starting there,
        // outermost first.
        var guards = new Dictionary<int, Label>();
        foreach (var group in flow.Groups.Where(group => group.IsFinally))
        {
            guards[group.Clauses[0].HandlerStart] = new Label();
        }

        var dispatches = new Dictionary<IlGroup, Label[]>();
        var starts = new Dictionary<IlGroup, Label>();
        Label Start(IlGroup group) => starts.TryGetValue(group, out var label) ? label : starts[group] = new Label();
        var entryTargets = new Label[awaits.Count + 1];
        var bodyStart = new Label();
        entryTargets[0] = bodyStart;
        foreach (var site in awaits)
        {
            entryTargets[site.Number] = site.Groups.Count == 0 ? site.Resume : Start(site.Groups[0]);
            for (int level = 0; level < site.Groups.Count; level++)
            {
                var group = site.Groups[level];
                if (!dispatches.TryGetValue(group, out var targets))
                {
                    dispatches[group] = targets = new Label[awaits.Count + 1];
                }

                targets[site.Number] = level + 1 < site.Groups.Count ? Start(site.Groups[level + 1]) : site.Resume;
            }
        }

        var items = new List<Item>
        {
            Call(Helper("EnterStep")),
            Op(ILOpCode.Stloc, context),
            Op(ILOpCode.Ldloc, state),
            Call(Helper("EnterContext")),
            Op(ILOpCode.Stloc, executionContext),
            Op(ILOpCode.Ldc_i4, 0),
            Op(ILOpCode.Stloc, suspending),
            Op(ILOpCode.Ldloc, state),
            new(ILOpCode.Switch) { Targets = entryTargets },
        };
        for (int position = 0; position < items.Count; position++)
        {
            items[position].Offset = position;
        }

        var exit = new Label();
        var siteAt = awaits.ToDictionary(site => site.Index);
        var labels = new Dictionary<int, Label>();
        Label At(int offset) => labels.TryGetValue(offset, out var label) ? label : labels[offset] = new Label();
        var placed = new Dictionary<int, List<Item>>();
        // Where each try block without a dispatch starts: after the
        // dispatches of the try blocks around it starting there too.
        var tryStarts = new Dictionary<IlGroup, int>();
        for (int index = 0; index < instructions.Length; index++)
        {
            var instruction = instructions[index];
            var all = new List<Item>();
            var fallthroughs = new List<(Label Label, int Position)>();
            if (guards.TryGetValue(instruction.Offset, out var guard))
            {
                all.Add(Op(ILOpCode.Ldloc, suspending));
                all.Add(new Item(ILOpCode.Brfalse) { Target = guard });
                all.Add(Op(ILOpCode.Endfinally));
            }

            int afterGuard = all.Count;
            var starting = flow.Groups.Where(group => group.TryStart == instruction.Offset).OrderByDescending(group => group.TryEnd).ToList();
            var positions = new Dictionary<IlGroup, int>();
            foreach (var group in starting)
            {
                positions[group] = all.Count;
                if (dispatches.TryGetValue(group, out var targets))
                {
                    var fallthrough = new Label();
                    for (int number = 0; number < targets.Length; number++)
                    {
                        targets[number] ??= fallthrough;
                    }

                    all.Add(Op(ILOpCode.Ldloc, state));
                    all.Add(new Item(ILOpCode.Switch) { Targets = targets });
                    fallthroughs.Add((fallthrough, all.Count));
                }
            }

            all.AddRange(siteAt.TryGetValue(index, out var site)
                ? AwaitItems(site, exit)
                : instruction.OpCode == ILOpCode.Ret && !flow.Before[index].IsDefault
                    ? ReturnItems(exit)
                    : [Copy(index, At)]);
            if (all.Count >= Scale)
            {
                throw flow.Error(index, "An await with this much on the evaluation stack is unsupported.");
            }

            for (int position = 0; position < all.Count; position++)
            {
                all[position].Offset = (instruction.Offset + 1) * Scale + position;
                items.Add(all[position]);
            }

            foreach (var group in starting)
            {
                if (dispatches.ContainsKey(group))
                {
                    Start(group).Item = all[positions[group]];
                }
                else
                {
                    tryStarts[group] = all[positions[group]].Offset;
                }
            }

            foreach (var (fallthrough, position) in fallthroughs)
            {
                fallthrough.Item = all[position];
            }

            if (guard is not null)
            {
                guard.Item = all[afterGuard];
            }

            // A branch to the instruction lands past the guard (only the
            // handler's entry runs it), at the first dispatch.
            At(instruction.Offset).Item = all[afterGuard];
            placed[instruction.Offset] = all;
            if (index == 0)
            {
                bodyStart.Item = all[0];
            }
        }

        // What escapes the method faults or cancels its task; the step's
        // end restores the contexts and returns.
        int handlerStart = (end + 1) * Scale;
        var handler = new List<Item>
        {
            Op(ILOpCode.Stloc, exception),
            Op(ILOpCode.Ldloc, task),
            Op(ILOpCode.Ldloc, exception),
            Call(Helper("Fail", resultType)),
            new(ILOpCode.Leave) { Target = exit },
        };
        var leaving = new List<Item>
        {
            Op(ILOpCode.Ldloc, context),
            Call(Helper("LeaveStep")),
            Op(ILOpCode.Ldloc, executionContext),
            Call(Helper("LeaveContext")),
            Op(IlPseudo.StepReturn),
        };
        exit.Item = leaving[0];
        int next = handlerStart;
        foreach (var item in handler.Concat(leaving))
        {
            item.Offset = next++;
            items.Add(item);
        }

        // An original offset as the rewritten body has it: its first item
        // (what goes before an instruction belongs to the region starting
        // there), or past the IL's end.
        int Map(int offset) => placed.TryGetValue(offset, out var all) ? all[0].Offset : handlerStart;

        var regions = new List<IlRegion>();
        foreach (var region in original.Regions)
        {
            var group = flow.Groups.FirstOrDefault(candidate => candidate.Clauses.Contains(region));
            int tryStart = group is null ? Map(region.TryStart)
                : starts.TryGetValue(group, out var dispatch) && dispatch.Item is { } first ? first.Offset
                : tryStarts.TryGetValue(group, out int start) ? start
                : Map(region.TryStart);
            regions.Add(region with
            {
                TryStart = tryStart,
                TryEnd = Map(region.TryEnd),
                HandlerStart = Map(region.HandlerStart),
                HandlerEnd = Map(region.HandlerEnd),
                FilterStart = region.FilterStart >= 0 ? Map(region.FilterStart) : -1,
            });
        }

        regions.Add(new IlRegion(ExceptionRegionKind.Catch, 0, handlerStart, handlerStart, handlerStart + handler.Count, -1, -1));
        return Build(items, regions, IlCodeKind.RuntimeAsyncResume, offset => Math.Clamp(offset / Scale - 1, 0, Math.Max(end - 1, 0)));
    }

    // The AsyncHelpers method an instruction calls, if it is one.
    private IMethodSymbol? IsAwait(int index) =>
        original.Instructions[index].OpCode == ILOpCode.Call
        && flow.Operands[index] is IMethodSymbol { Name: "Await" or "AwaitAwaiter" or "UnsafeAwaitAwaiter", ContainingType.Name: "AsyncHelpers" } called
        && called.ContainingType.ContainingNamespace?.ToDisplayString() == "System.Runtime.CompilerServices"
            ? called
            : null;

    private List<Item> AwaitItems(AwaitSite site, Label exit)
    {
        var called = IsAwait(site.Index)!;
        var stack = flow.Before[site.Index];
        var awaitable = stack[^1].Type!;
        var (spill, reload) = Spill(site.Index, stack.Length - 1);
        var items = new List<Item>();
        int awaiter;
        ITypeSymbol awaiterType;
        bool custom = called.Name != "Await";
        if (custom)
        {
            // AwaitAwaiter and UnsafeAwaitAwaiter: the IL has the awaiter,
            // asked it IsCompleted, and calls GetResult after.
            awaiterType = called.TypeArguments[0];
            awaiter = Local(awaiterType);
            items.Add(Op(ILOpCode.Stloc, awaiter));
            items.AddRange(spill);
        }
        else
        {
            int held = Local(awaitable);
            items.Add(Op(ILOpCode.Stloc, held));
            items.AddRange(spill);
            items.Add(Op(awaitable.IsValueType ? ILOpCode.Ldloca : ILOpCode.Ldloc, held));
            var getAwaiter = Member(awaitable, "GetAwaiter");
            items.Add(Call(getAwaiter));
            awaiterType = getAwaiter.ReturnType;
            awaiter = Local(awaiterType);
            items.Add(Op(ILOpCode.Stloc, awaiter));
            items.Add(Op(awaiterType.IsValueType ? ILOpCode.Ldloca : ILOpCode.Ldloc, awaiter));
            items.Add(Call(Getter(awaiterType, "IsCompleted")));
            items.Add(new Item(ILOpCode.Brtrue) { Target = site.Resume });
        }

        items.Add(Op(ILOpCode.Ldloca, awaiter));
        items.Add(Op(ILOpCode.Ldloc, resume));
        items.Add(Op(ILOpCode.Ldloc, task));
        items.Add(Call(Helper(called.Name == "AwaitAwaiter" ? "SuspendSafe" : "Suspend", awaiterType, resultType)));
        items.Add(Op(ILOpCode.Ldc_i4, site.Number));
        items.Add(Op(ILOpCode.Stloc, state));
        items.Add(Op(ILOpCode.Ldc_i4, 1));
        items.Add(Op(ILOpCode.Stloc, suspending));
        items.Add(new Item(ILOpCode.Leave) { Target = exit });
        var resumed = Op(ILOpCode.Ldc_i4, 0);
        site.Resume.Item = resumed;
        items.Add(resumed);
        items.Add(Op(ILOpCode.Stloc, state));
        items.AddRange(reload);
        if (!custom)
        {
            items.Add(Op(awaiterType.IsValueType ? ILOpCode.Ldloca : ILOpCode.Ldloc, awaiter));
            items.Add(Call(Member(awaiterType, "GetResult")));
        }

        return items;
    }

    // `ret`: the task completes with the result, and the step ends.
    private List<Item> ReturnItems(Label exit)
    {
        var items = new List<Item>();
        if (returnsValue)
        {
            items.Add(Op(ILOpCode.Stloc, result));
            items.Add(Op(ILOpCode.Ldloc, task));
            items.Add(Op(ILOpCode.Ldloc, result));
            items.Add(Call(Helper("Complete", resultType)));
        }
        else
        {
            items.Add(Op(ILOpCode.Ldloc, task));
            items.Add(Call(Helper("CompleteVoid")));
        }

        items.Add(new Item(ILOpCode.Leave) { Target = exit });
        return items;
    }

    // An instruction of the IL as it is, its branches to the IL's offsets.
    private Item Copy(int index, Func<int, Label> at)
    {
        var instruction = original.Instructions[index];
        return new Item(instruction.OpCode, instruction.Operand)
        {
            Real = instruction.Real,
            Targets = instruction.Targets?.Select(at).ToArray(),
            Target = instruction.OpCode is ILOpCode.Br or ILOpCode.Leave || IlAnalysis.IsConditional(instruction.OpCode)
                ? at(instruction.Target)
                : null,
        };
    }

    private IlCode Build(List<Item> items, List<IlRegion> regions, IlCodeKind kind, Func<int, int> sourceOffset)
    {
        var instructions = ImmutableArray.CreateBuilder<IlInstruction>(items.Count);
        for (int index = 0; index < items.Count; index++)
        {
            var item = items[index];
            if (item.Symbol is not null)
            {
                synthetic[index] = new IlSymbolOperand(item.Symbol);
            }

            long operand = item.Target is { } target ? Resolve(target) : item.Operand;
            instructions.Add(new IlInstruction(item.Offset, item.OpCode, operand, item.Real, item.Targets?.Select(Resolve).ToArray()));
        }

        var code = new IlCode(original, instructions.MoveToImmutable(), [.. regions], [.. extraLocals], new(synthetic), sourceOffset) { Kind = kind };
        synthetic.Clear();
        return code;
    }

    private static int Resolve(Label label) =>
        label.Item?.Offset ?? throw new InternalCompilerError("a label of the runtime-async splitter was not placed.");
}
