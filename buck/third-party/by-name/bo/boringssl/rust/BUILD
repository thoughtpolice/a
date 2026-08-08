# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

BINDGEN_VERSION = "0.72.1"

BINDGEN_TARGET = shims.select({
    # Rust's UEFI targets use Windows COFF/ABI LLVM targets. Clang does not
    # recognize aarch64-unknown-uefi, so use the llvm-target values from the
    # corresponding Rust target specifications for both architectures.
    "toolchains//cfg/target:target[x86_64-unknown-uefi]": "x86_64-unknown-windows",
    "toolchains//cfg/target:target[x86_64-unknown-linux-gnu]": "x86_64-unknown-linux-gnu",
    "toolchains//cfg/target:target[x86_64-apple-darwin]": "x86_64-apple-darwin",
    "toolchains//cfg/target:target[x86_64-pc-windows-msvc]": "x86_64-pc-windows-msvc",
    "toolchains//cfg/target:target[aarch64-unknown-uefi]": "aarch64-unknown-windows",
    "toolchains//cfg/target:target[aarch64-unknown-linux-gnu]": "aarch64-unknown-linux-gnu",
    "toolchains//cfg/target:target[aarch64-apple-darwin]": "aarch64-apple-darwin",
    "toolchains//cfg/target:target[aarch64-pc-windows-msvc]": "aarch64-pc-windows-msvc",
})

# MARK: main library

shims.cxx_genrule(
    name = "wrapper.rs",
    srcs = {
        "wrapper.h": "third-party//by-name/bo/boringssl:src[rust/bssl-sys/wrapper.h]",
    },
    outs = {
        "wrapper.rs": ["wrapper.rs"],
        # XXX FIXME (aseipp): --wrap-static-fns uses $TMPDIR? why?
        "extern.c": ["extern.c"],
    },
    # Bindgen parses target-dependent C types. Make the target explicit so a
    # cross build cannot silently generate host-ABI bindings, and fail closed
    # if a developer or CI image supplies a different bindgen release.
    cmd = """
      bindgen --version | (
        bindgen_version=
        read -r bindgen_version
        if [ "$bindgen_version" != "bindgen {BINDGEN_VERSION}" ]; then
          echo "expected bindgen {BINDGEN_VERSION}, found $bindgen_version" >&2
          exit 1
        fi
      )

      bindgen \
        wrapper.h -o $OUT/wrapper.rs \
          --no-derive-default \
          --enable-function-attribute-detection \
          --use-core \
          --default-macro-constant-type=signed \
          --rustified-enum=point_conversion_form_t \
          --allowlist-file=".*[[:punct:]]include[[:punct:]]openssl[[:punct:]].*\\.h" \
          --experimental \
          --wrap-static-fns \
          --wrap-static-fns-path $OUT/extern.c \
        -- --target=$BINDGEN_TARGET \
          -I$(location third-party//by-name/bo/boringssl:src)/include
    """.format(BINDGEN_VERSION = BINDGEN_VERSION),
    default_outs = ["wrapper.rs"],
    env = {
        "BINDGEN_TARGET": BINDGEN_TARGET,
    },
    visibility = [],
)

# this library contains all the needed wrappers for static inline functions
shims.cxx_library(
    name = "bssl-sys-cbits",
    srcs = [":wrapper.rs[extern.c]"],
    header_namespace = "",
    headers = {
        "wrapper.h": "third-party//by-name/bo/boringssl:src[rust/bssl-sys/wrapper.h]",
    },
    visibility = ["third-party//by-name/bo/boringssl/..."],
    deps = [
        "third-party//by-name/bo/boringssl:crypto",
        "third-party//by-name/bo/boringssl:ssl",
    ],
)

shims.rust_library(
    name = "bssl-macros",
    srcs = ["third-party//by-name/bo/boringssl:src[rust/bssl-macros/src/lib.rs]"],
    visibility = ["third-party//by-name/bo/boringssl/..."],
)

shims.rust_library(
    name = "bssl-sys",
    srcs = [
        "third-party//by-name/bo/boringssl:src[rust/bssl-sys/src/lib.rs]",
    ],
    env = {
        "BINDGEN_RS_FILE": "$(location :wrapper.rs)",
    },
    rustc_flags = [
        "--cfg",
        "bindgen_rs_file",
    ],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/bo/boringssl:crypto",
        "third-party//by-name/bo/boringssl:ssl",
        ":bssl-macros",
        ":bssl-sys-cbits",  # NOTE: MUST be linked! requires crypto and ssl!
    ],
)

shims.alias(
    name = "rust",
    actual = ":bssl-sys",
    visibility = ["PUBLIC"],
)
