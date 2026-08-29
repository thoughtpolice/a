// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generative contracts for Core operation and type verification.
//!
//! Every generator here is bounded by construction and avoids `assume`,
//! `reject`, and filtering, so a derandomized run spends its whole case budget
//! on accepted cases. `derandomize` keeps the generated stream reproducible for
//! the pinned test configuration, the assertion helpers print their context
//! before panicking, and Hegel shrinks a failure to a minimal counterexample.

mod core_operation_test_support;

use core_operation_test_support::{
    ARRAY_TYPE, CALLEE_TYPE, PACKED_ARRAY_TYPE, REF_ARRAY_TYPE, STRUCT_TYPE, memory_argument,
    operation_program, reference, source,
};
use hegel::{Generator, TestCase, generators as gs};
use wedge::ir::*;
use wedge::opcode::CoreOpcode;

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

macro_rules! property_panic {
    ($($message:tt)*) => {{
        eprintln!($($message)*);
        panic!("property failed after printing its diagnostic");
    }};
}

macro_rules! property_assert {
    ($condition:expr, $($message:tt)*) => {{
        if !$condition {
            property_panic!($($message)*);
        }
    }};
}

macro_rules! property_assert_eq {
    ($left:expr, $right:expr, $($message:tt)*) => {{
        let left = &$left;
        let right = &$right;
        if left != right {
            eprintln!($($message)*);
            eprintln!("left: {left:#?}\nright: {right:#?}");
            panic!("property equality failed after printing its diagnostic");
        }
    }};
}

fn operation(opcode: CoreOpcode, params: &[ValueType], results: &[ValueType]) -> Operation {
    Operation::core(opcode, params.to_vec(), results.to_vec())
}

fn verify(operation: &Operation) -> Result<(), String> {
    operation_program(operation.clone())
        .verify()
        .map_err(|errors| errors.to_string())
}

fn assert_valid(operation: &Operation, subject: &str) {
    if let Err(error) = verify(operation) {
        property_panic!("valid {subject} was rejected: {operation:#?}\n{error}");
    }
}

fn assert_schema_rejected(operation: &Operation, subject: &str) {
    let error = expect_rejected(operation, subject);
    property_assert!(
        error.contains("invalid Core schema"),
        "{subject} was rejected without a Core-schema diagnostic: {operation:#?}\n{error}"
    );
}

fn expect_rejected(operation: &Operation, subject: &str) -> String {
    match verify(operation) {
        Ok(()) => property_panic!("invalid {subject} was accepted: {operation:#?}"),
        Err(error) => error,
    }
}

fn draw_entity_index(tc: &TestCase) -> u32 {
    match tc.draw(gs::integers::<u8>().max_value(2)) {
        0 => tc.draw(gs::integers::<u32>().max_value(12)),
        1 => tc.draw(gs::integers::<u32>()),
        2 => u32::MAX,
        _ => unreachable!(),
    }
}

fn draw_heap_type(tc: &TestCase) -> HeapType {
    match tc.draw(gs::integers::<u8>().max_value(12)) {
        0 => HeapType::Any,
        1 => HeapType::Eq,
        2 => HeapType::I31,
        3 => HeapType::Struct,
        4 => HeapType::Array,
        5 => HeapType::None,
        6 => HeapType::Func,
        7 => HeapType::NoFunc,
        8 => HeapType::Extern,
        9 => HeapType::NoExtern,
        10 => HeapType::Exn,
        11 => HeapType::NoExn,
        12 => HeapType::Concrete(TypeId(draw_entity_index(tc))),
        _ => unreachable!(),
    }
}

fn draw_value_type(tc: &TestCase) -> ValueType {
    match tc.draw(gs::integers::<u8>().max_value(5)) {
        0 => ValueType::I32,
        1 => ValueType::I64,
        2 => ValueType::F32,
        3 => ValueType::F64,
        4 => ValueType::V128,
        5 => reference(tc.draw(gs::booleans()), draw_heap_type(tc)),
        _ => unreachable!(),
    }
}

fn draw_bytes(tc: &TestCase, maximum: usize) -> Vec<u8> {
    let length = tc.draw(gs::integers::<usize>().max_value(maximum));
    (0..length).map(|_| tc.draw(gs::integers::<u8>())).collect()
}

fn draw_immediate(tc: &TestCase) -> Immediate {
    match tc.draw(gs::integers::<u8>().max_value(21)) {
        0 => Immediate::U32(tc.draw(gs::integers::<u32>())),
        1 => Immediate::U64(tc.draw(gs::integers::<u64>())),
        2 => Immediate::S32(tc.draw(gs::integers::<i32>())),
        3 => Immediate::S64(tc.draw(gs::integers::<i64>())),
        4 => Immediate::F32(tc.draw(gs::integers::<u32>())),
        5 => Immediate::F64(tc.draw(gs::integers::<u64>())),
        6 => {
            let mut bytes = [0; 16];
            for byte in &mut bytes {
                *byte = tc.draw(gs::integers::<u8>());
            }
            Immediate::V128(bytes)
        }
        7 => Immediate::Lane(tc.draw(gs::integers::<u8>())),
        8 => Immediate::Bytes(draw_bytes(tc, 20)),
        9 => Immediate::Type(TypeId(draw_entity_index(tc))),
        10 => Immediate::Function(FunctionId(draw_entity_index(tc))),
        11 => Immediate::Table(TableId(draw_entity_index(tc))),
        12 => Immediate::Memory(MemoryId(draw_entity_index(tc))),
        13 => Immediate::Global(GlobalId(draw_entity_index(tc))),
        14 => Immediate::Tag(TagId(draw_entity_index(tc))),
        15 => Immediate::Element(ElementId(draw_entity_index(tc))),
        16 => Immediate::Data(DataId(draw_entity_index(tc))),
        17 => Immediate::Local(LocalId(draw_entity_index(tc))),
        18 => Immediate::Region(RegionId(draw_entity_index(tc))),
        19 => Immediate::ValueType(draw_value_type(tc)),
        20 => Immediate::HeapType(draw_heap_type(tc)),
        21 => Immediate::MemoryArgument(MemoryArgument {
            memory: MemoryId(draw_entity_index(tc)),
            offset: tc.draw(gs::integers::<u64>()),
            alignment_log2: tc.draw(gs::integers::<u8>()),
        }),
        _ => unreachable!(),
    }
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn arbitrary_forged_operations_verify_totally_and_deterministically(tc: TestCase) {
    let opcode = tc.draw(gs::sampled_from(CoreOpcode::ALL).print_as_debug());
    let parameter_count = tc.draw(gs::integers::<usize>().max_value(4));
    let result_count = tc.draw(gs::integers::<usize>().max_value(3));
    let immediate_count = tc.draw(gs::integers::<usize>().max_value(4));
    let params = (0..parameter_count).map(|_| draw_value_type(&tc)).collect();
    let results = (0..result_count).map(|_| draw_value_type(&tc)).collect();
    let immediates = (0..immediate_count).map(|_| draw_immediate(&tc)).collect();
    let operation = Operation::core(opcode, params, results).with_immediates(immediates);
    let program = operation_program(operation.clone());

    let first = program.verify().map_err(|errors| errors.to_string());
    let second = program.verify().map_err(|errors| errors.to_string());
    property_assert_eq!(
        first,
        second,
        "forged-operation diagnostics changed between runs: {operation:#?}"
    );
    if first.is_ok() {
        property_assert!(
            opcode.is_standard_wasm3(),
            "out-of-profile operation verified successfully: {operation:#?}"
        );
    }
}

fn assert_empty_inventory_probe_fails_closed(opcode: CoreOpcode) {
    let operation = Operation::core(opcode, vec![], vec![]);
    let result = verify(&operation);

    if opcode == CoreOpcode::Nop {
        assert_valid(&operation, "nop inventory probe");
        return;
    }

    let error = match result {
        Ok(()) => {
            property_panic!("non-nop empty inventory probe was accepted: {operation:#?}")
        }
        Err(error) => error,
    };
    if !opcode.is_standard_wasm3() {
        property_assert!(
            error.contains("out-of-profile core opcode"),
            "out-of-profile probe lacked its profile diagnostic: {operation:#?}\n{error}"
        );
    }
}

#[test]
fn every_empty_parser_inventory_probe_fails_closed() {
    for &opcode in CoreOpcode::ALL {
        assert_empty_inventory_probe_fails_closed(opcode);
    }
}

fn signature_seed_operations() -> Vec<Operation> {
    let anyref = reference(true, HeapType::Any);
    let externref = reference(true, HeapType::Extern);
    let structref = reference(true, HeapType::Concrete(STRUCT_TYPE));
    let arrayref = reference(true, HeapType::Concrete(ARRAY_TYPE));
    let callee = reference(true, HeapType::Concrete(CALLEE_TYPE));
    vec![
        operation(
            CoreOpcode::I32Add,
            &[ValueType::I32, ValueType::I32],
            &[ValueType::I32],
        ),
        operation(CoreOpcode::I64Eqz, &[ValueType::I64], &[ValueType::I32]),
        operation(
            CoreOpcode::F32ConvertI64U,
            &[ValueType::I64],
            &[ValueType::F32],
        ),
        operation(
            CoreOpcode::I32TruncSatF64S,
            &[ValueType::F64],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::I8x16Splat,
            &[ValueType::I32],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::I64x2ExtractLane,
            &[ValueType::V128],
            &[ValueType::I64],
        )
        .with_immediates(vec![Immediate::Lane(0)]),
        operation(
            CoreOpcode::I32x4Add,
            &[ValueType::V128, ValueType::V128],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::V128Bitselect,
            &[ValueType::V128, ValueType::V128, ValueType::V128],
            &[ValueType::V128],
        ),
        operation(
            CoreOpcode::Select,
            &[ValueType::I32, ValueType::I32, ValueType::I32],
            &[ValueType::I32],
        ),
        operation(
            CoreOpcode::TypedSelect,
            &[ValueType::I64, ValueType::I64, ValueType::I32],
            &[ValueType::I64],
        )
        .with_immediates(vec![Immediate::ValueType(ValueType::I64)]),
        operation(
            CoreOpcode::Call,
            &[reference(false, HeapType::Concrete(STRUCT_TYPE))],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Function(FunctionId(0))]),
        operation(
            CoreOpcode::CallIndirect,
            &[
                reference(false, HeapType::Concrete(STRUCT_TYPE)),
                ValueType::I32,
            ],
            &[ValueType::I32],
        )
        .with_immediates(vec![
            Immediate::Type(CALLEE_TYPE),
            Immediate::Table(TableId(0)),
        ]),
        operation(
            CoreOpcode::CallRef,
            &[reference(false, HeapType::Concrete(STRUCT_TYPE)), callee],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(CALLEE_TYPE)]),
        operation(CoreOpcode::GlobalGet, &[], &[ValueType::I32])
            .with_immediates(vec![Immediate::Global(GlobalId(0))]),
        operation(
            CoreOpcode::GlobalSet,
            &[reference(false, HeapType::Extern)],
            &[],
        )
        .with_immediates(vec![Immediate::Global(GlobalId(1))]),
        operation(CoreOpcode::I32Load, &[ValueType::I32], &[ValueType::I32])
            .with_immediates(vec![memory_argument(MemoryId(0), 8, 2)]),
        operation(
            CoreOpcode::V128Store,
            &[ValueType::I64, ValueType::V128],
            &[],
        )
        .with_immediates(vec![memory_argument(MemoryId(1), 8, 4)]),
        operation(
            CoreOpcode::MemoryCopy,
            &[ValueType::I64, ValueType::I32, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Memory(MemoryId(1)),
            Immediate::Memory(MemoryId(0)),
        ]),
        operation(
            CoreOpcode::MemoryInit,
            &[ValueType::I64, ValueType::I32, ValueType::I32],
            &[],
        )
        .with_immediates(vec![
            Immediate::Data(DataId(0)),
            Immediate::Memory(MemoryId(1)),
        ]),
        operation(
            CoreOpcode::TableGet,
            &[ValueType::I64],
            &[externref.clone()],
        )
        .with_immediates(vec![Immediate::Table(TableId(1))]),
        operation(
            CoreOpcode::TableGrow,
            &[reference(true, HeapType::Func), ValueType::I32],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Table(TableId(0))]),
        operation(CoreOpcode::RefIsNull, &[anyref.clone()], &[ValueType::I32]),
        operation(
            CoreOpcode::RefAsNonNull,
            &[externref.clone()],
            &[reference(false, HeapType::Extern)],
        ),
        operation(
            CoreOpcode::RefCastNonNull,
            &[anyref],
            &[reference(false, HeapType::Concrete(STRUCT_TYPE))],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Concrete(STRUCT_TYPE))]),
        operation(
            CoreOpcode::StructNew,
            &[ValueType::I32, ValueType::I32],
            &[reference(false, HeapType::Concrete(STRUCT_TYPE))],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE)]),
        operation(
            CoreOpcode::StructGet,
            &[structref.clone()],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(0)]),
        operation(CoreOpcode::StructSet, &[structref, ValueType::I32], &[])
            .with_immediates(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(1)]),
        operation(
            CoreOpcode::ArrayNew,
            &[ValueType::I32, ValueType::I32],
            &[reference(false, HeapType::Concrete(ARRAY_TYPE))],
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]),
        operation(
            CoreOpcode::ArrayGet,
            &[arrayref.clone(), ValueType::I32],
            &[ValueType::I32],
        )
        .with_immediates(vec![Immediate::Type(ARRAY_TYPE)]),
        operation(
            CoreOpcode::ArrayCopy,
            &[
                arrayref.clone(),
                ValueType::I32,
                arrayref,
                ValueType::I32,
                ValueType::I32,
            ],
            &[],
        )
        .with_immediates(vec![
            Immediate::Type(ARRAY_TYPE),
            Immediate::Type(ARRAY_TYPE),
        ]),
    ]
}

fn incompatible_type(ty: &ValueType) -> ValueType {
    match ty {
        ValueType::I32 => ValueType::I64,
        ValueType::I64 => ValueType::F32,
        ValueType::F32 => ValueType::F64,
        ValueType::F64 => ValueType::V128,
        ValueType::V128 | ValueType::Ref(_) => ValueType::I32,
    }
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn one_incompatible_signature_slot_is_always_rejected(tc: TestCase) {
    let seeds = signature_seed_operations();
    let seed = tc.draw(gs::integers::<usize>().max_value(seeds.len() - 1));
    let mut operation = seeds[seed].clone();
    assert_valid(&operation, "signature-mutation baseline");

    let parameter_count = operation.signature.params.len();
    let slot = tc.draw(
        gs::integers::<usize>().max_value(parameter_count + operation.signature.results.len() - 1),
    );
    let ty = if slot < parameter_count {
        &mut operation.signature.params[slot]
    } else {
        &mut operation.signature.results[slot - parameter_count]
    };
    *ty = incompatible_type(ty);

    assert_schema_rejected(&operation, "single-slot signature mutation");
}

fn immediate_seed_operations() -> Vec<Operation> {
    let mut seeds = signature_seed_operations()
        .into_iter()
        .filter(|operation| !operation.immediates.is_empty())
        .collect::<Vec<_>>();
    seeds.extend([
        operation(CoreOpcode::I32Const, &[], &[ValueType::I32])
            .with_immediates(vec![Immediate::S32(7)]),
        operation(
            CoreOpcode::RefNull,
            &[],
            &[reference(true, HeapType::Extern)],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Extern)]),
        operation(
            CoreOpcode::I8x16Shuffle,
            &[ValueType::V128, ValueType::V128],
            &[ValueType::V128],
        )
        .with_immediates(vec![Immediate::Bytes((0_u8..16).collect())]),
    ]);
    seeds
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn immediate_deletion_insertion_and_kind_corruption_are_rejected(tc: TestCase) {
    let seeds = immediate_seed_operations();
    let seed = tc.draw(gs::integers::<usize>().max_value(seeds.len() - 1));
    let mut operation = seeds[seed].clone();
    assert_valid(&operation, "immediate-mutation baseline");

    let mutation = tc.draw(gs::integers::<u8>().max_value(2));
    let wrong = Immediate::Region(RegionId(tc.draw(gs::integers::<u32>())));
    match mutation {
        0 => {
            let index = tc.draw(gs::integers::<usize>().max_value(operation.immediates.len() - 1));
            operation.immediates.remove(index);
        }
        1 => {
            let index = tc.draw(gs::integers::<usize>().max_value(operation.immediates.len()));
            operation.immediates.insert(index, wrong);
        }
        2 => {
            let index = tc.draw(gs::integers::<usize>().max_value(operation.immediates.len() - 1));
            operation.immediates[index] = wrong;
        }
        _ => unreachable!(),
    }

    assert_schema_rejected(&operation, "single immediate mutation");
}

#[derive(Clone, Debug)]
enum LaneKind {
    Extract(ValueType),
    Replace(ValueType),
    MemoryLoad { alignment_log2: u8 },
    MemoryStore { alignment_log2: u8 },
}

#[derive(Clone, Debug)]
struct LaneCase {
    opcode: CoreOpcode,
    bound: u8,
    kind: LaneKind,
}
hegel::pretty_print_as_debug!(LaneCase);

fn lane_cases() -> Vec<LaneCase> {
    use CoreOpcode::*;
    use LaneKind::*;
    vec![
        LaneCase {
            opcode: I8x16ExtractLaneS,
            bound: 16,
            kind: Extract(ValueType::I32),
        },
        LaneCase {
            opcode: I8x16ExtractLaneU,
            bound: 16,
            kind: Extract(ValueType::I32),
        },
        LaneCase {
            opcode: I8x16ReplaceLane,
            bound: 16,
            kind: Replace(ValueType::I32),
        },
        LaneCase {
            opcode: I16x8ExtractLaneS,
            bound: 8,
            kind: Extract(ValueType::I32),
        },
        LaneCase {
            opcode: I16x8ExtractLaneU,
            bound: 8,
            kind: Extract(ValueType::I32),
        },
        LaneCase {
            opcode: I16x8ReplaceLane,
            bound: 8,
            kind: Replace(ValueType::I32),
        },
        LaneCase {
            opcode: I32x4ExtractLane,
            bound: 4,
            kind: Extract(ValueType::I32),
        },
        LaneCase {
            opcode: I32x4ReplaceLane,
            bound: 4,
            kind: Replace(ValueType::I32),
        },
        LaneCase {
            opcode: F32x4ExtractLane,
            bound: 4,
            kind: Extract(ValueType::F32),
        },
        LaneCase {
            opcode: F32x4ReplaceLane,
            bound: 4,
            kind: Replace(ValueType::F32),
        },
        LaneCase {
            opcode: I64x2ExtractLane,
            bound: 2,
            kind: Extract(ValueType::I64),
        },
        LaneCase {
            opcode: I64x2ReplaceLane,
            bound: 2,
            kind: Replace(ValueType::I64),
        },
        LaneCase {
            opcode: F64x2ExtractLane,
            bound: 2,
            kind: Extract(ValueType::F64),
        },
        LaneCase {
            opcode: F64x2ReplaceLane,
            bound: 2,
            kind: Replace(ValueType::F64),
        },
        LaneCase {
            opcode: V128Load8Lane,
            bound: 16,
            kind: MemoryLoad { alignment_log2: 0 },
        },
        LaneCase {
            opcode: V128Load16Lane,
            bound: 8,
            kind: MemoryLoad { alignment_log2: 1 },
        },
        LaneCase {
            opcode: V128Load32Lane,
            bound: 4,
            kind: MemoryLoad { alignment_log2: 2 },
        },
        LaneCase {
            opcode: V128Load64Lane,
            bound: 2,
            kind: MemoryLoad { alignment_log2: 3 },
        },
        LaneCase {
            opcode: V128Store8Lane,
            bound: 16,
            kind: MemoryStore { alignment_log2: 0 },
        },
        LaneCase {
            opcode: V128Store16Lane,
            bound: 8,
            kind: MemoryStore { alignment_log2: 1 },
        },
        LaneCase {
            opcode: V128Store32Lane,
            bound: 4,
            kind: MemoryStore { alignment_log2: 2 },
        },
        LaneCase {
            opcode: V128Store64Lane,
            bound: 2,
            kind: MemoryStore { alignment_log2: 3 },
        },
    ]
}

fn lane_operation(case: &LaneCase, lane: u8) -> Operation {
    match &case.kind {
        LaneKind::Extract(scalar) => operation(
            case.opcode,
            &[ValueType::V128],
            std::slice::from_ref(scalar),
        )
        .with_immediates(vec![Immediate::Lane(lane)]),
        LaneKind::Replace(scalar) => operation(
            case.opcode,
            &[ValueType::V128, scalar.clone()],
            &[ValueType::V128],
        )
        .with_immediates(vec![Immediate::Lane(lane)]),
        LaneKind::MemoryLoad { alignment_log2 } => operation(
            case.opcode,
            &[ValueType::I32, ValueType::V128],
            &[ValueType::V128],
        )
        .with_immediates(vec![
            memory_argument(MemoryId(0), 0, *alignment_log2),
            Immediate::Lane(lane),
        ]),
        LaneKind::MemoryStore { alignment_log2 } => {
            operation(case.opcode, &[ValueType::I32, ValueType::V128], &[]).with_immediates(vec![
                memory_argument(MemoryId(0), 0, *alignment_log2),
                Immediate::Lane(lane),
            ])
        }
    }
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn every_simd_lane_byte_obeys_its_shape_bound(tc: TestCase) {
    let cases = lane_cases();
    let case = tc.draw(gs::sampled_from(cases));
    let lane = tc.draw(gs::integers::<u8>());
    let operation = lane_operation(&case, lane);
    let expected = lane < case.bound;
    let result = verify(&operation);
    property_assert_eq!(
        result.is_ok(),
        expected,
        "lane oracle disagreed for {case:?}, lane {lane}: {operation:#?}\n{result:?}"
    );
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn shuffle_validity_is_exactly_selector_range_validity(tc: TestCase) {
    let should_be_valid = tc.draw(gs::booleans());
    let mut lanes = tc.draw(
        gs::vecs(gs::integers::<u8>().max_value(31))
            .min_size(16)
            .max_size(16),
    );
    if !should_be_valid {
        let index = tc.draw(gs::integers::<usize>().max_value(15));
        lanes[index] = tc.draw(gs::integers::<u8>().min_value(32));
    }
    let operation = operation(
        CoreOpcode::I8x16Shuffle,
        &[ValueType::V128, ValueType::V128],
        &[ValueType::V128],
    )
    .with_immediates(vec![Immediate::Bytes(lanes.clone())]);
    let expected = lanes.len() == 16 && lanes.iter().all(|lane| *lane < 32);
    let result = verify(&operation);
    property_assert_eq!(
        result.is_ok(),
        expected,
        "shuffle oracle disagreed for {lanes:?}: {operation:#?}\n{result:?}"
    );
}

#[derive(Clone, Debug)]
struct MemoryCase {
    opcode: CoreOpcode,
    value: ValueType,
    natural_alignment_log2: u8,
    is_store: bool,
}
hegel::pretty_print_as_debug!(MemoryCase);

fn memory_cases() -> Vec<MemoryCase> {
    vec![
        MemoryCase {
            opcode: CoreOpcode::I32Load,
            value: ValueType::I32,
            natural_alignment_log2: 2,
            is_store: false,
        },
        MemoryCase {
            opcode: CoreOpcode::I64Load8U,
            value: ValueType::I64,
            natural_alignment_log2: 0,
            is_store: false,
        },
        MemoryCase {
            opcode: CoreOpcode::F64Load,
            value: ValueType::F64,
            natural_alignment_log2: 3,
            is_store: false,
        },
        MemoryCase {
            opcode: CoreOpcode::I64Store32,
            value: ValueType::I64,
            natural_alignment_log2: 2,
            is_store: true,
        },
        MemoryCase {
            opcode: CoreOpcode::F32Store,
            value: ValueType::F32,
            natural_alignment_log2: 2,
            is_store: true,
        },
        MemoryCase {
            opcode: CoreOpcode::V128Load,
            value: ValueType::V128,
            natural_alignment_log2: 4,
            is_store: false,
        },
        MemoryCase {
            opcode: CoreOpcode::V128Load8Splat,
            value: ValueType::V128,
            natural_alignment_log2: 0,
            is_store: false,
        },
        MemoryCase {
            opcode: CoreOpcode::V128Store,
            value: ValueType::V128,
            natural_alignment_log2: 4,
            is_store: true,
        },
    ]
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn memory_validity_matches_width_offset_and_alignment_rules(tc: TestCase) {
    let cases = memory_cases();
    let case = tc.draw(gs::sampled_from(cases));
    let memory64 = tc.draw(gs::booleans());
    let oversized_memory32_offset = tc.draw(gs::booleans());
    let offset = if memory64 {
        tc.draw(gs::integers::<u64>())
    } else if oversized_memory32_offset {
        tc.draw(gs::integers::<u64>().min_value(u64::from(u32::MAX) + 1))
    } else {
        tc.draw(gs::integers::<u64>().max_value(u64::from(u32::MAX)))
    };
    let alignment_log2 = tc.draw(gs::integers::<u8>().max_value(case.natural_alignment_log2 + 2));
    let memory = if memory64 { MemoryId(1) } else { MemoryId(0) };
    let address = if memory64 {
        ValueType::I64
    } else {
        ValueType::I32
    };
    let (params, results) = if case.is_store {
        (vec![address, case.value.clone()], vec![])
    } else {
        (vec![address], vec![case.value.clone()])
    };
    let operation = Operation::core(case.opcode, params, results)
        .with_immediates(vec![memory_argument(memory, offset, alignment_log2)]);
    let expected =
        alignment_log2 <= case.natural_alignment_log2 && (memory64 || !oversized_memory32_offset);
    let result = verify(&operation);
    property_assert_eq!(
        result.is_ok(),
        expected,
        "memory oracle disagreed for {case:?}, memory64={memory64}, offset={offset}, alignment={alignment_log2}: {operation:#?}\n{result:?}"
    );
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn array_new_fixed_relates_count_to_every_generated_operand(tc: TestCase) {
    let length = tc.draw(gs::integers::<u32>().max_value(32));
    let array_kind = tc.draw(gs::integers::<u8>().max_value(2));
    let (ty, elements) = match array_kind {
        0 => (ARRAY_TYPE, vec![ValueType::I32; length as usize]),
        1 => (PACKED_ARRAY_TYPE, vec![ValueType::I32; length as usize]),
        2 => (
            REF_ARRAY_TYPE,
            (0..length)
                .map(|_| draw_extern_subtype(&tc))
                .collect::<Vec<_>>(),
        ),
        _ => unreachable!(),
    };
    let result = reference(false, HeapType::Concrete(ty));
    let exact = Operation::core(
        CoreOpcode::ArrayNewFixed,
        elements.clone(),
        vec![result.clone()],
    )
    .with_immediates(vec![Immediate::Type(ty), Immediate::U32(length)]);
    assert_valid(&exact, "generated array.new_fixed");

    let wrong_length = if length == 32 { length - 1 } else { length + 1 };
    let wrong_count = Operation::core(CoreOpcode::ArrayNewFixed, elements, vec![result])
        .with_immediates(vec![Immediate::Type(ty), Immediate::U32(wrong_length)]);
    assert_schema_rejected(&wrong_count, "array.new_fixed count mutation");
}

fn draw_extern_subtype(tc: &TestCase) -> ValueType {
    let heap = if tc.draw(gs::booleans()) {
        HeapType::Extern
    } else {
        HeapType::NoExtern
    };
    reference(tc.draw(gs::booleans()), heap)
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn array_new_fixed_checks_every_reference_operand_subtype(tc: TestCase) {
    let length = tc.draw(gs::integers::<u32>().min_value(1).max_value(32));
    let result = reference(false, HeapType::Concrete(REF_ARRAY_TYPE));
    let elements = (0..length)
        .map(|_| draw_extern_subtype(&tc))
        .collect::<Vec<_>>();
    let exact = Operation::core(
        CoreOpcode::ArrayNewFixed,
        elements.clone(),
        vec![result.clone()],
    )
    .with_immediates(vec![
        Immediate::Type(REF_ARRAY_TYPE),
        Immediate::U32(length),
    ]);
    assert_valid(&exact, "subtyped reference array.new_fixed");

    let mut incompatible = elements;
    let slot = tc.draw(gs::integers::<usize>().max_value(incompatible.len() - 1));
    incompatible[slot] = reference(true, HeapType::Any);
    let corrupted =
        Operation::core(CoreOpcode::ArrayNewFixed, incompatible, vec![result]).with_immediates(
            vec![Immediate::Type(REF_ARRAY_TYPE), Immediate::U32(length)],
        );
    assert_schema_rejected(&corrupted, "incompatible reference array.new_fixed element");
}

fn append_nominal_struct_chain(program: &mut Program, depth: u32) -> u32 {
    let base = program.types.len() as u32;
    for index in 0..depth {
        let id = TypeId(base + index);
        program.types.push(TypeDefinition {
            canonical_alias: None,
            final_: index + 1 == depth,
            supertype: index.checked_sub(1).map(|parent| TypeId(base + parent)),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        });
        program.rec_groups.push(RecGroup {
            types: vec![id],
            source: source(),
        });
    }
    base
}

fn install_prefix_nominal_struct_chain(program: &mut Program, depth: u32) {
    for index in 0..depth {
        program.types[index as usize] = TypeDefinition {
            canonical_alias: None,
            final_: index + 1 == depth,
            supertype: index.checked_sub(1).map(TypeId),
            composite: CompositeType::Struct(vec![]),
            source: source(),
        };
    }
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn generated_nominal_chains_match_reachability_and_nullability(tc: TestCase) {
    let depth = tc.draw(gs::integers::<u32>().min_value(1).max_value(64));
    let mut program = Program::new(1);
    let base = append_nominal_struct_chain(&mut program, depth);
    property_assert_eq!(base, 0, "a fresh nominal chain did not begin at type0");
    program.verify().unwrap_or_else(|error| {
        property_panic!("generated nominal chain was invalid at depth {depth}:\n{error}")
    });

    let actual = tc.draw(gs::integers::<u32>().max_value(depth - 1));
    let expected = tc.draw(gs::integers::<u32>().max_value(depth - 1));
    let actual_nullable = tc.draw(gs::booleans());
    let expected_nullable = tc.draw(gs::booleans());
    let nominal_oracle = actual >= expected;
    property_assert_eq!(
        is_nominal_type_subtype(&program.types, TypeId(actual), TypeId(expected)),
        nominal_oracle,
        "nominal reachability disagreed at depth {depth}: actual={actual}, expected={expected}"
    );

    let actual_ty = reference(actual_nullable, HeapType::Concrete(TypeId(actual)));
    let expected_ty = reference(expected_nullable, HeapType::Concrete(TypeId(expected)));
    let value_oracle = (!actual_nullable || expected_nullable) && nominal_oracle;
    property_assert_eq!(
        is_value_subtype(&program.types, &actual_ty, &expected_ty),
        value_oracle,
        "reference subtype oracle disagreed at depth {depth}: actual={actual_ty}, expected={expected_ty}"
    );
    property_assert_eq!(
        are_value_types_equivalent(&program.types, &actual_ty, &expected_ty),
        actual == expected && actual_nullable == expected_nullable,
        "canonical-equivalence oracle disagreed at depth {depth}: actual={actual_ty}, expected={expected_ty}"
    );
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn direct_call_context_consumes_nominal_subtyping_and_nullability(tc: TestCase) {
    let depth = tc.draw(gs::integers::<u32>().min_value(1).max_value(4));
    let actual = tc.draw(gs::integers::<u32>().max_value(depth - 1));
    let expected = tc.draw(gs::integers::<u32>().max_value(depth - 1));
    let actual_nullable = tc.draw(gs::booleans());
    let expected_nullable = tc.draw(gs::booleans());
    let actual_ty = reference(actual_nullable, HeapType::Concrete(TypeId(actual)));
    let expected_ty = reference(expected_nullable, HeapType::Concrete(TypeId(expected)));
    let call = operation(
        CoreOpcode::Call,
        std::slice::from_ref(&actual_ty),
        &[ValueType::I32],
    )
    .with_immediates(vec![Immediate::Function(FunctionId(0))]);
    let mut program = operation_program(call);
    install_prefix_nominal_struct_chain(&mut program, depth);
    program.types[CALLEE_TYPE.index()].composite = CompositeType::Function(FunctionType {
        params: vec![expected_ty.clone()],
        results: vec![ValueType::I32],
    });
    program.functions[0].locals = vec![expected_ty.clone()];

    let expected_valid = actual >= expected && (!actual_nullable || expected_nullable);
    match (expected_valid, program.verify()) {
        (true, Ok(())) => {}
        (true, Err(errors)) => property_panic!(
            "valid call subtype was rejected at depth {depth}: actual={actual_ty}, expected={expected_ty}\n{errors}"
        ),
        (false, Ok(())) => property_panic!(
            "invalid call subtype was accepted at depth {depth}: actual={actual_ty}, expected={expected_ty}"
        ),
        (false, Err(errors)) => {
            let operation_location = VerifyLocation {
                function: Some(FunctionId(1)),
                block: Some(BlockId(0)),
                instruction: Some(InstructionId(0)),
            };
            property_assert!(
                errors.0.iter().any(|error| {
                    error.location == operation_location
                        && error.message.contains("invalid Core schema")
                        && error.message.contains("call")
                        && error.message.contains("parameter 0")
                        && error.message.contains("expected a subtype")
                }),
                "invalid call subtype lacked its operation diagnostic at depth {depth}: actual={actual_ty}, expected={expected_ty}\n{errors}"
            );
        }
    }
}
