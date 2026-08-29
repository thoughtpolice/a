// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Forged-IR tests for Core operator immediate layouts and placement.

use wedge::ir::*;
use wedge::opcode::CoreOpcode;
use wedge::semantics::effects_for_operation;

const STRUCT_TYPE: TypeId = TypeId(0);
const ARRAY_TYPE: TypeId = TypeId(1);
const EMPTY_FUNCTION_TYPE: TypeId = TypeId(2);
const WRAPPER_FUNCTION_TYPE: TypeId = TypeId(3);

fn source() -> SourceInfo {
    SourceInfo::synthetic()
}

fn reference(nullable: bool, heap: HeapType) -> ValueType {
    ValueType::Ref(RefType { nullable, heap })
}

fn table_reference() -> RefType {
    RefType {
        nullable: true,
        heap: HeapType::Func,
    }
}

/// Place one operation in an otherwise-valid function and provide one valid
/// entity of every immediate index-space kind. Concrete GC types precede the
/// wrapper function type so the scaffold also obeys recursive-group scope.
fn program_with_operation(operation: Operation) -> Program {
    let signature = operation.signature.clone();
    let parameters = signature
        .params
        .iter()
        .enumerate()
        .map(|(index, ty)| ValueDefinition::new(ValueId(index as u32), ty.clone()))
        .collect::<Vec<_>>();
    let operands = parameters
        .iter()
        .map(|parameter| parameter.id)
        .collect::<Vec<_>>();
    let first_result = parameters.len() as u32;
    let results = signature
        .results
        .iter()
        .enumerate()
        .map(|(index, ty)| ValueDefinition::new(ValueId(first_result + index as u32), ty.clone()))
        .collect::<Vec<_>>();
    let returned = results.iter().map(|result| result.id).collect::<Vec<_>>();

    let mut instruction =
        Instruction::new(InstructionId(0), operation, operands, results, source());
    instruction.effects = effects_for_operation(&instruction.operation);

    let mut program = Program::new(1);
    program.types = vec![
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Struct(vec![FieldType {
                storage: StorageType::Value(ValueType::I32),
                mutable: false,
            }]),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Array(FieldType {
                storage: StorageType::Value(ValueType::I32),
                mutable: true,
            }),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Function(FunctionType::default()),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Function(signature.clone()),
            source: source(),
        },
    ];
    program.rec_groups = (0..program.types.len())
        .map(|index| RecGroup {
            types: vec![TypeId(index as u32)],
            source: source(),
        })
        .collect();
    program.functions.push(Function {
        wasm_index: 0,
        ty: WRAPPER_FUNCTION_TYPE,
        origin: EntityOrigin::Defined,
        locals: signature.params,
        body: Some(FunctionBody {
            entry: BlockId(0),
            root_region: RegionId(0),
            blocks: vec![Block {
                id: BlockId(0),
                region: RegionId(0),
                parameters,
                instructions: vec![instruction],
                terminator: Terminator::return_(returned, source()),
                source: source(),
            }],
            regions: vec![Region {
                id: RegionId(0),
                parent: None,
                kind: RegionKind::Function,
                entry: BlockId(0),
                source: source(),
            }],
        }),
        source: source(),
    });
    program.tables.push(Table {
        ty: TableType {
            element: table_reference(),
            limits: Limits {
                min: 0,
                max: Some(1),
            },
            address_type: AddressType::I32,
        },
        origin: EntityOrigin::Defined,
        initializer: None,
        source: source(),
    });
    program.memories.push(Memory {
        ty: MemoryType {
            limits: Limits {
                min: 0,
                max: Some(1),
            },
            address_type: AddressType::I32,
        },
        origin: EntityOrigin::Defined,
        source: source(),
    });
    program.globals.push(Global {
        ty: GlobalType {
            value: ValueType::I32,
            mutable: false,
        },
        origin: EntityOrigin::Defined,
        initializer: Some(ConstExpr {
            instructions: vec![ConstInstruction {
                operation: Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
                    .with_immediates(vec![Immediate::S32(0)]),
                source: source(),
            }],
            result_type: ValueType::I32,
            source: source(),
        }),
        source: source(),
    });
    program.tags.push(Tag {
        ty: TagType {
            signature: EMPTY_FUNCTION_TYPE,
        },
        origin: EntityOrigin::Defined,
        source: source(),
    });
    program.elements.push(Element {
        ty: table_reference(),
        mode: ElementMode::Passive,
        items: vec![],
        source: source(),
    });
    program.data.push(DataSegment {
        mode: DataMode::Passive,
        bytes: vec![],
        source: source(),
    });
    program
}

fn verification_error(operation: Operation) -> String {
    program_with_operation(operation)
        .verify()
        .expect_err("forged Core operation should fail verification")
        .to_string()
}

fn assert_schema_error(operation: Operation, fragments: &[&str]) {
    let error = verification_error(operation);
    for fragment in fragments {
        assert!(
            error.contains(fragment),
            "expected `{fragment}` in verifier diagnostic:\n{error}"
        );
    }
}

fn assert_valid_operation(operation: Operation) {
    let opcode = operation.kind;
    program_with_operation(operation)
        .verify()
        .unwrap_or_else(|error| panic!("valid {opcode:?} schema was rejected:\n{error}"));
}

fn memory_argument() -> Immediate {
    Immediate::MemoryArgument(MemoryArgument {
        memory: MemoryId(0),
        offset: 8,
        alignment_log2: 2,
    })
}

fn i32_const(immediates: Vec<Immediate>) -> Operation {
    Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32]).with_immediates(immediates)
}

fn i32_load(immediates: Vec<Immediate>) -> Operation {
    Operation::core(
        CoreOpcode::I32Load,
        vec![ValueType::I32],
        vec![ValueType::I32],
    )
    .with_immediates(immediates)
}

fn memory_init(immediates: Vec<Immediate>) -> Operation {
    Operation::core(CoreOpcode::MemoryInit, vec![ValueType::I32; 3], vec![])
        .with_immediates(immediates)
}

fn table_init(immediates: Vec<Immediate>) -> Operation {
    Operation::core(CoreOpcode::TableInit, vec![ValueType::I32; 3], vec![])
        .with_immediates(immediates)
}

fn struct_get(immediates: Vec<Immediate>) -> Operation {
    Operation::core(
        CoreOpcode::StructGet,
        vec![reference(true, HeapType::Concrete(STRUCT_TYPE))],
        vec![ValueType::I32],
    )
    .with_immediates(immediates)
}

fn array_new_data(immediates: Vec<Immediate>) -> Operation {
    Operation::core(
        CoreOpcode::ArrayNewData,
        vec![ValueType::I32, ValueType::I32],
        vec![reference(false, HeapType::Concrete(ARRAY_TYPE))],
    )
    .with_immediates(immediates)
}

fn shuffle(immediates: Vec<Immediate>) -> Operation {
    Operation::core(
        CoreOpcode::I8x16Shuffle,
        vec![ValueType::V128, ValueType::V128],
        vec![ValueType::V128],
    )
    .with_immediates(immediates)
}

fn typed_select_multi(immediates: Vec<Immediate>) -> Operation {
    Operation::core(
        CoreOpcode::TypedSelectMulti,
        vec![
            ValueType::I32,
            ValueType::I64,
            ValueType::I32,
            ValueType::I64,
            ValueType::I32,
        ],
        vec![ValueType::I32, ValueType::I64],
    )
    .with_immediates(immediates)
}

#[test]
fn accepts_representative_immediates_from_every_ordinary_schema_family() {
    let operations = [
        Operation::core(CoreOpcode::Nop, vec![], vec![]),
        i32_const(vec![Immediate::S32(-1)]),
        Operation::core(CoreOpcode::I64Const, vec![], vec![ValueType::I64])
            .with_immediates(vec![Immediate::S64(-2)]),
        Operation::core(CoreOpcode::F32Const, vec![], vec![ValueType::F32])
            .with_immediates(vec![Immediate::F32(0x3f80_0000)]),
        Operation::core(CoreOpcode::F64Const, vec![], vec![ValueType::F64])
            .with_immediates(vec![Immediate::F64(0x3ff0_0000_0000_0000)]),
        Operation::core(CoreOpcode::V128Const, vec![], vec![ValueType::V128])
            .with_immediates(vec![Immediate::V128([0xa5; 16])]),
        Operation::core(
            CoreOpcode::RefNull,
            vec![],
            vec![reference(true, HeapType::Extern)],
        )
        .with_immediates(vec![Immediate::HeapType(HeapType::Extern)]),
        Operation::core(CoreOpcode::GlobalGet, vec![], vec![ValueType::I32])
            .with_immediates(vec![Immediate::Global(GlobalId(0))]),
        Operation::core(CoreOpcode::Call, vec![], vec![])
            .with_immediates(vec![Immediate::Function(FunctionId(0))]),
        Operation::core(CoreOpcode::CallIndirect, vec![ValueType::I32], vec![]).with_immediates(
            vec![
                Immediate::Type(EMPTY_FUNCTION_TYPE),
                Immediate::Table(TableId(0)),
            ],
        ),
        i32_load(vec![memory_argument()]),
        memory_init(vec![
            Immediate::Data(DataId(0)),
            Immediate::Memory(MemoryId(0)),
        ]),
        Operation::core(
            CoreOpcode::TableGet,
            vec![ValueType::I32],
            vec![ValueType::Ref(table_reference())],
        )
        .with_immediates(vec![Immediate::Table(TableId(0))]),
        table_init(vec![
            Immediate::Element(ElementId(0)),
            Immediate::Table(TableId(0)),
        ]),
        struct_get(vec![Immediate::Type(STRUCT_TYPE), Immediate::U32(0)]),
        array_new_data(vec![
            Immediate::Type(ARRAY_TYPE),
            Immediate::Data(DataId(0)),
        ]),
        Operation::core(
            CoreOpcode::TypedSelect,
            vec![ValueType::I32, ValueType::I32, ValueType::I32],
            vec![ValueType::I32],
        )
        .with_immediates(vec![Immediate::ValueType(ValueType::I32)]),
        Operation::core(
            CoreOpcode::I8x16ExtractLaneS,
            vec![ValueType::V128],
            vec![ValueType::I32],
        )
        .with_immediates(vec![Immediate::Lane(7)]),
        shuffle(vec![Immediate::Bytes((0_u8..16).collect())]),
    ];

    for operation in operations {
        assert_valid_operation(operation);
    }
}

#[test]
fn rejects_missing_and_extra_constant_immediates() {
    assert_schema_error(
        i32_const(vec![]),
        &[
            "missing immediate 0",
            "field `value`",
            "signed 32-bit integer",
        ],
    );
    assert_schema_error(
        i32_const(vec![Immediate::S32(1), Immediate::U32(2)]),
        &["i32.const", "1 unexpected immediate", "index 1"],
    );
}

#[test]
fn rejects_the_wrong_owned_kind_for_each_constant_encoding() {
    let cases = [
        (
            i32_const(vec![Immediate::S64(0)]),
            "signed 32-bit integer",
            "signed 64-bit integer",
        ),
        (
            Operation::core(CoreOpcode::I64Const, vec![], vec![ValueType::I64])
                .with_immediates(vec![Immediate::S32(0)]),
            "signed 64-bit integer",
            "signed 32-bit integer",
        ),
        (
            Operation::core(CoreOpcode::F32Const, vec![], vec![ValueType::F32])
                .with_immediates(vec![Immediate::F64(0)]),
            "raw f32 bits",
            "raw f64 bits",
        ),
        (
            Operation::core(CoreOpcode::F64Const, vec![], vec![ValueType::F64])
                .with_immediates(vec![Immediate::F32(0)]),
            "raw f64 bits",
            "raw f32 bits",
        ),
        (
            Operation::core(CoreOpcode::V128Const, vec![], vec![ValueType::V128])
                .with_immediates(vec![Immediate::Bytes(vec![0; 16])]),
            "v128 constant",
            "byte string",
        ),
    ];

    for (operation, expected, actual) in cases {
        assert_schema_error(
            operation,
            &["immediate 0", "field `value`", expected, actual],
        );
    }
}

#[test]
fn rejects_missing_extra_wrong_and_reordered_call_immediates() {
    assert_schema_error(
        Operation::core(CoreOpcode::Call, vec![], vec![]),
        &["missing immediate 0", "field `function_index`"],
    );
    assert_schema_error(
        Operation::core(CoreOpcode::Call, vec![], vec![])
            .with_immediates(vec![Immediate::Global(GlobalId(0))]),
        &[
            "field `function_index`",
            "function reference",
            "global reference",
        ],
    );
    assert_schema_error(
        Operation::core(CoreOpcode::Call, vec![], vec![])
            .with_immediates(vec![Immediate::Function(FunctionId(0)), Immediate::U32(0)]),
        &["call", "1 unexpected immediate", "index 1"],
    );
    assert_schema_error(
        Operation::core(CoreOpcode::CallIndirect, vec![ValueType::I32], vec![])
            .with_immediates(vec![Immediate::Type(EMPTY_FUNCTION_TYPE)]),
        &["missing immediate 1", "field `table_index`"],
    );
    assert_schema_error(
        Operation::core(CoreOpcode::CallIndirect, vec![ValueType::I32], vec![]).with_immediates(
            vec![
                Immediate::Table(TableId(0)),
                Immediate::Type(EMPTY_FUNCTION_TYPE),
            ],
        ),
        &["field `type_index`", "type reference", "table reference"],
    );
}

#[test]
fn rejects_missing_extra_wrong_and_reordered_memory_immediates() {
    assert_schema_error(
        i32_load(vec![]),
        &["missing immediate 0", "field `memarg`", "memory argument"],
    );
    assert_schema_error(
        i32_load(vec![Immediate::Memory(MemoryId(0))]),
        &["field `memarg`", "memory argument", "memory reference"],
    );
    assert_schema_error(
        i32_load(vec![memory_argument(), Immediate::U32(0)]),
        &["i32.load", "1 unexpected immediate", "index 1"],
    );
    assert_schema_error(
        memory_init(vec![Immediate::Data(DataId(0))]),
        &["missing immediate 1", "field `mem`", "memory reference"],
    );
    assert_schema_error(
        memory_init(vec![
            Immediate::Memory(MemoryId(0)),
            Immediate::Data(DataId(0)),
        ]),
        &[
            "field `data_index`",
            "data-segment reference",
            "memory reference",
        ],
    );
}

#[test]
fn rejects_missing_wrong_and_reordered_table_immediates() {
    let table_get = |immediates| {
        Operation::core(
            CoreOpcode::TableGet,
            vec![ValueType::I32],
            vec![ValueType::Ref(table_reference())],
        )
        .with_immediates(immediates)
    };
    assert_schema_error(
        table_get(vec![]),
        &["missing immediate 0", "field `table`", "table reference"],
    );
    assert_schema_error(
        table_get(vec![Immediate::Memory(MemoryId(0))]),
        &["field `table`", "table reference", "memory reference"],
    );
    assert_schema_error(
        table_init(vec![Immediate::Element(ElementId(0))]),
        &["missing immediate 1", "field `table`"],
    );
    assert_schema_error(
        table_init(vec![
            Immediate::Table(TableId(0)),
            Immediate::Element(ElementId(0)),
        ]),
        &[
            "field `elem_index`",
            "element-segment reference",
            "table reference",
        ],
    );
}

#[test]
fn rejects_missing_wrong_and_reordered_gc_index_immediates() {
    assert_schema_error(
        struct_get(vec![Immediate::Type(STRUCT_TYPE)]),
        &["missing immediate 1", "field `field_index`"],
    );
    assert_schema_error(
        struct_get(vec![Immediate::Data(DataId(0)), Immediate::U32(0)]),
        &[
            "field `struct_type_index`",
            "type reference",
            "data-segment reference",
        ],
    );
    assert_schema_error(
        struct_get(vec![Immediate::U32(0), Immediate::Type(STRUCT_TYPE)]),
        &[
            "field `struct_type_index`",
            "type reference",
            "unsigned 32-bit integer",
        ],
    );
    assert_schema_error(
        array_new_data(vec![
            Immediate::Data(DataId(0)),
            Immediate::Type(ARRAY_TYPE),
        ]),
        &[
            "field `array_type_index`",
            "type reference",
            "data-segment reference",
        ],
    );
}

#[test]
fn checks_counted_multi_value_select_immediates_even_though_the_opcode_is_out_of_profile() {
    assert_schema_error(
        typed_select_multi(vec![]),
        &[
            "missing immediate 0",
            "field `tys`",
            "unsigned 32-bit integer",
        ],
    );
    assert_schema_error(
        typed_select_multi(vec![
            Immediate::U32(2),
            Immediate::ValueType(ValueType::I32),
        ]),
        &["missing immediate 2", "field `tys`", "value type"],
    );
    assert_schema_error(
        typed_select_multi(vec![
            Immediate::U32(2),
            Immediate::ValueType(ValueType::I32),
            Immediate::S32(0),
        ]),
        &["immediate 2", "field `tys`", "value type", "signed 32-bit"],
    );
    assert_schema_error(
        typed_select_multi(vec![
            Immediate::U32(1),
            Immediate::ValueType(ValueType::I32),
            Immediate::ValueType(ValueType::I64),
        ]),
        &["select", "1 unexpected immediate", "index 2"],
    );

    let error = verification_error(typed_select_multi(vec![
        Immediate::U32(2),
        Immediate::ValueType(ValueType::I32),
        Immediate::ValueType(ValueType::I64),
    ]));
    assert!(
        error.contains("uses out-of-profile core opcode select"),
        "{error}"
    );
    assert!(!error.contains("missing immediate"), "{error}");
    assert!(!error.contains("unexpected immediate"), "{error}");
    assert!(!error.contains("field `tys` must be"), "{error}");
}

#[test]
fn requires_exactly_sixteen_shuffle_lane_bytes() {
    for length in [0, 15, 17, 32] {
        assert_schema_error(
            shuffle(vec![Immediate::Bytes(vec![0; length])]),
            &["field `lanes`", "exactly 16 bytes", "byte string"],
        );
    }
    assert_schema_error(
        shuffle(vec![Immediate::V128([0; 16])]),
        &["field `lanes`", "exactly 16 bytes", "v128 constant"],
    );
    assert_schema_error(
        shuffle(vec![Immediate::Bytes(vec![0; 16]), Immediate::Lane(0)]),
        &["i8x16.shuffle", "1 unexpected immediate", "index 1"],
    );
}

fn operation_with_inventory_arity(opcode: CoreOpcode) -> Operation {
    let (parameters, results) = opcode.fixed_arity().unwrap_or((0, 0));
    Operation::core(
        opcode,
        vec![ValueType::I32; parameters],
        vec![ValueType::I32; results],
    )
}

#[test]
fn rejects_structured_control_operators_as_ordinary_instructions() {
    for opcode in [
        CoreOpcode::Block,
        CoreOpcode::Loop,
        CoreOpcode::If,
        CoreOpcode::Else,
        CoreOpcode::End,
        CoreOpcode::TryTable,
    ] {
        assert_schema_error(
            operation_with_inventory_arity(opcode),
            &["structured-control operator", "ordinary IR operation"],
        );
    }
}

#[test]
fn rejects_local_ssa_operators_as_ordinary_instructions() {
    for opcode in [
        CoreOpcode::LocalGet,
        CoreOpcode::LocalSet,
        CoreOpcode::LocalTee,
    ] {
        assert_schema_error(
            operation_with_inventory_arity(opcode),
            &["local SSA action", "ordinary IR operation"],
        );
    }
}

#[test]
fn rejects_cfg_terminator_operators_as_ordinary_instructions() {
    for opcode in [
        CoreOpcode::Unreachable,
        CoreOpcode::Br,
        CoreOpcode::BrIf,
        CoreOpcode::BrTable,
        CoreOpcode::Return,
        CoreOpcode::ReturnCall,
        CoreOpcode::ReturnCallIndirect,
        CoreOpcode::ReturnCallRef,
        CoreOpcode::Throw,
        CoreOpcode::ThrowRef,
        CoreOpcode::BrOnNull,
        CoreOpcode::BrOnNonNull,
        CoreOpcode::BrOnCast,
        CoreOpcode::BrOnCastFail,
    ] {
        assert_schema_error(
            operation_with_inventory_arity(opcode),
            &["CFG terminator", "ordinary IR operation"],
        );
    }
}
