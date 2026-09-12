// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Gameplay.Compiler;

// Method-group thunks: the function a delegate of a method runs.
internal sealed partial class FunctionEmitter
{

    // A method group's function: the target, if any, comes out of the
    // delegate; the call is the one C# would make on it. Like an itable
    // thunk, it spends no fuel or depth of its own.
    private WasmFunction EmitMethodGroupThunk()
    {
        var method = plan.Symbol!;
        if (!method.IsStatic && Frontend.IsObjectMember(method))
        {
            // An object member, dispatched on the target by the object
            // helper as a virtual call of it on an object is
            // (Frontend.MethodGroupThunk); the target was checked for null
            // when the delegate was made.
            LocalGet(0);
            code.Gc(2, plan.Parameters[0].Heap, Frontend.DelegateTargetField); // struct.get: the target
            if (method.Name == "Equals")
            {
                LocalGet(1);
                if (method.Parameters[0].Type.IsValueType)
                {
                    EmitBox(method.Parameters[0].Type);
                }
            }

            int helper = frontend.ObjectHelper(method.Name);
            Call(helper);
            CastToShape(frontend.PlanOfFunction(helper).Result, plan.Result);
            code.Byte(0x0b); // end
            return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
        }

        if (!method.IsStatic && Frontend.IsStruct(method.ContainingType))
        {
            // A struct's method, on the storage of the box that is the
            // target (Frontend.MethodGroupThunk).
            LocalGet(0);
            code.Gc(2, plan.Parameters[0].Heap, Frontend.DelegateTargetField); // struct.get: the target
            code.RefCast(WType.NonNullRef(plan.Bound));
            code.Gc(2, plan.Bound, frontend.BoxValueField); // struct.get: the storage
            int function = frontend.BoxMethodIndex(method);
            PushParametersFor(new CallTarget(function), method, 1, 1);
            Call(function);
            CastToShape(frontend.PlanOfFunction(function).Result, plan.Result);
            code.Byte(0x0b); // end
            return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
        }

        int target = -1;
        if (plan.Bound >= 0)
        {
            LocalGet(0);
            code.Gc(2, plan.Parameters[0].Heap, Frontend.DelegateTargetField); // struct.get: the target
            code.RefCast(WType.NonNullRef(plan.Bound));
            target = NewLocal(WType.Ref(plan.Bound));
            LocalSet(target);
            LocalGet(target);
        }

        var called = frontend.ResolveCall(method, plan.Receiver, plan.BaseAccess, plan.Generic);
        // The delegate's parameters are its canonical type's (Frontend.Sharing).
        PushParametersFor(called, method, 1, target >= 0 ? 1 : 0);
        EmitCallTarget(called, target);
        if (Frontend.HasCovariantResult(method) && plan.Result.IsRef)
        {
            code.RefCast(plan.Result);
        }
        else if (!frontend.IsImport(method))
        {
            CastToShape(TargetShape(called, method).Result, plan.Result);
        }

        if (frontend.IsImport(method) && !method.ReturnsVoid)
        {
            Canonicalize(code, ScalarOfType(method.ReturnType)!.Value);
        }

        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }
}
