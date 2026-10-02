// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use wit_parser::Resolve;

use super::*;

fn generate(wit: &str, lang: Lang) -> (String, Report) {
    let mut resolve = Resolve::default();
    let package = resolve.push_str("test.wit", wit).unwrap();
    let world = resolve.select_world(&[package], None).unwrap();
    host(&resolve, world, lang, &COptions::default(), &[]).unwrap()
}

const FIXTURE: &str = include_str!("../../tests/host.wit");

#[test]
fn every_language_binds_the_fixture_whole() {
    for lang in [Lang::C, Lang::Rust, Lang::Ts] {
        let (source, report) = generate(FIXTURE, lang);
        assert!(report.skipped.is_empty(), "{lang:?}: {:?}", report.skipped);
        assert!(!source.is_empty());
    }
}

#[test]
fn functions_the_host_cannot_implement_are_reported() {
    let (source, report) = generate(
        "package a:b;
        interface i {
            variant v { x(u32), y }
            resource r { m: func(); }
            fine: func(x: u32) -> u32;
            maybe: func(x: option<u32>);
            either: func() -> result<u32, string>;
            pick: func(v: v);
            later: async func();
            many: func(names: list<string>);
            nested: func(lists: list<list<u8>>);
        }
        world w { import i; }",
        Lang::Ts,
    );
    assert_eq!(
        report.skipped,
        [
            "a:b/i#[method]r.m: functions of resources",
            "a:b/i#maybe: passes a option",
            "a:b/i#either: passes a result",
            "a:b/i#pick: passes a variant",
            "a:b/i#later: async functions",
            "a:b/i#many: passes a list of strings or lists",
            "a:b/i#nested: passes a list of strings or lists",
        ]
    );
    assert!(source.contains("\"fine\": (a0: number): number => {"));
    assert!(!source.contains("maybe"));
}

#[test]
fn imports_name_their_memories_and_allocators() {
    let (source, _) = generate(FIXTURE, Lang::Ts);
    let memory = source
        .split("export const THINGS_MEMORY: readonly string[] = [")
        .nth(1)
        .unwrap()
        .split("];")
        .next()
        .unwrap();
    for name in ["\"text\"", "\"points\"", "\"spilled\"", "\"tuples\""] {
        assert!(memory.contains(name), "{name} has a memory");
    }
    for name in ["\"scalars\"", "\"enums\"", "\"nothing\""] {
        assert!(!memory.contains(name), "{name} has no memory");
    }
    let realloc = source
        .split("export const THINGS_REALLOC: readonly string[] = [")
        .nth(1)
        .unwrap()
        .split("];")
        .next()
        .unwrap();
    assert!(realloc.contains("\"list-items\""));
    assert!(
        !realloc.contains("\"record-param\""),
        "a record of scalars needs no allocator"
    );
}

#[test]
fn spilled_parameters_and_return_pointers_follow_the_signature() {
    let (source, _) = generate(FIXTURE, Lang::Rust);
    assert!(
        source.contains("let &[Flat::I32(a0)] = args else"),
        "spilled params arrive as a pointer"
    );
    assert!(source.contains("view(guest, a0, 1, 80, 8)?;"));
    let (source, _) = generate(FIXTURE, Lang::C);
    assert!(source.contains("uint32_t test_host_spilled(test_host_t *instance, uint32_t a0) {"));
    assert!(source.contains(
        "void test_host_list_items(test_host_t *instance, uint32_t a0, uint32_t a1, uint32_t a2) {"
    ));
}

#[test]
fn world_functions_are_their_own_group() {
    let (source, _) = generate(FIXTURE, Lang::Ts);
    assert!(source.contains("export const HOST_TEST_MODULE = \"$root\";"));
    assert!(source.contains("export function bindHostTest("));
    let (source, _) = generate(FIXTURE, Lang::Rust);
    assert!(source.contains("pub mod host_test {"));
}

#[test]
fn names_that_shadow_the_bindings_are_escaped() {
    let (source, _) = generate(
        "package a:b;
        interface i {
            f: func(host: u32, a0: u32, %type: u32, guest: string);
        }
        world w { import i; }",
        Lang::Rust,
    );
    assert!(source.contains("fn f(&mut self, host_: u32, a0_: u32, type_: u32, guest_: &[u8])"));
    let (source, _) = generate(
        "package a:b;
        interface i {
            f: func(memory: u32, int: u32);
        }
        world w { import i; }",
        Lang::C,
    );
    assert!(source.contains("void a_b_i_f(a_b_t *instance, uint32_t memory_, uint32_t int_);"));
}

#[test]
fn c_options_rename_the_bindings() {
    let mut resolve = Resolve::default();
    let package = resolve
        .push_str(
            "test.wit",
            "package console:hal;
            interface raw { exit: func(code: s32); }
            world platform { import raw; }",
        )
        .unwrap();
    let world = resolve.select_world(&[package], None).unwrap();
    let options = COptions {
        prefix: Some("hal_".into()),
        flat_prefix: Some("flat_".into()),
        context: Some("struct ctx".into()),
    };
    let (source, _) = host(&resolve, world, Lang::C, &options, &[]).unwrap();
    assert!(source.contains("void hal_exit(struct ctx *instance, int32_t code);"));
    assert!(source.contains("void flat_exit(struct ctx *instance, uint32_t a0) {"));
    assert!(source.contains("#if defined(HAL_IMPLEMENTATION) && !defined(HAL_IMPLEMENTED)"));
    assert!(source.contains("#ifndef HAL_GUEST"));
}

#[test]
fn the_header_lines_come_first() {
    let mut resolve = Resolve::default();
    let package = resolve.push_str("test.wit", FIXTURE).unwrap();
    let world = resolve.select_world(&[package], None).unwrap();
    let header = vec!["// SPDX-License-Identifier: Apache-2.0".to_string()];
    for lang in [Lang::C, Lang::Rust, Lang::Ts] {
        let (source, _) = host(&resolve, world, lang, &COptions::default(), &header).unwrap();
        assert!(source.starts_with("// SPDX-License-Identifier: Apache-2.0\n\n// Host bindings"));
    }
}
