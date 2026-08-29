// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end contracts for standardized GC operators in constant expressions.
//!
//! The repository's pinned WABT accepts GC type declarations but does not
//! tokenize executable GC instructions. These tests therefore encode the
//! smallest relevant standard binaries directly and still exercise the full
//! wasmparser validation and Wedge lowering pipeline.

use wedge::ir::{
    ConstExpr, EffectAccess, EffectResource, HeapType, Immediate, Operation, OperationKind,
    RefType, TrapCode, TypeId, ValueType,
};
use wedge::opcode::CoreOpcode;
use wedge::semantics::effects_for_operation;
use wedge::{CompileError, Compiler};
mod encoding_support;

use encoding_support::{append_section, encode_u32};

fn global_entry(value_type: &[u8], initializer: &[u8]) -> Vec<u8> {
    let mut entry = Vec::new();
    entry.extend_from_slice(value_type);
    entry.push(0x00); // immutable, unshared
    entry.extend_from_slice(initializer);
    entry.push(0x0b); // end
    entry
}

fn gc_const_expr_module() -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();

    let types = [
        0x02, // two types
        0x5f, 0x03, // struct with three fields
        0x78, 0x00, // immutable i8 (represented as i32 on the stack)
        0x7e, 0x01, // mutable i64
        0x6e, 0x00, // immutable anyref
        0x5e, // array
        0x77, 0x01, // mutable i16 (represented as i32 on the stack)
    ];
    append_section(&mut module, 1, &types);

    let globals = [
        global_entry(
            &[0x64, 0x00], // (ref 0)
            &[
                0x41, 0x07, // i32.const 7
                0x42, 0x09, // i64.const 9
                0x41, 0x0a, // i32.const 10
                0xfb, 0x1c, // ref.i31, a subtype of the field's anyref type
                0xfb, 0x00, 0x00, // struct.new 0
            ],
        ),
        global_entry(
            &[0x64, 0x00],       // (ref 0)
            &[0xfb, 0x01, 0x00], // struct.new_default 0
        ),
        global_entry(
            &[0x64, 0x01], // (ref 1)
            &[
                0x41, 0x02, // i32.const 2
                0x41, 0x03, // i32.const 3
                0xfb, 0x06, 0x01, // array.new 1
            ],
        ),
        global_entry(
            &[0x64, 0x01], // (ref 1)
            &[
                0x41, 0x03, // i32.const 3
                0xfb, 0x07, 0x01, // array.new_default 1
            ],
        ),
        global_entry(
            &[0x64, 0x01], // (ref 1)
            &[
                0x41, 0x04, // i32.const 4
                0x41, 0x05, // i32.const 5
                0xfb, 0x08, 0x01, 0x02, // array.new_fixed 1 2
            ],
        ),
        global_entry(
            &[0x64, 0x6c], // (ref i31)
            &[
                0x41, 0x06, // i32.const 6
                0xfb, 0x1c, // ref.i31
            ],
        ),
        global_entry(
            &[0x6f], // (ref null extern)
            &[
                0xd0, 0x6e, // ref.null any
                0xfb, 0x1b, // extern.convert_any
            ],
        ),
        global_entry(
            &[0x6e], // (ref null any)
            &[
                0xd0, 0x6f, // ref.null extern
                0xfb, 0x1a, // any.convert_extern
            ],
        ),
        global_entry(
            &[0x64, 0x6e], // (ref any)
            &[
                0x41, 0x08, // i32.const 8
                0xfb, 0x1c, // ref.i31
                0xfb, 0x1b, // extern.convert_any
                0xfb, 0x1a, // any.convert_extern
            ],
        ),
    ];

    let mut global_section = Vec::new();
    encode_u32(&mut global_section, globals.len() as u32);
    for global in globals {
        global_section.extend(global);
    }
    append_section(&mut module, 6, &global_section);
    module
}

fn compile_module() -> wedge::ir::Program {
    let program = Compiler::default()
        .compile(&gc_const_expr_module())
        .expect("compile standard GC constant expressions");
    program
        .verify()
        .expect("GC constant-expression lowering must produce valid IR");
    program
}

fn initializer(program: &wedge::ir::Program, index: usize) -> &ConstExpr {
    program.globals[index]
        .initializer
        .as_ref()
        .expect("defined global has an initializer")
}

fn operation<'a>(expression: &'a ConstExpr, opcode: CoreOpcode) -> &'a Operation {
    expression
        .instructions
        .iter()
        .map(|instruction| &instruction.operation)
        .find(|operation| operation.kind == OperationKind::Core(opcode))
        .unwrap_or_else(|| panic!("initializer did not lower {}", opcode.mnemonic()))
}

fn reference(nullable: bool, heap: HeapType) -> ValueType {
    ValueType::Ref(RefType { nullable, heap })
}

fn replace_first(module: &mut [u8], original: &[u8], replacement: &[u8]) {
    assert_eq!(original.len(), replacement.len());
    let offset = module
        .windows(original.len())
        .position(|window| window == original)
        .expect("opcode exists in test module");
    module[offset..offset + replacement.len()].copy_from_slice(replacement);
}

fn assert_profile_rejection(wasm: &[u8]) {
    let compiler = Compiler::default();
    assert!(matches!(
        compiler.validate(wasm),
        Err(CompileError::InvalidWasm { .. })
    ));
    assert!(matches!(
        compiler.compile(wasm),
        Err(CompileError::InvalidWasm { .. })
    ));
}

#[test]
fn lowers_every_standard_gc_constant_expression_operator() {
    let program = compile_module();
    let cases = [
        (0, CoreOpcode::StructNew),
        (1, CoreOpcode::StructNewDefault),
        (2, CoreOpcode::ArrayNew),
        (3, CoreOpcode::ArrayNewDefault),
        (4, CoreOpcode::ArrayNewFixed),
        (5, CoreOpcode::RefI31),
        (6, CoreOpcode::ExternConvertAny),
        (7, CoreOpcode::AnyConvertExtern),
    ];

    for (global, opcode) in cases {
        let operation = operation(initializer(&program, global), opcode);
        assert_eq!(operation.kind, OperationKind::Core(opcode));
        assert_eq!(operation.mnemonic, opcode.mnemonic());
    }
}

#[test]
fn instantiates_gc_allocation_signatures_and_owned_immediates() {
    let program = compile_module();
    let anyref = reference(true, HeapType::Any);
    let struct_ref = reference(false, HeapType::Concrete(TypeId(0)));
    let array_ref = reference(false, HeapType::Concrete(TypeId(1)));

    let struct_new = operation(initializer(&program, 0), CoreOpcode::StructNew);
    assert_eq!(
        struct_new.signature.params,
        [ValueType::I32, ValueType::I64, anyref]
    );
    assert_eq!(struct_new.signature.results, [struct_ref.clone()]);
    assert_eq!(struct_new.immediates, [Immediate::Type(TypeId(0))]);

    let struct_default = operation(initializer(&program, 1), CoreOpcode::StructNewDefault);
    assert!(struct_default.signature.params.is_empty());
    assert_eq!(struct_default.signature.results, [struct_ref]);
    assert_eq!(struct_default.immediates, [Immediate::Type(TypeId(0))]);

    let array_new = operation(initializer(&program, 2), CoreOpcode::ArrayNew);
    assert_eq!(array_new.signature.params, [ValueType::I32, ValueType::I32]);
    assert_eq!(array_new.signature.results, [array_ref.clone()]);
    assert_eq!(array_new.immediates, [Immediate::Type(TypeId(1))]);

    let array_default = operation(initializer(&program, 3), CoreOpcode::ArrayNewDefault);
    assert_eq!(array_default.signature.params, [ValueType::I32]);
    assert_eq!(array_default.signature.results, [array_ref.clone()]);

    let array_fixed = operation(initializer(&program, 4), CoreOpcode::ArrayNewFixed);
    assert_eq!(
        array_fixed.signature.params,
        [ValueType::I32, ValueType::I32]
    );
    assert_eq!(array_fixed.signature.results, [array_ref]);
    assert_eq!(
        array_fixed.immediates,
        [Immediate::Type(TypeId(1)), Immediate::U32(2)]
    );

    for operation in [
        struct_new,
        struct_default,
        array_new,
        array_default,
        array_fixed,
    ] {
        let effects = effects_for_operation(operation);
        assert!(effects.allocates);
        assert!(effects.traps.contains(&TrapCode::AllocationFailure));
        assert!(effects.accesses.iter().any(|effect| {
            effect.resource == EffectResource::GcHeap && effect.access == EffectAccess::Write
        }));
    }
}

#[test]
fn reference_conversions_preserve_operand_nullability() {
    let program = compile_module();

    let nullable_to_extern = operation(initializer(&program, 6), CoreOpcode::ExternConvertAny);
    assert_eq!(
        nullable_to_extern.signature.params,
        [reference(true, HeapType::Any)]
    );
    assert_eq!(
        nullable_to_extern.signature.results,
        [reference(true, HeapType::Extern)]
    );

    let nullable_to_any = operation(initializer(&program, 7), CoreOpcode::AnyConvertExtern);
    assert_eq!(
        nullable_to_any.signature.params,
        [reference(true, HeapType::Extern)]
    );
    assert_eq!(
        nullable_to_any.signature.results,
        [reference(true, HeapType::Any)]
    );

    let round_trip = initializer(&program, 8);
    let non_null_to_extern = operation(round_trip, CoreOpcode::ExternConvertAny);
    assert_eq!(
        non_null_to_extern.signature.params,
        [reference(false, HeapType::I31)]
    );
    assert_eq!(
        non_null_to_extern.signature.results,
        [reference(false, HeapType::Extern)]
    );
    let non_null_to_any = operation(round_trip, CoreOpcode::AnyConvertExtern);
    assert_eq!(
        non_null_to_any.signature.params,
        [reference(false, HeapType::Extern)]
    );
    assert_eq!(
        non_null_to_any.signature.results,
        [reference(false, HeapType::Any)]
    );
}

#[test]
fn retains_precise_source_information_for_gc_const_instructions() {
    let program = compile_module();

    for global in &program.globals {
        let expression = global
            .initializer
            .as_ref()
            .expect("defined global has an initializer");
        let expression_span = expression.source.byte_span.expect("expression byte span");
        for (ordinal, instruction) in expression.instructions.iter().enumerate() {
            assert_eq!(instruction.source.ordinal, Some(ordinal as u32));
            let span = instruction.source.byte_span.expect("instruction byte span");
            assert!(span.start < span.end);
            assert!(expression_span.start <= span.start);
            assert!(span.end <= expression_span.end);
        }
    }
}

#[test]
fn rejects_nonstandard_gc_constant_expression_variants() {
    let mut descriptor_allocation = gc_const_expr_module();
    replace_first(
        &mut descriptor_allocation,
        &[0xfb, 0x00, 0x00], // struct.new 0
        &[0xfb, 0x20, 0x00], // struct.new_desc 0
    );
    assert_profile_rejection(&descriptor_allocation);

    let mut shared_i31 = gc_const_expr_module();
    replace_first(
        &mut shared_i31,
        &[0xfb, 0x1c], // ref.i31
        &[0xfe, 0x72], // ref.i31_shared
    );
    assert_profile_rejection(&shared_i31);
}
