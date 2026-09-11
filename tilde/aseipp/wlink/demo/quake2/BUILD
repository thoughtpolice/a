# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/wlink/demo/sdk:defs.bzl", "C_FLAGS", "WASM", "console_application", "console_web")

ENGINE_COMMIT = "6608a8beae5cb1d52acc0875c54088f7a049daf6"

# The C-only static build from the upstream Makefile: client, common,
# server, the game module, and the software renderer. Its Unix platform
# file, socket network layer, SDL window, generic system layer, null sound
# driver, and hunk allocator are left out: the shim supplies the platform
# and window hooks, system.c the system layer with a real directory search,
# sound.c the sound driver, hunk.c the allocator, and the loopback network
# stands in for sockets.
ENGINE_SOURCES = [
    "client/cl_cin.c",
    "client/cl_ents.c",
    "client/cl_fx.c",
    "client/cl_input.c",
    "client/cl_inv.c",
    "client/cl_main.c",
    "client/cl_newfx.c",
    "client/cl_parse.c",
    "client/cl_pred.c",
    "client/cl_scrn.c",
    "client/cl_tent.c",
    "client/cl_view.c",
    "client/console.c",
    "client/keys.c",
    "client/menu.c",
    "client/qmenu.c",
    "client/snd_dma.c",
    "client/snd_mem.c",
    "client/snd_mix.c",
    "game/g_ai.c",
    "game/g_chase.c",
    "game/g_cmds.c",
    "game/g_combat.c",
    "game/g_func.c",
    "game/g_items.c",
    "game/g_main.c",
    "game/g_misc.c",
    "game/g_monster.c",
    "game/g_phys.c",
    "game/g_save.c",
    "game/g_spawn.c",
    "game/g_svcmds.c",
    "game/g_target.c",
    "game/g_trigger.c",
    "game/g_turret.c",
    "game/g_utils.c",
    "game/g_weapon.c",
    "game/m_actor.c",
    "game/m_berserk.c",
    "game/m_boss2.c",
    "game/m_boss3.c",
    "game/m_boss31.c",
    "game/m_boss32.c",
    "game/m_brain.c",
    "game/m_chick.c",
    "game/m_flash.c",
    "game/m_flipper.c",
    "game/m_float.c",
    "game/m_flyer.c",
    "game/m_gladiator.c",
    "game/m_gunner.c",
    "game/m_hover.c",
    "game/m_infantry.c",
    "game/m_insane.c",
    "game/m_medic.c",
    "game/m_move.c",
    "game/m_mutant.c",
    "game/m_parasite.c",
    "game/m_soldier.c",
    "game/m_supertank.c",
    "game/m_tank.c",
    "game/p_client.c",
    "game/p_hud.c",
    "game/p_trail.c",
    "game/p_view.c",
    "game/p_weapon.c",
    "game/q_shared.c",
    "net/net_loopback.c",
    "null/cd_null.c",
    "other/glob.c",
    "other/vid_lib.c",
    "other/vid_menu.c",
    "qcommon/cmd.c",
    "qcommon/cmodel.c",
    "qcommon/common.c",
    "qcommon/crc.c",
    "qcommon/cvar.c",
    "qcommon/files.c",
    "qcommon/md4.c",
    "qcommon/net_chan.c",
    "qcommon/pmove.c",
    "ref_soft/r_aclip.c",
    "ref_soft/r_alias.c",
    "ref_soft/r_bsp.c",
    "ref_soft/r_draw.c",
    "ref_soft/r_edge.c",
    "ref_soft/r_image.c",
    "ref_soft/r_light.c",
    "ref_soft/r_main.c",
    "ref_soft/r_misc.c",
    "ref_soft/r_model.c",
    "ref_soft/r_part.c",
    "ref_soft/r_poly.c",
    "ref_soft/r_polyse.c",
    "ref_soft/r_rast.c",
    "ref_soft/r_scan.c",
    "ref_soft/r_sprite.c",
    "ref_soft/r_surf.c",
    "server/sv_ccmds.c",
    "server/sv_ents.c",
    "server/sv_game.c",
    "server/sv_init.c",
    "server/sv_main.c",
    "server/sv_send.c",
    "server/sv_user.c",
    "server/sv_world.c",
]

# Every header the sources reach through their relative includes.
ENGINE_HEADERS = [
    "client/adivtab.h",
    "client/anorms.h",
    "client/block16.h",
    "client/block8.h",
    "client/cdaudio.h",
    "client/client.h",
    "client/console.h",
    "client/input.h",
    "client/keys.h",
    "client/qmenu.h",
    "client/ref.h",
    "client/screen.h",
    "client/snd_loc.h",
    "client/sound.h",
    "client/vid.h",
    "game/g_local.h",
    "game/game.h",
    "game/m_actor.h",
    "game/m_berserk.h",
    "game/m_boss2.h",
    "game/m_boss31.h",
    "game/m_boss32.h",
    "game/m_brain.h",
    "game/m_chick.h",
    "game/m_flipper.h",
    "game/m_float.h",
    "game/m_flyer.h",
    "game/m_gladiator.h",
    "game/m_gunner.h",
    "game/m_hover.h",
    "game/m_infantry.h",
    "game/m_insane.h",
    "game/m_medic.h",
    "game/m_mutant.h",
    "game/m_parasite.h",
    "game/m_player.h",
    "game/m_rider.h",
    "game/m_soldier.h",
    "game/m_supertank.h",
    "game/m_tank.h",
    "game/q_shared.h",
    "other/glob.h",
    "qcommon/crc.h",
    "qcommon/qcommon.h",
    "qcommon/qfiles.h",
    "quake2.h",
    "quakegeneric.h",
    "ref_soft/adivtab.h",
    "ref_soft/anorms.h",
    "ref_soft/r_local.h",
    "ref_soft/r_model.h",
    "ref_soft/rand1k.h",
    "server/server.h",
]

# The engine at a pinned commit of a fork that fixes two function prototypes
# whose mismatch WebAssembly's indirect-call signature check rejects. The
# port compiles the files it needs against the SDK libc, so every C-only
# source and header is a sub-target. The OpenGL renderer, the
# capture-the-flag module, and the SDL, Win32, and X11 ports stay unused in
# the archive. Provenance and licences are in README.md.
depot.http_archive(
    name = "quake2generic",
    sha256 = "c3ff4a36a30d91e59833ae2528dc3d989972b0e7e9426743ed9c772d21ea7ce6",
    strip_prefix = "quake2generic-" + ENGINE_COMMIT,
    sub_targets = ENGINE_SOURCES + ENGINE_HEADERS,
    type = "tar.gz",
    urls = ["https://github.com/thoughtpolice/quake2generic/archive/" + ENGINE_COMMIT + ".tar.gz"],
)

ENGINE = ":quake2generic"

ENGINE_INCLUDES = {header: ENGINE + "[" + header + "]" for header in ENGINE_HEADERS}

depot.cxx_library(
    name = "engine",
    srcs = [ENGINE + "[" + source + "]" for source in ENGINE_SOURCES],
    compiler_flags = C_FLAGS + [
        "-Dstricmp=strcasecmp",
        # The version string embeds the build date; the engine's commit date
        # keeps the objects reproducible.
        "-Wno-builtin-macro-redefined",
        '-D__DATE__="Jul 18 2026"',
    ],
    header_namespace = "",
    preferred_linkage = "static",
    raw_headers = [ENGINE + "[" + header + "]" for header in ENGINE_HEADERS],
    target_compatible_with = WASM,
    visibility = [],
    deps = ["//aseipp/wlink/demo/sdk/libc"],
)

[
    depot.export_file(
        name = name,
        src = name,
    )
    for name in [
        "e2e_test.py",
        "extract_pak.py",
    ]
]

# The native host keeps a quake2/ path so its object stays apart from the
# SDK's own host.c in the binary that compiles both.
depot.export_file(
    name = "host.c",
    src = "host.c",
    out = "quake2/host.c",
)

# The only freely redistributable Quake II data is id's 3.14 demo installer,
# and only as that unmodified file; the pak inside it is taken out at build
# time and never uploaded to a shared cache.
depot.http_file(
    name = "demo-installer",
    sha256 = "7ace5a43983f10d6bdc9d9b6e17a1032ba6223118d389bd170df89b945a04a1e",
    urls = ["https://ftp.gwdg.de/pub/misc/ftp.idsoftware.com/idstuff/quake2/q2-314-demo-x86.exe"],
)

depot.genrule(
    name = "demo-data",
    outs = {
        "pak": ["pak0.pak"],
        "license": ["license.txt"],
    },
    cacheable = False,
    cmd = "python3 $(location :extract_pak.py) $(location :demo-installer) $OUT",
    default_outs = ["pak0.pak"],
    visibility = ["PUBLIC"],
)

[
    console_application(
        name = name,
        srcs = [
            "hunk.c",
            "shim.c",
            "sound.c",
            "system.c",
        ] + (["state.c"] if name == "quake2-test" else []),
        compiler_flags = ["-DQUAKE2_TEST"] if name == "quake2-test" else [],
        headers = ENGINE_INCLUDES,
        host_srcs = [":host.c"],
        initial_memory = 67108864,
        deps = [":engine"],
    )
    for name in [
        "quake2",
        "quake2-test",
    ]
]

# The pak is never uploaded to a shared cache, so neither is a package holding
# a copy of it.
console_web(
    name = "quake2",
    # A page is not a terminal: it has the pixels for the engine's custom
    # mode and a window shaped nothing like 4:3, so the browser gets 720p
    # scaled to fit. The engine draws its status bar, its menus and its
    # console a pixel to a pixel whatever the mode is, so a taller one
    # shrinks them into a corner; this is the widescreen size that leaves
    # them legible, and it costs less than half of 1080p to draw. Neither
    # reaches the native runner, which draws into a terminal and keeps the
    # engine's 320x240.
    args = [
        "+set",
        "sw_mode",
        "-1",
        "+set",
        "vid_width",
        "1280",
        "+set",
        "vid_height",
        "720",
    ],
    aspect = "fill",
    cacheable = False,
    frames_per_second = 60,
    linked = ":quake2-linked",
    mounts = {"baseq2/pak0.pak": ":demo-data[pak]"},
    option = "pak",
    title = "Quake II",
)

depot.command(
    name = "quake2",
    cmd = [
        "$(exe :quake2-host)",
        "--pak",
        "$(location :demo-data[pak])",
    ],
    visibility = ["PUBLIC"],
)

depot.cxx_binary(
    name = "hunk-tests",
    srcs = [
        "hunk.c",
        "hunk_test.c",
    ],
    compiler_flags = ["-DHUNK_NATIVE_TEST"],
)

depot.command_test(
    name = "test-hunk",
    cmd = ["$(exe :hunk-tests)"],
)

# The engine abandons a frame after an error by jumping out of it, which on
# this target is a lowering onto WebAssembly's exception mechanism rather than
# anything a jump buffer holds. A demo that is not there is the shortest way
# to one of those errors: the engine must report it, shut the server down, and
# carry on running frames rather than take the application with it.
depot.command_test(
    name = "test-quake2-error-recovery",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/quake2-error-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :quake2-host) --pak $(location :demo-data[pak]) --headless --frames 60 --no-save \
  -- +map nosuch.dm2 >"$out/log"
grep -q "ERROR: Couldn't open demos/nosuch.dm2" "$out/log"
grep -q '==== ShutdownGame ====' "$out/log"
grep -q 'summary frames=60 presents=60 .* exit=0' "$out/log"
""",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.command_test(
    name = "test-quake2-e2e",
    cmd = [
        "python3",
        "$(location :e2e_test.py)",
        "$(exe :quake2-test-host)",
        "$(exe :quake2-host)",
        "$(location :demo-data[pak])",
    ],
    target_compatible_with = ["config//os:linux"],
)

depot.command_test(
    name = "test-quake2-e2e-web",
    cmd = [
        "python3",
        "$(location :e2e_test.py)",
        "$(exe :quake2-web-headless) --module $(location :quake2-test-linked-opt.wasm)",
        "$(exe :quake2-web-headless)",
        "$(location :demo-data[pak])",
    ],
)

depot.command_test(
    name = "test-quake2-web-parity",
    cmd = [
        "python3",
        "$(location //aseipp/wlink/demo:parity-test.py)",
        "quake2",
        "$(exe :quake2-host)",
        "$(exe :quake2-web-headless)",
        "$(location :demo-data[pak])",
    ],
    target_compatible_with = ["config//os:linux"],
)

# The game imports nothing but the SDK, and the linked module nothing but the
# HAL, so the host that runs Doom runs Quake II too.
depot.command_test(
    name = "test-quake2-imports",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/wlink-quake2-imports-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe third-party//by-name/wa/wabt:wasm-validate) --enable-all $(location :quake2-linked.wasm)
$(exe tilde//aseipp/wlink:wlink) print $(location :quake2-core.wasm) >"$out/game.wat"
$(exe tilde//aseipp/wlink:wlink) print $(location :quake2-linked.wasm) >"$out/linked.wat"
if grep '(import "' "$out/game.wat" | grep -v '"console:sdk/'; then
    echo "game imports services outside the SDK" >&2
    exit 1
fi
if grep '(import "' "$out/linked.wat" | grep -v '"console:hal/raw@0.1.0"'; then
    echo "linked module imports services outside the HAL" >&2
    exit 1
fi
grep -q '(export "init"' "$out/linked.wat"
grep -q '(export "frame"' "$out/linked.wat"
""",
    ],
    target_compatible_with = ["config//os:linux"],
)
