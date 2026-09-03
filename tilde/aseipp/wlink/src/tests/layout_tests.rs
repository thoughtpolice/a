// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The canonical ABI computations, checked against the worked examples of
//! `CanonicalABI.md`.

use wlink::types::{
    CoreType, FuncType, ValType, alignment, contains_borrows, contains_handles_in_memory,
    flat_types, layout, lift_signature, lower_signature, params_layout, size,
};

fn record(fields: &[(&str, ValType)]) -> ValType {
    ValType::Record(
        fields
            .iter()
            .map(|(name, ty)| (name.to_string(), ty.clone()))
            .collect(),
    )
}

fn func(params: &[(&str, ValType)], result: Option<ValType>) -> FuncType {
    FuncType {
        params: params
            .iter()
            .map(|(name, ty)| (name.to_string(), ty.clone()))
            .collect(),
        result,
    }
}

#[test]
fn scalars_have_their_natural_size_and_one_flat_value() {
    assert_eq!((size(&ValType::Bool), alignment(&ValType::Bool)), (1, 1));
    assert_eq!((size(&ValType::U16), alignment(&ValType::U16)), (2, 2));
    assert_eq!((size(&ValType::Char), alignment(&ValType::Char)), (4, 4));
    assert_eq!((size(&ValType::S64), alignment(&ValType::S64)), (8, 8));
    assert_eq!(flat_types(&ValType::U8), vec![CoreType::I32]);
    assert_eq!(flat_types(&ValType::U64), vec![CoreType::I64]);
    assert_eq!(flat_types(&ValType::F32), vec![CoreType::F32]);
    assert_eq!(flat_types(&ValType::F64), vec![CoreType::F64]);
}

#[test]
fn records_pad_fields_to_their_alignment() {
    let ty = record(&[("a", ValType::U8), ("b", ValType::U32), ("c", ValType::U16)]);
    assert_eq!(size(&ty), 12);
    assert_eq!(alignment(&ty), 4);
    assert_eq!(flat_types(&ty), vec![CoreType::I32; 3]);
}

#[test]
fn strings_and_lists_are_pointer_length_pairs() {
    for ty in [ValType::String, ValType::List(Box::new(ValType::U16))] {
        assert_eq!((size(&ty), alignment(&ty)), (8, 4));
        assert_eq!(flat_types(&ty), vec![CoreType::I32, CoreType::I32]);
    }
}

#[test]
fn variants_join_their_payloads_after_a_discriminant() {
    let ty = ValType::Variant(vec![
        ("a".to_string(), Some(ValType::U32)),
        ("b".to_string(), Some(ValType::F32)),
        ("c".to_string(), Some(ValType::U64)),
        ("d".to_string(), None),
    ]);
    assert_eq!(flat_types(&ty), vec![CoreType::I32, CoreType::I64]);
    assert_eq!(alignment(&ty), 8);
    assert_eq!(size(&ty), 16);

    let option = ValType::Option(Box::new(ValType::U8));
    assert_eq!(flat_types(&option), vec![CoreType::I32, CoreType::I32]);
    assert_eq!(size(&option), 2);

    let result = ValType::Result {
        ok: Some(Box::new(ValType::F64)),
        err: None,
    };
    assert_eq!(flat_types(&result), vec![CoreType::I32, CoreType::F64]);
    assert_eq!(size(&result), 16);
}

#[test]
fn enums_and_flags_size_by_their_case_count() {
    let small = ValType::Enum((0..3).map(|i| format!("c{i}")).collect());
    let wide = ValType::Enum((0..300).map(|i| format!("c{i}")).collect());
    assert_eq!((size(&small), size(&wide)), (1, 2));
    assert_eq!(flat_types(&wide), vec![CoreType::I32]);

    let flags = ValType::Flags((0..9).map(|i| format!("f{i}")).collect());
    assert_eq!((size(&flags), alignment(&flags)), (2, 2));
    assert_eq!(flat_types(&flags), vec![CoreType::I32]);
}

#[test]
fn signatures_spill_wide_parameters_and_wide_results() {
    let wide: Vec<(&str, ValType)> = (0..17).map(|_| ("p", ValType::U32)).collect();
    let ty = func(&wide, Some(ValType::U32));
    assert_eq!(lift_signature(&ty).params, vec![CoreType::I32]);
    assert_eq!(lower_signature(&ty).params, vec![CoreType::I32]);

    let ty = func(&[("n", ValType::U32)], Some(ValType::String));
    let lift = lift_signature(&ty);
    assert_eq!(lift.params, vec![CoreType::I32]);
    assert_eq!(lift.results, vec![CoreType::I32]);
    let lower = lower_signature(&ty);
    assert_eq!(lower.params, vec![CoreType::I32, CoreType::I32]);
    assert!(lower.results.is_empty());

    let ty = func(&[], Some(ValType::U64));
    assert_eq!(lift_signature(&ty).results, vec![CoreType::I64]);
    assert_eq!(lower_signature(&ty).results, vec![CoreType::I64]);
}

#[test]
fn layouts_summarize_memory_and_handle_use() {
    let params = [
        ("name".to_string(), ValType::String),
        ("x".to_string(), ValType::U32),
        ("tail".to_string(), ValType::List(Box::new(ValType::U16))),
    ];
    let params = params_layout(&params);
    assert_eq!(params.size, 20);
    assert_eq!(params.align, 4);
    assert_eq!(params.flat.len(), 5);
    assert!(params.needs_memory());
    assert!(!params.handles);

    let scalars = record(&[("a", ValType::U8), ("b", ValType::F64)]);
    assert!(!layout(&scalars).needs_memory());

    let resource = wlink::types::Resource {
        name: "sprite".into(),
        id: 3,
    };
    let handle = ValType::Own(resource.clone());
    assert_eq!((size(&handle), alignment(&handle)), (4, 4));
    assert_eq!(flat_types(&handle), vec![CoreType::I32]);
    let handles = layout(&record(&[
        ("sprite", ValType::Borrow(resource.clone())),
        ("count", ValType::U32),
    ]));
    assert!(handles.handles && !handles.pointers);
    let in_list = ValType::List(Box::new(ValType::Own(resource.clone())));
    assert!(contains_handles_in_memory(&in_list));
    assert!(!contains_handles_in_memory(&handle));
    assert!(contains_borrows(&ValType::Option(Box::new(
        ValType::Borrow(resource.clone())
    ))));
    assert!(!contains_borrows(&in_list));

    // Identity is the resource, not the name it is seen under.
    let other_name = wlink::types::Resource {
        name: "image".into(),
        id: 3,
    };
    let other_resource = wlink::types::Resource {
        name: "sprite".into(),
        id: 4,
    };
    assert_eq!(ValType::Own(resource.clone()), ValType::Own(other_name));
    assert_ne!(ValType::Own(resource), ValType::Own(other_resource));
}

#[test]
fn nested_lists_and_variant_payloads_lay_out() {
    let nested = ValType::List(Box::new(ValType::String));
    let nested = layout(&nested);
    assert_eq!((nested.size, nested.align), (8, 4));
    assert!(nested.needs_memory());

    let optional = ValType::Option(Box::new(ValType::String));
    let optional = layout(&optional);
    assert_eq!((optional.size, optional.align), (12, 4));
    assert_eq!(
        optional.flat,
        vec![CoreType::I32, CoreType::I32, CoreType::I32]
    );
    assert!(optional.needs_memory());
}
