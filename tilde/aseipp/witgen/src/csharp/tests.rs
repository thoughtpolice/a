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
fn exported_resources_are_partial_classes() {
    let (source, report) = generate(
        "package t:p;
        interface cb {
            resource mine {
                constructor(name: string);
                get: func() -> u32;
                rename: func(name: string) -> string;
                merge: func(other: own<mine>);
                make: static func(n: u32) -> mine;
            }
            make: func() -> own<mine>;
            take: func(m: borrow<mine>) -> u32;
            all: func(n: u32) -> list<mine>;
        }
        world w { export cb; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    // The module implements the partial members; the class keeps the
    // objects the host holds handles of by rep.
    assert_contains(&source, "public sealed partial class Mine");
    assert_contains(
        &source,
        "private static readonly global::Gameplay.Runtime.ResourceReps<Mine> Reps_ = new global::Gameplay.Runtime.ResourceReps<Mine>();",
    );
    assert_contains(&source, "partial void OnDropped();");
    assert_contains(&source, "public partial Mine(string name);");
    assert_contains(&source, "public partial uint Get();");
    assert_contains(&source, "public partial string Rename(string name);");
    assert_contains(&source, "public partial void Merge(W.Cb.Mine other);");
    assert_contains(&source, "internal static partial W.Cb.Mine Make(uint n);");
    assert_contains(
        &source,
        "\
            internal static int LowerOwn_(Mine value)
            {
                if (value.Rep_ == 0)
                {
                    value.Rep_ = Reps_.Add(value);
                }

                return ResourceNew_(Reps_.Own(value.Rep_));
            }
",
    );
    assert_contains(
        &source,
        "\
            [global::Gameplay.WasmExport(\"t:p/cb#[dtor]mine\")]
            public static void Dtor_(int rep)
            {
                if (Reps_.Release(rep) is { } value)
                {
                    value.Rep_ = 0;
                    value.OnDropped();
                }
            }
",
    );
    for (intrinsic, declaration) in [
        ("new", "int ResourceNew_(int rep)"),
        ("rep", "int ResourceRep_(int handle)"),
        ("drop", "void ResourceDrop_(int handle)"),
    ] {
        assert_contains(
            &source,
            &format!(
                "[global::Gameplay.WasmImport(\"[export]t:p/cb\", \"[resource-{intrinsic}]mine\")]
            private static extern {declaration};"
            ),
        );
    }
    // A method's receiver arrives as its rep, an own handle given back is
    // the object's, and an object leaving as own gets a handle.
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"t:p/cb#[method]mine.get\")]",
    );
    assert_contains(&source, "W.Cb.Mine.LiftBorrow_(in_0)");
    assert_contains(&source, "W.Cb.Mine.LiftOwn_(in_1)");
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"t:p/cb#[constructor]mine\")]",
    );
    assert_contains(
        &source,
        "public static int Constructor_Export(int in_0, int in_1)",
    );
    assert_contains(&source, "var result_2 = new Mine(argument_1);");
    assert_contains(&source, "return W.Cb.Mine.LowerOwn_(result_2);");
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"t:p/cb#[static]mine.make\")]",
    );
    // Freestanding functions pass the objects too, flat or through memory.
    assert_contains(
        &source,
        "public static int MakeExport() => W.Cb.Mine.LowerOwn_(Make());",
    );
    assert_contains(
        &source,
        "public static uint TakeExport(int m) => Take(W.Cb.Mine.LiftBorrow_(m));",
    );
    assert_contains(&source, "public static partial W.Cb.Mine[] All(uint n);");
}

#[test]
fn async_functions_of_exported_resources_are_partial_members() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            resource thing {
                poke: async func(times: u32) -> string;
                spawn: static async func() -> thing;
            }
        }
        world w { export a; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "public partial global::System.Threading.Tasks.Task<string> Poke(uint times);",
    );
    assert_contains(
        &source,
        "internal static partial global::System.Threading.Tasks.Task<W.A.Thing> Spawn();",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"[async-lift]t:p/a#[method]thing.poke\")]",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"[callback][async-lift]t:p/a#[method]thing.poke\")]",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmImport(\"[export]t:p/a\", \"[task-return][method]thing.poke\")]",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmImport(\"[export]t:p/a\", \"[task-return][static]thing.spawn\")]",
    );
    assert_contains(&source, "W.A.Thing.LiftBorrow_(in_0)");
    assert_contains(&source, "W.A.Thing.LowerOwn_(value)");
}

#[test]
fn imports_pass_no_objects_of_exported_resources() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            resource thing {}
        }
        world w {
            export a;
            use a.{thing};
            import look: func(t: borrow<thing>);
        }",
        "w",
    );
    assert!(
        report.skipped.iter().any(|item| item.starts_with("look:")),
        "{:?}",
        report.skipped
    );
    assert_lacks(&source, "\"look\"");
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

#[test]
fn strings_go_through_memory() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            greet: func(name: string) -> string;
        }
        world w { import a; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    let expected = "\
    [global::Gameplay.CanonicalAbi]
    internal static string Greet(string name)
    {
        int mark_1 = global::Gameplay.Runtime.Canonical.Mark();
        int pointer_2 = global::Gameplay.Runtime.Canonical.StoreString(name, out int length_3);
        int result_4 = global::Gameplay.Runtime.Canonical.Allocate(8, 4);
        Imports.Greet(pointer_2, length_3, result_4);
        var value_5 = global::Gameplay.Runtime.Canonical.LoadString(global::Gameplay.Runtime.Memory.Load32(result_4), global::Gameplay.Runtime.Memory.Load32(result_4 + 4));
        global::Gameplay.Runtime.Canonical.Release(mark_1);
        return value_5;
    }";
    assert_contains(&source, expected);
    assert_contains(
        &source,
        "internal static extern void Greet(int in_0, int in_1, int in_2);",
    );
    // Nothing needs the helper structs.
    assert_lacks(&source, "struct Option");
    assert_lacks(&source, "struct Tuple");
}

#[test]
fn exports_through_memory_return_their_result_area() {
    let (source, report) = generate(
        "package t:p;
        world w {
            export pairs: func(items: list<tuple<string, option<u8>>>) -> option<u32>;
        }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "public static partial W.Option<uint> Pairs(W.Tuple2<string, W.Option<byte>>[] items);",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"pairs\")]\n    [global::Gameplay.CanonicalAbi]\n    public static int PairsExport(int in_0, int in_1)",
    );
    assert_contains(
        &source,
        "public record struct Tuple2<T0, T1>(T0 Item0, T1 Item1);",
    );
    assert_contains(&source, "public struct Option<T>");
}

#[test]
fn records_with_strings_are_compiled_where_used() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            record entry { name: string, size: u32 }
            record flat { size: u32 }
            look: func(e: entry) -> flat;
        }
        world w { import a; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "[global::Gameplay.CanonicalAbi]\n    public sealed record Entry(string Name, uint Size);",
    );
    assert_lacks(
        &source,
        "[global::Gameplay.CanonicalAbi]\n    public sealed record Flat",
    );
    assert_contains(&source, "public sealed record Flat(uint Size);");
}

#[test]
fn functions_named_like_their_class_get_an_underscore() {
    let (source, _) = generate(
        "package t:p;
        interface log {
            log: func(message: string);
        }
        world w { import log; }",
        "w",
    );
    assert_contains(&source, "internal static void Log_(string message)");
    assert_contains(
        &source,
        "internal static extern void Log(int in_0, int in_1);",
    );
}

#[test]
fn variants_are_unions_and_results_the_world_union() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            variant shape { dot, sized(f32), wide(u64) }
            variant signal { go, stop }
            area: func(shape: shape) -> u32;
            check: func(s: signal) -> result<u32, string>;
        }
        world w { import a; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "public union Shape(ShapeDot, ShapeSized, ShapeWide);",
    );
    assert_contains(
        &source,
        "[global::Gameplay.CanonicalAbi]\n    public sealed record ShapeSized(float Value);",
    );
    assert_contains(
        &source,
        "[global::Gameplay.CanonicalAbi]\n    public sealed record ShapeDot;",
    );
    assert_contains(
        &source,
        "public enum Signal\n    {\n        Go,\n        Stop,\n    }",
    );
    assert_contains(
        &source,
        "internal static W.Result<uint, string> Check(A.Signal s)",
    );
    assert_contains(&source, "public union Result<T, E>(Ok<T>, Err<E>);");
    // f32 and u64 payloads join into an i64: the float's bits, widened.
    assert_contains(
        &source,
        "internal static extern int Area(int in_0, long in_1);",
    );
    assert_contains(
        &source,
        "flat_4 = (long)unchecked((uint)(global::Gameplay.Runtime.Memory.F32Bits(value_6.Value)));",
    );
}

#[test]
fn async_imports_lower_through_the_callback_abi() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            add: async func(x: u32, y: u32) -> u32;
            note: async func(text: string);
            wide: async func(a: u32, b: u32, c: u32, d: u32, e: u32);
            name: async func(id: u32) -> string;
        }
        world w { import a; }",
        "w",
    );
    // The result's area outlives the call; the arguments are marked for
    // release once the subtask has started.
    assert_contains(
        &source,
        "int result_1 = global::Gameplay.Runtime.ComponentTasks.ResultArea(4, 4);
        int mark_2 = global::Gameplay.Runtime.Canonical.Mark();",
    );
    assert_contains(
        &source,
        "return global::Gameplay.Runtime.ComponentTasks.Lowered<uint>(status_3, mark_2, result_1, AddResult_);",
    );
    assert_contains(
        &source,
        "internal static global::System.Threading.Tasks.Task Note(string text)",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmImport(\"t:p/a\", \"[async-lower]add\")]
        internal static extern int Add(int in_0, int in_1, int in_2);",
    );
    // Past four flat parameters, a pointer to them.
    assert_contains(&source, "internal static extern int Wide(int in_0);");
    // A result the host allocates: held until the lift has read it, and
    // every lift frees what it reads of the host's memory.
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "return global::Gameplay.Runtime.ComponentTasks.Lowered<string>(status_3, mark_2, result_1, NameResult_, true);",
    );
    assert_contains(
        &source,
        "int pointer_1 = global::Gameplay.Runtime.Memory.Load32(area);
        string value_2 = global::Gameplay.Runtime.Canonical.LoadString(pointer_1, global::Gameplay.Runtime.Memory.Load32(area + 4));
        global::Gameplay.Runtime.ComponentTasks.Consumed(pointer_1);",
    );
}

#[test]
fn lifts_free_host_memory_only_where_it_may_be_held() {
    // Without an async import whose result the host allocates, a lift
    // frees nothing.
    let (source, _) = generate(
        "package t:p;
        interface a { name: func(id: u32) -> string; }
        world w { import a; export echo: func(s: string) -> string; }",
        "w",
    );
    assert_lacks(&source, "Consumed");
    // With one, an export's arguments and a synchronous import's result
    // are freed once read too.
    let (source, _) = generate(
        "package t:p;
        interface a {
            name: func(id: u32) -> string;
            later: async func(id: u32) -> list<u8>;
        }
        world w { import a; export echo: func(s: string) -> string; }",
        "w",
    );
    assert_contains(
        &source,
        "Lowered<byte[]>(status_3, mark_2, result_1, LaterResult_, true);",
    );
    assert_eq!(
        source.matches("ComponentTasks.Consumed(").count(),
        3,
        "{source}"
    );
}

#[test]
fn async_exports_lift_with_a_callback() {
    let (source, report) = generate(
        "package t:p;
        interface b {
            greet: async func(who: string) -> string;
            ping: async func();
        }
        world w {
            export b;
            export run: async func(n: u32) -> u64;
        }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(
        &source,
        "public static partial global::System.Threading.Tasks.Task<string> Greet(string who);",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"[async-lift]t:p/b#greet\")]",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmExport(\"[callback][async-lift]t:p/b#greet\")]",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmImport(\"[export]t:p/b\", \"[task-return]greet\")]
        private static extern void GreetTaskReturn_(int in_0, int in_1);",
    );
    assert_contains(
        &source,
        "return global::Gameplay.Runtime.ComponentTasks.Started(Ping(), PingReturn_);",
    );
    assert_contains(
        &source,
        "[global::Gameplay.WasmImport(\"[export]$root\", \"[task-return]run\")]
    private static extern void RunTaskReturn_(long in_0);",
    );
}

#[test]
fn async_functions_of_resources_are_wrappers_of_their_class() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            resource thing {
                poke: async func(times: u32) -> u32;
                make: static async func() -> thing;
            }
        }
        world w { import a; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    // A method is an instance member, its receiver the first argument.
    assert_contains(
        &source,
        "public global::System.Threading.Tasks.Task<uint> Poke(uint times)",
    );
    assert_contains(&source, "var object_3 = this;");
    assert_contains(
        &source,
        "[global::Gameplay.WasmImport(\"t:p/a\", \"[async-lower][method]thing.poke\")]
        internal static extern int ThingPoke(int in_0, int in_1, int in_2);",
    );
    assert_contains(
        &source,
        "internal static global::System.Threading.Tasks.Task<A.Thing> Make()",
    );
}

#[test]
fn futures_and_streams_import_their_built_ins_per_payload_type() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            f: func(s: stream<u32>) -> future<string>;
            g: func() -> stream<u32>;
        }
        interface b {
            record thing { name: string }
            h: func(x: future<thing>);
        }
        world w { import a; export b; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    // One ops class per payload type, over the first function naming it,
    // indexed among that function's futures and streams.
    assert_eq!(source.matches("class StreamU32Ops").count(), 1);
    assert_contains(
        &source,
        "var value_3 = global::Gameplay.Runtime.ComponentTasks.LiftStream(raw_2, W.StreamU32Ops.Instance);",
    );
    assert_contains(
        &source,
        "Imports.F(global::Gameplay.Runtime.ComponentTasks.LowerStream(s));",
    );
    for name in [
        "[stream-new-0]f",
        "[async-lower][stream-read-0]f",
        "[async-lower][stream-write-0]f",
        "[async-lower][stream-cancel-read-0]f",
        "[async-lower][stream-cancel-write-0]f",
        "[stream-drop-readable-0]f",
        "[stream-drop-writable-0]f",
        "[future-new-1]f",
        "[async-lower][future-read-1]f",
    ] {
        assert_contains(
            &source,
            &format!("[global::Gameplay.WasmImport(\"t:p/a\", \"{name}\")]"),
        );
    }
    assert_contains(
        &source,
        "internal static (global::Gameplay.Runtime.StreamReader<uint> Reader, global::Gameplay.Runtime.StreamWriter<uint> Writer) NewStreamU32()",
    );
    // An exported function's are the export's intrinsics.
    assert_contains(
        &source,
        "[global::Gameplay.WasmImport(\"[export]t:p/b\", \"[future-new-0]h\")]",
    );
    // Strings and lists in a payload are the host's to allocate, so the
    // lifts free what they read.
    assert_contains(&source, "public override bool HostMemory() => true;");
    assert_contains(&source, "global::Gameplay.Runtime.ComponentTasks.Consumed(");
}

#[test]
fn channels_of_one_payload_name_in_two_interfaces_are_numbered() {
    let (source, report) = generate(
        "package t:p;
        interface a {
            enum code { x }
            f: func() -> future<code>;
        }
        interface b {
            enum code { y }
            g: func() -> future<code>;
        }
        world w { import a; import b; }",
        "w",
    );
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_contains(&source, "class FutureCodeOps");
    assert_contains(&source, "class FutureCode2Ops");
    assert_contains(&source, "NewFutureCode2()");
}
