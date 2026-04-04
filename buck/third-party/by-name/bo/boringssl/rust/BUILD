# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# MARK: main library

shims.cxx_genrule(
    name="wrapper.rs",
    outs={
        "wrapper.rs": ["wrapper.rs"],
        # XXX FIXME (aseipp): --wrap-static-fns uses $TMPDIR? why?
        "extern.c": ["extern.c"],
    },
    default_outs=["wrapper.rs"],
    srcs={
        "wrapper.h": "third-party//by-name/bo/boringssl:src[rust/bssl-sys/wrapper.h]",
    },
    cmd=f"""
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
        -- -I$(location third-party//by-name/bo/boringssl:src)/include
    """,
    visibility=[],
)

# this library contains all the needed wrappers for static inline functions
shims.cxx_library(
    name="bssl-sys-cbits",
    srcs=[":wrapper.rs[extern.c]"],
    header_namespace="",
    headers={
        "wrapper.h": "third-party//by-name/bo/boringssl:src[rust/bssl-sys/wrapper.h]",
    },
    deps=[
        "third-party//by-name/bo/boringssl:crypto",
        "third-party//by-name/bo/boringssl:ssl",
    ],
    visibility=["third-party//by-name/bo/boringssl/..."],
)

shims.rust_library(
    name="bssl-macros",
    srcs=["third-party//by-name/bo/boringssl:src[rust/bssl-macros/src/lib.rs]"],
    visibility=["third-party//by-name/bo/boringssl/..."],
)

shims.rust_library(
    name="bssl-sys",
    srcs=[
        "third-party//by-name/bo/boringssl:src[rust/bssl-sys/src/lib.rs]",
    ],
    rustc_flags=["--cfg", "bindgen_rs_file"],
    env={
        "BINDGEN_RS_FILE": "$(location :wrapper.rs)",
    },
    deps=[
        "third-party//by-name/bo/boringssl:crypto",
        "third-party//by-name/bo/boringssl:ssl",
        ":bssl-sys-cbits",  # NOTE: MUST be linked! requires crypto and ssl!
        ":bssl-macros",
    ],
    visibility=["PUBLIC"],
)

shims.alias(
    name="rust",
    actual=":bssl-sys",
    visibility=["PUBLIC"],
)
