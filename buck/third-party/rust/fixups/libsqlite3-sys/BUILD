# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot = "shims")

depot.cxx_genrule(
    name = 'bindgen.rs',
    outs = {
        'bindgen.rs': [ 'bindgen.rs' ],
        # XXX FIXME (aseipp): --wrap-static-fns uses $TMPDIR? why?
        'extern.c': [ 'extern.c' ],
    },
    default_outs = [ 'bindgen.rs' ],
    srcs = {
        'wrapper.h': 'third-party//sqlite:wrapper_sqlite3ext.h',
    },
    # this abomination comes from
    # https://github.com/rusqlite/rusqlite/blob/fb95263b1c17947dbe81fa03fd8bd216b4fba6b3/libsqlite3-sys/build.rs#L530-L576
    cmd = """
        bindgen \
        wrapper.h -o $OUT/bindgen.rs \
          --default-macro-constant-type=signed \
          --disable-nested-struct-naming \
          --distrust-clang-mangling \
          --blocklist-function=sqlite3_auto_extension \
          --raw-line='extern "C" { pub fn sqlite3_auto_extension(xEntryPoint: ::std::option::Option<unsafe extern "C" fn(db: *mut sqlite3, pzErrMsg: *mut *mut ::std::os::raw::c_char, _: *const sqlite3_api_routines) -> ::std::os::raw::c_int>) -> ::std::os::raw::c_int; }' \
          --blocklist-function=sqlite3_cancel_auto_extension \
          --raw-line='extern "C" { pub fn sqlite3_cancel_auto_extension(xEntryPoint: ::std::option::Option<unsafe extern "C" fn(db: *mut sqlite3, pzErrMsg: *mut *mut ::std::os::raw::c_char, _: *const sqlite3_api_routines) -> ::std::os::raw::c_int>) -> ::std::os::raw::c_int; }' \
          --blocklist-function=sqlite3_close_v2 \
          --blocklist-function=sqlite3_create_collation \
          --blocklist-function=sqlite3_create_function \
          --blocklist-function=sqlite3_create_module \
          --blocklist-function=sqlite3_prepare \
          --blocklist-function=.*16* \
        -- -I$(location third-party//sqlite:src)
    """,
    visibility = [],
)

depot.filegroup(
    name = 'rust_bindgen_out_dir',
    srcs = [ ':bindgen.rs' ],
    visibility = [ 'third-party//rust/...' ],
)
