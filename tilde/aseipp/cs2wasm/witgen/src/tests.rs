// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generator regressions on small worlds. tests/wit compiles a larger world
//! end to end through gameplayc; these pin the shape of the output.

use super::*;

fn generate(wit: &str, world: &str) -> (String, Report) {
    let mut resolve = Resolve::default();
    let package = resolve.push_source("test.wit", wit).expect("valid WIT");
    let world = resolve
        .select_world(&[package], Some(world))
        .expect("the world exists");
    csharp(&resolve, world, None, &[]).expect("generation succeeds")
}

/// Asserts `needle` appears in `haystack`, showing the output otherwise.
#[track_caller]
fn assert_contains(haystack: &str, needle: &str) {
    assert!(
        haystack.contains(needle),
        "expected\n{needle}\nin\n{haystack}"
    );
}

#[track_caller]
fn assert_lacks(haystack: &str, needle: &str) {
    assert!(
        !haystack.contains(needle),
        "did not expect\n{needle}\nin\n{haystack}"
    );
}

#[test]
fn used_resource_resolves_to_its_definition() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            resource thing { get: func() -> u32; }
        }
        interface b {
            use a.{thing};
            give: func(n: u32) -> own<thing>;
            look: func(t: borrow<thing>) -> u32;
        }
        world w { import b; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "internal static A.Thing Give(uint n) => A.Thing.FromHandle(Imports.Give(n));",
    );
    assert_contains(&source, "internal static uint Look(A.Thing t)");
    assert_lacks(&source, "B.Thing");
}

#[test]
fn options_lower_independently() {
    let (source, _) = generate(
        "package t:p;
        interface a {
            record r { x: s32, y: bool }
            both: func(first: option<r>, second: option<r>) -> u32;
        }
        world w { import a; }",
        "w",
    );
    let expected = "\
    internal static uint Both(A.R first, A.R second)
    {
        int first_Some = 0;
        int first_0 = 0;
        bool first_1 = false;
        if (first != null)
        {
            first_Some = 1;
            first_0 = first.X;
            first_1 = first.Y;
        }
        int second_Some = 0;
        int second_0 = 0;
        bool second_1 = false;
        if (second != null)
        {
            second_Some = 1;
            second_0 = second.X;
            second_1 = second.Y;
        }

        return Imports.Both(first_Some, first_0, first_1, second_Some, second_0, second_1);
    }
";
    assert_contains(&source, expected);
    // No early return and no combination of cases.
    assert_lacks(&source, "== null");
}

#[test]
fn owned_arguments_are_spent_like_dispose() {
    let (source, _) = generate(
        "package t:p;
        interface a {
            record r { x: s32 }
            resource thing {
                constructor(source: own<thing>, clip: option<r>);
                eat: func(other: own<thing>, clip: option<r>);
            }
        }
        world w { import a; }",
        "w",
    );
    // A method: the option is lowered and the owned argument is spent,
    // whether or not the option is present.
    assert_contains(
        &source,
        "\
        public void Eat(A.Thing other, A.R clip)
        {
            int clip_Some = 0;
            int clip_0 = 0;
            if (clip != null)
            {
                clip_Some = 1;
                clip_0 = clip.X;
            }

            Imports.ThingEat(Handle, other.Handle, clip_Some, clip_0);
            other.Dropped = true;
            other.Handle = 0;
        }
",
    );
    // The constructor shares the lowering and the ownership transfer.
    assert_contains(
        &source,
        "\
        public Thing(A.Thing source, A.R clip)
        {
            int clip_Some = 0;
            int clip_0 = 0;
            if (clip != null)
            {
                clip_Some = 1;
                clip_0 = clip.X;
            }

            Handle = Imports.ThingConstructor(source.Handle, clip_Some, clip_0);
            source.Dropped = true;
            source.Handle = 0;
        }
",
    );
}

#[test]
fn owned_result_with_owned_argument_returns_after_spending() {
    let (source, _) = generate(
        "package t:p;
        interface a {
            resource thing {}
            swap: func(old: own<thing>) -> own<thing>;
        }
        world w { import a; }",
        "w",
    );
    assert_contains(
        &source,
        "\
        var result_ = A.Thing.FromHandle(Imports.Swap(old.Handle));
        old.Dropped = true;
        old.Handle = 0;
        return result_;
",
    );
}

#[test]
fn wrapping_constructor_cannot_collide() {
    let (source, _) = generate(
        "package t:p;
        interface a {
            resource counter { constructor(start: s32); }
            resource glyph { constructor(code: char); }
        }
        world w { import a; }",
        "w",
    );
    assert_contains(&source, "public Counter(int start)");
    assert_contains(&source, "public Glyph(int code)");
    assert_contains(&source, "private Counter(Adopt_ adopt, int handle)");
    assert_contains(
        &source,
        "public static Counter FromHandle(int handle) => new Counter(Adopt_.Handle, handle);",
    );
    assert_lacks(&source, "(int handle)\n");
}

#[test]
fn option_record_fields_in_both_directions() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            record r { x: s32 }
            record window { frame: r, clip: option<r> }
            show: func(w: window);
        }
        interface cb {
            use a.{window, r};
            on-show: func(w: window, extra: option<r>) -> u32;
        }
        world w { import a; export cb; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    // Imported: the field lowers like an option parameter.
    assert_contains(
        &source,
        "\
    internal static void Show(A.Window w)
    {
        int w_Clip_Some = 0;
        int w_Clip_0 = 0;
        if (w.Clip != null)
        {
            w_Clip_Some = 1;
            w_Clip_0 = w.Clip.X;
        }

        Imports.Show(w.Frame.X, w_Clip_Some, w_Clip_0);
    }
",
    );
    assert_contains(
        &source,
        "internal static extern void Show(int w_Frame_X, int w_Clip_Some, int w_Clip_0);",
    );
    // Exported: rebuilt with null for none.
    assert_contains(
        &source,
        "public static uint OnShowExport(int w_Frame_X, int w_Clip_Some, int w_Clip_0, \
         int extra_Some, int extra_0) => OnShow(new A.Window(new A.R(w_Frame_X), \
         (w_Clip_Some != 0 ? new A.R(w_Clip_0) : null)), \
         (extra_Some != 0 ? new A.R(extra_0) : null));",
    );
}

#[test]
fn nested_options_get_their_own_locals() {
    let (source, _) = generate(
        "package t:p;
        interface a {
            record r { x: s32 }
            record outer { inner: option<r>, y: u8 }
            put: func(o: option<outer>);
        }
        world w { import a; }",
        "w",
    );
    assert_contains(
        &source,
        "\
        int o_Some = 0;
        int o_0 = 0;
        int o_1 = 0;
        byte o_2 = 0;
        if (o != null)
        {
            int o_Inner_Some = 0;
            int o_Inner_0 = 0;
            if (o.Inner != null)
            {
                o_Inner_Some = 1;
                o_Inner_0 = o.Inner.X;
            }
            o_Some = 1;
            o_0 = o_Inner_Some;
            o_1 = o_Inner_0;
            o_2 = o.Y;
        }

        Imports.Put(o_Some, o_0, o_1, o_2);
",
    );
}

#[test]
fn exports_with_handles_wrap_and_unwrap() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            resource thing {}
        }
        interface cb {
            use a.{thing};
            pass: func(seen: borrow<thing>, kept: own<thing>) -> own<thing>;
        }
        world w { import a; export cb; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "public static partial A.Thing Pass(A.Thing seen, A.Thing kept);",
    );
    assert_contains(
        &source,
        "\
        [global::Gameplay.WasmExport(\"t:p/cb#pass\")]
        public static int PassExport(int seen, int kept)
        {
            var result_ = Pass(A.Thing.FromHandle(seen), A.Thing.FromHandle(kept));
            int handle_ = result_.Handle;
            result_.Dropped = true;
            result_.Handle = 0;
            return handle_;
        }
",
    );
}

#[test]
fn exported_resources_are_reported() {
    let (source, report) = generate(
        "package t:p;
        interface cb {
            resource mine {}
            make: func() -> own<mine>;
            take: func(m: borrow<mine>);
        }
        world w { export cb; }",
        "w",
    );
    assert!(
        report
            .skipped
            .iter()
            .any(|item| item.starts_with("export make:")),
        "{:?}",
        report.skipped
    );
    assert!(
        report
            .skipped
            .iter()
            .any(|item| item.starts_with("export take:")),
        "{:?}",
        report.skipped
    );
    assert_lacks(&source, "WasmExport(\"t:p/cb#make\")");
}

#[test]
fn flags_named_none_are_not_duplicated() {
    let (source, _) = generate(
        "package t:p;
        interface a {
            flags mode { none, fast }
            flags plain { fast }
        }
        world w { import a; }",
        "w",
    );
    assert_contains(
        &source,
        "\
    public enum Mode : uint
    {
        None = 1u << 0,
        Fast = 1u << 1,
    }
",
    );
    assert_contains(
        &source,
        "\
    public enum Plain : uint
    {
        None = 0,
        Fast = 1u << 0,
    }
",
    );
}

#[test]
fn same_interface_names_in_different_packages() {
    let (source, report) = generate(
        "package t:main;
        package t:one { interface util { record r { x: s32 } f: func(r: r); } }
        package t:two { interface util { g: func(); } }
        interface only { h: func(); }
        world w {
            import t:one/util;
            import t:two/util;
            import only;
        }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(&source, "public static class TOneUtil\n");
    assert_contains(&source, "public static class TTwoUtil\n");
    assert_contains(&source, "internal static void F(TOneUtil.R r)");
    // Names that do not collide stay short.
    assert_contains(&source, "public static class Only\n");
}

#[test]
fn interface_named_like_the_world() {
    let (source, _) = generate(
        "package t:p;
        package t:dep { interface game { f: func(); } }
        world game { import t:dep/game; }",
        "game",
    );
    assert_contains(&source, "public static class TDepGame\n");
    assert_contains(&source, "public static partial class Game\n");
}

#[test]
fn same_package_different_versions() {
    let mut resolve = Resolve::default();
    resolve
        .push_source(
            "one.wit",
            "package t:dep@1.0.0; interface util { f: func(); }",
        )
        .unwrap();
    resolve
        .push_source(
            "two.wit",
            "package t:dep@2.0.0; interface util { f: func(); }",
        )
        .unwrap();
    let main = resolve
        .push_source(
            "main.wit",
            "package t:main; world w { import t:dep/util@1.0.0; import t:dep/util@2.0.0; }",
        )
        .unwrap();
    let world = resolve.select_world(&[main], Some("w")).unwrap();
    let (source, _) = csharp(&resolve, world, None, &[]).unwrap();
    assert_contains(&source, "public static class TDepUtilV1_0_0\n");
    assert_contains(&source, "public static class TDepUtilV2_0_0\n");
}
