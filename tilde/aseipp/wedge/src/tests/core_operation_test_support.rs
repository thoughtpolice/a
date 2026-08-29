// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Shared forged-IR scaffold for Core operation verifier tests.

#![allow(dead_code)]

use wedge::ir::*;
use wedge::opcode::CoreOpcode;
use wedge::semantics::effects_for_operation;

pub const STRUCT_TYPE: TypeId = TypeId(0);
pub const ARRAY_TYPE: TypeId = TypeId(1);
pub const PACKED_ARRAY_TYPE: TypeId = TypeId(2);
pub const REF_ARRAY_TYPE: TypeId = TypeId(3);
pub const CALLEE_TYPE: TypeId = TypeId(4);
pub const EMPTY_FUNCTION_TYPE: TypeId = TypeId(5);

pub fn source() -> SourceInfo {
    SourceInfo::synthetic()
}

pub fn reference(nullable: bool, heap: HeapType) -> ValueType {
    ValueType::Ref(RefType { nullable, heap })
}

pub fn ref_type(nullable: bool, heap: HeapType) -> RefType {
    RefType { nullable, heap }
}

pub fn function_type(params: Vec<ValueType>, results: Vec<ValueType>) -> TypeDefinition {
    TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: None,
        composite: CompositeType::Function(FunctionType { params, results }),
        source: source(),
    }
}

pub fn operation_program(operation: Operation) -> Program {
    let wrapper_signature = operation.signature.clone();
    let parameters = wrapper_signature
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
    let results = wrapper_signature
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
            composite: CompositeType::Struct(vec![
                FieldType {
                    storage: StorageType::Value(ValueType::I32),
                    mutable: false,
                },
                FieldType {
                    storage: StorageType::I8,
                    mutable: true,
                },
            ]),
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
            composite: CompositeType::Array(FieldType {
                storage: StorageType::I8,
                mutable: true,
            }),
            source: source(),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Array(FieldType {
                storage: StorageType::Value(reference(true, HeapType::Extern)),
                mutable: true,
            }),
            source: source(),
        },
        function_type(vec![reference(true, HeapType::Any)], vec![ValueType::I32]),
        function_type(vec![], vec![]),
        function_type(
            wrapper_signature.params.clone(),
            wrapper_signature.results.clone(),
        ),
    ];
    program.rec_groups = (0..program.types.len())
        .map(|index| RecGroup {
            types: vec![TypeId(index as u32)],
            source: source(),
        })
        .collect();

    program.imports.push(Import {
        module: "test".to_owned(),
        name: "callee".to_owned(),
        item: ImportItem::Function(FunctionId(0)),
        source: source(),
    });
    program.functions.push(Function {
        wasm_index: 0,
        ty: CALLEE_TYPE,
        origin: EntityOrigin::Imported(ImportId(0)),
        locals: vec![reference(true, HeapType::Any)],
        body: None,
        source: source(),
    });
    program.functions.push(Function {
        wasm_index: 1,
        ty: TypeId(6),
        origin: EntityOrigin::Defined,
        locals: wrapper_signature.params,
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

    program.tables = vec![
        Table {
            ty: TableType {
                element: ref_type(true, HeapType::Func),
                limits: Limits {
                    min: 0,
                    max: Some(1),
                },
                address_type: AddressType::I32,
            },
            origin: EntityOrigin::Defined,
            initializer: None,
            source: source(),
        },
        Table {
            ty: TableType {
                element: ref_type(true, HeapType::Extern),
                limits: Limits {
                    min: 0,
                    max: Some(1),
                },
                address_type: AddressType::I64,
            },
            origin: EntityOrigin::Defined,
            initializer: None,
            source: source(),
        },
    ];
    program.memories = vec![
        Memory {
            ty: MemoryType {
                limits: Limits {
                    min: 0,
                    max: Some(1),
                },
                address_type: AddressType::I32,
            },
            origin: EntityOrigin::Defined,
            source: source(),
        },
        Memory {
            ty: MemoryType {
                limits: Limits {
                    min: 0,
                    max: Some(1),
                },
                address_type: AddressType::I64,
            },
            origin: EntityOrigin::Defined,
            source: source(),
        },
    ];
    program.globals = vec![
        Global {
            ty: GlobalType {
                value: ValueType::I32,
                mutable: false,
            },
            origin: EntityOrigin::Defined,
            initializer: Some(i32_const_expression()),
            source: source(),
        },
        Global {
            ty: GlobalType {
                value: reference(true, HeapType::Extern),
                mutable: true,
            },
            origin: EntityOrigin::Defined,
            initializer: Some(ref_null_expression(HeapType::Extern)),
            source: source(),
        },
    ];
    program.elements = vec![
        Element {
            ty: ref_type(true, HeapType::Func),
            mode: ElementMode::Passive,
            items: vec![],
            source: source(),
        },
        Element {
            ty: ref_type(true, HeapType::Extern),
            mode: ElementMode::Passive,
            items: vec![],
            source: source(),
        },
    ];
    program.data.push(DataSegment {
        mode: DataMode::Passive,
        bytes: vec![],
        source: source(),
    });
    program
}

fn i32_const_expression() -> ConstExpr {
    ConstExpr {
        instructions: vec![ConstInstruction {
            operation: Operation::core(CoreOpcode::I32Const, vec![], vec![ValueType::I32])
                .with_immediates(vec![Immediate::S32(0)]),
            source: source(),
        }],
        result_type: ValueType::I32,
        source: source(),
    }
}

fn ref_null_expression(heap: HeapType) -> ConstExpr {
    let result = reference(true, heap.clone());
    ConstExpr {
        instructions: vec![ConstInstruction {
            operation: Operation::core(CoreOpcode::RefNull, vec![], vec![result.clone()])
                .with_immediates(vec![Immediate::HeapType(heap)]),
            source: source(),
        }],
        result_type: result,
        source: source(),
    }
}

pub fn memory_argument(memory: MemoryId, offset: u64, alignment_log2: u8) -> Immediate {
    Immediate::MemoryArgument(MemoryArgument {
        memory,
        offset,
        alignment_log2,
    })
}

pub fn verification_error(operation: Operation) -> String {
    operation_program(operation)
        .verify()
        .expect_err("forged Core operation should fail verification")
        .to_string()
}

pub fn assert_schema_error(operation: Operation, fragments: &[&str]) {
    let errors = operation_program(operation)
        .verify()
        .expect_err("forged Core operation should fail verification");
    let operation_location = VerifyLocation {
        function: Some(FunctionId(1)),
        block: Some(BlockId(0)),
        instruction: Some(InstructionId(0)),
    };
    assert!(
        errors
            .0
            .iter()
            .all(|error| error.location == operation_location),
        "test scaffold produced a diagnostic outside the forged operation:\n{errors}"
    );
    let matching = errors.0.iter().find(|error| {
        error.message.contains("invalid Core schema")
            && fragments
                .iter()
                .all(|fragment| error.message.contains(fragment))
    });
    assert!(
        matching.is_some(),
        "expected one Core-schema diagnostic containing {fragments:?}:\n{errors}"
    );
}

pub fn assert_valid_operation(operation: Operation) {
    let opcode = operation.kind;
    operation_program(operation)
        .verify()
        .unwrap_or_else(|error| panic!("valid {opcode:?} schema was rejected:\n{error}"));
}
