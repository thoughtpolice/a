// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Gameplay.Compiler;

// Two-pass exception handling, for modules with `when` filters. The CLR
// handles an exception in two passes: the first finds the catch clause that
// takes it, running filters where the exception was thrown, before any
// finally block has run; the second unwinds to that clause, running the
// finally blocks it leaves. Wasm unwinds in one pass, so a module with
// filters keeps the first pass itself: a module-global stack of handler
// records, one per try statement with catch clauses whose protected code is
// running, innermost last. The stack is an array of records the module
// reuses, grown (doubling) when a try goes deeper than ever before; a try
// allocates nothing, as in .NET, and the growth, bookkeeping bounded by the
// deepest nesting, is not charged to the allocation budget. Filters, entries
// and type initializers set the stack's base to its top, hiding the records
// below. Every throw (`throw`, `throw;`, and the checks)
// calls the raise function, which asks each record's selector, in order,
// which of its clauses takes the exception, and marks the first record that
// answers, then throws. A catch site takes only the exception its record
// was marked for, with the marked clause, and passes everything else on.
//
// A selector is a function of its own per try statement: the type tests and
// filters of the clauses, in order. A filter is lowered there, so the
// variables it uses from its function live in cells its selector reaches
// (FunctionEmitter.IlFilters), and the record holds them as they are at the
// try statement. The catch variable is the selector's own. While a
// filter runs, the stack is empty, so an exception thrown inside it can be
// caught only inside it; one that escapes makes the filter false.
//
// Without filters, type tests decide alone, and they are pure: whether they
// run before or after the finally blocks in between cannot be observed, so
// a module without filters keeps the one-pass lowering.
internal sealed partial class Frontend
{
    private bool twoPass;
    private int handlerHeap = -1;
    private int selectorSignature = -1;
    private int raiseFunction = -1;
    private int growHandlersFunction = -1;
    private int handlerPoolHeap = -1;
    private readonly Dictionary<Instance, int> selectorIds = [];

    public bool TwoPass => twoPass;

    public int HandlerHeap => handlerHeap;

    public int SelectorSignature => selectorSignature;

    public int Raise => imports.Count + raiseFunction;

    public int GrowHandlers => imports.Count + growHandlersFunction;

    public int HandlerPoolHeap => handlerPoolHeap;

    public int ImportCount => imports.Count;

    // The fields of a handler record.
    public const int HandlerSelector = 0;
    public const int HandlerEnvironment = 1;
    public const int HandlerException = 2;
    public const int HandlerClause = 3;

    private void StartTwoPass(bool filters)
    {
        if (!filters)
        {
            return;
        }

        twoPass = true;
        exceptions = true;
        RegisterFrameworkClass(ExceptionType);
        handlerHeap = AddType(null);
        selectorSignature = SignatureType(
            [WType.NonNullRef(handlerHeap), WType.NonNullRef(ExceptionHeap)], WType.I32);
        types[handlerHeap] = TypeDefinition.Struct("handler",
        [
            new(WType.Ref(selectorSignature)),
            new(WType.Ref(WType.StructHeap)),
            new(WType.Ref(ExceptionHeap)),
            new(WType.I32),
        ]);
        handlerPoolHeap = AddType(TypeDefinition.Array("handlers", new(WType.Ref(handlerHeap))));
        raiseFunction = methods.Count;
        methods.Add(new(
            null, "<raise>", [WType.NonNullRef(ExceptionHeap)], WType.Void, true, null, MethodPlanKind.Raise,
            Substitution.Empty));
        growHandlersFunction = methods.Count;
        methods.Add(new(
            null, "<grow handlers>", [], WType.Void, true, null, MethodPlanKind.GrowHandlers,
            Substitution.Empty));
    }
}
