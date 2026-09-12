# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/cs2wasm:defs.bzl", "gameplay")
load("//aseipp/cs2wasm/engine:defs.bzl", "KILN", "KILN_GENERATOR", "KILN_PLATFORM")
load("//aseipp/wlink/demo/sdk:defs.bzl", "console_link", "console_terminal", "console_web")

SDK = "tilde//aseipp/wlink/demo/sdk"

SDK_WIT = SDK + ":sdk.wit"

gameplay.bindings(
    name = "bindings",
    wit = SDK_WIT,
    world = "game",
)

SOURCES = [
    "Art.cs",
    "Autopilot.cs",
    "Boss.cs",
    "Components.cs",
    "Dungeon.cs",
    "Enemies.cs",
    "Game.cs",
    "Main.cs",
    "Render.cs",
    "Scores.cs",
    "Sounds.cs",
    "Systems.cs",
    "Upgrades.cs",
]

# `buck2 build tilde//aseipp/cs2wasm/examples/lichgate:lichgate --show-output`:
# the game, Kiln's console platform and the console SDK's bindings, over
# the Kiln library, compiled with Kiln's generator, which writes the game's
# schedule. A frame renders a whole indexed screen
# and mixes a frame of audio, which takes more control steps than the
# default budget allows, and a room's background is a 56 KB canvas, which
# the allocation charge counts at 8 units a byte.
gameplay.module(
    name = "lichgate",
    srcs = SOURCES + KILN_PLATFORM + [":bindings"],
    alloc_units = 16777216,
    fuel = 1000000,
    generators = [KILN_GENERATOR],
    visibility = ["PUBLIC"],
    deps = [KILN],
)

gameplay.component(
    name = "lichgate-component",
    module = ":lichgate",
    visibility = ["PUBLIC"],
    wit = [SDK_WIT],
    world = "game",
)

# Linked with the console's platform component, as every console game is.
# The game is on the GC heap, so the console's hosts for it are the ones
# that run the module in a Wasm engine: the browser's, and Deno's for the
# headless and terminal hosts.
console_link(
    name = "lichgate-linked",
    game = ":lichgate-component",
    gc = True,
)

# `buck2 run tilde//aseipp/cs2wasm/examples/lichgate:lichgate-web-serve`
console_web(
    name = "lichgate",
    aspect = "frame",
    linked = ":lichgate-linked",
    title = "Lichgate",
)

# `buck2 run tilde//aseipp/cs2wasm/examples/lichgate:terminal` plays it in
# the terminal, through the console's terminal host for linked modules the
# native runner cannot translate (wasm2c has no garbage collector). Options
# follow (`-- --seed 5`, `-- --no-audio`), and guest arguments after a
# second `--` (`-- -- --autopilot` watches the demonstration).
console_terminal(
    name = "terminal",
    app = "lichgate",
    linked = ":lichgate-linked",
)

# Two seconds through the terminal renderer, without a terminal.
depot.command_test(
    name = "terminal-test",
    script = """
        drawn=`$(exe :terminal) --frames 120 --no-save --seed 1`
        cells=`printf '%s\\n' "$drawn" | grep -o '▀' | wc -l`
        if [ "$cells" -lt 1000 ]; then
            echo "only $cells cells drawn" >&2
            exit 1
        fi
    """,
)

# The attract mode's autopilot plays 12,000 frames (200 seconds of game
# time) of seed 7 under the console's headless host: the first run falls
# in the Lich's lair, the second takes a relic, kills the Lich, takes
# another and goes down to floor 2. The whole run is a function of its
# seed, so its last frame and its audio are pinned; a change to the game
# that changes them updates the pin (the summary line is printed). The
# game module keeps to its size budget: lower it when the module shrinks,
# and explain a raise. Raised by 416 bytes (1,413,669 to 1,414,085) when a
# catch clause came to restore its function's call depth (a local saved on
# entry, set again in the handler): the functions with catch clauses, most
# of them async methods' MoveNext and the task library's, leaked the depth
# of the frames an exception unwound. Raised by 16 more (to 1,414,101)
# when integer formatting came to print R without a precision as D (it
# printed an integer ending in zeros in scientific notation). Lowered to
# 1,411,262 when throwing stopped marking the exception thrown (what made
# printing one fault, now the CLR's text without its stack trace). Raised
# by 27,366 (to 1,438,628) when Kiln's world moved into the Kiln library
# and the generator came to write a schedule class instead of the world's
# other half: each component's storage is a table per world (Storage<T>:
# its registration, table and release code are instantiated per component,
# with its statics), events' channels likewise, resources a shared table,
# and the Schedule base; frames spend about 0.2% less fuel. Raised by
# 1,275 more (to 1,439,903) when Kiln came to age the world's particles
# itself: the Particles resource's world property and the schedule's
# runner of Kiln's Particles.Advance, which Upkeep.Settle no longer does.
# Raised by 84 more (to 1,439,987) when the CoreLib's List and HashSet
# came to dispose the enumerator of the sequence they are made from, as the
# BCL's do: a Kiln query's enumerator ends its iteration when disposed.
# Raised by 5,476 more (to 1,445,463) when Kiln's components stopped being
# limited to 63: an entity's components are words of a bitset, and the
# world's members index them by the component's word (Has, Add, Remove and
# Count per component), queries built at run time carry the words past the
# first, and despawning walks them. The game's query loops are unchanged
# (one word), and its autopilot's fuel with them.
depot.command_test(
    name = "autopilot-test",
    script = """
        size=`wc -c < $(location :lichgate)`
        if [ "$size" -gt 1448222 ]; then
            echo "lichgate.wasm is $size bytes, over its budget of 1448222" >&2
            exit 1
        fi
        trace=`$(exe :lichgate-web-headless) --headless --frames 12000 --seed 7 --trace -- --autopilot`
        summary=`printf '%s\\n' "$trace" | tail -n 1`
        printf '%s\\n' "$trace" | grep -v '^frame=' | tail -n 40
        # grep reads everything, so the printf is never cut short.
        expect() {
            if ! printf '%s\\n' "$trace" | grep -F -- "$1" > /dev/null; then
                echo "expected: $1" >&2
                exit 1
            fi
        }
        case "$summary" in
            *"summary frames=12000 presents=12000 width=320 height=192 hash=345f0431b5a54d74 "*" audio=8539cd7769d9f6b9 played=8820000 exit=0") ;;
            *) echo "unexpected run: $summary" >&2; exit 1 ;;
        esac
        expect "enter room 4,0 Boss"
        expect "run over: score=785 floor=1 kills=35 rooms=3 (demo)"
        expect "relic LONG REACH on floor 1"
        expect "the lich falls on floor 1 score=2150"
        expect "relic SWIFT BOOTS on floor 1"
        expect "floor 2: 11 rooms, score=2200"
        if printf '%s\\n' "$trace" | grep -F 'kiln:' > /dev/null; then
            echo "the game reported a failure" >&2
            exit 1
        fi
        drawn=`printf '%s\\n' "$trace" | awk '/^frame=/ { print $2 }' | sort -u | wc -l`
        if [ "$drawn" -lt 10000 ]; then
            echo "only $drawn different frames" >&2
            exit 1
        fi
    """,
)

depot.export_file(
    name = "play.txt",
    src = "tests/play.txt",
)

# A player's session from tests/play.txt: Enter at the title, north into
# the first fight, shooting in turn at each direction while strafing,
# then Escape and Q to end the run, a name typed for the hall of the
# fallen and Enter. The session is recorded, and replaying the recording
# into a fresh save directory must give the same run; a third run from
# the first's save directory finds its high score.
depot.command_test(
    name = "play-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        mkdir "$out/save" "$out/replay"
        run() {
            $(exe :lichgate-web-headless) --headless --seed 3 "$@"
        }
        played=`run --frames 2500 --script $(location :play.txt) --save-dir "$out/save" --record "$out/recorded.txt"`
        printf '%s\\n' "$played"
        expect() {
            if ! printf '%s\\n' "$1" | grep -F -- "$2" > /dev/null; then
                echo "expected: $2" >&2
                exit 1
            fi
        }
        expect "$played" "enter room 3,2 Fight doors=S"
        expect "$played" "run over: score=30 floor=1 kills=3 rooms=0"
        expect "$played" "high score ADA 30 floor 1"
        grep -q '^name.0=ADA$' "$out/save/lichgate/scores.txt"
        grep -q '^score.0=30$' "$out/save/lichgate/scores.txt"
        replayed=`run --frames 2500 --script "$out/recorded.txt" --save-dir "$out/replay"`
        if [ "`printf '%s\\n' "$played" | tail -n 1`" != "`printf '%s\\n' "$replayed" | tail -n 1`" ]; then
            echo "the replay differs from the session" >&2
            printf '%s\\n' "$replayed" | tail -n 1 >&2
            exit 1
        fi
        again=`run --frames 60 --save-dir "$out/save"`
        expect "$again" "lichgate: seed 3, 1 high scores"
    """,
)
