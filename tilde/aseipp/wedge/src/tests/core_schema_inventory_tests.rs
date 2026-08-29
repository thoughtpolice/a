// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Public-API inventory tests for Core operation schema coverage.

mod core_operation_test_support;

use std::collections::{BTreeMap, BTreeSet};

use core_operation_test_support::operation_program;
use wedge::ir::*;
use wedge::opcode::{CoreOpcode, CoreProposal};

#[test]
fn pins_the_complete_standard_wasm3_inventory_by_proposal() {
    let mut standard_by_proposal = BTreeMap::<CoreProposal, usize>::new();
    let mut parser_names = BTreeSet::new();
    let mut visitor_names = BTreeSet::new();

    for &opcode in CoreOpcode::ALL {
        let proposal = opcode.proposal();
        assert_eq!(
            opcode.is_standard_wasm3(),
            proposal.is_standard_wasm3() && opcode != CoreOpcode::TypedSelectMulti,
            "unexpected profile classification for {opcode:?}"
        );

        assert!(
            parser_names.insert(opcode.parser_name()),
            "duplicate parser identity {}",
            opcode.parser_name()
        );
        assert!(
            visitor_names.insert(opcode.visitor_name()),
            "duplicate visitor identity {}",
            opcode.visitor_name()
        );
        assert!(opcode.visitor_name().starts_with("visit_"), "{opcode:?}");

        let mnemonic = opcode.mnemonic();
        assert!(!mnemonic.is_empty(), "{opcode:?}");
        assert_eq!(opcode.to_string(), mnemonic, "{opcode:?}");
        let representative = CoreOpcode::from_mnemonic(&mnemonic)
            .unwrap_or_else(|| panic!("missing mnemonic lookup for {opcode:?}"));
        assert_eq!(representative.mnemonic(), mnemonic, "{opcode:?}");

        if opcode.is_standard_wasm3() {
            *standard_by_proposal.entry(proposal).or_default() += 1;
        }
    }

    assert_eq!(CoreOpcode::ALL.len(), 627);
    assert_eq!(parser_names.len(), CoreOpcode::ALL.len());
    assert_eq!(visitor_names.len(), CoreOpcode::ALL.len());
    assert_eq!(
        standard_by_proposal,
        BTreeMap::from([
            (CoreProposal::Mvp, 172),
            (CoreProposal::SignExtension, 5),
            (CoreProposal::Gc, 32),
            (CoreProposal::SaturatingFloatToInt, 8),
            (CoreProposal::BulkMemory, 7),
            // The parser bucket has ten entries; multi-result select is not
            // a standard Core Wasm 3 operator.
            (CoreProposal::ReferenceTypes, 9),
            (CoreProposal::TailCall, 2),
            (CoreProposal::Simd, 236),
            (CoreProposal::RelaxedSimd, 20),
            (CoreProposal::Exceptions, 3),
            (CoreProposal::FunctionReferences, 5),
        ])
    );
    assert_eq!(standard_by_proposal.values().sum::<usize>(), 499);
}

#[test]
fn pins_every_canonical_mnemonic_collision_and_its_representative() {
    let mut by_mnemonic = BTreeMap::<String, Vec<CoreOpcode>>::new();
    for &opcode in CoreOpcode::ALL {
        by_mnemonic
            .entry(opcode.mnemonic().to_owned())
            .or_default()
            .push(opcode);
    }
    let collisions = by_mnemonic
        .into_iter()
        .filter(|(_, opcodes)| opcodes.len() > 1)
        .collect::<Vec<_>>();

    assert_eq!(
        collisions,
        vec![
            (
                "ref.cast".to_owned(),
                vec![CoreOpcode::RefCastNonNull, CoreOpcode::RefCastNullable],
            ),
            (
                "ref.test".to_owned(),
                vec![CoreOpcode::RefTestNonNull, CoreOpcode::RefTestNullable],
            ),
            (
                "select".to_owned(),
                vec![
                    CoreOpcode::Select,
                    CoreOpcode::TypedSelect,
                    CoreOpcode::TypedSelectMulti,
                ],
            ),
        ]
    );

    for (mnemonic, opcodes) in collisions {
        assert_eq!(
            CoreOpcode::from_mnemonic(&mnemonic),
            opcodes.first().copied()
        );
    }
}

#[test]
fn forged_programs_keep_shared_select_mnemonics_schema_distinct() {
    let params = vec![ValueType::I32, ValueType::I32, ValueType::I32];
    let results = vec![ValueType::I32];

    let untyped = Operation::core(CoreOpcode::Select, params.clone(), results.clone());
    let typed = Operation::core(CoreOpcode::TypedSelect, params.clone(), results.clone())
        .with_immediates(vec![Immediate::ValueType(ValueType::I32)]);

    assert_eq!(untyped.mnemonic, typed.mnemonic);
    assert_ne!(untyped.kind, typed.kind);
    operation_program(untyped)
        .verify()
        .expect("untyped select should satisfy its public Core schema");
    operation_program(typed)
        .verify()
        .expect("typed select should satisfy its public Core schema");

    let inferred = Operation::new("select", params, results)
        .with_immediates(vec![Immediate::ValueType(ValueType::I32)]);
    assert_eq!(
        inferred.kind,
        OperationKind::Core(CoreOpcode::Select),
        "mnemonic lookup deliberately chooses the first parser variant"
    );
    let error = operation_program(inferred)
        .verify()
        .expect_err("typed-select immediates must not fit untyped select")
        .to_string();
    assert!(error.contains("unexpected immediate"), "{error}");
}
