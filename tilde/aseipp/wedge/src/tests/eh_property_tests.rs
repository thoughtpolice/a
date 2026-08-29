// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generative contracts for exceptional CFG edges and normal-only SSA values.
//!
//! Every Hegel generator here is bounded and rejection-free so a derandomized
//! run spends its whole case budget on accepted cases. Assertion helpers print
//! the complete generated program and verifier diagnostics before panicking,
//! and Hegel shrinks a failure to a minimal counterexample.

use hegel::{TestCase, generators as gs};
use wedge::ir::*;

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

const ENTRY: BlockId = BlockId(0);
const THROW_SOURCE: BlockId = BlockId(1);
const NORMAL_CONTINUATION: BlockId = BlockId(2);
const HANDLER: BlockId = BlockId(3);
const SIBLING_ENTRY: BlockId = BlockId(4);
const ROOT_REGION: RegionId = RegionId(0);
const TRY_REGION: RegionId = RegionId(1);
const SIBLING_TRY_REGION: RegionId = RegionId(2);
const TAG: TagId = TagId(0);
const NORMAL_RESULT: ValueId = ValueId(900);

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

fn source() -> SourceInfo {
    SourceInfo::synthetic()
}

fn function_type(params: Vec<ValueType>, results: Vec<ValueType>) -> FunctionType {
    FunctionType { params, results }
}

fn type_definition(signature: FunctionType) -> TypeDefinition {
    TypeDefinition {
        canonical_alias: None,
        final_: true,
        supertype: None,
        composite: CompositeType::Function(signature),
        source: source(),
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
        terminator: Terminator::new(terminator, source()),
        source: source(),
    }
}

fn generated_value(instruction: InstructionId, value: ValueId, ty: ValueType) -> Instruction {
    Instruction::new(
        instruction,
        Operation::synthetic("wedge.generated_value", vec![], vec![ty.clone()]),
        vec![],
        vec![ValueDefinition::new(value, ty)],
        source(),
    )
}

fn generated_use(instruction: InstructionId, value: ValueId, ty: ValueType) -> Instruction {
    Instruction::new(
        instruction,
        Operation::synthetic("wedge.generated_use", vec![ty], vec![]),
        vec![value],
        vec![],
        source(),
    )
}

fn verify(program: &Program) -> Result<(), String> {
    program.verify().map_err(|errors| errors.to_string())
}

fn assert_valid(program: &Program, subject: &str) {
    if let Err(error) = verify(program) {
        property_panic!("valid {subject} was rejected:\n{error}\n{program:#?}");
    }
}

fn assert_rejected(program: &Program, subject: &str, fragments: &[&str]) {
    let error = match verify(program) {
        Ok(()) => property_panic!("invalid {subject} was accepted:\n{program:#?}"),
        Err(error) => error,
    };
    property_assert!(
        fragments.iter().all(|fragment| error.contains(fragment)),
        "{subject} lacked diagnostic fragments {fragments:?}:\n{error}\n{program:#?}"
    );
}

fn body(program: &Program) -> &FunctionBody {
    program.functions[0]
        .body
        .as_ref()
        .expect("generated function body")
}

fn body_mut(program: &mut Program) -> &mut FunctionBody {
    program.functions[0]
        .body
        .as_mut()
        .expect("generated function body")
}

fn block_mut(program: &mut Program, id: BlockId) -> &mut Block {
    body_mut(program)
        .blocks
        .iter_mut()
        .find(|block| block.id == id)
        .unwrap_or_else(|| panic!("missing generated {id}"))
}

fn continuation_block(depth: usize) -> BlockId {
    if depth == 0 {
        NORMAL_CONTINUATION
    } else {
        BlockId(4 + depth as u32)
    }
}

fn draw_scalar_type(tc: &TestCase) -> ValueType {
    match tc.draw(gs::integers::<u8>().max_value(4)) {
        0 => ValueType::I32,
        1 => ValueType::I64,
        2 => ValueType::F32,
        3 => ValueType::F64,
        4 => ValueType::V128,
        _ => unreachable!(),
    }
}

fn draw_types(tc: &TestCase, minimum: usize, maximum: usize) -> Vec<ValueType> {
    let count = tc.draw(
        gs::integers::<usize>()
            .min_value(minimum)
            .max_value(maximum),
    );
    (0..count).map(|_| draw_scalar_type(tc)).collect()
}

#[derive(Clone, Copy, Debug)]
enum CatchShape {
    Tagged,
    TaggedRef,
    All,
    AllRef,
}

impl CatchShape {
    fn draw(tc: &TestCase) -> Self {
        match tc.draw(gs::integers::<u8>().max_value(3)) {
            0 => Self::Tagged,
            1 => Self::TaggedRef,
            2 => Self::All,
            3 => Self::AllRef,
            _ => unreachable!(),
        }
    }

    const fn kind(self) -> CatchKind {
        match self {
            Self::Tagged => CatchKind::Catch,
            Self::TaggedRef => CatchKind::CatchRef,
            Self::All => CatchKind::CatchAll,
            Self::AllRef => CatchKind::CatchAllRef,
        }
    }

    const fn tagged(self) -> bool {
        matches!(self, Self::Tagged | Self::TaggedRef)
    }

    const fn catches_reference(self) -> bool {
        matches!(self, Self::TaggedRef | Self::AllRef)
    }

    const fn tag(self) -> Option<TagId> {
        if self.tagged() { Some(TAG) } else { None }
    }
}

#[derive(Debug)]
struct DynamicCase {
    program: Program,
    prefix_len: usize,
    local_values: Vec<ValueId>,
}

fn dynamic_case(
    shape: CatchShape,
    tag_payload: Vec<ValueType>,
    local_types: Vec<ValueType>,
    normal_result_use: Option<(usize, usize)>,
) -> DynamicCase {
    let payload_types = if shape.tagged() {
        tag_payload.clone()
    } else {
        Vec::new()
    };
    let mut caught_types = payload_types.clone();
    if shape.catches_reference() {
        caught_types.push(ValueType::Ref(RefType {
            nullable: false,
            heap: HeapType::Exn,
        }));
    }
    let prefix_len = caught_types.len();

    let local_values: Vec<_> = (0..local_types.len())
        .map(|index| ValueId(10 + index as u32))
        .collect();
    let source_instructions: Vec<_> = local_values
        .iter()
        .copied()
        .zip(local_types.iter().cloned())
        .enumerate()
        .map(|(index, (value, ty))| generated_value(InstructionId(10 + index as u32), value, ty))
        .collect();

    let mut exceptional_arguments: Vec<_> = payload_types
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, ty)| ExceptionalArgument::CaughtPayload {
            index: index as u32,
            ty,
        })
        .collect();
    if shape.catches_reference() {
        exceptional_arguments.push(ExceptionalArgument::CaughtException);
    }
    exceptional_arguments.extend(local_values.iter().copied().map(ExceptionalArgument::Value));

    let result_types = normal_result_use
        .is_some()
        .then_some(vec![ValueType::I32])
        .unwrap_or_default();
    let results = normal_result_use
        .is_some()
        .then_some(vec![ValueDefinition::new(NORMAL_RESULT, ValueType::I32)])
        .unwrap_or_default();
    let entry = block(
        ENTRY,
        ROOT_REGION,
        vec![],
        vec![],
        TerminatorKind::Jump(Edge::new(THROW_SOURCE, vec![])),
    );
    let mut throwing_block = block(
        THROW_SOURCE,
        TRY_REGION,
        vec![],
        source_instructions,
        TerminatorKind::Invoke {
            operation: Operation::synthetic("wedge.generated_may_throw", vec![], result_types),
            operands: vec![],
            effects: Effects {
                exception: ExceptionEffect::MayThrow,
                ..Effects::pure()
            },
            normal: Edge::new(NORMAL_CONTINUATION, vec![]),
        },
    );
    throwing_block.terminator.exception = Some(ExceptionRouting {
        arms: vec![ExceptionalEdge::new(
            TRY_REGION,
            0,
            HANDLER,
            exceptional_arguments,
        )],
        escapes: shape.tagged(),
    });

    let maximum_depth = normal_result_use.map_or(0, |(maximum, _)| maximum);
    let use_depth = normal_result_use.map(|(_, use_depth)| use_depth);
    let mut continuation = Vec::with_capacity(maximum_depth + 1);
    for depth in 0..=maximum_depth {
        let id = continuation_block(depth);
        let terminator = if depth == maximum_depth {
            TerminatorKind::Return { values: vec![] }
        } else {
            TerminatorKind::Jump(Edge::new(continuation_block(depth + 1), vec![]))
        };
        let instructions = (use_depth == Some(depth))
            .then_some(vec![generated_use(
                InstructionId(901),
                NORMAL_RESULT,
                ValueType::I32,
            )])
            .unwrap_or_default();
        let parameters = if depth == 0 { results.clone() } else { vec![] };
        continuation.push(block(id, ROOT_REGION, parameters, instructions, terminator));
    }

    let mut handler_types = caught_types;
    handler_types.extend(local_types.iter().cloned());
    let handler_parameters = handler_types
        .into_iter()
        .enumerate()
        .map(|(index, ty)| ValueDefinition::new(ValueId(1_000 + index as u32), ty))
        .collect();
    let handler = block(
        HANDLER,
        ROOT_REGION,
        handler_parameters,
        vec![],
        TerminatorKind::Return { values: vec![] },
    );
    let sibling_entry = block(
        SIBLING_ENTRY,
        SIBLING_TRY_REGION,
        vec![],
        vec![],
        TerminatorKind::Return { values: vec![] },
    );

    let catch = CatchClause {
        kind: shape.kind(),
        tag: shape.tag(),
        target: HANDLER,
    };
    let regions = vec![
        Region {
            id: ROOT_REGION,
            parent: None,
            kind: RegionKind::Function,
            entry: ENTRY,
            source: source(),
        },
        Region {
            id: TRY_REGION,
            parent: Some(ROOT_REGION),
            kind: RegionKind::TryTable {
                catches: vec![catch],
            },
            entry: THROW_SOURCE,
            source: source(),
        },
        Region {
            id: SIBLING_TRY_REGION,
            parent: Some(ROOT_REGION),
            kind: RegionKind::TryTable {
                catches: vec![catch],
            },
            entry: SIBLING_ENTRY,
            source: source(),
        },
    ];

    let mut blocks = vec![entry, throwing_block];
    blocks.extend(continuation);
    blocks.extend([handler, sibling_entry]);

    let function_signature = function_type(vec![], vec![]);
    let mut program = Program::new(1);
    program.rec_groups = vec![
        RecGroup {
            types: vec![TypeId(0)],
            source: source(),
        },
        RecGroup {
            types: vec![TypeId(1)],
            source: source(),
        },
    ];
    program.types = vec![
        type_definition(function_signature.clone()),
        type_definition(function_type(tag_payload, vec![])),
    ];
    program.functions.push(Function {
        wasm_index: 0,
        ty: TypeId(0),
        origin: EntityOrigin::Defined,
        locals: vec![],
        body: Some(FunctionBody {
            entry: ENTRY,
            root_region: ROOT_REGION,
            blocks,
            regions,
        }),
        source: source(),
    });
    program.tags.push(Tag {
        ty: TagType {
            signature: TypeId(1),
        },
        origin: EntityOrigin::Defined,
        source: source(),
    });

    DynamicCase {
        program,
        prefix_len,
        local_values,
    }
}

fn replace_entry_with_branch(program: &mut Program, other: BlockId) {
    let entry = block_mut(program, ENTRY);
    entry.instructions.push(generated_value(
        InstructionId(903),
        ValueId(903),
        ValueType::I32,
    ));
    entry.terminator = Terminator::new(
        TerminatorKind::Branch {
            condition: ValueId(903),
            then_edge: Edge::new(THROW_SOURCE, vec![]),
            else_edge: Edge::new(other, vec![]),
        },
        source(),
    );
}

#[hegel::test(test_cases = 400, derandomize = true, database = None)]
fn normal_only_results_are_available_below_their_exclusive_continuation(tc: TestCase) {
    let maximum_depth = tc.draw(gs::integers::<usize>().max_value(8));
    let use_depth = tc.draw(gs::integers::<usize>().max_value(maximum_depth));
    let case = dynamic_case(
        CatchShape::All,
        vec![],
        vec![ValueType::I32],
        Some((maximum_depth, use_depth)),
    );

    assert_valid(
        &case.program,
        &format!("normal-only use at continuation depth {use_depth}/{maximum_depth}"),
    );
}

#[hegel::test(test_cases = 500, derandomize = true, database = None)]
fn invoke_results_are_continuation_parameters_and_reject_misuse(tc: TestCase) {
    let mutation = tc.draw(gs::integers::<u8>().max_value(5));
    let maximum_depth = tc.draw(gs::integers::<usize>().min_value(1).max_value(8));
    let use_depth = tc.draw(
        gs::integers::<usize>()
            .min_value(1)
            .max_value(maximum_depth),
    );
    let mut case = dynamic_case(
        CatchShape::All,
        vec![],
        vec![ValueType::I32],
        Some((maximum_depth, use_depth)),
    );
    assert_valid(&case.program, "invoke-result mutation seed");

    let (subject, expected): (&str, &[&str]) = match mutation {
        0 => {
            block_mut(&mut case.program, HANDLER)
                .instructions
                .push(generated_use(
                    InstructionId(902),
                    NORMAL_RESULT,
                    ValueType::I32,
                ));
            ("invoke result used by its handler", &["does not dominate"])
        }
        1 => {
            block_mut(&mut case.program, NORMAL_CONTINUATION)
                .parameters
                .push(ValueDefinition::new(ValueId(1_900), ValueType::I32));
            let TerminatorKind::Invoke { normal, .. } =
                &mut block_mut(&mut case.program, THROW_SOURCE).terminator.kind
            else {
                unreachable!();
            };
            normal.arguments.push(NORMAL_RESULT);
            (
                "invoke result used by its own normal edge",
                &["does not dominate"],
            )
        }
        2 => {
            replace_entry_with_branch(&mut case.program, continuation_block(use_depth));
            (
                "invoke result used below a bypassed continuation",
                &["does not dominate"],
            )
        }
        3 => {
            block_mut(&mut case.program, NORMAL_CONTINUATION)
                .parameters
                .clear();
            (
                "continuation without the result parameter",
                &["invoke continuation", "declares 0 parameters"],
            )
        }
        4 => {
            block_mut(&mut case.program, NORMAL_CONTINUATION).parameters[0].ty = ValueType::I64;
            (
                "continuation with a mistyped result parameter",
                &["invoke continuation", "parameter 0 is i64"],
            )
        }
        5 => {
            terminator_routing_mut(&mut case.program).arms.clear();
            (
                "invoke without an in-function route",
                &["invoke has no in-function exception route"],
            )
        }
        _ => unreachable!(),
    };
    assert_rejected(&case.program, subject, expected);
}

#[test]
fn a_continuation_may_have_other_predecessors_that_supply_the_results() {
    let mut case = dynamic_case(CatchShape::All, vec![], vec![ValueType::I32], Some((1, 1)));
    let entry = block_mut(&mut case.program, ENTRY);
    entry.instructions.push(generated_value(
        InstructionId(903),
        ValueId(903),
        ValueType::I32,
    ));
    entry.instructions.push(generated_value(
        InstructionId(906),
        ValueId(906),
        ValueType::I32,
    ));
    entry.terminator = Terminator::new(
        TerminatorKind::Branch {
            condition: ValueId(903),
            then_edge: Edge::new(THROW_SOURCE, vec![]),
            else_edge: Edge::new(NORMAL_CONTINUATION, vec![ValueId(906)]),
        },
        source(),
    );
    assert_valid(&case.program, "continuation with a second predecessor");
}

#[hegel::test(test_cases = 700, derandomize = true, database = None)]
fn exceptional_routes_reject_structural_and_exclusivity_mutations(tc: TestCase) {
    let shape = CatchShape::draw(&tc);
    let payload = draw_types(&tc, 0, 3);
    let local_types = draw_types(&tc, 1, 3);
    let mut case = dynamic_case(shape, payload, local_types, None);
    assert_valid(&case.program, "exception-route mutation seed");

    let mutation = tc.draw(gs::integers::<u8>().max_value(9));
    let first_local = case.local_values[0];
    let (subject, expected): (&str, &[&str]) = match mutation {
        0 => {
            terminator_routing_mut(&mut case.program).arms.clear();
            ("omitted lexical route", &["expected lexical routes"])
        }
        9 => {
            terminator_routing_mut(&mut case.program).arms[0].target = SIBLING_ENTRY;
            (
                "arm target disagreeing with its clause",
                &["targets block4, but the clause targets block3"],
            )
        }
        1 => {
            let duplicate = terminator_routing_mut(&mut case.program).arms[0].clone();
            terminator_routing_mut(&mut case.program)
                .arms
                .push(duplicate);
            ("duplicated lexical route", &["expected lexical routes"])
        }
        2 => {
            terminator_routing_mut(&mut case.program).arms[0].handler = SIBLING_TRY_REGION;
            (
                "route to a non-enclosing handler",
                &["not an enclosing handler"],
            )
        }
        3 => {
            terminator_routing_mut(&mut case.program).arms[0].handler = ROOT_REGION;
            ("route to a non-try region", &["is not a try_table"])
        }
        4 => {
            terminator_routing_mut(&mut case.program).arms[0].handler = RegionId(u32::MAX);
            (
                "route to a missing handler",
                &["names missing region4294967295"],
            )
        }
        5 => {
            terminator_routing_mut(&mut case.program).arms[0].clause = u32::MAX;
            ("route to a missing clause", &["references missing clause"])
        }
        6 => {
            let routing = terminator_routing_mut(&mut case.program);
            routing.escapes = !routing.escapes;
            ("incorrect exception escape bit", &["expected escapes="])
        }
        7 => {
            terminator_routing_mut(&mut case.program).arms[0]
                .arguments
                .pop();
            ("short exceptional argument list", &["supplies", "expected"])
        }
        8 => {
            terminator_routing_mut(&mut case.program).arms[0]
                .arguments
                .push(ExceptionalArgument::Value(first_local));
            ("long exceptional argument list", &["supplies", "expected"])
        }
        _ => unreachable!(),
    };
    assert_rejected(&case.program, subject, expected);
}

#[hegel::test(test_cases = 700, derandomize = true, database = None)]
fn exceptional_arguments_reject_forged_provenance_types_and_dominance(tc: TestCase) {
    let shape = if tc.draw(gs::booleans()) {
        CatchShape::Tagged
    } else {
        CatchShape::TaggedRef
    };
    let payload = draw_types(&tc, 1, 3);
    let first_payload_type = payload[0].clone();
    let mut case = dynamic_case(shape, payload, vec![ValueType::I32, ValueType::I64], None);
    assert_valid(&case.program, "exception-provenance mutation seed");

    let mutation = tc.draw(gs::integers::<u8>().max_value(7));
    let local_slot = case.prefix_len;
    let second_local = case.local_values[1];
    let (subject, expected): (&str, &[&str]) = match mutation {
        0 => {
            let ExceptionalArgument::CaughtPayload { index, .. } =
                &mut terminator_routing_mut(&mut case.program).arms[0].arguments[0]
            else {
                unreachable!();
            };
            *index = u32::MAX;
            (
                "caught payload with wrong field index",
                &["names caught field"],
            )
        }
        1 => {
            let ExceptionalArgument::CaughtPayload { ty, .. } =
                &mut terminator_routing_mut(&mut case.program).arms[0].arguments[0]
            else {
                unreachable!();
            };
            *ty = if *ty == ValueType::I32 {
                ValueType::I64
            } else {
                ValueType::I32
            };
            ("caught payload with wrong stored type", &["stores type"])
        }
        2 => {
            let ordinary_payload = ValueId(905);
            block_mut(&mut case.program, THROW_SOURCE)
                .instructions
                .push(generated_value(
                    InstructionId(905),
                    ordinary_payload,
                    first_payload_type,
                ));
            terminator_routing_mut(&mut case.program).arms[0].arguments[0] =
                ExceptionalArgument::Value(ordinary_payload);
            (
                "ordinary value forged as dynamic payload",
                &["ordinary", "synthesized payload slot"],
            )
        }
        3 => {
            if shape.catches_reference() {
                let exception_slot = case.prefix_len - 1;
                terminator_routing_mut(&mut case.program).arms[0].arguments[exception_slot] =
                    ExceptionalArgument::CaughtPayload {
                        index: 0,
                        ty: ValueType::Ref(RefType {
                            nullable: false,
                            heap: HeapType::Exn,
                        }),
                    };
                (
                    "payload forged as caught exception",
                    &["names caught field"],
                )
            } else {
                terminator_routing_mut(&mut case.program).arms[0].arguments[0] =
                    ExceptionalArgument::CaughtException;
                (
                    "caught exception forged in a non-ref catch",
                    &["exception reference in payload slot"],
                )
            }
        }
        4 => {
            terminator_routing_mut(&mut case.program).arms[0].arguments[local_slot] =
                ExceptionalArgument::CaughtException;
            (
                "dispatch provenance forged as a local snapshot",
                &["local slot", "not an ordinary SSA value"],
            )
        }
        5 => {
            terminator_routing_mut(&mut case.program).arms[0].arguments[local_slot] =
                ExceptionalArgument::Value(second_local);
            (
                "wrong-typed exceptional local snapshot",
                &["as i64, expected i32"],
            )
        }
        6 => {
            terminator_routing_mut(&mut case.program).arms[0].arguments[local_slot] =
                ExceptionalArgument::Value(ValueId(u32::MAX));
            (
                "undefined exceptional local snapshot",
                &["use of undefined"],
            )
        }
        7 => {
            block_mut(&mut case.program, NORMAL_CONTINUATION)
                .instructions
                .push(generated_value(
                    InstructionId(904),
                    ValueId(904),
                    ValueType::I32,
                ));
            terminator_routing_mut(&mut case.program).arms[0].arguments[local_slot] =
                ExceptionalArgument::Value(ValueId(904));
            (
                "non-dominating exceptional local snapshot",
                &["does not dominate"],
            )
        }
        _ => unreachable!(),
    };
    assert_rejected(&case.program, subject, expected);
}

fn known_throw_case(payload: Vec<ValueType>) -> DynamicCase {
    let mut case = dynamic_case(
        CatchShape::TaggedRef,
        payload.clone(),
        vec![ValueType::I32],
        None,
    );
    let payload_values: Vec<_> = payload
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, ty)| {
            let value = ValueId(500 + index as u32);
            block_mut(&mut case.program, THROW_SOURCE)
                .instructions
                .insert(
                    index,
                    generated_value(InstructionId(500 + index as u32), value, ty),
                );
            value
        })
        .collect();
    let mut arguments: Vec<_> = payload_values
        .iter()
        .copied()
        .map(ExceptionalArgument::Value)
        .collect();
    arguments.push(ExceptionalArgument::CaughtException);
    arguments.extend(
        case.local_values
            .iter()
            .copied()
            .map(ExceptionalArgument::Value),
    );
    block_mut(&mut case.program, THROW_SOURCE).terminator = Terminator::new(
        TerminatorKind::Throw {
            tag: TAG,
            arguments: payload_values,
        },
        source(),
    )
    .with_exception_routing(ExceptionRouting {
        arms: vec![ExceptionalEdge::new(TRY_REGION, 0, HANDLER, arguments)],
        escapes: false,
    });
    case
}

fn terminator_routing_mut(program: &mut Program) -> &mut ExceptionRouting {
    block_mut(program, THROW_SOURCE)
        .terminator
        .exception
        .as_mut()
        .expect("generated throw routing")
}

#[hegel::test(test_cases = 400, derandomize = true, database = None)]
fn known_throws_require_existing_payload_values_and_dispatch_exception_provenance(tc: TestCase) {
    let payload = draw_types(&tc, 1, 3);
    let mut case = known_throw_case(payload.clone());
    assert_valid(&case.program, "known-throw mutation seed");

    let mutation = tc.draw(gs::integers::<u8>().max_value(3));
    let (subject, expected): (&str, &[&str]) = match mutation {
        0 => {
            terminator_routing_mut(&mut case.program).arms[0].arguments[0] =
                ExceptionalArgument::CaughtPayload {
                    index: 0,
                    ty: payload[0].clone(),
                };
            (
                "dynamic payload provenance on a known throw",
                &["dynamic payload provenance for a known throw"],
            )
        }
        1 => {
            let alternate = ValueId(800);
            block_mut(&mut case.program, THROW_SOURCE)
                .instructions
                .push(generated_value(
                    InstructionId(800),
                    alternate,
                    payload[0].clone(),
                ));
            terminator_routing_mut(&mut case.program).arms[0].arguments[0] =
                ExceptionalArgument::Value(alternate);
            (
                "wrong existing value as a known throw payload",
                &["ordinary", "synthesized payload slot"],
            )
        }
        2 => {
            let exception_slot = payload.len();
            let actual_payload = match &block_mut(&mut case.program, THROW_SOURCE).terminator.kind {
                TerminatorKind::Throw { arguments, .. } => arguments[0],
                _ => unreachable!(),
            };
            terminator_routing_mut(&mut case.program).arms[0].arguments[exception_slot] =
                ExceptionalArgument::Value(actual_payload);
            (
                "ordinary value forged as a caught exception",
                &["ordinary", "synthesized payload slot"],
            )
        }
        3 => {
            terminator_routing_mut(&mut case.program).escapes = true;
            (
                "known caught throw marked escaping",
                &["expected escapes=false"],
            )
        }
        _ => unreachable!(),
    };
    assert_rejected(&case.program, subject, expected);
}

#[test]
fn generated_exception_scaffolds_cover_all_catch_shapes() {
    for shape in [
        CatchShape::Tagged,
        CatchShape::TaggedRef,
        CatchShape::All,
        CatchShape::AllRef,
    ] {
        let case = dynamic_case(
            shape,
            vec![ValueType::I32, ValueType::I64],
            vec![ValueType::I32],
            None,
        );
        assert_valid(&case.program, &format!("{shape:?} scaffold"));
        let routing = body(&case.program)
            .blocks
            .iter()
            .find(|block| block.id == THROW_SOURCE)
            .expect("throw source")
            .terminator
            .exception
            .as_ref()
            .expect("invoke routing");
        property_assert!(
            routing.escapes == shape.tagged(),
            "{shape:?} has the wrong valid escape policy: {routing:#?}"
        );
    }
}
