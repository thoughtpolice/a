// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Modules linked by `wlink` (`tilde//aseipp/wlink`), consumed exactly as the
//! build produces them.
//!
//! The linker turns a package of components into one core module. Fused
//! adapters copy strings between the components' memories and spill wide
//! parameter lists through memory, and every import the package leaves open
//! is reached through a trampoline. That is what a compiled game looks like
//! to the compiler, so the frontend must lower those constructs, verify them,
//! and keep the package's interface intact.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use wedge::Compiler;
use wedge::cfg::{ControlFlowGraph, ExitPolicy};
use wedge::dump::CfgDump;
use wedge::ir::{
    AddressType, Block, Callee, CompositeType, Effect, EffectAccess, EffectResource, ElementItem,
    ElementMode, EntityOrigin, ExportItem, ExportKind, Function, FunctionBody, FunctionId,
    FunctionType, Immediate, ImportItem, Instruction, Limits, MemoryId, Program, TableId,
    TerminatorKind, ValueId, ValueType,
};

mod fixture_support;

use fixture_support::{exported_body, exported_function, instructions};

/// Every module `tilde//aseipp/wlink` links for these tests.
const LINKED_MODULES: [&str; 13] = [
    "chain",
    "console",
    "doom",
    "hal",
    "host-abi",
    "lists",
    "nested",
    "records",
    "resources",
    "scalar",
    "string",
    "variant",
    "wide",
];

/// The module `tilde//aseipp/wlink` links under `name`, as built.
fn linked_bytes(name: &str) -> Vec<u8> {
    let path = buck_resources::get(format!("aseipp/wedge/wlink-{name}.wasm"))
        .unwrap_or_else(|error| panic!("locate wlink's linked {name} module: {error}"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Compiles one of wlink's modules and checks that the result verifies.
fn compile(name: &str, bytes: &[u8]) -> Program {
    let program = Compiler::default()
        .compile(bytes)
        .unwrap_or_else(|error| panic!("compile wlink's linked {name} module: {error}"));
    program.verify().unwrap_or_else(|errors| {
        panic!("frontend emitted invalid IR for wlink's linked {name} module:\n{errors}")
    });
    program
}

fn linked(name: &str) -> Program {
    compile(name, &linked_bytes(name))
}

fn id_of(program: &Program, function: &Function) -> FunctionId {
    let index = program
        .functions
        .iter()
        .position(|candidate| std::ptr::eq(candidate, function))
        .expect("the function belongs to the program");
    FunctionId(index as u32)
}

fn function_type<'p>(program: &'p Program, function: &Function) -> &'p FunctionType {
    match &program.types[function.ty.index()].composite {
        CompositeType::Function(ty) => ty,
        _ => panic!("func{} does not have a function type", function.wasm_index),
    }
}

fn imported_functions(program: &Program) -> Vec<(&str, &str, FunctionId)> {
    program
        .imports
        .iter()
        .filter_map(|import| match import.item {
            ImportItem::Function(id) => Some((import.module.as_str(), import.name.as_str(), id)),
            _ => None,
        })
        .collect()
}

fn imported_function_id(program: &Program, module: &str, name: &str) -> FunctionId {
    imported_functions(program)
        .into_iter()
        .find_map(|(import_module, import_name, id)| {
            (import_module == module && import_name == name).then_some(id)
        })
        .unwrap_or_else(|| panic!("missing function import {module:?}.{name:?}"))
}

fn exports(program: &Program) -> Vec<(&str, ExportKind)> {
    program
        .exports
        .iter()
        .map(|export| (export.name.as_str(), export.item.kind()))
        .collect()
}

fn exported_function_id(program: &Program, name: &str) -> FunctionId {
    program
        .exports
        .iter()
        .find_map(|export| match export.item {
            ExportItem::Function(id) if export.name == name => Some(id),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing function export {name:?}"))
}

fn exported_memory(program: &Program, name: &str) -> MemoryId {
    program
        .exports
        .iter()
        .find_map(|export| match export.item {
            ExportItem::Memory(id) if export.name == name => Some(id),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing memory export {name:?}"))
}

/// The functions active segments place in `table`.
fn table_functions(program: &Program, table: TableId) -> impl Iterator<Item = FunctionId> + '_ {
    program
        .elements
        .iter()
        .filter(move |element| {
            matches!(element.mode, ElementMode::Active { table: filled, .. } if filled == table)
        })
        .flat_map(|element| {
            element.items.iter().filter_map(|item| match item {
                ElementItem::Function(id) => Some(*id),
                ElementItem::Expression(_) => None,
            })
        })
}

fn collect_targets(
    program: &Program,
    mnemonic: &str,
    immediates: &[Immediate],
    through_tables: bool,
    found: &mut BTreeSet<FunctionId>,
) {
    for immediate in immediates {
        match immediate {
            Immediate::Function(id) => {
                found.insert(*id);
            }
            Immediate::Table(table) if through_tables && mnemonic == "call_indirect" => {
                found.extend(table_functions(program, *table));
            }
            _ => {}
        }
    }
}

/// The functions `body` names: direct callees and `ref.func` targets, plus,
/// with `through_tables`, whatever an indirect call's table holds.
fn function_references(
    program: &Program,
    body: &FunctionBody,
    through_tables: bool,
) -> BTreeSet<FunctionId> {
    let mut found = BTreeSet::new();
    for block in &body.blocks {
        for instruction in &block.instructions {
            collect_targets(
                program,
                instruction.operation.mnemonic(),
                &instruction.operation.immediates,
                through_tables,
                &mut found,
            );
        }
        match &block.terminator.kind {
            TerminatorKind::Invoke { operation, .. } => collect_targets(
                program,
                operation.mnemonic(),
                &operation.immediates,
                through_tables,
                &mut found,
            ),
            TerminatorKind::TailCall {
                callee: Callee::Direct(id),
                ..
            } => {
                found.insert(*id);
            }
            TerminatorKind::TailCall {
                callee: Callee::Indirect { table, .. },
                ..
            } if through_tables => {
                found.extend(table_functions(program, *table));
            }
            _ => {}
        }
    }
    found
}

/// Every function control can reach from `entry`, following tables at
/// indirect calls.
fn reachable_from(program: &Program, entry: FunctionId) -> BTreeSet<FunctionId> {
    let mut seen = BTreeSet::from([entry]);
    let mut queue = VecDeque::from([entry]);
    while let Some(id) = queue.pop_front() {
        let Some(body) = &program.functions[id.index()].body else {
            continue;
        };
        for target in function_references(program, body, true) {
            if seen.insert(target) {
                queue.push_back(target);
            }
        }
    }
    seen
}

fn direct_callers<'p>(program: &'p Program, callee: FunctionId) -> Vec<&'p Function> {
    program
        .functions
        .iter()
        .filter(|function| {
            function
                .body
                .as_ref()
                .is_some_and(|body| function_references(program, body, false).contains(&callee))
        })
        .collect()
}

/// Whether `function` does nothing but forward its parameters to `callee` and
/// return what comes back: the trampoline wlink puts in front of every open
/// import.
fn is_trampoline_to(function: &Function, callee: FunctionId) -> bool {
    let Some(body) = &function.body else {
        return false;
    };
    let [entry] = body.blocks.as_slice() else {
        return false;
    };
    let [call] = entry.instructions.as_slice() else {
        return false;
    };
    let parameters: Vec<ValueId> = entry
        .parameters
        .iter()
        .map(|parameter| parameter.id)
        .collect();
    let results: Vec<ValueId> = call.results.iter().map(|result| result.id).collect();
    call.operation.mnemonic() == "call"
        && call.operation.immediates == [Immediate::Function(callee)]
        && call.operands == parameters
        && matches!(&entry.terminator.kind, TerminatorKind::Return { values } if *values == results)
}

/// wlink's contract for the imports a package leaves open: each is called
/// from exactly one trampoline and never placed in a table, so an
/// ahead-of-time host such as wasm2c sees every import call in one place.
fn assert_open_imports_are_trampolined(program: &Program) {
    let imports = imported_functions(program);
    assert!(!imports.is_empty());
    for (module, name, import) in imports {
        let callers = direct_callers(program, import);
        assert_eq!(
            callers.len(),
            1,
            "{module}.{name} has {} direct callers",
            callers.len()
        );
        assert!(
            is_trampoline_to(callers[0], import),
            "the only caller of {module}.{name}, func{}, is not a trampoline",
            callers[0].wasm_index
        );
    }
    for element in &program.elements {
        for item in &element.items {
            if let ElementItem::Function(id) = item {
                assert_eq!(
                    program.functions[id.index()].origin,
                    EntityOrigin::Defined,
                    "{id} is an import placed in a table"
                );
            }
        }
    }
}

struct CrossMemoryCopy<'body> {
    instruction: &'body Instruction,
    destination: MemoryId,
    source: MemoryId,
}

/// `memory.copy` between two different memories. A component sees one
/// memory, so only wlink's adapters produce these.
fn cross_memory_copies(body: &FunctionBody) -> Vec<CrossMemoryCopy<'_>> {
    instructions(body)
        .filter(|instruction| instruction.operation.mnemonic() == "memory.copy")
        .filter_map(
            |instruction| match instruction.operation.immediates.as_slice() {
                [Immediate::Memory(destination), Immediate::Memory(source)]
                    if destination != source =>
                {
                    Some(CrossMemoryCopy {
                        instruction,
                        destination: *destination,
                        source: *source,
                    })
                }
                _ => None,
            },
        )
        .collect()
}

fn copying_adapters(program: &Program) -> Vec<&Function> {
    program
        .functions
        .iter()
        .filter(|function| {
            function
                .body
                .as_ref()
                .is_some_and(|body| !cross_memory_copies(body).is_empty())
        })
        .collect()
}

fn memory_argument(instruction: &Instruction) -> Option<MemoryId> {
    instruction
        .operation
        .immediates
        .iter()
        .find_map(|immediate| match immediate {
            Immediate::MemoryArgument(argument) => Some(argument.memory),
            _ => None,
        })
}

/// The value of `value` when an `i32.const` in `block` defines it.
fn constant(block: &Block, value: ValueId) -> Option<i32> {
    let instruction = defining(block, value)?;
    match instruction.operation.immediates.as_slice() {
        [Immediate::S32(constant)] if instruction.operation.mnemonic() == "i32.const" => {
            Some(*constant)
        }
        _ => None,
    }
}

/// The memory, address, and offset an `i32.load` in `block` reads `value` from.
fn load_of(block: &Block, value: ValueId) -> Option<(MemoryId, ValueId, u64)> {
    let instruction = defining(block, value)?;
    if instruction.operation.mnemonic() != "i32.load" {
        return None;
    }
    let argument =
        instruction
            .operation
            .immediates
            .iter()
            .find_map(|immediate| match immediate {
                Immediate::MemoryArgument(argument) => Some(argument),
                _ => None,
            })?;
    Some((argument.memory, instruction.operands[0], argument.offset))
}

fn defining(block: &Block, value: ValueId) -> Option<&Instruction> {
    block
        .instructions
        .iter()
        .find(|instruction| instruction.results.iter().any(|result| result.id == value))
}

/// The interface every package linked against the console SDK presents: the
/// HAL is all that is imported, the game's entry points and each component's
/// memory are exported, and the canonical options of the imports that take or
/// return memory name the platform's memory and allocator.
fn assert_console_sdk_interface(program: &Program) {
    let hal = "console:hal/raw@0.1.0";
    let hal_functions = [
        "arg",
        "arg-count",
        "audio-queued",
        "audio-write",
        "capture-pointer",
        "exit",
        "file-close",
        "file-create-directory",
        "file-list-directory",
        "file-open",
        "file-read-at",
        "file-remove",
        "file-rename",
        "file-size",
        "file-write-at",
        "frames-per-second",
        "host-features",
        "host-name",
        "input-capabilities",
        "now-ms",
        "present",
        "present-indexed",
        "random-seed",
        "read-events",
        "read-mouse",
        "read-text",
        "set-frame-rate",
        "set-title",
        "unix-seconds",
        "write-log",
    ];
    assert_eq!(
        imported_functions(program)
            .into_iter()
            .map(|(module, name, _)| (module, name))
            .collect::<BTreeSet<_>>(),
        hal_functions.into_iter().map(|name| (hal, name)).collect(),
    );
    assert_eq!(program.imports.len(), hal_functions.len());

    let memory_imports = [
        "audio-write",
        "file-open",
        "file-read-at",
        "file-write-at",
        "file-list-directory",
        "file-remove",
        "file-rename",
        "file-create-directory",
        "present",
        "present-indexed",
        "read-events",
        "read-mouse",
        "read-text",
        "write-log",
        "arg",
        "host-name",
        "set-title",
    ];
    let result_imports = [
        "file-read-at",
        "file-list-directory",
        "read-events",
        "read-text",
        "arg",
        "host-name",
    ];
    let mut expected_exports: BTreeMap<String, ExportKind> = memory_imports
        .into_iter()
        .map(|name| {
            (
                format!("wlink:import:{hal}#{name}:memory"),
                ExportKind::Memory,
            )
        })
        .chain(result_imports.into_iter().map(|name| {
            (
                format!("wlink:import:{hal}#{name}:realloc"),
                ExportKind::Function,
            )
        }))
        .collect();
    expected_exports.extend([
        ("init".into(), ExportKind::Function),
        ("frame".into(), ExportKind::Function),
        ("end-frame".into(), ExportKind::Function),
        ("platform:memory".into(), ExportKind::Memory),
        ("game:memory".into(), ExportKind::Memory),
        ("wlink:handles".into(), ExportKind::Memory),
    ]);
    assert_eq!(program.exports.len(), expected_exports.len());
    assert_eq!(
        exports(program)
            .into_iter()
            .map(|(name, kind)| (name.to_owned(), kind))
            .collect::<BTreeMap<_, _>>(),
        expected_exports,
    );
    assert_eq!(
        function_type(program, exported_function(program, "init")),
        &FunctionType::default()
    );
    assert_eq!(
        function_type(program, exported_function(program, "frame")),
        &FunctionType {
            params: vec![ValueType::I32],
            results: vec![ValueType::I32],
        }
    );

    // Each component keeps its own linear memory, and the SDK's file
    // resource gives the linker a handle table of its own after them.
    assert_eq!(program.memories.len(), 3);
    assert_eq!(exported_memory(program, "platform:memory"), MemoryId(0));
    assert_eq!(exported_memory(program, "game:memory"), MemoryId(1));
    assert_eq!(exported_memory(program, "wlink:handles"), MemoryId(2));
    for name in memory_imports {
        assert_eq!(
            exported_memory(program, &format!("wlink:import:{hal}#{name}:memory")),
            exported_memory(program, "platform:memory"),
        );
    }
    for name in result_imports {
        assert_eq!(
            function_type(
                program,
                exported_function(program, &format!("wlink:import:{hal}#{name}:realloc")),
            ),
            &FunctionType {
                params: vec![ValueType::I32; 4],
                results: vec![ValueType::I32],
            },
        );
    }
    for memory in &program.memories {
        assert_eq!(memory.origin, EntityOrigin::Defined);
        assert_eq!(memory.ty.address_type, AddressType::I32);
    }
    assert!(
        program.functions.iter().all(|function| {
            function.body.is_some() == (function.origin == EntityOrigin::Defined)
        })
    );
}

#[test]
fn the_console_package_keeps_only_the_hal_as_its_interface() {
    assert_console_sdk_interface(&linked("console"));
}

#[test]
fn the_original_game_reaches_its_hal_services_through_the_platform() {
    let program = linked("console");
    let hal = "console:hal/raw@0.1.0";
    let service = |name: &str| imported_function_id(&program, hal, name);

    // A frame polls input, which reads the HAL's key transitions, and logs,
    // through the platform's implementation and, for the string-taking
    // service, through a fused adapter behind an indirect call in
    // wit-component's shim. The expanded platform also imports services this
    // game never invokes; conservative indirect-call analysis may reach those.
    let from_frame = reachable_from(&program, exported_function_id(&program, "frame"));
    for name in ["read-events", "write-log"] {
        assert!(
            from_frame.contains(&service(name)),
            "frame does not reach {name}"
        );
    }

    // The platform shows what the game drew when the host ends the frame.
    let from_end = reachable_from(&program, exported_function_id(&program, "end-frame"));
    assert!(
        from_end.contains(&service("present")),
        "end-frame does not reach present"
    );

    // init must also reach the logging service.
    let from_init = reachable_from(&program, exported_function_id(&program, "init"));
    assert!(from_init.contains(&service("write-log")));
}

#[test]
fn hal_imports_are_called_only_through_trampolines() {
    assert_open_imports_are_trampolined(&linked("console"));
}

#[test]
fn string_adapters_copy_from_the_game_into_the_platform_memory() {
    let program = linked("console");
    let platform = exported_memory(&program, "platform:memory");
    let game = exported_memory(&program, "game:memory");

    // draw-text and log are the SDK's two string-taking functions; the scalar
    // ones bind directly and need no adapter.
    let adapters = copying_adapters(&program);
    assert_eq!(
        adapters.len(),
        2,
        "copying adapters: {:?}",
        adapters
            .iter()
            .map(|adapter| adapter.wasm_index)
            .collect::<Vec<_>>()
    );
    for adapter in adapters {
        let body = adapter.body.as_ref().expect("adapters are defined");
        let [entry] = body.blocks.as_slice() else {
            panic!("func{} is not straight-line", adapter.wasm_index)
        };
        let copies = cross_memory_copies(body);
        let [copy] = copies.as_slice() else {
            panic!("func{} copies more than one string", adapter.wasm_index)
        };
        assert_eq!((copy.destination, copy.source), (platform, game));
        assert_eq!(copy.instruction.effects.accesses.len(), 2);
        assert!(copy.instruction.effects.accesses.contains(&Effect {
            resource: EffectResource::Memory(platform),
            access: EffectAccess::Write,
        }));
        assert!(copy.instruction.effects.accesses.contains(&Effect {
            resource: EffectResource::Memory(game),
            access: EffectAccess::Read,
        }));

        // The destination comes from the platform's allocator, asked for the
        // string's length, and is handed to the platform's implementation
        // together with that length.
        let [destination, _source, length] = copy.instruction.operands.as_slice() else {
            panic!("memory.copy takes three operands")
        };
        assert!(
            entry
                .parameters
                .iter()
                .any(|parameter| parameter.id == *length),
            "the length is one of the adapter's flat parameters"
        );
        let position = entry
            .instructions
            .iter()
            .position(|instruction| instruction.id == copy.instruction.id)
            .expect("the copy is in the entry block");
        let allocation = entry.instructions[..position]
            .iter()
            .find(|instruction| {
                instruction
                    .results
                    .iter()
                    .any(|result| result.id == *destination)
            })
            .expect("the destination is allocated in the adapter");
        assert_eq!(allocation.operation.mnemonic(), "call");
        assert_eq!(allocation.operands.last(), Some(length));
        let handoff = entry.instructions[position + 1..]
            .iter()
            .find(|instruction| {
                instruction.operation.mnemonic() == "call"
                    && instruction.operands.contains(destination)
            })
            .expect("the copy is passed on");
        assert!(handoff.operands.contains(length));
    }
}

#[test]
fn imports_nothing_provides_survive_in_lowered_form() {
    let program = linked("hal");

    // A world-level import lowers under `$root`; an interface's under its
    // name. Both keep the canonical ABI's flat signatures.
    assert_eq!(
        imported_functions(&program),
        [
            ("$root", "tick", FunctionId(0)),
            ("test:hal/raw", "log", FunctionId(1)),
        ]
    );
    assert_eq!(
        function_type(&program, &program.functions[0]),
        &FunctionType {
            params: vec![ValueType::I32],
            results: vec![ValueType::I32],
        }
    );
    assert_eq!(
        function_type(&program, &program.functions[1]),
        &FunctionType {
            params: vec![ValueType::I32, ValueType::I32],
            results: vec![],
        }
    );
    assert_eq!(
        exports(&program),
        [
            ("wlink:import:test:hal/raw#log:memory", ExportKind::Memory),
            ("run", ExportKind::Function),
            ("hal_consumer:memory", ExportKind::Memory),
        ]
    );
    assert_eq!(
        exported_memory(&program, "wlink:import:test:hal/raw#log:memory"),
        exported_memory(&program, "hal_consumer:memory"),
    );
    assert_open_imports_are_trampolined(&program);

    let from_run = reachable_from(&program, exported_function_id(&program, "run"));
    assert!(from_run.contains(&FunctionId(0)) && from_run.contains(&FunctionId(1)));
}

#[test]
fn scalar_calls_bind_directly_to_their_producers() {
    // A scalar signature needs no adapter: the consumer's `run` calls the
    // producer's function itself, whether the producer is a sibling component
    // or nested inside the same composition.
    for (name, leaf) in [("scalar", "i32.add"), ("nested", "i32.mul")] {
        let program = linked(name);
        assert!(program.imports.is_empty());
        assert!(program.memories.is_empty());
        assert_eq!(exports(&program), [("run", ExportKind::Function)]);

        let run = exported_body(&program, "run");
        let callees: Vec<FunctionId> = function_references(&program, run, true)
            .into_iter()
            .collect();
        let [producer] = callees.as_slice() else {
            panic!("{name}: run names {callees:?}")
        };
        let producer = program.functions[producer.index()]
            .body
            .as_ref()
            .expect("the producer's function is defined");
        assert!(instructions(producer).any(|instruction| instruction.operation.mnemonic() == leaf));
        assert!(function_references(&program, producer, true).is_empty());
    }
}

#[test]
fn string_adapters_copy_in_both_directions() {
    let program = linked("string");
    assert!(program.imports.is_empty());
    assert_eq!(program.memories.len(), 2);
    let producer = exported_memory(&program, "string_producer:memory");
    let consumer = exported_memory(&program, "string_consumer:memory");
    let functions: Vec<_> = exports(&program)
        .into_iter()
        .filter(|(_, kind)| *kind == ExportKind::Function)
        .collect();
    assert_eq!(
        functions,
        [
            ("run", ExportKind::Function),
            ("run-name", ExportKind::Function),
        ]
    );

    // `greet` takes a string from the consumer; `name` returns one from the
    // producer.
    let directions: BTreeSet<(MemoryId, MemoryId)> = copying_adapters(&program)
        .iter()
        .flat_map(|adapter| {
            cross_memory_copies(adapter.body.as_ref().expect("adapters are defined"))
                .into_iter()
                .map(|copy| (copy.destination, copy.source))
        })
        .collect();
    assert_eq!(
        directions,
        BTreeSet::from([(producer, consumer), (consumer, producer)])
    );
}

#[test]
fn wide_parameter_lists_spill_through_memory() {
    let program = linked("wide");
    let producer = exported_memory(&program, "wide_producer:memory");
    let consumer = exported_memory(&program, "wide_consumer:memory");

    // `sum` takes sixteen u32s and a string: eighteen flat values, more than
    // the canonical ABI passes as parameters, so the consumer hands the
    // adapter a pointer to a 72-byte spill area instead. The adapter allocates
    // the producer's own area, copies the whole block across, then replaces
    // the string's pointer with one into a copy in the producer's memory.
    let adapters = copying_adapters(&program);
    let [adapter] = adapters.as_slice() else {
        panic!("exactly one adapter copies between the memories")
    };
    assert_eq!(function_type(&program, adapter).params, [ValueType::I32]);
    let body = adapter.body.as_ref().expect("adapters are defined");
    let [entry] = body.blocks.as_slice() else {
        panic!("the adapter is straight-line")
    };
    let area = entry.parameters[0].id;

    let copies = cross_memory_copies(body);
    let [block, string] = copies.as_slice() else {
        panic!("the adapter makes {} copies", copies.len())
    };
    for copy in &copies {
        assert_eq!((copy.destination, copy.source), (producer, consumer));
    }
    let [new_area, source, size] = block.instruction.operands.as_slice() else {
        panic!("memory.copy takes three operands")
    };
    assert_eq!(*source, area);
    assert_eq!(constant(entry, *size), Some(72));

    // The string's pointer and length sit in the last two slots.
    let [new_string, string_source, string_length] = string.instruction.operands.as_slice() else {
        panic!("memory.copy takes three operands")
    };
    assert_eq!(load_of(entry, *string_source), Some((consumer, area, 64)));
    assert_eq!(load_of(entry, *string_length), Some((consumer, area, 68)));
    let stores: Vec<&Instruction> = instructions(body)
        .filter(|instruction| instruction.operation.mnemonic() == "i32.store")
        .collect();
    let [store] = stores.as_slice() else {
        panic!("the adapter stores {} values", stores.len())
    };
    assert_eq!(memory_argument(store), Some(producer));
    assert_eq!(store.operands, [*new_area, *new_string]);
}

#[test]
fn every_linked_module_validates_compiles_and_dumps() {
    for name in LINKED_MODULES {
        let bytes = linked_bytes(name);
        Compiler::default()
            .validate(&bytes)
            .unwrap_or_else(|error| panic!("{name} does not validate: {error}"));
        let program = compile(name, &bytes);
        let ir = program.to_string();
        let cfg = CfgDump::new(&program).to_string();
        let bodies = program
            .functions
            .iter()
            .filter(|function| function.body.is_some())
            .count();
        assert_eq!(
            cfg.matches("\n  func func").count(),
            bodies,
            "{name}: the CFG dump does not cover every body"
        );
        for export in &program.exports {
            assert!(
                ir.contains(&format!("export {:?} = ", export.name)),
                "{name}: the IR does not list export {}",
                export.name
            );
            if let ExportItem::Function(id) = export.item {
                let label = program
                    .function_name(id)
                    .unwrap_or_else(|| panic!("{name}: wlink names {id}"));
                assert!(
                    cfg.contains(&format!("func {id} name={label:?} exports=[")),
                    "{name}: the CFG dump does not label {id}"
                );
            }
        }
    }
}

#[test]
fn result_strings_are_copied_before_post_return() {
    let program = linked("string");
    let producer = exported_memory(&program, "string_producer:memory");
    let consumer = exported_memory(&program, "string_consumer:memory");

    // `name` returns a string from the producer. Its adapter calls it, copies
    // the pointer/length pair and then the bytes into the consumer's memory,
    // and only then lets the producer reclaim them through post-return.
    let adapters = copying_adapters(&program);
    let adapter = adapters
        .iter()
        .find(|adapter| {
            cross_memory_copies(adapter.body.as_ref().expect("adapters are defined"))
                .iter()
                .all(|copy| copy.destination == consumer)
        })
        .expect("an adapter copies into the consumer");
    let body = adapter.body.as_ref().expect("adapters are defined");
    let [entry] = body.blocks.as_slice() else {
        panic!("the adapter is straight-line")
    };
    let copies = cross_memory_copies(body);
    let [pair, bytes] = copies.as_slice() else {
        panic!("the adapter makes {} copies", copies.len())
    };
    let call = entry
        .instructions
        .iter()
        .find(|instruction| instruction.operation.mnemonic() == "call")
        .expect("name is called first");
    let results: Vec<ValueId> = call.results.iter().map(|result| result.id).collect();
    let &[returned] = results.as_slice() else {
        panic!("name returns one pointer")
    };
    assert_eq!(pair.source, producer);
    assert_eq!(pair.instruction.operands[1], returned);
    assert_eq!(bytes.source, producer);
    let after_copies = entry
        .instructions
        .iter()
        .position(|instruction| instruction.id == bytes.instruction.id)
        .expect("the copy is in the entry block")
        + 1;
    let post_return = entry.instructions[after_copies..]
        .iter()
        .find(|instruction| {
            instruction.operation.mnemonic() == "call" && instruction.operands == [returned]
        })
        .expect("post-return runs after the copies, on the producer's pointer");
    assert!(post_return.results.is_empty());
}

#[test]
fn chains_keep_a_memory_per_component() {
    let program = linked("chain");
    assert!(program.imports.is_empty());
    assert_eq!(program.memories.len(), 3);
    let base = exported_memory(&program, "chain_base:memory");
    let mid = exported_memory(&program, "chain_mid:memory");
    let app = exported_memory(&program, "chain_app:memory");

    // The text moves from the app into mid and from mid into base, one
    // adapter per hop.
    let adapters = copying_adapters(&program);
    assert_eq!(adapters.len(), 2);
    let directions: BTreeSet<(MemoryId, MemoryId)> = adapters
        .iter()
        .flat_map(|adapter| {
            cross_memory_copies(adapter.body.as_ref().expect("adapters are defined"))
                .into_iter()
                .map(|copy| (copy.destination, copy.source))
        })
        .collect();
    assert_eq!(directions, BTreeSet::from([(mid, app), (base, mid)]));
    let from_run = reachable_from(&program, exported_function_id(&program, "run"));
    assert!(
        adapters
            .iter()
            .all(|adapter| from_run.contains(&id_of(&program, adapter)))
    );
}

#[test]
fn flat_aggregates_bind_directly_and_spilled_results_are_copied() {
    // area takes a record of four scalars, pick a bool, an option, and an
    // enum: flat on both sides, so run calls the producer's functions itself.
    // corner and status return two flat values, which come back through
    // memory and an adapter copying the eight bytes.
    for (name, leaf) in [("records", "i32.mul"), ("variant", "i32.and")] {
        let program = linked(name);
        let run = exported_body(&program, "run");
        let direct = function_references(&program, run, false);
        assert!(
            direct.iter().any(|id| {
                let body = program.functions[id.index()]
                    .body
                    .as_ref()
                    .expect("defined");
                instructions(body).any(|instruction| instruction.operation.mnemonic() == leaf)
            }),
            "{name}: run does not call the producer directly"
        );

        let adapters = copying_adapters(&program);
        let [adapter] = adapters.as_slice() else {
            panic!("{name}: {} copying adapters", adapters.len())
        };
        assert!(direct.contains(&id_of(&program, adapter)));
        let body = adapter.body.as_ref().expect("adapters are defined");
        let [entry] = body.blocks.as_slice() else {
            panic!("{name}: the adapter is not straight-line")
        };
        let copies = cross_memory_copies(body);
        let [copy] = copies.as_slice() else {
            panic!("{name}: the adapter makes {} copies", copies.len())
        };
        assert_eq!(
            constant(entry, copy.instruction.operands[2]),
            Some(8),
            "{name}"
        );
    }
}

#[test]
fn list_copies_scale_the_length_by_the_element_size() {
    let program = linked("lists");
    let producer = exported_memory(&program, "list_producer:memory");
    let consumer = exported_memory(&program, "list_consumer:memory");
    let adapter = |name: &str| -> &FunctionBody {
        let named = program.functions_named(name);
        let [id] = named.as_slice() else {
            panic!("wlink names one {name}")
        };
        program.functions[id.index()]
            .body
            .as_ref()
            .expect("adapters are defined")
    };

    // sum takes list<u32>: four bytes per element go into the producer's
    // memory. iota returns list<u8>: the pointer/length pair and then the
    // bytes come back, one byte per element.
    assert_eq!(copying_adapters(&program).len(), 4);
    for body in [adapter("adapter#sum"), adapter("adapter#iota")] {
        let [entry] = body.blocks.as_slice() else {
            panic!("the adapter is not straight-line")
        };
        let copies = cross_memory_copies(body);
        match copies.as_slice() {
            [elements] => {
                assert_eq!(
                    (elements.destination, elements.source),
                    (producer, consumer)
                );
                let size = defining(entry, elements.instruction.operands[2])
                    .expect("the byte count is computed in the adapter");
                assert_eq!(size.operation.mnemonic(), "i32.mul");
                assert!(size.operands.iter().any(|operand| {
                    entry
                        .parameters
                        .iter()
                        .any(|parameter| parameter.id == *operand)
                }));
                assert!(
                    size.operands
                        .iter()
                        .any(|operand| constant(entry, *operand) == Some(4))
                );
            }
            [pair, bytes] => {
                assert_eq!((pair.destination, pair.source), (consumer, producer));
                assert_eq!((bytes.destination, bytes.source), (consumer, producer));
                assert_eq!(constant(entry, pair.instruction.operands[2]), Some(8));
                let length = load_of(entry, bytes.instruction.operands[2])
                    .map(|(memory, _, offset)| (memory, offset));
                assert_eq!(length, Some((producer, 4)));
            }
            other => panic!("an adapter makes {} copies", other.len()),
        }
    }

    // total takes list<list<u32>>: the rows are copied in whole, then a loop
    // over the copy brings each row's elements across.
    let total = adapter("adapter#total");
    let graph = ControlFlowGraph::new(total).expect("the adapter's CFG builds");
    assert_eq!(graph.natural_loops().len(), 1);
    let copies = cross_memory_copies(total);
    assert_eq!(copies.len(), 2);
    assert!(
        copies
            .iter()
            .all(|copy| (copy.destination, copy.source) == (producer, consumer))
    );

    // label returns option<string>: the option comes back in whole, and the
    // string only when the discriminant says there is one.
    let label = adapter("adapter#label");
    let graph = ControlFlowGraph::new(label).expect("the adapter's CFG builds");
    assert!(graph.natural_loops().is_empty());
    assert!(label.blocks.len() > 1, "the string copy is conditional");
    let copies = cross_memory_copies(label);
    assert_eq!(copies.len(), 2);
    assert!(
        copies
            .iter()
            .all(|copy| (copy.destination, copy.source) == (consumer, producer))
    );
}

// PureDOOM as the console SDK's C guest: the whole game, the freestanding SDK,
// and the platform in one module, the largest the linker produces.

#[test]
fn puredoom_keeps_the_console_interface_and_the_sdk_memory_layout() {
    let program = linked("doom");
    assert_console_sdk_interface(&program);
    assert_open_imports_are_trampolined(&program);

    // The C SDK links the game with 32 MiB of memory that may grow to
    // 256 MiB; the platform's has no maximum.
    let game = exported_memory(&program, "game:memory");
    let platform = exported_memory(&program, "platform:memory");
    assert_eq!(
        program.memories[game.index()].ty.limits,
        Limits {
            min: 512,
            max: Some(4096)
        }
    );
    assert_eq!(program.memories[platform.index()].ty.limits.max, None);

    // Strings and lists cross in both directions: paths and log lines go
    // into the platform's memory, arguments and input events come back into
    // the game's.
    let directions: BTreeSet<(MemoryId, MemoryId)> = copying_adapters(&program)
        .iter()
        .flat_map(|adapter| {
            cross_memory_copies(adapter.body.as_ref().expect("adapters are defined"))
                .into_iter()
                .map(|copy| (copy.destination, copy.source))
        })
        .collect();
    assert_eq!(
        directions,
        BTreeSet::from([(platform, game), (game, platform)])
    );
}

#[test]
fn puredoom_reaches_the_hal_it_uses_through_the_platform() {
    let program = linked("doom");
    let hal = "console:hal/raw@0.1.0";
    let service = |name: &str| imported_function_id(&program, hal, name);

    // init reads the arguments and logs directly, and loads the WAD through
    // the file callbacks PureDOOM stores and calls indirectly, so tables are
    // followed at the indirect calls.
    let from_init = reachable_from(&program, exported_function_id(&program, "init"));
    for name in [
        "arg-count",
        "arg",
        "write-log",
        "file-open",
        "file-read-at",
        "file-close",
        "exit",
    ] {
        assert!(
            from_init.contains(&service(name)),
            "init does not reach {name}"
        );
    }

    // A frame reads input, runs the game, and presents the framebuffer.
    let from_frame = reachable_from(&program, exported_function_id(&program, "frame"));
    for name in ["read-events", "present", "now-ms", "exit", "write-log"] {
        assert!(
            from_frame.contains(&service(name)),
            "frame does not reach {name}"
        );
    }
}

#[test]
fn puredoom_lowers_whole_with_sound_cfg_analyses() {
    let program = linked("doom");
    let (mut bodies, mut blocks, mut loops) = (0usize, 0usize, 0usize);
    for function in &program.functions {
        let Some(body) = &function.body else {
            continue;
        };
        bodies += 1;
        let cfg = ControlFlowGraph::new(body)
            .unwrap_or_else(|errors| panic!("func{}: {errors:?}", function.wasm_index));

        let dominators = cfg.dominators();
        assert!(dominators.is_reachable(body.entry));
        assert_eq!(dominators.immediate_dominator(body.entry), None);
        for &block in cfg.reachable_blocks() {
            blocks += 1;
            if block != body.entry {
                let idom = dominators.immediate_dominator(block).unwrap_or_else(|| {
                    panic!(
                        "func{}: {block} has no immediate dominator",
                        function.wasm_index
                    )
                });
                assert!(dominators.strictly_dominates(idom, block));
            }
        }

        // Whatever can complete normally can, in particular, exit.
        let semantic = cfg.post_dominators(ExitPolicy::Semantic);
        let normal = cfg.post_dominators(ExitPolicy::NormalCompletion);
        for &block in cfg.reachable_blocks() {
            if normal.can_reach_exit(block) {
                assert!(semantic.can_reach_exit(block));
            }
        }

        for natural in cfg.natural_loops() {
            loops += 1;
            assert!(natural.blocks.contains(&natural.header));
            assert!(!natural.back_edges.is_empty());
            for &block in &natural.blocks {
                assert!(dominators.dominates(natural.header, block));
            }
            for &id in &natural.back_edges {
                let edge = cfg.edge(id).expect("back edges belong to the graph");
                assert_eq!(edge.target, natural.header);
                assert!(natural.blocks.contains(&edge.source));
            }
        }
    }

    // The build links the whole game: PureDOOM alone is hundreds of functions
    // with over a thousand loops, so anything smaller means it was dropped.
    assert!(bodies >= 500, "only {bodies} bodies");
    assert!(blocks >= 10_000, "only {blocks} blocks");
    assert!(loops >= 1_000, "only {loops} loops");
}
