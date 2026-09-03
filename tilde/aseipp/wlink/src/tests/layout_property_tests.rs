// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generative contracts for the canonical ABI layout functions.
//!
//! Types are drawn as bounded trees and checked against the shape
//! `CanonicalABI.md` prescribes, restated here independently of `types.rs`:
//! where a size and an alignment come from, which flat types a value has,
//! what a walk of the type finds, and when a signature spills to memory.
//! Every generator is bounded and rejection-free so a derandomized run spends
//! its whole case budget on accepted cases.

use hegel::{TestCase, generators as gs};
use wlink::types::{
    CoreType, FuncType, Layout, MAX_FLAT_PARAMS, MAX_FLAT_RESULTS, Resource, ValType, alignment,
    contains_borrows, contains_handles, contains_handles_in_memory, contains_pointers, flat_types,
    layout, lift_signature, lower_signature, params_layout, params_record, size,
};

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

const MAX_DEPTH: usize = 3;
const MAX_ARITY: usize = 4;
/// Enough cases for a two-byte discriminant.
const MAX_ENUM_CASES: usize = 300;
/// Enough flags for two- and four-byte representations.
const MAX_FLAGS: usize = 20;

fn names(tc: &TestCase, prefix: &str, max: usize) -> Vec<String> {
    let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(max));
    (0..count).map(|index| format!("{prefix}{index}")).collect()
}

fn resource(tc: &TestCase) -> Resource {
    let id = tc.draw(gs::integers::<u32>().max_value(3));
    Resource {
        name: format!("r{id}"),
        id,
    }
}

fn payload(tc: &TestCase, depth: usize) -> Option<Box<ValType>> {
    tc.draw(gs::booleans())
        .then(|| Box::new(draw_type(tc, depth - 1)))
}

fn draw_type(tc: &TestCase, depth: usize) -> ValType {
    const LEAVES: usize = 15;
    const NESTED: usize = 8;
    let kinds = if depth == 0 { LEAVES } else { LEAVES + NESTED };
    match tc.draw(gs::integers::<usize>().max_value(kinds - 1)) {
        0 => ValType::Bool,
        1 => ValType::S8,
        2 => ValType::U8,
        3 => ValType::S16,
        4 => ValType::U16,
        5 => ValType::S32,
        6 => ValType::U32,
        7 => ValType::S64,
        8 => ValType::U64,
        9 => ValType::F32,
        10 => ValType::F64,
        11 => ValType::Char,
        12 => ValType::String,
        13 => ValType::Own(resource(tc)),
        14 => ValType::Borrow(resource(tc)),
        15 => ValType::List(Box::new(draw_type(tc, depth - 1))),
        16 => ValType::Record(
            names(tc, "f", MAX_ARITY)
                .into_iter()
                .map(|name| (name, draw_type(tc, depth - 1)))
                .collect(),
        ),
        17 => {
            let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(MAX_ARITY));
            ValType::Tuple((0..count).map(|_| draw_type(tc, depth - 1)).collect())
        }
        18 => ValType::Variant(
            names(tc, "c", MAX_ARITY)
                .into_iter()
                .map(|name| (name, payload(tc, depth).map(|case| *case)))
                .collect(),
        ),
        19 => ValType::Enum(names(tc, "e", MAX_ENUM_CASES)),
        20 => ValType::Option(Box::new(draw_type(tc, depth - 1))),
        21 => ValType::Result {
            ok: payload(tc, depth),
            err: payload(tc, depth),
        },
        _ => ValType::Flags(names(tc, "b", MAX_FLAGS)),
    }
}

fn draw_func_type(tc: &TestCase) -> FuncType {
    let count = tc.draw(gs::integers::<usize>().max_value(6));
    let mut params: Vec<(String, ValType)> = (0..count)
        .map(|index| (format!("p{index}"), draw_type(tc, 2)))
        .collect();
    // Half of the signatures carry a tuple wide enough that the flat
    // parameters may pass the spill limit.
    if tc.draw(gs::booleans()) {
        let width = tc.draw(
            gs::integers::<usize>()
                .min_value(1)
                .max_value(MAX_FLAT_PARAMS + 4),
        );
        params.push(("wide".into(), ValType::Tuple(vec![ValType::U32; width])));
    }
    let result = tc.draw(gs::booleans()).then(|| draw_type(tc, 2));
    FuncType { params, result }
}

/// The despecialized fields of a record-like type.
fn fields(ty: &ValType) -> Option<Vec<&ValType>> {
    match ty {
        ValType::Record(fields) => Some(fields.iter().map(|(_, ty)| ty).collect()),
        ValType::Tuple(types) => Some(types.iter().collect()),
        _ => None,
    }
}

/// The despecialized cases of a variant-like type, payload or not.
fn cases(ty: &ValType) -> Option<Vec<Option<&ValType>>> {
    match ty {
        ValType::Variant(cases) => Some(cases.iter().map(|(_, ty)| ty.as_ref()).collect()),
        ValType::Enum(names) => Some(vec![None; names.len()]),
        ValType::Option(ty) => Some(vec![None, Some(ty)]),
        ValType::Result { ok, err } => Some(vec![ok.as_deref(), err.as_deref()]),
        _ => None,
    }
}

/// The types stored inside a value of `ty`: fields and case payloads. A
/// list's elements live behind its pointer, not inside it.
fn inline_children(ty: &ValType) -> Vec<&ValType> {
    fields(ty)
        .or_else(|| cases(ty).map(|cases| cases.into_iter().flatten().collect()))
        .unwrap_or_default()
}

/// Every type `ty` mentions, list elements included.
fn children(ty: &ValType) -> Vec<&ValType> {
    match ty {
        ValType::List(element) => vec![element],
        _ => inline_children(ty),
    }
}

/// Whether `predicate` holds for `ty` or any type nested in it.
fn any_node(ty: &ValType, predicate: &impl Fn(&ValType) -> bool) -> bool {
    predicate(ty)
        || children(ty)
            .into_iter()
            .any(|child| any_node(child, predicate))
}

fn align_up(offset: u32, align: u32) -> u32 {
    offset.next_multiple_of(align)
}

fn discriminant(cases: usize) -> u32 {
    match cases {
        0..=256 => 1,
        257..=65536 => 2,
        _ => 4,
    }
}

fn expected_alignment(ty: &ValType) -> u32 {
    match ty {
        ValType::Bool | ValType::S8 | ValType::U8 => 1,
        ValType::S16 | ValType::U16 => 2,
        ValType::S32 | ValType::U32 | ValType::F32 | ValType::Char => 4,
        ValType::S64 | ValType::U64 | ValType::F64 => 8,
        ValType::String | ValType::List(_) | ValType::Own(_) | ValType::Borrow(_) => 4,
        ValType::Flags(names) => match names.len() {
            0..=8 => 1,
            9..=16 => 2,
            _ => 4,
        },
        _ => {
            if let Some(fields) = fields(ty) {
                fields.iter().map(|field| alignment(field)).max().unwrap()
            } else {
                let cases = cases(ty).unwrap();
                let payloads = cases.iter().flatten().map(|case| alignment(case)).max();
                discriminant(cases.len()).max(payloads.unwrap_or(1))
            }
        }
    }
}

fn expected_size(ty: &ValType) -> u32 {
    match ty {
        ValType::String | ValType::List(_) => 8,
        ValType::Own(_) | ValType::Borrow(_) => 4,
        ValType::Flags(_) => expected_alignment(ty),
        _ if fields(ty).is_none() && cases(ty).is_none() => expected_alignment(ty),
        _ => {
            if let Some(fields) = fields(ty) {
                let end = fields.iter().fold(0, |offset, field| {
                    align_up(offset, alignment(field)) + size(field)
                });
                align_up(end, expected_alignment(ty))
            } else {
                let cases = cases(ty).unwrap();
                let payload_align = cases
                    .iter()
                    .flatten()
                    .map(|case| alignment(case))
                    .max()
                    .unwrap_or(1);
                let payload_size = cases
                    .iter()
                    .flatten()
                    .map(|case| size(case))
                    .max()
                    .unwrap_or(0);
                let end = align_up(discriminant(cases.len()), payload_align) + payload_size;
                align_up(end, expected_alignment(ty))
            }
        }
    }
}

fn join(left: CoreType, right: CoreType) -> CoreType {
    match (left, right) {
        _ if left == right => left,
        (CoreType::I32, CoreType::F32) | (CoreType::F32, CoreType::I32) => CoreType::I32,
        _ => CoreType::I64,
    }
}

fn expected_flat(ty: &ValType) -> Vec<CoreType> {
    match ty {
        ValType::Bool
        | ValType::S8
        | ValType::U8
        | ValType::S16
        | ValType::U16
        | ValType::S32
        | ValType::U32
        | ValType::Char
        | ValType::Flags(_)
        | ValType::Own(_)
        | ValType::Borrow(_) => vec![CoreType::I32],
        ValType::S64 | ValType::U64 => vec![CoreType::I64],
        ValType::F32 => vec![CoreType::F32],
        ValType::F64 => vec![CoreType::F64],
        ValType::String | ValType::List(_) => vec![CoreType::I32, CoreType::I32],
        _ => {
            if let Some(fields) = fields(ty) {
                fields.into_iter().flat_map(expected_flat).collect()
            } else {
                let mut joined: Vec<CoreType> = Vec::new();
                for case in cases(ty).unwrap().into_iter().flatten() {
                    for (index, flat) in expected_flat(case).into_iter().enumerate() {
                        match joined.get_mut(index) {
                            Some(slot) => *slot = join(*slot, flat),
                            None => joined.push(flat),
                        }
                    }
                }
                let mut flat = vec![CoreType::I32];
                flat.extend(joined);
                flat
            }
        }
    }
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn sizes_and_alignments_follow_the_canonical_abi(tc: TestCase) {
    let ty = draw_type(&tc, MAX_DEPTH);
    tc.note(&ty.to_string());
    let align = alignment(&ty);
    let total = size(&ty);
    assert!(matches!(align, 1 | 2 | 4 | 8), "{ty} has alignment {align}");
    assert_eq!(align, expected_alignment(&ty), "alignment of {ty}");
    assert_eq!(total, expected_size(&ty), "size of {ty}");
    assert_eq!(
        total % align,
        0,
        "{ty} has size {total} at alignment {align}"
    );
    for child in inline_children(&ty) {
        assert!(
            alignment(child) <= align,
            "{child} is aligned more strictly than the enclosing {ty}"
        );
        assert!(
            size(child) <= total,
            "{child} is larger than the enclosing {ty}"
        );
    }
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn flat_types_follow_the_canonical_abi(tc: TestCase) {
    let ty = draw_type(&tc, MAX_DEPTH);
    tc.note(&ty.to_string());
    assert_eq!(flat_types(&ty), expected_flat(&ty), "flat types of {ty}");
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn layouts_agree_with_their_parts(tc: TestCase) {
    let ty = draw_type(&tc, MAX_DEPTH);
    tc.note(&ty.to_string());
    let expected = Layout {
        size: size(&ty),
        align: alignment(&ty),
        flat: flat_types(&ty),
        pointers: contains_pointers(&ty),
        handles: contains_handles(&ty),
    };
    let actual = layout(&ty);
    assert_eq!(actual, expected, "layout of {ty}");
    assert_eq!(actual.needs_memory(), actual.pointers, "{ty} needs memory");

    let params = draw_func_type(&tc).params;
    let record = params_record(&params);
    assert_eq!(record, ValType::Record(params.clone()));
    assert_eq!(params_layout(&params), layout(&record));
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn containment_predicates_agree_with_a_walk(tc: TestCase) {
    let ty = draw_type(&tc, MAX_DEPTH);
    tc.note(&ty.to_string());
    let is_pointer = |ty: &ValType| matches!(ty, ValType::String | ValType::List(_));
    let is_handle = |ty: &ValType| matches!(ty, ValType::Own(_) | ValType::Borrow(_));
    let is_borrow = |ty: &ValType| matches!(ty, ValType::Borrow(_));
    let is_list_of_handles =
        |ty: &ValType| matches!(ty, ValType::List(element) if any_node(element, &is_handle));
    assert_eq!(
        contains_pointers(&ty),
        any_node(&ty, &is_pointer),
        "pointers in {ty}"
    );
    assert_eq!(
        contains_handles(&ty),
        any_node(&ty, &is_handle),
        "handles in {ty}"
    );
    assert_eq!(
        contains_borrows(&ty),
        any_node(&ty, &is_borrow),
        "borrows in {ty}"
    );
    assert_eq!(
        contains_handles_in_memory(&ty),
        any_node(&ty, &is_list_of_handles),
        "handles in memory in {ty}"
    );
}

#[hegel::test(test_cases = 300, derandomize = true, database = None)]
fn signatures_flatten_and_spill_past_the_limits(tc: TestCase) {
    let func = draw_func_type(&tc);
    tc.note(&format!("{func:?}"));
    let params: Vec<CoreType> = func
        .params
        .iter()
        .flat_map(|(_, param)| flat_types(param))
        .collect();
    let results = func.result.as_ref().map(flat_types).unwrap_or_default();
    let spilled_params = if params.len() > MAX_FLAT_PARAMS {
        vec![CoreType::I32]
    } else {
        params
    };

    let lift = lift_signature(&func);
    assert_eq!(lift.params, spilled_params, "lifted params");
    if results.len() > MAX_FLAT_RESULTS {
        assert_eq!(
            lift.results,
            vec![CoreType::I32],
            "lifted results through memory"
        );
    } else {
        assert_eq!(lift.results, results, "lifted results");
    }

    let lower = lower_signature(&func);
    if results.len() > MAX_FLAT_RESULTS {
        let mut with_retptr = spilled_params.clone();
        with_retptr.push(CoreType::I32);
        assert_eq!(
            lower.params, with_retptr,
            "lowered params with a return pointer"
        );
        assert!(lower.results.is_empty(), "lowered results through memory");
    } else {
        assert_eq!(lower.params, spilled_params, "lowered params");
        assert_eq!(lower.results, results, "lowered results");
    }
}
