// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The reference interpreter on small modules whose outcomes are known.
//!
//! Each test assembles a module from text, lowers it through the frontend,
//! and runs it, so the interpreter is exercised on exactly the IR the
//! frontend produces: block parameters, invoke terminators, exceptional
//! edges, and refinement edges included.

use wedge::Compiler;
use wedge::interp::{Config, Fault, Host, Instance, NoHost, Ref, Value};
use wedge::ir::{Import, Program, TrapCode};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn program(wat: &str) -> Program {
    let wasm = wat::parse_str(wat).expect("the module assembles");
    let program = Compiler::new().compile(&wasm).expect("the module compiles");
    program.verify().expect("the program verifies");
    program
}

fn instance(program: &Program) -> Instance<'_> {
    Instance::instantiate(program, &mut NoHost, Config::default()).expect("the module instantiates")
}

fn run(wat: &str, export: &str, arguments: &[Value]) -> Result<Vec<Value>, Fault> {
    let program = program(wat);
    let mut instance = instance(&program);
    instance.invoke_export(&mut NoHost, export, arguments)
}

fn values(wat: &str, export: &str, arguments: &[Value]) -> Vec<Value> {
    run(wat, export, arguments).unwrap_or_else(|fault| panic!("{export} faulted: {fault}"))
}

fn trap(wat: &str, export: &str, arguments: &[Value]) -> TrapCode {
    match run(wat, export, arguments) {
        Err(Fault::Trap(code)) => code,
        other => panic!("{export} should trap, got {other:?}"),
    }
}

const I32: fn(i32) -> Value = |value| Value::I32(value as u32);
const I64: fn(i64) -> Value = |value| Value::I64(value as u64);

#[test]
fn integer_arithmetic_wraps_and_traps_like_the_specification() {
    let module = r#"(module
        (func (export "div_s") (param i32 i32) (result i32) local.get 0 local.get 1 i32.div_s)
        (func (export "rem_s") (param i32 i32) (result i32) local.get 0 local.get 1 i32.rem_s)
        (func (export "div_u") (param i64 i64) (result i64) local.get 0 local.get 1 i64.div_u)
        (func (export "mixed") (param i32) (result i32 i32 i32 i64)
            local.get 0 i32.const 3 i32.rotl
            local.get 0 i32.clz
            local.get 0 i32.extend8_s
            local.get 0 i64.extend_i32_u)
        (func (export "shifts") (result i32 i64)
            i32.const 1 i32.const 33 i32.shl
            i64.const -8 i64.const 65 i64.shr_s)
    )"#;
    assert_eq!(values(module, "div_s", &[I32(-7), I32(2)]), [I32(-3)]);
    assert_eq!(values(module, "rem_s", &[I32(i32::MIN), I32(-1)]), [I32(0)]);
    assert_eq!(
        trap(module, "div_s", &[I32(1), I32(0)]),
        TrapCode::IntegerDivideByZero
    );
    assert_eq!(
        trap(module, "div_s", &[I32(i32::MIN), I32(-1)]),
        TrapCode::IntegerOverflow
    );
    assert_eq!(
        trap(module, "div_u", &[I64(1), I64(0)]),
        TrapCode::IntegerDivideByZero
    );
    assert_eq!(
        values(module, "div_u", &[I64(-1), I64(2)]),
        [Value::I64(u64::MAX / 2)]
    );
    assert_eq!(
        values(module, "mixed", &[I32(0x8000_00ff_u32 as i32)]),
        [
            Value::I32(0x0000_07fc),
            Value::I32(0),
            I32(-1),
            Value::I64(0x8000_00ff),
        ]
    );
    assert_eq!(values(module, "shifts", &[]), [I32(2), I64(-4)]);
}

#[test]
fn float_operations_follow_the_specification_corners() {
    let module = r#"(module
        (func (export "min") (param f32 f32) (result f32) local.get 0 local.get 1 f32.min)
        (func (export "max") (param f64 f64) (result f64) local.get 0 local.get 1 f64.max)
        (func (export "nearest") (param f32) (result f32) local.get 0 f32.nearest)
        (func (export "trunc") (param f64) (result i32) local.get 0 i32.trunc_f64_s)
        (func (export "trunc_u") (param f32) (result i64) local.get 0 i64.trunc_f32_u)
        (func (export "sat") (param f64) (result i32 i64) local.get 0 i32.trunc_sat_f64_u local.get 0 i64.trunc_sat_f64_s)
        (func (export "convert") (param i64) (result f32 f64) local.get 0 f32.convert_i64_u local.get 0 f64.convert_i64_s)
        (func (export "copysign") (param f32 f32) (result i32) local.get 0 local.get 1 f32.copysign i32.reinterpret_f32)
    )"#;
    assert_eq!(
        values(module, "min", &[Value::f32(0.0), Value::f32(-0.0)]),
        [Value::f32(-0.0)]
    );
    assert_eq!(
        values(module, "min", &[Value::f32(-0.0), Value::f32(0.0)]),
        [Value::f32(-0.0)]
    );
    assert_eq!(
        values(module, "max", &[Value::f64(-0.0), Value::f64(0.0)]),
        [Value::f64(0.0)]
    );
    assert_eq!(
        values(module, "max", &[Value::f64(1.0), Value::f64(f64::NAN)]),
        [Value::f64(f64::NAN)]
    );
    assert_eq!(
        values(module, "nearest", &[Value::f32(2.5)]),
        [Value::f32(2.0)]
    );
    assert_eq!(
        values(module, "nearest", &[Value::f32(-3.5)]),
        [Value::f32(-4.0)]
    );
    assert_eq!(
        values(module, "trunc", &[Value::f64(-2147483648.9)]),
        [I32(i32::MIN)]
    );
    assert_eq!(
        trap(module, "trunc", &[Value::f64(2147483648.0)]),
        TrapCode::IntegerOverflow
    );
    assert_eq!(
        trap(module, "trunc", &[Value::f64(f64::NAN)]),
        TrapCode::InvalidConversionToInteger
    );
    assert_eq!(values(module, "trunc_u", &[Value::f32(-0.5)]), [I64(0)]);
    assert_eq!(
        trap(module, "trunc_u", &[Value::f32(-1.0)]),
        TrapCode::IntegerOverflow
    );
    assert_eq!(
        values(module, "sat", &[Value::f64(-1e30)]),
        [Value::I32(0), Value::I64(i64::MIN as u64)]
    );
    assert_eq!(
        values(module, "sat", &[Value::f64(f64::NAN)]),
        [Value::I32(0), Value::I64(0)]
    );
    assert_eq!(
        values(module, "convert", &[Value::I64(u64::MAX)]),
        [Value::f32(18446744073709551616.0), Value::f64(-1.0)]
    );
    assert_eq!(
        values(module, "copysign", &[Value::f32(1.5), Value::f32(-0.0)]),
        [Value::I32((-1.5_f32).to_bits())]
    );
}

#[test]
fn structured_control_carries_values_through_block_parameters() {
    let module = r#"(module
        (func (export "sum") (param i32) (result i32)
            (local i32)
            block
                loop
                    local.get 0 i32.eqz br_if 1
                    local.get 1 local.get 0 i32.add local.set 1
                    local.get 0 i32.const 1 i32.sub local.set 0
                    br 0
                end
            end
            local.get 1)
        (func (export "pick") (param i32) (result i32)
            block (result i32)
                block (result i32)
                    block (result i32)
                        i32.const 10
                        local.get 0 br_table 0 1 2
                    end
                    i32.const 1 i32.add
                end
                i32.const 100 i32.add
            end)
        (func (export "diamond") (param i32) (result i32 i64)
            local.get 0
            if (result i32 i64)
                i32.const 1 i64.const 2
            else
                i32.const 3 i64.const 4
            end)
        (func (export "select") (param i32) (result f32)
            f32.const 1.5 f32.const -1.5 local.get 0 select)
        (func (export "early") (param i32) (result i32)
            local.get 0 i32.const 5 i32.gt_s
            if i32.const -1 return end
            local.get 0)
    )"#;
    assert_eq!(values(module, "sum", &[I32(100)]), [I32(5050)]);
    assert_eq!(values(module, "pick", &[I32(0)]), [I32(111)]);
    assert_eq!(values(module, "pick", &[I32(1)]), [I32(110)]);
    assert_eq!(values(module, "pick", &[I32(2)]), [I32(10)]);
    assert_eq!(values(module, "pick", &[I32(7)]), [I32(10)]);
    assert_eq!(values(module, "diamond", &[I32(1)]), [I32(1), I64(2)]);
    assert_eq!(values(module, "diamond", &[I32(0)]), [I32(3), I64(4)]);
    assert_eq!(values(module, "select", &[I32(0)]), [Value::f32(-1.5)]);
    assert_eq!(values(module, "early", &[I32(9)]), [I32(-1)]);
    assert_eq!(values(module, "early", &[I32(2)]), [I32(2)]);
}

#[test]
fn calls_recurse_dispatch_through_tables_and_tail_call_without_a_stack() {
    let module = r#"(module
        (type $binary (func (param i32 i32) (result i32)))
        (type $unary (func (param i32) (result i32)))
        (table 4 funcref)
        (elem (i32.const 0) $add $mul $fact)
        (func $add (type $binary) local.get 0 local.get 1 i32.add)
        (func $mul (type $binary) local.get 0 local.get 1 i32.mul)
        (func $fact (type $unary)
            local.get 0 i32.const 1 i32.le_s
            if (result i32) i32.const 1 else
                local.get 0 local.get 0 i32.const 1 i32.sub call $fact i32.mul
            end)
        (func (export "fact") (param i32) (result i32) local.get 0 call $fact)
        (func (export "apply") (param i32 i32 i32) (result i32)
            local.get 1 local.get 2 local.get 0 call_indirect (type $binary))
        (func (export "apply_unary") (param i32 i32) (result i32)
            local.get 1 local.get 0 call_indirect (type $unary))
        (func $count (param i32 i32) (result i32)
            local.get 0 i32.eqz
            if (result i32) local.get 1 else
                local.get 0 i32.const 1 i32.sub
                local.get 1 i32.const 1 i32.add
                return_call $count
            end)
        (func (export "count") (param i32) (result i32) local.get 0 i32.const 0 call $count)
        (func (export "count_indirect") (param i32) (result i32)
            local.get 0 i32.const 0 i32.const 3 return_call_indirect (type $binary))
        (elem (i32.const 3) $count)
    )"#;
    assert_eq!(values(module, "fact", &[I32(10)]), [I32(3628800)]);
    assert_eq!(
        values(module, "apply", &[I32(0), I32(6), I32(7)]),
        [I32(13)]
    );
    assert_eq!(
        values(module, "apply", &[I32(1), I32(6), I32(7)]),
        [I32(42)]
    );
    assert_eq!(
        trap(module, "apply", &[I32(2), I32(6), I32(7)]),
        TrapCode::IndirectCallTypeMismatch
    );
    assert_eq!(
        trap(module, "apply", &[I32(9), I32(6), I32(7)]),
        TrapCode::TableOutOfBounds
    );
    assert_eq!(values(module, "apply_unary", &[I32(2), I32(5)]), [I32(120)]);
    assert_eq!(values(module, "count", &[I32(100_000)]), [I32(100_000)]);
    assert_eq!(
        values(module, "count_indirect", &[I32(50_000)]),
        [I32(50_000)]
    );

    let program = program(module);
    let mut deep = Instance::instantiate(
        &program,
        &mut NoHost,
        Config {
            max_call_depth: 16,
            ..Config::default()
        },
    )
    .unwrap();
    assert_eq!(
        deep.invoke_export(&mut NoHost, "fact", &[I32(30)]),
        Err(Fault::CallDepthExceeded)
    );
    assert_eq!(
        deep.invoke_export(&mut NoHost, "count", &[I32(1000)]),
        Ok(vec![I32(1000)])
    );
}

#[test]
fn memories_are_bounds_checked_and_bulk_operations_check_before_writing() {
    let module = r#"(module
        (memory (export "memory") 1 2)
        (memory $second 1)
        (data (i32.const 8) "\01\02\03\04")
        (data $passive "\aa\bb\cc")
        (func (export "load") (param i32) (result i32 i64 i32)
            local.get 0 i32.load
            local.get 0 i64.load8_s offset=3
            local.get 0 i32.load16_u offset=1)
        (func (export "store") (param i32 i64) (result i64)
            local.get 0 local.get 1 i64.store32 offset=4
            local.get 0 i64.load offset=4)
        (func (export "grow") (param i32) (result i32 i32)
            local.get 0 memory.grow memory.size)
        (func (export "fill") (param i32 i32 i32) (result i32)
            local.get 0 local.get 1 local.get 2 memory.fill
            i32.const 0 i32.load)
        (func (export "copy") (param i32 i32 i32) (result i32)
            local.get 0 local.get 1 local.get 2 memory.copy
            local.get 0 i32.load)
        (func (export "init") (param i32 i32 i32) (result i32)
            local.get 0 local.get 1 local.get 2 memory.init $passive
            local.get 0 i32.load)
        (func (export "drop") data.drop $passive)
        (func (export "cross") (param i32) (result i32)
            local.get 0 i32.const 8 i32.const 4 memory.copy $second 0
            local.get 0 i32.load $second)
        (func (export "far") (result i32) i32.const -1 i32.load offset=4)
    )"#;
    assert_eq!(
        values(module, "load", &[I32(8)]),
        [Value::I32(0x0403_0201), I64(4), I32(0x0302)]
    );
    assert_eq!(
        trap(module, "load", &[I32(65533)]),
        TrapCode::MemoryOutOfBounds
    );
    assert_eq!(trap(module, "far", &[]), TrapCode::MemoryOutOfBounds);
    assert_eq!(
        values(
            module,
            "store",
            &[I32(0), Value::I64(0x1122_3344_5566_7788)]
        ),
        [Value::I64(0x0403_0201_5566_7788)]
    );
    assert_eq!(values(module, "grow", &[I32(1)]), [I32(1), I32(2)]);
    assert_eq!(values(module, "grow", &[I32(2)]), [I32(-1), I32(1)]);
    assert_eq!(
        values(module, "fill", &[I32(0), I32(0x5a), I32(4)]),
        [Value::I32(0x5a5a_5a5a)]
    );
    assert_eq!(
        trap(module, "fill", &[I32(65535), I32(1), I32(2)]),
        TrapCode::MemoryOutOfBounds
    );
    assert_eq!(
        values(module, "copy", &[I32(0), I32(8), I32(4)]),
        [Value::I32(0x0403_0201)]
    );
    assert_eq!(
        values(module, "copy", &[I32(9), I32(8), I32(3)]),
        [Value::I32(0x0003_0201)]
    );
    assert_eq!(
        trap(module, "copy", &[I32(0), I32(65535), I32(2)]),
        TrapCode::MemoryOutOfBounds
    );
    assert_eq!(
        values(module, "init", &[I32(0), I32(1), I32(2)]),
        [Value::I32(0x0000_ccbb)]
    );
    assert_eq!(
        trap(module, "init", &[I32(0), I32(2), I32(2)]),
        TrapCode::MemoryOutOfBounds
    );
    assert_eq!(
        values(module, "cross", &[I32(16)]),
        [Value::I32(0x0403_0201)]
    );

    let program = program(module);
    let mut instance = instance(&program);
    instance.invoke_export(&mut NoHost, "drop", &[]).unwrap();
    assert_eq!(
        instance.invoke_export(&mut NoHost, "init", &[I32(0), I32(0), I32(0)]),
        Ok(vec![Value::I32(0)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "init", &[I32(0), I32(0), I32(1)]),
        Err(Fault::Trap(TrapCode::MemoryOutOfBounds))
    );
    let bytes = &instance.store().memories[0].bytes;
    assert_eq!(&bytes[8..12], &[1, 2, 3, 4]);
}

#[test]
fn sixty_four_bit_memories_take_wide_addresses() {
    let module = r#"(module
        (memory i64 1)
        (func (export "roundtrip") (param i64 i32) (result i32 i64)
            local.get 0 local.get 1 i32.store
            local.get 0 i32.load
            memory.size)
        (func (export "grow") (param i64) (result i64) local.get 0 memory.grow)
    )"#;
    assert_eq!(
        values(module, "roundtrip", &[I64(65532), I32(7)]),
        [I32(7), I64(1)]
    );
    assert_eq!(
        trap(module, "roundtrip", &[I64(65533), I32(7)]),
        TrapCode::MemoryOutOfBounds
    );
    assert_eq!(
        trap(module, "roundtrip", &[I64(-4), I32(7)]),
        TrapCode::MemoryOutOfBounds
    );
    assert_eq!(values(module, "grow", &[I64(2)]), [I64(1)]);
}

#[test]
fn tables_hold_references_and_check_every_bulk_range() {
    let module = r#"(module
        (table $t (export "t") 4 8 funcref)
        (table $x 2 externref)
        (elem $seg func $a $b)
        (func $a (result i32) i32.const 1)
        (func $b (result i32) i32.const 2)
        (func (export "init") (param i32 i32 i32) local.get 0 local.get 1 local.get 2 table.init $t $seg)
        (func (export "call") (param i32) (result i32) local.get 0 call_indirect (result i32))
        (func (export "null") (param i32) (result i32) local.get 0 table.get $t ref.is_null)
        (func (export "set") (param i32) local.get 0 ref.func $b table.set $t)
        (func (export "grow") (param i32) (result i32 i32) ref.null func local.get 0 table.grow $t table.size $t)
        (func (export "fill") (param i32 i32) local.get 0 ref.func $a local.get 1 table.fill $t)
        (func (export "copy") (param i32 i32 i32) local.get 0 local.get 1 local.get 2 table.copy $t $t)
        (func (export "drop") elem.drop $seg)
        (func (export "extern") (param externref) (result i32) local.get 0 ref.is_null)
        (func (export "xset") (param i32 externref) local.get 0 local.get 1 table.set $x)
    )"#;
    let program = program(module);
    let mut instance = instance(&program);
    let call = |instance: &mut Instance<'_>, index: i32| {
        instance.invoke_export(&mut NoHost, "call", &[I32(index)])
    };
    assert_eq!(
        instance.invoke_export(&mut NoHost, "null", &[I32(0)]),
        Ok(vec![I32(1)])
    );
    assert_eq!(
        call(&mut instance, 0),
        Err(Fault::Trap(TrapCode::NullFunctionReference))
    );
    assert_eq!(
        call(&mut instance, 4),
        Err(Fault::Trap(TrapCode::TableOutOfBounds))
    );
    instance
        .invoke_export(&mut NoHost, "init", &[I32(1), I32(0), I32(2)])
        .unwrap();
    assert_eq!(call(&mut instance, 1), Ok(vec![I32(1)]));
    assert_eq!(call(&mut instance, 2), Ok(vec![I32(2)]));
    assert_eq!(
        instance.invoke_export(&mut NoHost, "init", &[I32(3), I32(0), I32(2)]),
        Err(Fault::Trap(TrapCode::TableOutOfBounds))
    );
    instance
        .invoke_export(&mut NoHost, "set", &[I32(0)])
        .unwrap();
    assert_eq!(call(&mut instance, 0), Ok(vec![I32(2)]));
    assert_eq!(
        instance.invoke_export(&mut NoHost, "grow", &[I32(2)]),
        Ok(vec![I32(4), I32(6)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "grow", &[I32(3)]),
        Ok(vec![I32(-1), I32(6)])
    );
    instance
        .invoke_export(&mut NoHost, "fill", &[I32(4), I32(2)])
        .unwrap();
    assert_eq!(call(&mut instance, 5), Ok(vec![I32(1)]));
    assert_eq!(
        instance.invoke_export(&mut NoHost, "fill", &[I32(5), I32(2)]),
        Err(Fault::Trap(TrapCode::TableOutOfBounds))
    );
    instance
        .invoke_export(&mut NoHost, "copy", &[I32(3), I32(0), I32(3)])
        .unwrap();
    assert_eq!(call(&mut instance, 3), Ok(vec![I32(2)]));
    assert_eq!(call(&mut instance, 4), Ok(vec![I32(1)]));
    instance.invoke_export(&mut NoHost, "drop", &[]).unwrap();
    assert_eq!(
        instance.invoke_export(&mut NoHost, "init", &[I32(0), I32(0), I32(1)]),
        Err(Fault::Trap(TrapCode::TableOutOfBounds))
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "extern", &[Value::Ref(Ref::Extern(7))]),
        Ok(vec![I32(0)])
    );
    instance
        .invoke_export(&mut NoHost, "xset", &[I32(1), Value::Ref(Ref::Extern(7))])
        .unwrap();
    assert_eq!(instance.store().tables[1].elements[1], Ref::Extern(7));
}

#[test]
fn globals_and_constant_expressions_initialize_in_order() {
    let module = r#"(module
        (type $sig (func (param i32) (result i32)))
        (global $a i32 (i32.const 20))
        (global $b (mut i32) (i32.add (global.get $a) (i32.const 22)))
        (global $f (mut (ref null $sig)) (ref.func $id))
        (func $id (type $sig) local.get 0)
        (func (export "get") (result i32) global.get $b)
        (func (export "bump") global.get $b i32.const 1 i32.add global.set $b)
        (func (export "call") (param i32) (result i32) local.get 0 global.get $f call_ref $sig)
    )"#;
    let program = program(module);
    let mut instance = instance(&program);
    assert_eq!(
        instance.invoke_export(&mut NoHost, "get", &[]),
        Ok(vec![I32(42)])
    );
    instance.invoke_export(&mut NoHost, "bump", &[]).unwrap();
    assert_eq!(
        instance.invoke_export(&mut NoHost, "get", &[]),
        Ok(vec![I32(43)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "call", &[I32(9)]),
        Ok(vec![I32(9)])
    );
    assert_eq!(instance.store().globals[0], I32(20));
}

#[test]
fn exceptions_route_to_matching_clauses_and_escape_otherwise() {
    let module = r#"(module
        (tag $e (param i32))
        (tag $f (param i32 i64))
        (tag $g)
        (func $throw (param i32) local.get 0 throw $e)
        (func $throw_f i32.const 1 i64.const 2 throw $f)
        (func (export "catch") (param i32) (result i32)
            block $h (result i32)
                try_table (catch $e $h)
                    local.get 0 call $throw
                end
                i32.const -1
            end)
        (func (export "catch_ref") (result i32)
            block $outer (result i32)
                block $inner (result i32 exnref)
                    try_table (catch_ref $e $inner)
                        i32.const 7 call $throw
                    end
                    i32.const 0 br $outer
                end
                block $again (param exnref) (result i32)
                    try_table (param exnref) (catch $e $again)
                        throw_ref
                    end
                    i32.const 0
                end
                i32.add
            end)
        (func (export "catch_all") (result i32)
            block $h
                try_table (catch_all $h)
                    call $throw_f
                end
                i32.const 0 return
            end
            i32.const 1)
        (func (export "nested") (result i32 i64)
            block $outer (result i32 i64)
                block $inner (result i32)
                    try_table (catch $f $outer)
                        try_table (catch $e $inner)
                            call $throw_f
                        end
                    end
                    i32.const 0
                end
                i64.const -1
            end)
        (func (export "escape") i32.const 3 call $throw)
        (func (export "static") (result i32)
            block $none
                block $h (result i32)
                    try_table (catch $g $none) (catch $e $h)
                        i32.const 5 throw $e
                    end
                    i32.const 0
                end
                i32.const 10 i32.mul return
            end
            i32.const -1)
        (func (export "tail") (param i32) local.get 0 return_call $throw)
    )"#;
    assert_eq!(values(module, "catch", &[I32(4)]), [I32(4)]);
    assert_eq!(values(module, "catch_ref", &[]), [I32(14)]);
    assert_eq!(values(module, "catch_all", &[]), [I32(1)]);
    assert_eq!(values(module, "nested", &[]), [I32(1), I64(2)]);
    assert_eq!(values(module, "static", &[]), [I32(50)]);

    let program = program(module);
    let mut instance = instance(&program);
    for (export, arguments) in [("escape", &[][..]), ("tail", &[I32(3)][..])] {
        let Err(Fault::Exception(exception)) =
            instance.invoke_export(&mut NoHost, export, arguments)
        else {
            panic!("{export} should throw");
        };
        let thrown = instance.store().exception(exception).unwrap();
        assert_eq!(thrown.tag, wedge::ir::TagId(0));
        assert_eq!(thrown.payload, [I32(3)]);
    }
}

#[test]
fn reference_branches_refine_without_changing_the_value() {
    let module = r#"(module
        (type $sig (func (result i32)))
        (func $seven (result i32) i32.const 7)
        (elem declare func $seven)
        (func (export "on_null") (param (ref null $sig)) (result i32)
            block $null
                local.get 0 br_on_null $null
                call_ref $sig return
            end
            i32.const -1)
        (func (export "on_non_null") (param (ref null $sig)) (result i32)
            block $some (result (ref $sig))
                local.get 0 br_on_non_null $some
                i32.const -2 return
            end
            call_ref $sig)
        (func (export "seven") (result (ref $sig)) ref.func $seven)
        (func (export "as_non_null") (param funcref) (result i32) local.get 0 ref.as_non_null ref.is_null)
    )"#;
    let program = program(module);
    let mut instance = instance(&program);
    let seven = instance
        .invoke_export(&mut NoHost, "seven", &[])
        .unwrap()
        .remove(0);
    assert_eq!(seven, Value::Ref(Ref::Func(wedge::ir::FunctionId(0))));
    assert_eq!(
        instance.invoke_export(&mut NoHost, "on_null", &[seven.clone()]),
        Ok(vec![I32(7)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "on_null", &[Value::Ref(Ref::Null)]),
        Ok(vec![I32(-1)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "on_non_null", &[seven]),
        Ok(vec![I32(7)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "on_non_null", &[Value::Ref(Ref::Null)]),
        Ok(vec![I32(-2)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "as_non_null", &[Value::Ref(Ref::Null)]),
        Err(Fault::Trap(TrapCode::NullReference))
    );
}

#[test]
fn managed_objects_pack_fields_and_check_casts() {
    let module = r#"(module
        (type $point (struct (field (mut i8)) (field i16) (field (mut f64))))
        (type $bytes (array (mut i8)))
        (type $words (array (mut i32)))
        (data $d "\01\02\03\04\05\06\07\08")
        (func (export "point") (result i32 i32 i32 f64)
            (local (ref $point))
            i32.const 0xf0 i32.const 0x8001 f64.const 2.5 struct.new $point local.tee 0
            struct.get_s $point 0
            local.get 0 struct.get_u $point 0
            local.get 0 struct.get_s $point 1
            local.get 0 i32.const 0x1ff struct.set $point 0
            local.get 0 struct.get_u $point 0
            i32.add
            local.get 0 struct.get $point 2)
        (func (export "array") (result i32 i32 i32)
            (local (ref $bytes))
            i32.const 0 i32.const 8 array.new_data $bytes $d local.tee 0
            array.len
            local.get 0 i32.const 0 array.get_u $bytes
            local.get 0 i32.const 1 i32.const 0xff i32.const 3 array.fill $bytes
            local.get 0 i32.const 3 array.get_s $bytes)
        (func (export "copy") (result i32)
            (local (ref $words))
            i32.const 1 i32.const 2 i32.const 3 i32.const 4 array.new_fixed $words 4 local.tee 0
            i32.const 1 local.get 0 i32.const 0 i32.const 3 array.copy $words $words
            local.get 0 i32.const 3 array.get $words)
        (func (export "oob") (param i32) (result i32)
            i32.const 0 i32.const 4 array.new $words local.get 0 array.get $words)
        (func (export "null") (result i32) ref.null $words array.len)
        (func (export "i31") (param i32) (result i32 i32)
            local.get 0 ref.i31 i31.get_s local.get 0 ref.i31 i31.get_u)
        (func (export "test") (param anyref) (result i32 i32 i32)
            local.get 0 ref.test (ref $point)
            local.get 0 ref.test (ref null $point)
            local.get 0 ref.test i31ref)
        (func (export "cast") (param anyref) (result (ref $point)) local.get 0 ref.cast (ref $point))
        (func (export "make") (result anyref) i32.const 1 i32.const 2 f64.const 3 struct.new $point)
        (func (export "br_on_cast") (param anyref) (result i32)
            block $point (result (ref $point))
                local.get 0 br_on_cast $point anyref (ref $point)
                drop i32.const 0 return
            end
            struct.get_s $point 0)
        (func (export "eq") (param eqref eqref) (result i32) local.get 0 local.get 1 ref.eq)
        (func (export "extern") (param (ref null $point)) (result i32)
            local.get 0 extern.convert_any any.convert_extern ref.cast (ref null $point)
            local.get 0 ref.eq)
    )"#;
    assert_eq!(
        values(module, "point", &[]),
        [I32(-16), I32(0xf0), I32(-0x7fff + 0xff), Value::f64(2.5)]
    );
    assert_eq!(values(module, "array", &[]), [I32(8), I32(1), I32(-1)]);
    assert_eq!(values(module, "copy", &[]), [I32(3)]);
    assert_eq!(values(module, "oob", &[I32(3)]), [I32(0)]);
    assert_eq!(trap(module, "oob", &[I32(4)]), TrapCode::BadArrayElement);
    assert_eq!(trap(module, "null", &[]), TrapCode::NullReference);
    assert_eq!(
        values(module, "i31", &[I32(-1)]),
        [I32(-1), I32(0x7fff_ffff)]
    );
    assert_eq!(
        values(module, "i31", &[I32(0x4000_0000)]),
        [I32(-0x4000_0000), I32(0x4000_0000)]
    );

    let program = program(module);
    let mut instance = instance(&program);
    let point = instance
        .invoke_export(&mut NoHost, "make", &[])
        .unwrap()
        .remove(0);
    assert_eq!(
        instance.invoke_export(&mut NoHost, "test", &[point.clone()]),
        Ok(vec![I32(1), I32(1), I32(0)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "test", &[Value::Ref(Ref::Null)]),
        Ok(vec![I32(0), I32(1), I32(1)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "test", &[Value::Ref(Ref::I31(5))]),
        Ok(vec![I32(0), I32(0), I32(1)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "cast", &[point.clone()]),
        Ok(vec![point.clone()])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "cast", &[Value::Ref(Ref::I31(5))]),
        Err(Fault::Trap(TrapCode::Other("cast-failure".to_owned())))
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "cast", &[Value::Ref(Ref::Null)]),
        Err(Fault::Trap(TrapCode::NullReference))
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "br_on_cast", &[point.clone()]),
        Ok(vec![I32(1)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "br_on_cast", &[Value::Ref(Ref::I31(1))]),
        Ok(vec![I32(0)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "eq", &[point.clone(), point.clone()]),
        Ok(vec![I32(1)])
    );
    let other = instance
        .invoke_export(&mut NoHost, "make", &[])
        .unwrap()
        .remove(0);
    assert_eq!(
        instance.invoke_export(&mut NoHost, "eq", &[point.clone(), other]),
        Ok(vec![I32(0)])
    );
    assert_eq!(
        instance.invoke_export(&mut NoHost, "extern", &[point]),
        Ok(vec![I32(1)])
    );
}

#[test]
fn vector_operations_work_lane_by_lane() {
    let module = r#"(module
        (memory 1)
        (data (i32.const 0) "\01\02\03\04\05\06\07\08\ff\fe\fd\fc\fb\fa\f9\f8")
        (func (export "add") (result v128)
            v128.const i32x4 1 2 3 4 v128.const i32x4 10 20 30 40 i32x4.add)
        (func (export "shuffle") (result v128)
            v128.const i8x16 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
            v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
            i8x16.shuffle 0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23)
        (func (export "min") (result v128)
            v128.const f32x4 0 -0 nan 1 v128.const f32x4 -0 0 1 nan f32x4.min)
        (func (export "narrow") (result v128)
            v128.const i16x8 -200 -1 0 1 127 128 300 -32768
            v128.const i16x8 0 0 0 0 0 0 0 0
            i8x16.narrow_i16x8_s)
        (func (export "bitmask") (result i32 i32)
            v128.const i8x16 -1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 -1 i8x16.bitmask
            v128.const i64x2 -1 1 i64x2.bitmask)
        (func (export "extend") (result v128) i32.const 8 v128.load8x8_s)
        (func (export "lane") (result i64)
            i32.const 0 v128.const i64x2 0 -1 v128.store64_lane 1
            i32.const 0 i64.load)
        (func (export "swizzle") (result v128)
            v128.const i8x16 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
            v128.const i8x16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1 16
            i8x16.swizzle)
        (func (export "sat") (result v128)
            v128.const f32x4 -1 3e9 nan 2.7 i32x4.trunc_sat_f32x4_u)
        (func (export "shift") (result v128)
            v128.const i32x4 1 1 1 1 i32.const 33 i32x4.shl)
    )"#;
    let lanes = |lanes: [u32; 4]| {
        let mut bytes = [0; 16];
        for (index, lane) in lanes.iter().enumerate() {
            bytes[index * 4..][..4].copy_from_slice(&lane.to_le_bytes());
        }
        Value::V128(bytes)
    };
    assert_eq!(values(module, "add", &[]), [lanes([11, 22, 33, 44])]);
    assert_eq!(
        values(module, "shuffle", &[]),
        [Value::V128([
            0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23
        ])]
    );
    assert_eq!(
        values(module, "min", &[]),
        [lanes([
            (-0.0_f32).to_bits(),
            (-0.0_f32).to_bits(),
            f32::NAN.to_bits(),
            f32::NAN.to_bits()
        ])]
    );
    assert_eq!(
        values(module, "narrow", &[]),
        [Value::V128([
            0x80, 0xff, 0, 1, 127, 127, 127, 0x80, 0, 0, 0, 0, 0, 0, 0, 0
        ])]
    );
    assert_eq!(values(module, "bitmask", &[]), [I32(0x8005), I32(1)]);
    let extended: [u8; 16] = [
        0xff, 0xff, 0xfe, 0xff, 0xfd, 0xff, 0xfc, 0xff, 0xfb, 0xff, 0xfa, 0xff, 0xf9, 0xff, 0xf8,
        0xff,
    ];
    assert_eq!(values(module, "extend", &[]), [Value::V128(extended)]);
    assert_eq!(values(module, "lane", &[]), [I64(-1)]);
    assert_eq!(
        values(module, "swizzle", &[]),
        [Value::V128([
            15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0
        ])]
    );
    assert_eq!(
        values(module, "sat", &[]),
        [lanes([0, 3_000_000_000, 0, 2])]
    );
    assert_eq!(values(module, "shift", &[]), [lanes([2, 2, 2, 2])]);
}

#[test]
fn instantiation_applies_segments_in_order_and_runs_start() {
    let ok = r#"(module
        (memory 1)
        (global $g (mut i32) (i32.const 0))
        (data (i32.const 65532) "\01\02\03\04")
        (func $start i32.const 5 global.set $g)
        (start $start)
        (func (export "get") (result i32) global.get $g i32.const 65532 i32.load i32.add)
    )"#;
    assert_eq!(values(ok, "get", &[]), [Value::I32(0x0403_0201 + 5)]);

    let data_out_of_bounds =
        program(r#"(module (memory 1) (data (i32.const 65533) "\01\02\03\04"))"#);
    assert!(matches!(
        Instance::instantiate(&data_out_of_bounds, &mut NoHost, Config::default()),
        Err(Fault::Trap(TrapCode::MemoryOutOfBounds))
    ));

    let element_out_of_bounds =
        program(r#"(module (table 1 funcref) (func $f) (elem (i32.const 1) $f))"#);
    assert!(matches!(
        Instance::instantiate(&element_out_of_bounds, &mut NoHost, Config::default()),
        Err(Fault::Trap(TrapCode::TableOutOfBounds))
    ));

    let start_traps = program(r#"(module (func $start unreachable) (start $start))"#);
    assert!(matches!(
        Instance::instantiate(&start_traps, &mut NoHost, Config::default()),
        Err(Fault::Trap(TrapCode::Unreachable))
    ));
}

#[test]
fn fuel_bounds_every_invocation() {
    let program = program(r#"(module (func (export "spin") loop br 0 end))"#);
    let mut instance = Instance::instantiate(
        &program,
        &mut NoHost,
        Config {
            fuel: 1000,
            ..Config::default()
        },
    )
    .unwrap();
    assert_eq!(
        instance.invoke_export(&mut NoHost, "spin", &[]),
        Err(Fault::OutOfFuel)
    );
    assert_eq!(instance.fuel(), 0);
    assert_eq!(
        instance.invoke_export(&mut NoHost, "spin", &[]),
        Err(Fault::OutOfFuel)
    );
}

struct Doubling {
    calls: usize,
}

impl Host for Doubling {
    fn call(
        &mut self,
        instance: &mut Instance<'_>,
        import: &Import,
        arguments: &[Value],
    ) -> Result<Vec<Value>, Fault> {
        self.calls += 1;
        match (import.name.as_str(), arguments) {
            ("double", [Value::I32(value)]) => Ok(vec![Value::I32(value * 2)]),
            ("poke", [Value::I32(address)]) => {
                instance.store_mut().memories[0].bytes[*address as usize] = 42;
                Ok(Vec::new())
            }
            // The guest's own `twice` runs at the depth and fuel of the
            // call that reached the host.
            ("twice", [value]) => {
                let twice = match instance.export("twice") {
                    Some(wedge::ir::ExportItem::Function(function)) => function,
                    _ => return Err(Fault::Unsupported("no twice export".to_owned())),
                };
                instance.call(self, twice, std::slice::from_ref(value))
            }
            _ => Err(Fault::Unsupported(format!("{}", import.name))),
        }
    }
}

#[test]
fn hosts_implement_function_imports() {
    let module = r#"(module
        (import "env" "double" (func $double (param i32) (result i32)))
        (import "env" "poke" (func $poke (param i32)))
        (import "env" "twice" (func $reenter (param i32) (result i32)))
        (memory 1)
        (func (export "run") (param i32) (result i32 i32)
            local.get 0 call $double
            i32.const 9 call $poke
            i32.const 9 i32.load8_u)
        (func (export "twice") (param i32) (result i32)
            local.get 0 i32.const 2 i32.mul)
        (func (export "through_host") (param i32) (result i32)
            local.get 0 call $reenter)
    )"#;
    let program = program(module);
    let mut host = Doubling { calls: 0 };
    let mut instance = Instance::instantiate(&program, &mut host, Config::default()).unwrap();
    assert_eq!(
        instance.invoke_export(&mut host, "run", &[I32(21)]),
        Ok(vec![I32(42), I32(42)])
    );
    assert_eq!(host.calls, 2);
    assert_eq!(
        instance.invoke_export(&mut host, "through_host", &[I32(5)]),
        Ok(vec![I32(10)])
    );
    assert_eq!(host.calls, 3);
    assert!(matches!(
        Instance::instantiate(&program, &mut NoHost, Config::default())
            .unwrap()
            .invoke_export(&mut NoHost, "run", &[I32(1)]),
        Err(Fault::Unsupported(_))
    ));
}
