// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Linking the component text fixtures under `tests/` and inspecting the
//! module that comes out. Behaviour is covered by the interpreter-driven
//! command tests in BUILD; these check structure.

use std::collections::BTreeMap;

use wasmparser::{ExternalKind, Parser, Payload, TypeRef};

fn input(name: &str, text: &str) -> wlink::Input {
    wlink::Input {
        name: name.to_string(),
        bytes: text.as_bytes().to_vec(),
    }
}

const SCALAR_PRODUCER: &str = include_str!("../../tests/scalar_producer.wat");
const SCALAR_CONSUMER: &str = include_str!("../../tests/scalar_consumer.wat");
const STRING_PRODUCER: &str = include_str!("../../tests/string_producer.wat");
const STRING_CONSUMER: &str = include_str!("../../tests/string_consumer.wat");
const HAL_CONSUMER: &str = include_str!("../../tests/hal_consumer.wat");
const NESTED: &str = include_str!("../../tests/nested.wat");
const WIDE_PRODUCER: &str = include_str!("../../tests/wide_producer.wat");
const WIDE_CONSUMER: &str = include_str!("../../tests/wide_consumer.wat");
const RECORD_PRODUCER: &str = include_str!("../../tests/record_producer.wat");
const RECORD_CONSUMER: &str = include_str!("../../tests/record_consumer.wat");
const LIST_PRODUCER: &str = include_str!("../../tests/list_producer.wat");
const LIST_CONSUMER: &str = include_str!("../../tests/list_consumer.wat");
const CHAIN_BASE: &str = include_str!("../../tests/chain_base.wat");
const CHAIN_MID: &str = include_str!("../../tests/chain_mid.wat");
const CHAIN_APP: &str = include_str!("../../tests/chain_app.wat");
const VARIANT: &str = include_str!("../../tests/variant.wat");
const HOST_A: &str = include_str!("../../tests/host_a.wat");
const HOST_B: &str = include_str!("../../tests/host_b.wat");
const HOST_EXPORTS: &str = include_str!("../../tests/host_exports.wat");
const HOST_LISTS: &str = include_str!("../../tests/host_lists.wat");

#[derive(Default)]
struct Shape {
    imports: Vec<(
        String,
        String,
        Vec<wasmparser::ValType>,
        Vec<wasmparser::ValType>,
    )>,
    exports: BTreeMap<String, ExternalKind>,
    export_indices: BTreeMap<String, u32>,
    defined_functions: usize,
    memories: usize,
    function_names: Vec<String>,
    start: Option<u32>,
}

fn has_adapter(shape: &Shape, name: &str) -> bool {
    let adapter = format!("adapter#{name}");
    shape
        .function_names
        .iter()
        .any(|function| *function == adapter)
}

fn shape(module: &[u8]) -> Shape {
    let mut shape = Shape::default();
    let mut types = Vec::new();
    for payload in Parser::new(0).parse_all(module) {
        match payload.expect("linked module parses") {
            Payload::TypeSection(reader) => {
                for group in reader {
                    for ty in group.unwrap().into_types() {
                        types.push(ty.composite_type.unwrap_func().clone());
                    }
                }
            }
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import = import.unwrap();
                    let TypeRef::Func(ty) = import.ty else {
                        panic!("only function imports remain")
                    };
                    let ty = &types[ty as usize];
                    shape.imports.push((
                        import.module.to_string(),
                        import.name.to_string(),
                        ty.params().to_vec(),
                        ty.results().to_vec(),
                    ));
                }
            }
            Payload::FunctionSection(reader) => shape.defined_functions = reader.count() as usize,
            Payload::MemorySection(reader) => shape.memories = reader.count() as usize,
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export = export.unwrap();
                    shape.exports.insert(export.name.to_string(), export.kind);
                    shape
                        .export_indices
                        .insert(export.name.to_string(), export.index);
                }
            }
            Payload::StartSection { func, .. } => shape.start = Some(func),
            Payload::CustomSection(reader) => {
                if let wasmparser::KnownCustom::Name(names) = reader.as_known() {
                    for name in names {
                        if let wasmparser::Name::Function(map) = name.unwrap() {
                            for naming in map {
                                shape.function_names.push(naming.unwrap().name.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    shape
}

#[test]
fn scalar_calls_bind_directly_to_the_callee() {
    let linked = wlink::link(&[
        input("producer", SCALAR_PRODUCER),
        input("consumer", SCALAR_CONSUMER),
    ])
    .expect("scalar components link");
    let shape = shape(&linked.module);
    assert!(shape.imports.is_empty());
    assert_eq!(shape.exports.get("run"), Some(&ExternalKind::Func));
    assert!(
        !shape.exports.contains_key("test:math/ops#add"),
        "consumed exports stay internal"
    );
    assert_eq!(
        shape.defined_functions, 2,
        "no adapter stands between add and run"
    );
    assert_eq!(linked.plan.adapters.len(), 1);
    assert_eq!(linked.plan.instances.len(), 2);
}

#[test]
fn input_order_does_not_matter() {
    let linked = wlink::link(&[
        input("consumer", SCALAR_CONSUMER),
        input("producer", SCALAR_PRODUCER),
    ])
    .expect("dependency order is derived from the interface names");
    assert_eq!(linked.plan.instances[0].name, "producer");
    assert_eq!(linked.plan.instances[1].name, "consumer");
}

#[test]
fn strings_get_copying_adapters_and_both_memories_survive() {
    let linked = wlink::link(&[
        input("producer", STRING_PRODUCER),
        input("consumer", STRING_CONSUMER),
    ])
    .expect("string components link");
    let shape = shape(&linked.module);
    assert_eq!(shape.memories, 2);
    assert_eq!(
        shape.exports.get("producer:memory"),
        Some(&ExternalKind::Memory)
    );
    assert_eq!(
        shape.exports.get("consumer:memory"),
        Some(&ExternalKind::Memory)
    );
    assert_eq!(shape.exports.get("run"), Some(&ExternalKind::Func));
    assert_eq!(shape.exports.get("run-name"), Some(&ExternalKind::Func));
    assert!(
        shape
            .function_names
            .iter()
            .any(|name| name == "adapter#greet")
    );
    assert!(
        shape
            .function_names
            .iter()
            .any(|name| name == "adapter#name")
    );
    assert_eq!(linked.plan.adapters.len(), 2);
    // greet, name, cabi_realloc, post_name, the consumer's realloc and two
    // entry points, plus two adapters.
    assert_eq!(shape.defined_functions, 9);
}

#[test]
fn unsatisfied_imports_remain_imports_in_lowered_form() {
    let linked = wlink::link(&[input("consumer", HAL_CONSUMER)]).expect("a lone consumer links");
    let shape = shape(&linked.module);
    use wasmparser::ValType::I32;
    assert_eq!(
        shape.imports,
        vec![
            (
                "$root".to_string(),
                "tick".to_string(),
                vec![I32],
                vec![I32]
            ),
            (
                "test:hal/raw".to_string(),
                "log".to_string(),
                vec![I32, I32],
                vec![]
            ),
        ]
    );
    assert_eq!(linked.plan.imports.len(), 2);
    assert_eq!(shape.exports.get("run"), Some(&ExternalKind::Func));
}

#[test]
fn nested_compositions_instantiate_in_place() {
    let linked = wlink::link(&[input("package", NESTED)]).expect("a composed component links");
    let shape = shape(&linked.module);
    assert!(shape.imports.is_empty());
    assert_eq!(shape.exports.get("run"), Some(&ExternalKind::Func));
    assert_eq!(linked.plan.instances.len(), 2);
    assert_eq!(linked.plan.instances[0].name, "package/0");
    assert_eq!(linked.plan.instances[1].name, "package/1");
}

#[test]
fn wide_parameter_lists_spill_through_memory() {
    let linked = wlink::link(&[
        input("producer", WIDE_PRODUCER),
        input("consumer", WIDE_CONSUMER),
    ])
    .expect("wide components link");
    let shape = shape(&linked.module);
    assert!(
        shape
            .function_names
            .iter()
            .any(|name| name == "adapter#sum")
    );
    assert_eq!(shape.memories, 2);
}

#[test]
fn mismatched_interfaces_are_rejected() {
    let producer = SCALAR_PRODUCER.replace("(param \"b\" u32) ", "");
    let producer = producer.replace(
        "(param i32 i32) (result i32)\n      local.get 0\n      local.get 1\n      i32.add",
        "(param i32) (result i32)\n      local.get 0",
    );
    let error = wlink::link(&[
        input("producer", &producer),
        input("consumer", SCALAR_CONSUMER),
    ])
    .err()
    .expect("a narrower provider is rejected");
    let message = format!("{error:#}");
    assert!(
        message.contains("expects func(a: u32, b: u32) -> u32"),
        "{message}"
    );
}

#[test]
fn a_component_cannot_provide_for_itself() {
    let error = wlink::link(&[
        input("producer", SCALAR_PRODUCER),
        input("again", SCALAR_PRODUCER),
    ])
    .err()
    .expect("duplicate providers are rejected");
    assert!(format!("{error:#}").contains("both `producer` and `again` export `test:math/ops`"));
}

#[test]
fn flat_records_bind_directly_and_spilled_results_get_adapters() {
    let linked = wlink::link(&[
        input("producer", RECORD_PRODUCER),
        input("consumer", RECORD_CONSUMER),
    ])
    .expect("record components link");
    let shape = shape(&linked.module);
    // area's record is four flat values on both sides; corner's result is
    // two, which the canonical ABI returns through memory.
    assert!(!has_adapter(&shape, "area"));
    assert!(has_adapter(&shape, "corner"));
    assert_eq!(shape.memories, 2);
    assert_eq!(shape.exports.get("run"), Some(&ExternalKind::Func));
}

#[test]
fn lists_get_copying_adapters() {
    let linked = wlink::link(&[
        input("producer", LIST_PRODUCER),
        input("consumer", LIST_CONSUMER),
    ])
    .expect("list components link");
    let shape = shape(&linked.module);
    assert!(has_adapter(&shape, "sum"));
    assert!(has_adapter(&shape, "iota"));
    assert_eq!(shape.exports.get("run-iota"), Some(&ExternalKind::Func));
}

#[test]
fn chains_link_bottom_up_with_a_memory_per_component() {
    let linked = wlink::link(&[
        input("app", CHAIN_APP),
        input("base", CHAIN_BASE),
        input("mid", CHAIN_MID),
    ])
    .expect("a chain of three links");
    let names: Vec<&str> = linked
        .plan
        .instances
        .iter()
        .map(|instance| instance.name.as_str())
        .collect();
    let first = |component: &str| {
        names
            .iter()
            .position(|name| name.starts_with(component))
            .unwrap_or_else(|| panic!("{component} was not instantiated"))
    };
    assert!(first("base") < first("mid") && first("mid") < first("app"));
    let adapters: Vec<&str> = linked
        .plan
        .adapters
        .iter()
        .map(|adapter| adapter.name.as_str())
        .collect();
    assert_eq!(adapters, ["shout", "relay"]);

    let shape = shape(&linked.module);
    assert_eq!(shape.memories, 3);
    for component in ["base", "mid", "app"] {
        assert_eq!(
            shape.exports.get(&format!("{component}:memory")),
            Some(&ExternalKind::Memory)
        );
    }
    assert!(
        !shape.exports.contains_key("test:chain/mid#relay"),
        "consumed exports stay internal"
    );
}

#[test]
fn variants_flatten_and_only_spilled_results_need_adapters() {
    let linked = wlink::link(&[input("package", VARIANT)]).expect("the variant composition links");
    let shape = shape(&linked.module);
    // bool, option<u32>, and an enum are one or two i32s each; result<u32,
    // u32> is two flat values and returns through memory.
    assert!(!has_adapter(&shape, "pick"));
    assert!(has_adapter(&shape, "status"));
    assert_eq!(linked.plan.adapters.len(), 2);
    assert_eq!(shape.exports.get("run"), Some(&ExternalKind::Func));
}

#[test]
fn core_modules_are_rejected() {
    let error = wlink::link(&[input("module", "(module)")])
        .err()
        .expect("a core module is not a component");
    let message = format!("{error:#}");
    assert!(
        message.contains("the input is a core module, not a component"),
        "{message}"
    );
}

fn half_of_a_cycle(this: &str, other: &str) -> String {
    format!(
        r#"(component
  (import "test:cycle/{other}" (instance $other (export "{other}" (func (result u32)))))
  (core func $other (canon lower (func $other "{other}")))
  (core module $m
    (import "test:cycle/{other}" "{other}" (func (result i32)))
    (func (export "{this}") (result i32) i32.const 1))
  (core instance $i (instantiate $m (with "test:cycle/{other}" (instance (export "{other}" (func $other))))))
  (func $this (result u32) (canon lift (core func $i "{this}")))
  (instance $exports (export "{this}" (func $this)))
  (export "test:cycle/{this}" (instance $exports))
)"#
    )
}

#[test]
fn import_cycles_are_rejected() {
    let error = wlink::link(&[
        input("a", &half_of_a_cycle("a", "b")),
        input("b", &half_of_a_cycle("b", "a")),
    ])
    .err()
    .expect("mutual imports cannot be ordered");
    let message = format!("{error:#}");
    assert!(
        message.contains("import each other in a cycle"),
        "{message}"
    );
}

#[test]
fn providers_missing_a_function_are_rejected() {
    let consumer = SCALAR_CONSUMER.replace(
        "(export \"add\" (func (param \"a\" u32) (param \"b\" u32) (result u32)))))",
        "(export \"add\" (func (param \"a\" u32) (param \"b\" u32) (result u32)))\n    \
         (export \"sub\" (func (param \"a\" u32) (param \"b\" u32) (result u32)))))",
    );
    assert_ne!(consumer, SCALAR_CONSUMER);
    let error = wlink::link(&[
        input("producer", SCALAR_PRODUCER),
        input("consumer", &consumer),
    ])
    .err()
    .expect("a provider must export every function the interface names");
    let message = format!("{error:#}");
    assert!(
        message.contains("needs `sub`, which its provider does not export"),
        "{message}"
    );
}

#[test]
fn string_transcoding_is_rejected() {
    let consumer = STRING_CONSUMER.replace("string-encoding=utf8", "string-encoding=utf16");
    let error = wlink::link(&[
        input("producer", STRING_PRODUCER),
        input("consumer", &consumer),
    ])
    .err()
    .expect("utf16 on one side would need transcoding");
    let message = format!("{error:#}");
    assert!(
        message.contains("only utf8 on both sides is supported"),
        "{message}"
    );
}

const RESOURCE_PRODUCER: &str = r#"(component
  (core module $m
    (import "[export]test:res/api" "[resource-new]r" (func $new (param i32) (result i32)))
    (import "[export]test:res/api" "[resource-rep]r" (func $rep (param i32) (result i32)))
    (import "[export]test:res/api" "[resource-drop]r" (func $drop (param i32)))
    (func (export "make") (param i32) (result i32) local.get 0 call $new)
    (func (export "use") (param i32) (result i32) local.get 0 call $rep local.get 0 call $drop)
    (func (export "peek") (param i32) (result i32) local.get 0)
    (func (export "dtor") (param i32)))
  (core module $shim
    (table (export "$imports") 1 1 funcref)
    (func (export "0") (param i32) local.get 0 i32.const 0 call_indirect (param i32)))
  (core instance $s (instantiate $shim))
  (alias core export $s "0" (core func $dtor))
  (type $r (resource (rep i32) (dtor $dtor)))
  (core func $new (canon resource.new $r))
  (core func $rep (canon resource.rep $r))
  (core func $drop (canon resource.drop $r))
  (core instance $i (instantiate $m
    (with "[export]test:res/api" (instance
      (export "[resource-new]r" (func $new))
      (export "[resource-rep]r" (func $rep))
      (export "[resource-drop]r" (func $drop))))))
  (core module $fixup
    (import "actual" "dtor" (func $dtor (param i32)))
    (import "shim" "$imports" (table 1 1 funcref))
    (elem (i32.const 0) func $dtor))
  (core instance (instantiate $fixup
    (with "actual" (instance (export "dtor" (func $i "dtor"))))
    (with "shim" (instance (export "$imports" (table $s "$imports"))))))
  (func $make (param "n" u32) (result (own $r)) (canon lift (core func $i "make")))
  (func $use (param "h" (own $r)) (result u32) (canon lift (core func $i "use")))
  (func $peek (param "h" (borrow $r)) (result u32) (canon lift (core func $i "peek")))
  (instance $exports
    (export "r" (type $r))
    (export "make" (func $make))
    (export "use" (func $use))
    (export "peek" (func $peek)))
  (export "test:res/api" (instance $exports))
)"#;

const RESOURCE_CONSUMER: &str = r#"(component
  (import "test:res/api" (instance $api
    (export "r" (type $r (sub resource)))
    (export "make" (func (param "n" u32) (result (own $r))))
    (export "use" (func (param "h" (own $r)) (result u32)))
    (export "peek" (func (param "h" (borrow $r)) (result u32)))))
  (alias export $api "r" (type $r))
  (core func $make (canon lower (func $api "make")))
  (core func $use (canon lower (func $api "use")))
  (core func $peek (canon lower (func $api "peek")))
  (core func $drop (canon resource.drop $r))
  (core module $m
    (import "test:res/api" "make" (func $make (param i32) (result i32)))
    (import "test:res/api" "use" (func $use (param i32) (result i32)))
    (import "test:res/api" "peek" (func $peek (param i32) (result i32)))
    (import "test:res/api" "[resource-drop]r" (func $drop (param i32)))
    (func (export "run") (result i32) (local i32)
      i32.const 40 call $make local.tee 0
      call $peek
      local.get 0 call $use
      i32.add
      i32.const 2 call $make call $drop))
  (core instance $i (instantiate $m
    (with "test:res/api" (instance
      (export "make" (func $make))
      (export "use" (func $use))
      (export "peek" (func $peek))
      (export "[resource-drop]r" (func $drop))))))
  (func $run (result u32) (canon lift (core func $i "run")))
  (export "run" (func $run))
)"#;

/// A consumer of the same interface whose import states `use` in terms of
/// a different resource: one the host owns.
const RESOURCE_IMPOSTOR: &str = r#"(component
  (import "other" (type $other (sub resource)))
  (import "test:res/api" (instance $api
    (export "use" (func (param "h" (own $other)) (result u32)))))
  (core func $use (canon lower (func $api "use")))
  (core module $m
    (import "test:res/api" "use" (func $use (param i32) (result i32))))
  (core instance $i (instantiate $m
    (with "test:res/api" (instance (export "use" (func $use))))))
)"#;

#[test]
fn resource_handles_cross_between_components_through_adapters() {
    let linked = wlink::link(&[
        input("producer", RESOURCE_PRODUCER),
        input("consumer", RESOURCE_CONSUMER),
    ])
    .expect("components exchanging handles link");
    let shape = shape(&linked.module);
    // A handle changes tables on the way through, so even a scalar-looking
    // signature needs an adapter.
    for name in ["make", "use", "peek"] {
        assert!(has_adapter(&shape, name), "{name} needs an adapter");
    }
    assert_eq!(
        shape.exports.get("wlink:handles"),
        Some(&ExternalKind::Memory)
    );
    assert_eq!(shape.memories, 1, "only the handle table needs memory");
    for name in [
        "wlink#handle.add",
        "wlink#handle.get",
        "wlink#handle.free",
        "resource.new#producer#producer:r",
        "resource.rep#producer#producer:r",
        "resource.drop#producer#producer:r",
        "resource.drop#consumer#producer:r",
    ] {
        assert!(
            shape.function_names.iter().any(|function| function == name),
            "{name} missing from {:?}",
            shape.function_names
        );
    }
    assert!(shape.imports.is_empty());

    let plan = &linked.plan;
    assert_eq!(plan.resources.len(), 1);
    assert_eq!(plan.resources[0].name, "producer:r");
    assert_eq!(plan.resources[0].owner, Some(0));
    assert!(plan.resources[0].dtor.is_some());
    assert_eq!(plan.frames.len(), 2);
    let description = wlink::describe(plan);
    assert!(
        description.contains("adapter make: func(n: u32) -> own<producer:r>"),
        "{description}"
    );
    assert!(
        description.contains("builtin resource.drop producer:r in consumer"),
        "{description}"
    );
}

#[test]
fn a_different_resource_of_the_same_name_is_rejected() {
    let error = wlink::link(&[
        input("producer", RESOURCE_PRODUCER),
        input("impostor", RESOURCE_IMPOSTOR),
    ])
    .err()
    .expect("a handle of one resource cannot stand in for another");
    let message = format!("{error:#}");
    assert!(
        message.contains(
            "import `test:res/api.use` expects func(h: own<$root#other>) -> u32, but its \
             provider is func(h: own<producer:r>) -> u32"
        ),
        "{message}"
    );
}

#[test]
fn host_resources_stay_representations_at_the_edge() {
    // Nothing provides the interface, so the host implements it: it deals in
    // representations, and the consumer's handles are lifted and lowered by
    // the trampolines. Dropping an owned handle asks the host to destroy it.
    let linked =
        wlink::link(&[input("consumer", RESOURCE_CONSUMER)]).expect("a lone consumer links");
    let shape = shape(&linked.module);
    use wasmparser::ValType::I32;
    let imports: Vec<_> = shape
        .imports
        .iter()
        .map(|(module, name, params, results)| {
            (
                module.as_str(),
                name.as_str(),
                params.clone(),
                results.clone(),
            )
        })
        .collect();
    assert_eq!(
        imports,
        vec![
            ("test:res/api", "make", vec![I32], vec![I32]),
            ("test:res/api", "use", vec![I32], vec![I32]),
            ("test:res/api", "peek", vec![I32], vec![I32]),
            ("test:res/api", "[resource-drop]r", vec![I32], vec![]),
        ]
    );
    let plan = &linked.plan;
    assert_eq!(plan.resources.len(), 1);
    assert_eq!(plan.resources[0].owner, None);
    assert_eq!(plan.resources[0].host_drop, Some(3));
    assert_eq!(plan.imports[3].frame, 0);
}

#[test]
fn handles_in_memory_reach_host_imports_through_the_lender_chain() {
    // The host implements `item`; its handles reach the host's imports
    // inside lists and in a spilled parameter record, so each one is a word
    // of the component's memory that the trampoline rewrites in place and,
    // for a borrow, remembers on the handle table's lender chain.
    let linked = wlink::link(&[input("lists", HOST_LISTS)]).expect("handles in memory link");
    let shape = shape(&linked.module);
    use wasmparser::ValType::I32;
    let imports: BTreeMap<&str, (Vec<_>, Vec<_>)> = shape
        .imports
        .iter()
        .map(|(module, name, params, results)| {
            assert_eq!(module, "host:res/pool");
            (name.as_str(), (params.clone(), results.clone()))
        })
        .collect();
    assert_eq!(
        imports,
        BTreeMap::from([
            ("open", (vec![I32], vec![I32])),
            ("sum-all", (vec![I32, I32], vec![I32])),
            ("take-all", (vec![I32, I32], vec![I32])),
            ("wide", (vec![I32], vec![I32])),
            ("describe", (vec![I32, I32], vec![I32])),
            ("[resource-drop]item", (vec![I32], vec![])),
        ])
    );
    for name in [
        "trampoline#host:res/pool#sum-all",
        "trampoline#host:res/pool#wide",
        "trampoline#host:res/pool#describe",
        "wlink#handle.add",
        "wlink#handle.free",
    ] {
        assert!(
            shape.function_names.iter().any(|function| function == name),
            "{name} missing from {:?}",
            shape.function_names
        );
    }
    // The host reads the lists from the component's memory.
    assert_eq!(
        shape.export_indices["wlink:import:host:res/pool#sum-all:memory"],
        shape.export_indices["lists:memory"]
    );
    assert_eq!(
        shape.export_indices["wlink:import:host:res/pool#wide:memory"],
        shape.export_indices["lists:memory"]
    );
    let description = wlink::describe(&linked.plan);
    assert!(description.contains("sum-all"), "{description}");
}

#[test]
fn exported_resources_give_the_host_a_destructor() {
    let linked =
        wlink::link(&[input("producer", RESOURCE_PRODUCER)]).expect("a lone producer links");
    let shape = shape(&linked.module);
    for name in [
        "test:res/api#make",
        "test:res/api#use",
        "test:res/api#peek",
        "test:res/api#[resource-drop]r",
    ] {
        assert_eq!(shape.exports.get(name), Some(&ExternalKind::Func), "{name}");
    }
    // The host passes and receives representations, so the exports that
    // carry handles are wrapped.
    for name in ["export#test:res/api#make", "export#test:res/api#use"] {
        assert!(
            shape.function_names.iter().any(|function| function == name),
            "{name} missing from {:?}",
            shape.function_names
        );
    }
    assert_eq!(
        linked.plan.resource_exports[0].name,
        "test:res/api#[resource-drop]r"
    );
}

#[test]
fn the_plan_describes_itself() {
    let linked = wlink::link(&[
        input("producer", STRING_PRODUCER),
        input("consumer", STRING_CONSUMER),
    ])
    .expect("string components link");
    let description = wlink::describe(&linked.plan);
    for line in [
        "instance producer = module 0\n",
        "adapter greet: func(name: string) -> u32",
        "adapter name: func() -> string",
        "export run: func() -> u32",
    ] {
        assert!(
            description.contains(line),
            "{line:?} missing from:\n{description}"
        );
    }
}

#[test]
fn host_imports_keep_distinct_memories_and_share_identical_lowers() {
    let linked = wlink::link(&[input("a", HOST_A), input("b", HOST_B)]).expect("both callers link");
    assert_eq!(linked.plan.imports.len(), 2, "one lowering per memory");
    let shape = shape(&linked.module);
    let names: Vec<_> = shape
        .imports
        .iter()
        .map(|(module, name, _, _)| (module.as_str(), name.as_str()))
        .collect();
    assert_eq!(names, [("host", "read$lower0"), ("host", "read$lower1")]);
    for (index, component) in [(0, "a"), (1, "b")] {
        assert_eq!(
            shape
                .export_indices
                .get(&format!("wlink:import:host#read$lower{index}:memory")),
            shape.export_indices.get(&format!("{component}:memory")),
        );
    }
    assert_ne!(
        shape.export_indices["a:memory"],
        shape.export_indices["b:memory"]
    );
}

#[test]
fn host_exports_include_canonical_memory_realloc_and_post_return() {
    let linked =
        wlink::link(&[input("exports", HOST_EXPORTS)]).expect("the host-facing exports link");
    let shape = shape(&linked.module);
    assert_eq!(
        shape.exports.get("cabi_post_name"),
        Some(&ExternalKind::Func)
    );
    assert_eq!(
        shape.exports.get("wlink:export:greet:realloc"),
        Some(&ExternalKind::Func)
    );
    for name in ["name", "greet"] {
        assert_eq!(
            shape
                .export_indices
                .get(&format!("wlink:export:{name}:memory")),
            shape.export_indices.get("exports:memory"),
        );
    }
}
