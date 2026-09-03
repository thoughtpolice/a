# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.genrule(
    name = "game-c",
    outs = {
        "c": ["game.c"],
        "h": ["game.h"],
    },
    cmd = "$(exe third-party//by-name/wi/wit-bindgen:wit-bindgen) c " +
          "$(location tilde//aseipp/wlink/demo/sdk:sdk.wit) --world game --no-object-file --out-dir $OUT",
    default_outs = [
        "game.c",
        "game.h",
    ],
    visibility = ["PUBLIC"],
)

# Resolve the HAL package with its SDK dependency in the standard WIT layout.
WIT_LAYOUT = ("mkdir -p $BUCK_SCRATCH_PATH/wit/deps/sdk && " +
              "cp $(location tilde//aseipp/wlink/demo/sdk:hal.wit) $BUCK_SCRATCH_PATH/wit/hal.wit && " +
              "cp $(location tilde//aseipp/wlink/demo/sdk:sdk.wit) $BUCK_SCRATCH_PATH/wit/deps/sdk/sdk.wit && ")

depot.genrule(
    name = "platform-c",
    outs = {
        "c": ["platform.c"],
        "h": ["platform.h"],
    },
    cmd = WIT_LAYOUT +
          "$(exe third-party//by-name/wi/wit-bindgen:wit-bindgen) c " +
          "$BUCK_SCRATCH_PATH/wit --world platform --no-object-file --out-dir $OUT",
    default_outs = ["platform.h"],
    visibility = ["PUBLIC"],
)

depot.genrule(
    name = "game-rust",
    out = "game.rs",
    cmd = "$(exe third-party//by-name/wi/wit-bindgen:wit-bindgen) rust " +
          "$(location tilde//aseipp/wlink/demo/sdk:sdk.wit) --world game --generate-all " +
          "--runtime-path crate::runtime --bitflags-path bitflags " +
          "--disable-run-ctors-once-workaround --disable-custom-section-link-helpers --out-dir $BUCK_SCRATCH_PATH && " +
          "cp $BUCK_SCRATCH_PATH/game.rs $OUT",
    visibility = ["PUBLIC"],
)

depot.genrule(
    name = "platform-rust",
    out = "platform.rs",
    cmd = WIT_LAYOUT +
          "$(exe third-party//by-name/wi/wit-bindgen:wit-bindgen) rust " +
          "$BUCK_SCRATCH_PATH/wit --world platform --generate-all " +
          "--runtime-path crate::runtime --bitflags-path bitflags " +
          "--disable-run-ctors-once-workaround --disable-custom-section-link-helpers --out-dir $BUCK_SCRATCH_PATH && " +
          "cp $BUCK_SCRATCH_PATH/platform.rs $OUT",
    visibility = ["PUBLIC"],
)
