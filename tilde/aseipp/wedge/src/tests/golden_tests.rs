// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Checked-in golden tests for Wedge's deterministic milestone-1 IR printer.
//
// The harness is intentionally tiny: golden files are read-only test
// resources, and a mismatch reports its first line and column. There is no
// update mode, so accepting a printer change always requires an ordinary,
// reviewable source edit.

use wedge::Compiler;
use wedge::ir::*;
use wedge::semantics::effects_for_operation;

fn synthetic() -> SourceInfo {
    SourceInfo::synthetic()
}

fn source(start: u64, end: u64, ordinal: u32) -> SourceInfo {
    SourceInfo::new(ByteSpan::new(start, end), ordinal)
}

fn function_type(params: Vec<ValueType>, results: Vec<ValueType>) -> FunctionType {
    FunctionType { params, results }
}

fn append_type(program: &mut Program, composite: CompositeType) -> TypeId {
    let id = TypeId(program.types.len() as u32);
    program.types.push(TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: None,
        composite,
        source: synthetic(),
    });
    program.rec_groups.push(RecGroup {
        types: vec![id],
        source: synthetic(),
    });
    id
}

fn root_region(entry: BlockId) -> Region {
    Region {
        id: RegionId(0),
        parent: None,
        kind: RegionKind::Function,
        entry,
        source: synthetic(),
    }
}

fn block(
    id: BlockId,
    region: RegionId,
    parameters: Vec<ValueDefinition>,
    instructions: Vec<Instruction>,
    terminator: TerminatorKind,
) -> Block {
    Block {
        id,
        region,
        parameters,
        instructions,
        terminator: Terminator::new(terminator, synthetic()),
        source: synthetic(),
    }
}

fn instruction(
    instruction: u32,
    mnemonic: &str,
    params: Vec<ValueType>,
    results: Vec<(u32, ValueType)>,
    operands: Vec<ValueId>,
    immediates: Vec<Immediate>,
) -> Instruction {
    let result_types = results.iter().map(|(_, ty)| ty.clone()).collect();
    Instruction::new(
        InstructionId(instruction),
        Operation::new(mnemonic, params, result_types).with_immediates(immediates),
        operands,
        results
            .into_iter()
            .map(|(id, ty)| ValueDefinition::new(ValueId(id), ty))
            .collect(),
        synthetic(),
    )
}

fn i32_constant(instruction_id: u32, value_id: u32, value: i32) -> Instruction {
    instruction(
        instruction_id,
        "i32.const",
        vec![],
        vec![(value_id, ValueType::I32)],
        vec![],
        vec![Immediate::S32(value)],
    )
}

fn const_expr(operation: Operation, result_type: ValueType) -> ConstExpr {
    ConstExpr {
        instructions: vec![ConstInstruction {
            operation,
            source: synthetic(),
        }],
        result_type,
        source: synthetic(),
    }
}

fn i32_const_expr(value: i32) -> ConstExpr {
    const_expr(
        Operation::new("i32.const", vec![], vec![ValueType::I32])
            .with_immediates(vec![Immediate::S32(value)]),
        ValueType::I32,
    )
}

fn i64_const_expr(value: i64) -> ConstExpr {
    const_expr(
        Operation::new("i64.const", vec![], vec![ValueType::I64])
            .with_immediates(vec![Immediate::S64(value)]),
        ValueType::I64,
    )
}

fn minimal_typed_function() -> Program {
    let mut program = Program::new(1);
    let ty = append_type(
        &mut program,
        CompositeType::Function(function_type(vec![], vec![ValueType::I32])),
    );
    program.functions.push(Function {
        wasm_index: 0,
        ty,
        origin: EntityOrigin::Defined,
        locals: vec![],
        body: Some(FunctionBody {
            entry: BlockId(0),
            root_region: RegionId(0),
            blocks: vec![block(
                BlockId(0),
                RegionId(0),
                vec![],
                vec![i32_constant(0, 0, 42)],
                TerminatorKind::Return {
                    values: vec![ValueId(0)],
                },
            )],
            regions: vec![root_region(BlockId(0))],
        }),
        source: synthetic(),
    });
    program.exports.push(Export {
        name: "answer".into(),
        item: ExportItem::Function(FunctionId(0)),
        source: synthetic(),
    });
    program
}

fn diamond_cfg() -> Program {
    let mut program = Program::new(1);
    let ty = append_type(
        &mut program,
        CompositeType::Function(function_type(vec![], vec![ValueType::I32])),
    );

    let entry = block(
        BlockId(0),
        RegionId(0),
        vec![],
        vec![i32_constant(0, 0, 1)],
        TerminatorKind::Branch {
            condition: ValueId(0),
            then_edge: Edge::new(BlockId(1), vec![]),
            else_edge: Edge::new(BlockId(2), vec![]),
        },
    );
    let then_block = block(
        BlockId(1),
        RegionId(1),
        vec![],
        vec![i32_constant(1, 1, 10)],
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![ValueId(1)])),
    );
    let else_block = block(
        BlockId(2),
        RegionId(2),
        vec![],
        vec![i32_constant(2, 2, 20)],
        TerminatorKind::Jump(Edge::new(BlockId(3), vec![ValueId(2)])),
    );
    let merge = block(
        BlockId(3),
        RegionId(0),
        vec![ValueDefinition::new(ValueId(3), ValueType::I32)],
        vec![],
        TerminatorKind::Return {
            values: vec![ValueId(3)],
        },
    );
    let regions = vec![
        root_region(BlockId(0)),
        Region {
            id: RegionId(1),
            parent: Some(RegionId(0)),
            kind: RegionKind::IfThen,
            entry: BlockId(1),
            source: synthetic(),
        },
        Region {
            id: RegionId(2),
            parent: Some(RegionId(0)),
            kind: RegionKind::IfElse,
            entry: BlockId(2),
            source: synthetic(),
        },
    ];
    program.functions.push(Function {
        wasm_index: 0,
        ty,
        origin: EntityOrigin::Defined,
        locals: vec![],
        body: Some(FunctionBody {
            entry: BlockId(0),
            root_region: RegionId(0),
            blocks: vec![entry, then_block, else_block, merge],
            regions,
        }),
        source: synthetic(),
    });
    program
}

fn effects_and_exception_handling() -> Program {
    let mut program = Program::new(1);
    let imported_ty = append_type(
        &mut program,
        CompositeType::Function(function_type(vec![], vec![ValueType::I32])),
    );
    let body_ty = append_type(
        &mut program,
        CompositeType::Function(function_type(vec![], vec![ValueType::I32])),
    );

    program.imports.push(Import {
        module: "host".into(),
        name: "may_throw".into(),
        item: ImportItem::Function(FunctionId(0)),
        source: source(8, 29, 0),
    });
    program.functions.push(Function {
        wasm_index: 0,
        ty: imported_ty,
        origin: EntityOrigin::Imported(ImportId(0)),
        locals: vec![],
        body: None,
        source: source(8, 29, 0),
    });
    program.memories.push(Memory {
        ty: MemoryType {
            limits: Limits {
                min: 1,
                max: Some(8),
            },
            address_type: AddressType::I32,
        },
        origin: EntityOrigin::Defined,
        source: source(30, 35, 1),
    });

    let mut call = instruction(
        0,
        "call",
        vec![],
        vec![(0, ValueType::I32)],
        vec![],
        vec![Immediate::Function(FunctionId(0))],
    );
    call.effects = effects_for_operation(&call.operation);
    let mut invoke = block(
        BlockId(0),
        RegionId(1),
        vec![],
        vec![],
        TerminatorKind::Invoke {
            operation: call.operation,
            operands: vec![],
            effects: call.effects,
            normal: Edge::new(BlockId(2), vec![]),
        },
    );
    invoke.terminator = invoke.terminator.with_exception_routing(ExceptionRouting {
        arms: vec![ExceptionalEdge::new(RegionId(1), 0, BlockId(1), vec![])],
        escapes: false,
    });
    invoke.terminator.source = source(44, 46, 0);
    let mut fallback = i32_constant(1, 1, -1);
    fallback.source = source(50, 52, 1);

    program.functions.push(Function {
        wasm_index: 1,
        ty: body_ty,
        origin: EntityOrigin::Defined,
        locals: vec![],
        body: Some(FunctionBody {
            entry: BlockId(0),
            root_region: RegionId(0),
            blocks: vec![
                invoke,
                block(
                    BlockId(1),
                    RegionId(2),
                    vec![],
                    vec![fallback],
                    TerminatorKind::Return {
                        values: vec![ValueId(1)],
                    },
                ),
                block(
                    BlockId(2),
                    RegionId(1),
                    vec![ValueDefinition::new(ValueId(0), ValueType::I32)],
                    vec![],
                    TerminatorKind::Return {
                        values: vec![ValueId(0)],
                    },
                ),
            ],
            regions: vec![
                root_region(BlockId(0)),
                Region {
                    id: RegionId(1),
                    parent: Some(RegionId(0)),
                    kind: RegionKind::TryTable {
                        catches: vec![CatchClause {
                            kind: CatchKind::CatchAll,
                            tag: None,
                            target: BlockId(1),
                        }],
                    },
                    entry: BlockId(0),
                    source: source(40, 49, 0),
                },
                Region {
                    id: RegionId(2),
                    parent: Some(RegionId(0)),
                    kind: RegionKind::Catch,
                    entry: BlockId(1),
                    source: source(49, 55, 1),
                },
            ],
        }),
        source: source(36, 56, 2),
    });
    program.exports.push(Export {
        name: "run".into(),
        item: ExportItem::Function(FunctionId(1)),
        source: source(57, 62, 3),
    });
    program
}

fn rich_module_entities_and_types() -> Program {
    let mut program = Program::new(1);
    program.source = source(0, 240, 0);

    let callback_ty = TypeId(0);
    let tag_ty = TypeId(1);
    let struct_ty = TypeId(2);
    let array_ty = TypeId(3);
    let start_ty = TypeId(4);
    program.types = vec![
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Function(function_type(
                vec![ValueType::I32],
                vec![ValueType::I32],
            )),
            source: source(8, 16, 0),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Function(function_type(vec![ValueType::I64], vec![])),
            source: source(17, 25, 1),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: false,
            supertype: None,
            composite: CompositeType::Struct(vec![
                FieldType {
                    storage: StorageType::I8,
                    mutable: false,
                },
                FieldType {
                    storage: StorageType::Value(ValueType::Ref(RefType {
                        nullable: true,
                        heap: HeapType::Extern,
                    })),
                    mutable: true,
                },
            ]),
            source: source(26, 40, 2),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Array(FieldType {
                storage: StorageType::I16,
                mutable: true,
            }),
            source: source(41, 48, 3),
        },
        TypeDefinition {
            canonical_alias: None,
            final_: true,
            supertype: None,
            composite: CompositeType::Function(function_type(vec![], vec![])),
            source: source(49, 55, 4),
        },
    ];
    program.rec_groups = vec![
        RecGroup {
            types: vec![callback_ty],
            source: synthetic(),
        },
        RecGroup {
            types: vec![tag_ty],
            source: synthetic(),
        },
        RecGroup {
            types: vec![struct_ty, array_ty],
            source: source(26, 48, 2),
        },
        RecGroup {
            types: vec![start_ty],
            source: synthetic(),
        },
    ];

    program.imports = vec![
        Import {
            module: "host".into(),
            name: "callback".into(),
            item: ImportItem::Function(FunctionId(0)),
            source: synthetic(),
        },
        Import {
            module: "host".into(),
            name: "objects".into(),
            item: ImportItem::Table(TableId(0)),
            source: synthetic(),
        },
        Import {
            module: "host".into(),
            name: "linear64".into(),
            item: ImportItem::Memory(MemoryId(0)),
            source: synthetic(),
        },
        Import {
            module: "host".into(),
            name: "seed".into(),
            item: ImportItem::Global(GlobalId(0)),
            source: synthetic(),
        },
        Import {
            module: "host".into(),
            name: "failure".into(),
            item: ImportItem::Tag(TagId(0)),
            source: synthetic(),
        },
    ];
    program.tables = vec![
        Table {
            ty: TableType {
                element: RefType {
                    nullable: true,
                    heap: HeapType::Func,
                },
                limits: Limits {
                    min: 1,
                    max: Some(4),
                },
                address_type: AddressType::I32,
            },
            origin: EntityOrigin::Imported(ImportId(1)),
            initializer: None,
            source: synthetic(),
        },
        Table {
            ty: TableType {
                element: RefType {
                    nullable: true,
                    heap: HeapType::Extern,
                },
                limits: Limits { min: 2, max: None },
                address_type: AddressType::I64,
            },
            origin: EntityOrigin::Defined,
            initializer: Some(const_expr(
                Operation::new(
                    "ref.null",
                    vec![],
                    vec![ValueType::Ref(RefType {
                        nullable: true,
                        heap: HeapType::Extern,
                    })],
                )
                .with_immediates(vec![Immediate::HeapType(HeapType::Extern)]),
                ValueType::Ref(RefType {
                    nullable: true,
                    heap: HeapType::Extern,
                }),
            )),
            source: synthetic(),
        },
    ];
    program.memories = vec![
        Memory {
            ty: MemoryType {
                limits: Limits {
                    min: 1,
                    max: Some(4),
                },
                address_type: AddressType::I64,
            },
            origin: EntityOrigin::Imported(ImportId(2)),
            source: synthetic(),
        },
        Memory {
            ty: MemoryType {
                limits: Limits { min: 2, max: None },
                address_type: AddressType::I32,
            },
            origin: EntityOrigin::Defined,
            source: synthetic(),
        },
    ];
    program.globals = vec![
        Global {
            ty: GlobalType {
                value: ValueType::I32,
                mutable: false,
            },
            origin: EntityOrigin::Imported(ImportId(3)),
            initializer: None,
            source: synthetic(),
        },
        Global {
            ty: GlobalType {
                value: ValueType::I64,
                mutable: true,
            },
            origin: EntityOrigin::Defined,
            initializer: Some(i64_const_expr(99)),
            source: synthetic(),
        },
    ];
    program.tags = vec![
        Tag {
            ty: TagType { signature: tag_ty },
            origin: EntityOrigin::Imported(ImportId(4)),
            source: synthetic(),
        },
        Tag {
            ty: TagType { signature: tag_ty },
            origin: EntityOrigin::Defined,
            source: synthetic(),
        },
    ];
    program.functions = vec![
        Function {
            wasm_index: 0,
            ty: callback_ty,
            origin: EntityOrigin::Imported(ImportId(0)),
            locals: vec![ValueType::I32],
            body: None,
            source: synthetic(),
        },
        Function {
            wasm_index: 1,
            ty: start_ty,
            origin: EntityOrigin::Defined,
            locals: vec![ValueType::V128],
            body: Some(FunctionBody {
                entry: BlockId(0),
                root_region: RegionId(0),
                blocks: vec![block(
                    BlockId(0),
                    RegionId(0),
                    vec![],
                    vec![],
                    TerminatorKind::Return { values: vec![] },
                )],
                regions: vec![root_region(BlockId(0))],
            }),
            source: synthetic(),
        },
    ];

    let funcref = RefType {
        nullable: true,
        heap: HeapType::Func,
    };
    let typed_funcref = RefType {
        nullable: false,
        heap: HeapType::Concrete(callback_ty),
    };
    program.elements = vec![
        Element {
            ty: funcref,
            mode: ElementMode::Active {
                table: TableId(0),
                offset: i32_const_expr(0),
            },
            items: vec![ElementItem::Function(FunctionId(0))],
            source: synthetic(),
        },
        Element {
            ty: typed_funcref.clone(),
            mode: ElementMode::Declarative,
            items: vec![ElementItem::Expression(const_expr(
                Operation::new(
                    "ref.func",
                    vec![],
                    vec![ValueType::Ref(typed_funcref.clone())],
                )
                .with_immediates(vec![Immediate::Function(FunctionId(0))]),
                ValueType::Ref(typed_funcref),
            ))],
            source: synthetic(),
        },
    ];
    program.data = vec![
        DataSegment {
            mode: DataMode::Active {
                memory: MemoryId(0),
                offset: i64_const_expr(16),
            },
            bytes: b"wedge".to_vec(),
            source: synthetic(),
        },
        DataSegment {
            mode: DataMode::Passive,
            bytes: vec![0x00, 0x7f, 0x80, 0xff],
            source: synthetic(),
        },
    ];
    program.exports = vec![
        Export {
            name: "start".into(),
            item: ExportItem::Function(FunctionId(1)),
            source: synthetic(),
        },
        Export {
            name: "objects".into(),
            item: ExportItem::Table(TableId(1)),
            source: synthetic(),
        },
        Export {
            name: "memory".into(),
            item: ExportItem::Memory(MemoryId(1)),
            source: synthetic(),
        },
        Export {
            name: "counter".into(),
            item: ExportItem::Global(GlobalId(1)),
            source: synthetic(),
        },
        Export {
            name: "failure".into(),
            item: ExportItem::Tag(TagId(1)),
            source: synthetic(),
        },
    ];
    program.start = Some(FunctionId(1));
    program.metadata.module_name = Some("rich-module".into());
    program
        .metadata
        .function_names
        .insert(FunctionId(0), "callback".into());
    program
        .metadata
        .function_names
        .insert(FunctionId(1), "initialize".into());
    program
        .metadata
        .local_names
        .insert((FunctionId(0), LocalId(0)), "value".into());
    program
        .metadata
        .local_names
        .insert((FunctionId(1), LocalId(0)), "scratch".into());
    program.metadata.producers.push(Producer {
        field: "processed-by".into(),
        name: "wedge-golden".into(),
        version: "0".into(),
    });
    program.metadata.custom_sections.push(CustomSection {
        name: "research-note".into(),
        data: b"fat blocks".to_vec(),
        source: source(220, 240, 20),
    });
    program
}

fn assert_golden(name: &str, program: Program) {
    program
        .verify()
        .unwrap_or_else(|errors| panic!("golden {name} constructed invalid IR:\n{errors}"));

    let resource = buck_resources::get(format!("aseipp/wedge/golden/{name}.txt"))
        .unwrap_or_else(|error| panic!("locate golden {name}: {error}"));
    let expected = std::fs::read_to_string(resource)
        .unwrap_or_else(|error| panic!("read golden {name}: {error}"));
    let actual = program.to_string();
    assert_exact(name, &expected, &actual);
}

fn compiled_fixture(name: &str) -> Program {
    let resource = buck_resources::get(format!("aseipp/wedge/{name}.wasm"))
        .unwrap_or_else(|error| panic!("locate compiled WAT fixture {name}: {error}"));
    let wasm = std::fs::read(resource)
        .unwrap_or_else(|error| panic!("read compiled WAT fixture {name}: {error}"));
    Compiler::default()
        .compile(&wasm)
        .unwrap_or_else(|error| panic!("compile {name}.wat: {error}"))
}

fn assert_exact(name: &str, expected: &str, actual: &str) {
    let Some((line, column)) = first_difference(expected, actual) else {
        return;
    };

    let expected_line = line_text(expected, line);
    let actual_line = line_text(actual, line);
    panic!(
        "golden {name} differs at line {line}, column {column}\n\
         expected: {expected_line:?}\n\
           actual: {actual_line:?}"
    );
}

fn first_difference(expected: &str, actual: &str) -> Option<(usize, usize)> {
    let mut line = 1;
    let mut column = 1;
    let mut expected_chars = expected.chars();
    let mut actual_chars = actual.chars();

    loop {
        match (expected_chars.next(), actual_chars.next()) {
            (Some(expected), Some(actual)) if expected == actual => {
                if expected == '\n' {
                    line += 1;
                    column = 1;
                } else {
                    column += 1;
                }
            }
            (None, None) => return None,
            _ => return Some((line, column)),
        }
    }
}

fn line_text(text: &str, line: usize) -> &str {
    text.split_terminator('\n')
        .nth(line - 1)
        .unwrap_or("<end-of-file>")
}

#[test]
fn comparator_finds_the_first_character_or_end_of_file() {
    assert_eq!(first_difference("same", "same"), None);
    assert_eq!(first_difference("abc", "axc"), Some((1, 2)));
    assert_eq!(first_difference("one\ntwo", "one\ntoo"), Some((2, 2)));
    assert_eq!(first_difference("α\nβ", "α\nβ!"), Some((2, 2)));
    assert_eq!(line_text("one\n", 2), "<end-of-file>");
    assert_eq!(line_text("one\r\ntwo", 1), "one\r");
}

#[test]
fn golden_minimal_typed_function() {
    assert_golden("minimal_typed_function", minimal_typed_function());
}

#[test]
fn golden_diamond_cfg() {
    assert_golden("diamond_cfg", diamond_cfg());
}

#[test]
fn golden_effects_and_exception_handling() {
    assert_golden(
        "effects_and_exception_handling",
        effects_and_exception_handling(),
    );
}

#[test]
fn golden_rich_module_entities_and_types() {
    assert_golden(
        "rich_module_entities_and_types",
        rich_module_entities_and_types(),
    );
}

#[test]
fn golden_wat_to_compiler_answer() {
    assert_golden("compiled_answer", compiled_fixture("answer"));
}

#[test]
fn golden_wat_to_compiler_add() {
    assert_golden("compiled_add", compiled_fixture("add"));
}
