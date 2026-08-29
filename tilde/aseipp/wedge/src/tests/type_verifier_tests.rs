// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Focused contracts for Core Wasm nominal subtype and recursive-group rules.

use wedge::ir::*;

fn source() -> SourceInfo {
    SourceInfo::synthetic()
}

fn definition(final_: bool, supertype: Option<u32>, composite: CompositeType) -> TypeDefinition {
    TypeDefinition {
        canonical_alias: None,
        final_,
        supertype: supertype.map(TypeId),
        composite,
        source: source(),
    }
}

fn structure(final_: bool, supertype: Option<u32>, fields: Vec<FieldType>) -> TypeDefinition {
    definition(final_, supertype, CompositeType::Struct(fields))
}

fn array(final_: bool, supertype: Option<u32>, field: FieldType) -> TypeDefinition {
    definition(final_, supertype, CompositeType::Array(field))
}

fn function(
    final_: bool,
    supertype: Option<u32>,
    params: Vec<ValueType>,
    results: Vec<ValueType>,
) -> TypeDefinition {
    definition(
        final_,
        supertype,
        CompositeType::Function(FunctionType { params, results }),
    )
}

fn field(storage: StorageType, mutable: bool) -> FieldType {
    FieldType { storage, mutable }
}

fn reference(id: u32) -> ValueType {
    ValueType::Ref(RefType {
        nullable: true,
        heap: HeapType::Concrete(TypeId(id)),
    })
}

fn singleton_groups(count: usize) -> Vec<Vec<u32>> {
    (0..count).map(|index| vec![index as u32]).collect()
}

fn program(types: Vec<TypeDefinition>, groups: Vec<Vec<u32>>) -> Program {
    let mut program = Program::new(1);
    program.types = types;
    program.rec_groups = groups
        .into_iter()
        .map(|types| RecGroup {
            types: types.into_iter().map(TypeId).collect(),
            source: source(),
        })
        .collect();
    program
}

fn verification_error(program: &Program) -> String {
    program
        .verify()
        .expect_err("malformed type IR should fail verification")
        .to_string()
}

fn base_and_child() -> Vec<TypeDefinition> {
    vec![
        structure(false, None, vec![]),
        structure(true, Some(0), vec![]),
    ]
}

fn subtype_chain(length: usize) -> Vec<TypeDefinition> {
    (0..length)
        .map(|index| {
            structure(
                index + 1 == length,
                index.checked_sub(1).map(|supertype| supertype as u32),
                vec![],
            )
        })
        .collect()
}

#[test]
fn rejects_a_subtype_of_a_final_type() {
    let types = vec![
        structure(true, None, vec![]),
        structure(true, Some(0), vec![]),
    ];
    let error = verification_error(&program(types, singleton_groups(2)));
    assert!(
        error.contains("type1 cannot extend final supertype type0"),
        "{error}"
    );
}

#[test]
fn rejects_a_supertype_that_is_not_defined_earlier() {
    let types = vec![
        structure(true, Some(1), vec![]),
        structure(false, None, vec![]),
    ];
    let error = verification_error(&program(types, singleton_groups(2)));
    assert!(
        error.contains("type0 supertype type1 is not an earlier module type"),
        "{error}"
    );
}

#[test]
fn enforces_the_core_nominal_subtype_depth_limit() {
    program(subtype_chain(64), singleton_groups(64))
        .verify()
        .expect("a root plus 63 nominal subtype edges is valid");

    let error = verification_error(&program(subtype_chain(65), singleton_groups(65)));
    assert!(
        error.contains("type64 subtype hierarchy depth 64 exceeds maximum 63"),
        "{error}"
    );
}

#[test]
fn rejects_mismatched_composite_kinds() {
    let types = vec![
        structure(false, None, vec![]),
        array(
            true,
            Some(0),
            field(StorageType::Value(ValueType::I32), false),
        ),
    ];
    let error = verification_error(&program(types, singleton_groups(2)));
    assert!(
        error.contains("type1 composite type does not match declared supertype type0"),
        "{error}"
    );
}

#[test]
fn accepts_contravariant_function_parameters_and_covariant_results() {
    let mut types = base_and_child();
    types.extend([
        function(false, None, vec![reference(1)], vec![reference(0)]),
        function(true, Some(2), vec![reference(0)], vec![reference(1)]),
    ]);
    program(types, singleton_groups(4))
        .verify()
        .expect("valid function variance");
}

#[test]
fn rejects_covariant_function_parameters() {
    let mut types = base_and_child();
    types.extend([
        function(false, None, vec![reference(0)], vec![]),
        function(true, Some(2), vec![reference(1)], vec![]),
    ]);
    let error = verification_error(&program(types, singleton_groups(4)));
    assert!(
        error.contains("type3 composite type does not match declared supertype type2"),
        "{error}"
    );
}

#[test]
fn rejects_contravariant_function_results() {
    let mut types = base_and_child();
    types.extend([
        function(false, None, vec![], vec![reference(1)]),
        function(true, Some(2), vec![], vec![reference(0)]),
    ]);
    let error = verification_error(&program(types, singleton_groups(4)));
    assert!(
        error.contains("type3 composite type does not match declared supertype type2"),
        "{error}"
    );
}

#[test]
fn rejects_function_arity_changes() {
    let types = vec![
        function(false, None, vec![], vec![]),
        function(true, Some(0), vec![ValueType::I32], vec![]),
    ];
    let error = verification_error(&program(types, singleton_groups(2)));
    assert!(
        error.contains("type1 composite type does not match declared supertype type0"),
        "{error}"
    );
}

#[test]
fn accepts_struct_width_and_immutable_field_covariance() {
    let mut types = base_and_child();
    types.extend([
        structure(
            false,
            None,
            vec![field(StorageType::Value(reference(0)), false)],
        ),
        structure(
            true,
            Some(2),
            vec![
                field(StorageType::Value(reference(1)), false),
                field(StorageType::Value(ValueType::I32), true),
            ],
        ),
    ]);
    program(types, singleton_groups(4))
        .verify()
        .expect("valid struct width and depth subtyping");
}

#[test]
fn rejects_missing_or_widened_struct_prefix_fields() {
    let too_short = vec![
        structure(
            false,
            None,
            vec![
                field(StorageType::Value(ValueType::I32), false),
                field(StorageType::Value(ValueType::I64), false),
            ],
        ),
        structure(
            true,
            Some(0),
            vec![field(StorageType::Value(ValueType::I32), false)],
        ),
    ];
    let error = verification_error(&program(too_short, singleton_groups(2)));
    assert!(
        error.contains("type1 composite type does not match declared supertype type0"),
        "{error}"
    );

    let mut widened = base_and_child();
    widened.extend([
        structure(
            false,
            None,
            vec![field(StorageType::Value(reference(1)), false)],
        ),
        structure(
            true,
            Some(2),
            vec![field(StorageType::Value(reference(0)), false)],
        ),
    ]);
    let error = verification_error(&program(widened, singleton_groups(4)));
    assert!(
        error.contains("type3 composite type does not match declared supertype type2"),
        "{error}"
    );
}

#[test]
fn immutable_array_fields_are_covariant_but_mutable_fields_are_invariant() {
    let mut immutable = base_and_child();
    immutable.extend([
        array(false, None, field(StorageType::Value(reference(0)), false)),
        array(
            true,
            Some(2),
            field(StorageType::Value(reference(1)), false),
        ),
    ]);
    program(immutable, singleton_groups(4))
        .verify()
        .expect("immutable array fields may narrow");

    let mut mutable = base_and_child();
    mutable.extend([
        array(false, None, field(StorageType::Value(reference(0)), true)),
        array(true, Some(2), field(StorageType::Value(reference(1)), true)),
    ]);
    let error = verification_error(&program(mutable, singleton_groups(4)));
    assert!(
        error.contains("type3 composite type does not match declared supertype type2"),
        "{error}"
    );
}

#[test]
fn rejects_field_mutability_changes() {
    for (super_mutable, subtype_mutable) in [(false, true), (true, false)] {
        let types = vec![
            array(
                false,
                None,
                field(StorageType::Value(ValueType::I32), super_mutable),
            ),
            array(
                true,
                Some(0),
                field(StorageType::Value(ValueType::I32), subtype_mutable),
            ),
        ];
        let error = verification_error(&program(types, singleton_groups(2)));
        assert!(
            error.contains("type1 composite type does not match declared supertype type0"),
            "{error}"
        );
    }
}

#[test]
fn mutable_fields_accept_canonically_equivalent_type_indices() {
    let mut alias = structure(true, None, vec![]);
    alias.canonical_alias = Some(TypeId(0));
    let types = vec![
        structure(true, None, vec![]),
        alias,
        array(false, None, field(StorageType::Value(reference(0)), true)),
        array(true, Some(2), field(StorageType::Value(reference(1)), true)),
    ];
    program(types, singleton_groups(4))
        .verify()
        .expect("canonical aliases are equivalent in invariant fields");
}

#[test]
fn packed_storage_types_match_only_themselves() {
    let types = vec![
        array(false, None, field(StorageType::I8, false)),
        array(true, Some(0), field(StorageType::I16, false)),
    ];
    let error = verification_error(&program(types, singleton_groups(2)));
    assert!(
        error.contains("type1 composite type does not match declared supertype type0"),
        "{error}"
    );
}

#[test]
fn accepts_recursive_struct_field_refinement_within_one_group() {
    let types = vec![
        structure(
            false,
            None,
            vec![field(StorageType::Value(reference(0)), false)],
        ),
        structure(
            true,
            Some(0),
            vec![field(StorageType::Value(reference(1)), false)],
        ),
    ];
    program(types, vec![vec![0, 1]])
        .verify()
        .expect("recursive nominal field refinement");
}

#[test]
fn recursive_groups_preserve_type_order_while_allowing_empty_groups() {
    let types = vec![
        structure(
            true,
            None,
            vec![field(StorageType::Value(reference(1)), false)],
        ),
        structure(true, None, vec![]),
    ];
    program(types, vec![vec![], vec![0, 1], vec![]])
        .verify()
        .expect("empty groups and same-group forward references are valid");

    for groups in [vec![vec![1, 0, 2]], vec![vec![0, 2], vec![1]]] {
        let types = vec![
            structure(true, None, vec![]),
            structure(true, None, vec![]),
            structure(true, None, vec![]),
        ];
        let error = verification_error(&program(types, groups));
        assert!(error.contains("at flattened position"), "{error}");
    }
}

#[test]
fn rejects_a_type_reference_into_a_later_recursive_group() {
    let types = vec![
        structure(
            true,
            None,
            vec![field(StorageType::Value(reference(1)), false)],
        ),
        structure(true, None, vec![]),
    ];
    let error = verification_error(&program(types, singleton_groups(2)));
    assert!(
        error.contains("type0 references type1 in later recursive type group rec1"),
        "{error}"
    );
}
