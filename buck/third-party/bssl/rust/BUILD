# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

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
        "rust_wrapper.c": "third-party//bssl:src[src/rust/bssl-sys/rust_wrapper.c]",
        "rust_wrapper.h": "third-party//bssl:src[src/rust/bssl-sys/rust_wrapper.h]",
        "wrapper.h": "third-party//bssl:src[src/rust/bssl-sys/wrapper.h]",
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
        -- -I$(location third-party//bssl:src)/src/include
    """,
    visibility=[],
)

# this library contains all the needed wrappers for static inline functions
shims.cxx_library(
    name="bssl-sys-cbits",
    srcs=[":wrapper.rs[extern.c]"],
    header_namespace="",
    headers={
        "wrapper.h": "third-party//bssl:src[src/rust/bssl-sys/wrapper.h]",
        "rust_wrapper.h": "third-party//bssl:src[src/rust/bssl-sys/rust_wrapper.h]",
    },
    deps=[
        "third-party//bssl:crypto",
        "third-party//bssl:ssl",
    ],
    visibility=["third-party//bssl/..."],
)

shims.rust_library(
    name="bssl-sys",
    srcs=[
        "third-party//bssl:src[src/rust/bssl-sys/src/lib.rs]",
    ],
    env={
        "BINDGEN_RS_FILE": "$(location :wrapper.rs)",
    },
    deps=[
        "third-party//bssl:crypto",
        "third-party//bssl:ssl",
        ":bssl-sys-cbits",  # NOTE: MUST be linked! requires crypto and ssl!
    ],
    visibility=["PUBLIC"],
)

shims.alias(
    name="rust",
    actual=":bssl-sys",
    visibility=["PUBLIC"],
)
