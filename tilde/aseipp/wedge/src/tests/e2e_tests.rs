// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end tests from checked-in WAT through WABT and the Wedge frontend.

use wedge::ir::{
    CompositeType, DataMode, ElementMode, EntityOrigin, ExportItem, FunctionId, HeapType,
    Immediate, Program, RefType, StorageType, TerminatorKind, TypeId, ValueDefinition, ValueId,
    ValueType,
};
use wedge::{CompileError, Compiler};
mod fixture_support;

use fixture_support::{compile_fixture, fixture};

#[test]
fn accepts_distinct_module_types_with_one_canonical_identity() {
    let program = compile_fixture("canonical_types");

    assert_eq!(program.types.len(), 3);
    assert_eq!(program.functions[0].ty, TypeId(1));
    assert_eq!(program.functions[1].ty, TypeId(2));
    assert_eq!(program.types[0].canonical_alias, None);
    assert_eq!(program.types[1].canonical_alias, Some(TypeId(0)));
    assert_eq!(program.types[2].canonical_alias, None);
    assert!(matches!(
        &program.types[0].composite,
        CompositeType::Function(signature)
            if signature.params.is_empty() && signature.results.is_empty()
    ));
    assert!(matches!(
        &program.types[1].composite,
        CompositeType::Function(signature)
            if signature.params.is_empty() && signature.results.is_empty()
    ));

    let producer = program.functions[1]
        .body
        .as_ref()
        .expect("defined producer body");
    let reference = &producer.blocks[0].instructions[0].results[0];
    assert_eq!(
        reference.ty,
        ValueType::Ref(RefType {
            nullable: false,
            heap: HeapType::Concrete(TypeId(0)),
        })
    );
    assert!(
        program
            .to_string()
            .contains("type type1 = canonical(type0) final func")
    );
}

#[test]
fn canonicalizes_equivalent_mutually_recursive_groups_from_a_real_binary() {
    // The pinned WABT does not yet accept the standard `(rec ...)` text form,
    // so encode two equivalent recursive groups directly. Each group has a
    // pair of structs that refer to one another, and the extra i32 field makes
    // the pair's order unambiguous during canonicalization.
    let wasm = [
        0x00, 0x61, 0x73, 0x6d, // magic
        0x01, 0x00, 0x00, 0x00, // version
        0x01, 0x1d, // type section, 29-byte payload
        0x02, // two recursive-group entries
        0x4e, 0x02, // first explicit group, two types
        0x5f, 0x01, 0x63, 0x01, 0x00, // type 0: struct { (ref null 1) }
        0x5f, 0x02, 0x7f, 0x00, 0x63, 0x00, 0x00, // type 1: struct { i32, (ref null 0) }
        0x4e, 0x02, // second explicit group, two equivalent types
        0x5f, 0x01, 0x63, 0x03, 0x00, // type 2: struct { (ref null 3) }
        0x5f, 0x02, 0x7f, 0x00, 0x63, 0x02, 0x00, // type 3: struct { i32, (ref null 2) }
    ];
    let compiler = Compiler::default();

    compiler
        .validate(&wasm)
        .expect("equivalent mutually recursive groups are valid Core Wasm");
    let program = compiler
        .compile(&wasm)
        .expect("lower equivalent mutually recursive groups");
    program
        .verify()
        .expect("recursive canonical aliases remain valid IR");

    assert_eq!(program.rec_groups.len(), 2);
    assert_eq!(program.rec_groups[0].types, [TypeId(0), TypeId(1)]);
    assert_eq!(program.rec_groups[1].types, [TypeId(2), TypeId(3)]);
    assert_eq!(program.types[0].canonical_alias, None);
    assert_eq!(program.types[1].canonical_alias, None);
    assert_eq!(program.types[2].canonical_alias, Some(TypeId(0)));
    assert_eq!(program.types[3].canonical_alias, Some(TypeId(1)));

    let referenced_type = |ty: TypeId, field: usize| match &program.types[ty.index()].composite {
        CompositeType::Struct(fields) => match &fields[field].storage {
            StorageType::Value(ValueType::Ref(RefType {
                heap: HeapType::Concrete(target),
                ..
            })) => *target,
            storage => panic!("expected a concrete reference field, got {storage:?}"),
        },
        composite => panic!("expected a struct type, got {composite:?}"),
    };
    assert_eq!(referenced_type(TypeId(0), 0), TypeId(1));
    assert_eq!(referenced_type(TypeId(1), 1), TypeId(0));
    assert_eq!(referenced_type(TypeId(2), 0), TypeId(3));
    assert_eq!(referenced_type(TypeId(3), 1), TypeId(2));
}

#[test]
fn compiles_constant_into_a_typed_ssa_value() {
    let program = compile_fixture("answer");

    assert_eq!(program.wasm_version, 1);
    assert_eq!(program.import_count(), 0);
    assert_eq!(program.imported_function_count(), 0);
    assert_eq!(program.functions.len(), 1);
    assert_eq!(program.exports.len(), 1);
    assert_eq!(program.exports[0].name, "answer");
    assert_eq!(
        program.exports[0].item,
        ExportItem::Function(wedge::ir::FunctionId(0))
    );

    let body = program
        .functions
        .first()
        .expect("defined function")
        .body
        .as_ref()
        .expect("defined body");
    assert_eq!(body.blocks.len(), 1);
    let entry = &body.blocks[0];
    assert_eq!(entry.instructions.len(), 1);
    assert_eq!(entry.instructions[0].operation.mnemonic, "i32.const");
    assert_eq!(
        entry.instructions[0].operation.immediates,
        [Immediate::S32(42)]
    );
    assert_eq!(
        entry.instructions[0].results,
        [ValueDefinition::new(ValueId(0), ValueType::I32)]
    );
    assert!(matches!(
        &entry.terminator.kind,
        TerminatorKind::Return { values } if values == &[ValueId(0)]
    ));
}

#[test]
fn turns_parameters_and_the_wasm_stack_into_ssa_dataflow() {
    let program = compile_fixture("add");

    let body = program
        .functions
        .first()
        .expect("defined function")
        .body
        .as_ref()
        .expect("defined body");
    let entry = body.blocks.first().expect("entry block");
    let mnemonics: Vec<_> = entry
        .instructions
        .iter()
        .map(|instruction| instruction.operation.mnemonic())
        .collect();
    assert_eq!(
        entry.parameters,
        [
            ValueDefinition::new(ValueId(0), ValueType::I32),
            ValueDefinition::new(ValueId(1), ValueType::I32),
        ]
    );
    assert_eq!(mnemonics, ["i32.add"]);
    assert_eq!(entry.instructions[0].operands, [ValueId(0), ValueId(1)]);
    assert_eq!(
        entry.instructions[0].results,
        [ValueDefinition::new(ValueId(2), ValueType::I32)]
    );
    assert!(matches!(
        &entry.terminator.kind,
        TerminatorKind::Return { values } if values == &[ValueId(2)]
    ));

    let ordinals: Vec<_> = entry
        .instructions
        .iter()
        .map(|instruction| instruction.source.ordinal)
        .chain(std::iter::once(entry.terminator.source.ordinal))
        .collect();
    assert_eq!(ordinals, [Some(2), Some(3)]);
    assert!(
        entry
            .instructions
            .iter()
            .all(|instruction| instruction.source.byte_span.is_some())
    );
}

#[test]
fn decodes_the_name_section_and_drops_entries_naming_nothing() {
    let program = compile_fixture("named_functions");

    assert_eq!(program.metadata.module_name.as_deref(), Some("named"));
    let names: Vec<_> = program
        .metadata
        .function_names
        .iter()
        .map(|(id, name)| (id.index(), name.as_str()))
        .collect();
    assert_eq!(names, [(0, "log"), (1, "accumulate"), (2, "helper")]);
    let locals: Vec<_> = program
        .metadata
        .local_names
        .iter()
        .map(|((function, local), name)| (function.index(), local.index(), name.as_str()))
        .collect();
    assert_eq!(locals, [(1, 0, "count"), (1, 1, "total")]);
    assert_eq!(program.functions_named("accumulate"), [FunctionId(1)]);
    assert_eq!(program.function_name(FunctionId(2)), Some("helper"));
    assert!(
        program
            .metadata
            .custom_sections
            .iter()
            .all(|section| section.name != "name"),
        "a decoded name section is not retained opaquely"
    );

    let text = program.to_string();
    assert!(
        text.contains("func func1 wasm-index=1 : type1 defined name=\"accumulate\""),
        "{text}"
    );
    assert!(text.contains("name func2 = \"helper\""), "{text}");
    assert!(text.contains("name func1/local1 = \"total\""), "{text}");
    let display = program
        .function_display(FunctionId(0))
        .expect("func0 exists")
        .to_string();
    assert!(
        display.starts_with("  func func0 wasm-index=0 : type0 imported(import0) name=\"log\""),
        "{display}"
    );
    assert_eq!(display.lines().count(), 1);
    assert!(program.function_display(FunctionId(3)).is_none());

    // The name section is not validated: an entry for a function or local
    // that does not exist is dropped, and the module still compiles.
    let mut oversized = fixture("named_functions");
    let mut names = Vec::new();
    push_name(&mut names, "name");
    names.push(1);
    push_name_map(&mut names, &[(7, "phantom"), (1, "accumulate")]);
    names.push(2);
    let mut locals = vec![2];
    push_u32_leb(&mut locals, 1);
    push_name_map(&mut locals, &[(9, "ghost")]);
    push_u32_leb(&mut locals, 8);
    push_name_map(&mut locals, &[(0, "orphan")]);
    push_u32_leb(&mut names, locals.len() as u32);
    names.extend(locals);
    push_section(&mut oversized, 0, &names);
    let program = Compiler::default()
        .compile(&oversized)
        .expect("a name section naming nothing is not an error");
    let names: Vec<_> = program
        .metadata
        .function_names
        .iter()
        .map(|(id, name)| (id.index(), name.as_str()))
        .collect();
    assert_eq!(names, [(0, "log"), (1, "accumulate"), (2, "helper")]);
    assert_eq!(program.metadata.local_names.len(), 2);
    program.verify().expect("pruned metadata verifies");
}

#[test]
fn decodes_producers_and_retains_malformed_standard_sections_opaquely() {
    let mut module = fixture("answer");
    let mut producers = Vec::new();
    push_name(&mut producers, "producers");
    push_u32_leb(&mut producers, 2);
    push_name(&mut producers, "language");
    push_u32_leb(&mut producers, 1);
    push_name(&mut producers, "wat");
    push_name(&mut producers, "");
    push_name(&mut producers, "processed-by");
    push_u32_leb(&mut producers, 2);
    push_name(&mut producers, "wabt");
    push_name(&mut producers, "1.0");
    push_name(&mut producers, "wedge");
    push_name(&mut producers, "0");
    push_section(&mut module, 0, &producers);
    // A function-names subsection whose declared length runs past its data.
    let mut malformed = Vec::new();
    push_name(&mut malformed, "name");
    malformed.extend([1, 200, 1, 0, 3, b'a']);
    push_section(&mut module, 0, &malformed);

    let program = Compiler::default()
        .compile(&module)
        .expect("custom sections never invalidate a module");
    let producers: Vec<_> = program
        .metadata
        .producers
        .iter()
        .map(|producer| {
            (
                producer.field.as_str(),
                producer.name.as_str(),
                producer.version.as_str(),
            )
        })
        .collect();
    assert_eq!(
        producers,
        [
            ("language", "wat", ""),
            ("processed-by", "wabt", "1.0"),
            ("processed-by", "wedge", "0"),
        ]
    );
    assert!(program.metadata.function_names.is_empty());
    let retained: Vec<_> = program
        .metadata
        .custom_sections
        .iter()
        .map(|section| section.name.as_str())
        .collect();
    assert_eq!(retained, ["name"]);
    assert!(
        program
            .to_string()
            .contains("producer \"processed-by\" \"wedge\" \"0\"")
    );
}

fn push_u32_leb(out: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn push_name(out: &mut Vec<u8>, name: &str) {
    push_u32_leb(out, name.len() as u32);
    out.extend_from_slice(name.as_bytes());
}

fn push_name_map(out: &mut Vec<u8>, names: &[(u32, &str)]) {
    push_u32_leb(out, names.len() as u32);
    for (index, name) in names {
        push_u32_leb(out, *index);
        push_name(out, name);
    }
}

fn push_section(out: &mut Vec<u8>, id: u8, payload: &[u8]) {
    out.push(id);
    push_u32_leb(out, payload.len() as u32);
    out.extend_from_slice(payload);
}

#[test]
fn owns_every_import_and_export_index_space() {
    let program = compile_fixture("module_entities");

    assert_eq!(program.imports.len(), 5);
    assert_eq!(program.functions.len(), 1);
    assert_eq!(program.tables.len(), 1);
    assert_eq!(program.memories.len(), 1);
    assert_eq!(program.globals.len(), 1);
    assert_eq!(program.tags.len(), 1);
    assert_eq!(program.exports.len(), 5);
    assert!(
        program.metadata.custom_sections.iter().any(|section| {
            section.name == "wedge.meta" && section.data.as_slice() == b"dataflow"
        })
    );
    assert!(program.functions[0].body.is_none());
    assert!(matches!(
        program.functions[0].origin,
        EntityOrigin::Imported(_)
    ));

    let exported: Vec<_> = program
        .exports
        .iter()
        .map(|export| export.item.kind())
        .collect();
    assert_eq!(
        exported,
        [
            wedge::ir::ExportKind::Function,
            wedge::ir::ExportKind::Table,
            wedge::ir::ExportKind::Memory,
            wedge::ir::ExportKind::Global,
            wedge::ir::ExportKind::Tag,
        ]
    );
}

#[test]
fn owns_gc_struct_and_array_type_declarations() {
    let program = compile_fixture("gc_types");

    assert_eq!(program.types.len(), 2);
    assert_eq!(program.rec_groups.len(), 2);
    assert!(matches!(
        program.types[0].composite,
        CompositeType::Struct(_)
    ));
    assert!(matches!(
        program.types[1].composite,
        CompositeType::Array(_)
    ));
}

#[test]
fn owns_active_passive_and_declarative_segments() {
    let program = compile_fixture("segments");

    assert_eq!(program.elements.len(), 3);
    assert!(matches!(
        program.elements[0].mode,
        ElementMode::Active { .. }
    ));
    assert!(matches!(program.elements[1].mode, ElementMode::Passive));
    assert!(matches!(program.elements[2].mode, ElementMode::Declarative));
    assert_eq!(program.data.len(), 2);
    assert!(matches!(program.data[0].mode, DataMode::Active { .. }));
    assert!(matches!(program.data[1].mode, DataMode::Passive));
}

#[test]
fn owns_extended_constant_expressions() {
    let program = compile_fixture("extended_const");

    let initializer = program
        .globals
        .get(1)
        .expect("defined global")
        .initializer
        .as_ref()
        .expect("defined global initializer");
    let mnemonics: Vec<_> = initializer
        .instructions
        .iter()
        .map(|instruction| instruction.operation.mnemonic())
        .collect();
    assert_eq!(mnemonics, ["global.get", "i32.const", "i32.add"]);
    assert!(matches!(
        program.data.first().expect("active data segment").mode,
        DataMode::Active { .. }
    ));
}

#[test]
fn preserves_the_precise_type_of_reference_constant_expressions() {
    let program = compile_fixture("reference_const_expr");

    let table = program.tables.first().expect("defined table");
    assert_eq!(
        table.ty.element,
        RefType {
            nullable: true,
            heap: HeapType::Func,
        }
    );

    let initializer = table.initializer.as_ref().expect("table initializer");
    let precise_type = ValueType::Ref(RefType {
        nullable: false,
        heap: HeapType::Concrete(TypeId(0)),
    });
    assert_eq!(initializer.result_type, precise_type);
    assert_eq!(initializer.instructions.len(), 1);
    let operation = &initializer.instructions[0].operation;
    assert_eq!(operation.mnemonic, "ref.func");
    assert_eq!(operation.signature.results, [precise_type]);
    assert_eq!(
        operation.immediates,
        [Immediate::Function(wedge::ir::FunctionId(0))]
    );
}

#[test]
fn lowers_standard_scalar_operators_with_instantiated_signatures() {
    let program = compile_fixture("numeric");
    let operations: Vec<_> = program
        .functions
        .iter()
        .flat_map(|function| &function.body)
        .flat_map(|body| &body.blocks)
        .flat_map(|block| &block.instructions)
        .map(|instruction| instruction.operation.mnemonic())
        .collect();

    assert!(operations.contains(&"i64.mul"));
    assert!(operations.contains(&"f64.sqrt"));
    assert!(operations.contains(&"f32.reinterpret_i32"));
}

#[test]
fn rejects_malformed_binary_input_before_lowering() {
    let error = Compiler::default()
        .compile(b"not wasm")
        .expect_err("malformed input must fail validation");

    assert!(matches!(error, CompileError::InvalidWasm { .. }));
}

#[test]
fn an_empty_recursive_group_does_not_shift_following_type_indices() {
    let wasm = [
        0x00, 0x61, 0x73, 0x6d, // magic
        0x01, 0x00, 0x00, 0x00, // version
        0x01, 0x0b, // type section, eleven-byte payload
        0x03, // three rec-group entries
        0x4e, 0x00, // explicit rec group containing zero types
        0x60, 0x00, 0x00, // type 0: () -> ()
        0x60, 0x01, 0x7f, 0x01, 0x7f, // type 1: (i32) -> i32
        0x03, 0x02, 0x01, 0x01, // one function using module type index 1
        0x0a, 0x06, // code section, six-byte payload
        0x01, 0x04, // one four-byte body
        0x00, // no local declarations
        0x20, 0x00, // local.get 0
        0x0b, // end
    ];
    let compiler = Compiler::default();

    compiler
        .validate(&wasm)
        .expect("an empty recursive group before used types is valid Core Wasm");
    let program = compiler
        .compile(&wasm)
        .expect("lower types and a function after an empty recursive group");
    program
        .verify()
        .expect("empty recursive group preserves valid IR indices");

    assert_eq!(program.rec_groups.len(), 3);
    assert!(program.rec_groups[0].types.is_empty());
    assert_eq!(program.rec_groups[1].types, [TypeId(0)]);
    assert_eq!(program.rec_groups[2].types, [TypeId(1)]);
    assert_eq!(program.types.len(), 2);
    assert_eq!(program.functions.len(), 1);
    assert_eq!(program.functions[0].ty, TypeId(1));

    let body = program.functions[0].body.as_ref().expect("defined body");
    assert_eq!(body.blocks[0].parameters[0].ty, ValueType::I32);
    assert!(matches!(
        &body.blocks[0].terminator.kind,
        TerminatorKind::Return { values }
            if values == &[body.blocks[0].parameters[0].id]
    ));
}
