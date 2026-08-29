// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end contracts for non-control Core WebAssembly operators.

use wedge::Compiler;
use wedge::ir::{
    DataId, ElementId, FunctionType, GlobalId, HeapType, Immediate, Instruction, MemoryArgument,
    MemoryId, OperationKind, Program, RefType, TableId, ValueType,
};
use wedge::opcode::CoreOpcode;
mod fixture_support;

use fixture_support::compile_fixture;

fn instructions(program: &Program) -> impl Iterator<Item = &Instruction> {
    program
        .functions
        .iter()
        .filter_map(|function| function.body.as_ref())
        .flat_map(|body| &body.blocks)
        .flat_map(|block| &block.instructions)
}

fn instruction<'a>(program: &'a Program, mnemonic: &str) -> &'a Instruction {
    instructions(program)
        .find(|instruction| instruction.operation.mnemonic == mnemonic)
        .unwrap_or_else(|| panic!("fixture did not lower {mnemonic}"))
}

fn signature(params: Vec<ValueType>, results: Vec<ValueType>) -> FunctionType {
    FunctionType { params, results }
}

fn externref() -> ValueType {
    ValueType::Ref(RefType {
        nullable: true,
        heap: HeapType::Extern,
    })
}

#[test]
fn lowers_scalar_numeric_and_conversion_fixtures() {
    for name in [
        "numeric",
        "saturating_conversions",
        "scalar_leaf_operations",
        "sign_extension",
    ] {
        compile_fixture(name);
    }
}

#[test]
fn lowers_fixed_and_relaxed_simd_fixtures() {
    for name in ["simd", "simd_lane_operations", "relaxed_simd"] {
        compile_fixture(name);
    }
}

#[test]
fn lowers_global_accesses() {
    compile_fixture("mutable_globals");
}

#[test]
fn lowers_memory32_memory64_and_multi_memory() {
    for name in ["memory", "memory64", "multi_memory"] {
        compile_fixture(name);
    }
}

#[test]
fn lowers_bulk_memory_and_segment_operations() {
    compile_fixture("bulk_memory");
}

#[test]
fn lowers_table32_and_table64_operations() {
    for name in ["reference_types", "table64", "table_leaf_operations"] {
        compile_fixture(name);
    }
}

#[test]
fn preserves_gc_composite_type_declarations() {
    // The pinned WABT accepts final GC type declarations with --enable-gc,
    // but does not yet tokenize GC instructions such as struct.new. Keep the
    // executable GC lowering gap visible without bypassing the WAT pipeline.
    let program = compile_fixture("gc_types");
    assert_eq!(program.types.len(), 2);
}

#[test]
fn gives_every_scalar_leaf_a_canonical_core_identity() {
    let program = compile_fixture("scalar_leaf_operations");

    for instruction in instructions(&program) {
        let OperationKind::Core(opcode) = instruction.operation.kind else {
            panic!(
                "{} was lowered without a Core opcode identity",
                instruction.operation.mnemonic
            );
        };
        assert_eq!(instruction.operation.mnemonic, opcode.mnemonic());
    }

    assert_eq!(
        instruction(&program, "i32.rotr").operation.kind,
        OperationKind::Core(CoreOpcode::I32Rotr)
    );
}

#[test]
fn instantiates_scalar_comparison_and_conversion_signatures() {
    let program = compile_fixture("scalar_leaf_operations");

    assert_eq!(
        instruction(&program, "i64.ge_s").operation.signature,
        signature(vec![ValueType::I64, ValueType::I64], vec![ValueType::I32])
    );
    assert_eq!(
        instruction(&program, "f64.convert_i64_u")
            .operation
            .signature,
        signature(vec![ValueType::I64], vec![ValueType::F64])
    );
    assert_eq!(
        instruction(&program, "i32.trunc_f64_s").operation.signature,
        signature(vec![ValueType::F64], vec![ValueType::I32])
    );
}

#[test]
fn owns_shuffle_and_lane_immediates() {
    let simd = compile_fixture("simd");
    let shuffle = instruction(&simd, "i8x16.shuffle");
    assert_eq!(
        shuffle.operation.immediates,
        [Immediate::Bytes(vec![
            0, 1, 2, 3, 16, 17, 18, 19, 4, 5, 6, 7, 20, 21, 22, 23,
        ])]
    );

    let lanes = compile_fixture("simd_lane_operations");
    let extract = instruction(&lanes, "i8x16.extract_lane_s");
    assert_eq!(extract.operation.immediates, [Immediate::Lane(7)]);
    assert_eq!(
        extract.operation.signature,
        signature(vec![ValueType::V128], vec![ValueType::I32])
    );
}

#[test]
fn owns_simd_lane_memory_arguments() {
    let program = compile_fixture("simd_lane_operations");
    let load = instruction(&program, "v128.load8_lane");

    assert_eq!(
        load.operation.immediates,
        [
            Immediate::MemoryArgument(MemoryArgument {
                memory: MemoryId(0),
                offset: 9,
                alignment_log2: 0,
            }),
            Immediate::Lane(3),
        ]
    );
    assert_eq!(
        load.operation.signature,
        signature(vec![ValueType::I32, ValueType::V128], vec![ValueType::V128])
    );
}

#[test]
fn owns_typed_global_and_memory_immediates() {
    let globals = compile_fixture("mutable_globals");
    let get = instruction(&globals, "global.get");
    let set = instruction(&globals, "global.set");
    assert_eq!(get.operation.immediates, [Immediate::Global(GlobalId(0))]);
    assert_eq!(
        get.operation.signature,
        signature(vec![], vec![ValueType::I32])
    );
    assert_eq!(set.operation.immediates, [Immediate::Global(GlobalId(0))]);
    assert_eq!(
        set.operation.signature,
        signature(vec![ValueType::I32], vec![])
    );

    let memory = compile_fixture("memory");
    let load = instruction(&memory, "i32.load");
    assert_eq!(
        load.operation.immediates,
        [Immediate::MemoryArgument(MemoryArgument {
            memory: MemoryId(0),
            offset: 4,
            alignment_log2: 2,
        })]
    );
    assert_eq!(
        load.operation.signature,
        signature(vec![ValueType::I32], vec![ValueType::I32])
    );
}

#[test]
fn derives_memory64_address_types_from_the_referenced_memory() {
    let program = compile_fixture("memory64");
    let load = instruction(&program, "i32.load");

    assert_eq!(
        load.operation.immediates,
        [Immediate::MemoryArgument(MemoryArgument {
            memory: MemoryId(0),
            offset: 0,
            alignment_log2: 2,
        })]
    );
    assert_eq!(
        load.operation.signature,
        signature(vec![ValueType::I64], vec![ValueType::I32])
    );
    assert_eq!(
        instruction(&program, "memory.grow").operation.signature,
        signature(vec![ValueType::I64], vec![ValueType::I64])
    );
}

#[test]
fn owns_multi_memory_and_bulk_segment_indices() {
    let memories = compile_fixture("multi_memory");
    let copy = instruction(&memories, "memory.copy");
    assert_eq!(
        copy.operation.immediates,
        [
            Immediate::Memory(MemoryId(1)),
            Immediate::Memory(MemoryId(0))
        ]
    );

    let bulk = compile_fixture("bulk_memory");
    let memory_init = instruction(&bulk, "memory.init");
    assert_eq!(
        memory_init.operation.immediates,
        [Immediate::Data(DataId(0)), Immediate::Memory(MemoryId(0))]
    );
    let table_init = instruction(&bulk, "table.init");
    assert_eq!(
        table_init.operation.immediates,
        [
            Immediate::Element(ElementId(0)),
            Immediate::Table(TableId(0))
        ]
    );
}

#[test]
fn owns_typed_table_indices_and_address_widths() {
    let table32 = compile_fixture("table_leaf_operations");
    let grow = instruction(&table32, "table.grow");
    assert_eq!(grow.operation.immediates, [Immediate::Table(TableId(0))]);
    assert_eq!(
        grow.operation.signature,
        signature(vec![externref(), ValueType::I32], vec![ValueType::I32])
    );

    let table64 = compile_fixture("table64");
    let get = instruction(&table64, "table.get");
    assert_eq!(get.operation.immediates, [Immediate::Table(TableId(0))]);
    assert_eq!(
        get.operation.signature,
        signature(vec![ValueType::I64], vec![externref()])
    );
}

#[test]
fn owns_reference_heap_type_immediates_and_signatures() {
    let program = compile_fixture("reference_types");
    let null = instruction(&program, "ref.null");
    assert_eq!(
        null.operation.immediates,
        [Immediate::HeapType(HeapType::Extern)]
    );
    assert_eq!(
        null.operation.signature,
        signature(vec![], vec![externref()])
    );

    let is_null = instruction(&program, "ref.is_null");
    assert_eq!(
        is_null.operation.signature,
        signature(vec![externref()], vec![ValueType::I32])
    );
}

#[test]
fn relaxed_simd_results_are_flagged_nondeterministic() {
    let program = compile_fixture("relaxed_simd");
    let relaxed: Vec<_> = instructions(&program)
        .filter(|instruction| instruction.operation.mnemonic.contains("relaxed"))
        .collect();
    assert!(!relaxed.is_empty(), "the fixture lowers relaxed operations");
    for instruction in relaxed {
        assert!(
            instruction.effects.nondeterministic && !instruction.effects.is_pure(),
            "{} is nondeterministic",
            instruction.operation.mnemonic
        );
    }
    assert!(
        instructions(&program)
            .filter(|instruction| !instruction.operation.mnemonic.contains("relaxed"))
            .all(|instruction| !instruction.effects.nondeterministic),
        "only relaxed operations are flagged"
    );
    assert!(program.to_string().contains("effects[nondeterministic]"));
}
