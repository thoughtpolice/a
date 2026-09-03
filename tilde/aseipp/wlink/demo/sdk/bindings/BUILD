# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# The guests' bindings, from wit-bindgen's generators as witgen runs them in
# the build graph. WIT files come in dependency order: the SDK's package
# first, then the package whose world is bound.
WITGEN = "$(exe tilde//aseipp/witgen:witgen) "

SDK_WIT = "$(location tilde//aseipp/wlink/demo/sdk:sdk.wit) "

HAL_WIT = "$(location tilde//aseipp/wlink/demo/sdk:hal.wit) "

SCHEDULER_WIT = "$(location tilde//aseipp/wlink/demo/sdk:scheduler.wit) "

RUST_OPTS = ("--generate-all --runtime-path crate::runtime --bitflags-path bitflags " +
             "--disable-run-ctors-once-workaround --disable-custom-section-link-helpers ")

depot.genrule(
    name = "game-c",
    outs = {
        "c": ["game.c"],
        "h": ["game.h"],
    },
    cmd = WITGEN + "c " + SDK_WIT + "--world game --no-object-file --out-dir $OUT",
    default_outs = [
        "game.c",
        "game.h",
    ],
    visibility = ["PUBLIC"],
)

depot.genrule(
    name = "game-rust",
    out = "game.rs",
    cmd = WITGEN + "rust " + SDK_WIT + "--world game " + RUST_OPTS +
          "--out-dir $BUCK_SCRATCH_PATH && cp $BUCK_SCRATCH_PATH/game.rs $OUT",
    visibility = ["PUBLIC"],
)

depot.genrule(
    name = "platform-rust",
    out = "platform.rs",
    cmd = WITGEN + "rust " + SDK_WIT + HAL_WIT + "--world platform " + RUST_OPTS +
          "--out-dir $BUCK_SCRATCH_PATH && cp $BUCK_SCRATCH_PATH/platform.rs $OUT",
    visibility = ["PUBLIC"],
)

# An async game's C bindings: callback-style exports and the async helpers
# for its waits and streams.
depot.genrule(
    name = "async-game-c",
    outs = {
        "c": ["async_game.c"],
        "h": ["async_game.h"],
    },
    cmd = WITGEN + "c " + SDK_WIT + "--world async-game --no-object-file --out-dir $OUT",
    default_outs = [
        "async_game.c",
        "async_game.h",
    ],
    visibility = ["PUBLIC"],
)

# The scheduler and the launcher, with the SDK as their dependency.
[
    depot.genrule(
        name = world + "-c",
        outs = {
            "c": [world + ".c"],
            "h": [world + ".h"],
        },
        cmd = WITGEN + "c " + SDK_WIT + SCHEDULER_WIT + "--world " + world +
              " --no-object-file --out-dir $OUT",
        default_outs = [
            world + ".c",
            world + ".h",
        ],
        visibility = ["PUBLIC"],
    )
    for world in [
        "scheduler",
        "launcher",
    ]
]
