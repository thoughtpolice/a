// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Chez Scheme's C interface, raw: scheme.h's functions, and its macros as
//! compiled by shim.c. Everything here is unsafe; [`crate::Value`] and
//! [`crate::Scope`] are the safe layer.

use std::ffi::{c_char, c_int, c_void};

/// A Scheme object (scheme.h's `ptr`).
pub type Ptr = *mut c_void;
/// scheme.h's `iptr`.
pub type Iptr = isize;

unsafe extern "C" {
    // Predicates (shim.c).
    pub fn chez_fixnump(x: Ptr) -> c_int;
    pub fn chez_charp(x: Ptr) -> c_int;
    pub fn chez_nullp(x: Ptr) -> c_int;
    pub fn chez_eof_objectp(x: Ptr) -> c_int;
    pub fn chez_bwp_objectp(x: Ptr) -> c_int;
    pub fn chez_booleanp(x: Ptr) -> c_int;
    pub fn chez_pairp(x: Ptr) -> c_int;
    pub fn chez_symbolp(x: Ptr) -> c_int;
    pub fn chez_procedurep(x: Ptr) -> c_int;
    pub fn chez_flonump(x: Ptr) -> c_int;
    pub fn chez_vectorp(x: Ptr) -> c_int;
    pub fn chez_bytevectorp(x: Ptr) -> c_int;
    pub fn chez_stringp(x: Ptr) -> c_int;
    pub fn chez_bignump(x: Ptr) -> c_int;
    pub fn chez_boxp(x: Ptr) -> c_int;
    pub fn chez_recordp(x: Ptr) -> c_int;
    pub fn chez_is_false(x: Ptr) -> c_int;
    pub fn chez_is_void(x: Ptr) -> c_int;

    // Accessors (shim.c).
    pub fn chez_fixnum_value(x: Ptr) -> Iptr;
    pub fn chez_char_value(x: Ptr) -> u32;
    pub fn chez_flonum_value(x: Ptr) -> f64;
    pub fn chez_car(x: Ptr) -> Ptr;
    pub fn chez_cdr(x: Ptr) -> Ptr;
    pub fn chez_unbox(x: Ptr) -> Ptr;
    pub fn chez_vector_length(x: Ptr) -> Iptr;
    pub fn chez_vector_ref(x: Ptr, i: Iptr) -> Ptr;
    pub fn chez_bytevector_length(x: Ptr) -> Iptr;
    pub fn chez_bytevector_data(x: Ptr) -> *mut u8;
    pub fn chez_string_length(x: Ptr) -> Iptr;
    pub fn chez_string_ref(x: Ptr, i: Iptr) -> u32;
    pub fn chez_string_set(x: Ptr, i: Iptr, c: u32);

    // Constants and immediates (shim.c).
    pub fn chez_fixnum(n: Iptr) -> Ptr;
    pub fn chez_char(c: u32) -> Ptr;
    pub fn chez_nil() -> Ptr;
    pub fn chez_true() -> Ptr;
    pub fn chez_false() -> Ptr;
    pub fn chez_void() -> Ptr;
    pub fn chez_eof() -> Ptr;
    pub fn chez_bwp() -> Ptr;

    // scheme.h's functions.
    pub fn Scons(car: Ptr, cdr: Ptr) -> Ptr;
    pub fn Sset_car(x: Ptr, v: Ptr);
    pub fn Sset_cdr(x: Ptr, v: Ptr);
    pub fn Sbox(x: Ptr) -> Ptr;
    pub fn Sstring_to_symbol(s: *const c_char) -> Ptr;
    pub fn Ssymbol_to_string(x: Ptr) -> Ptr;
    pub fn Sflonum(x: f64) -> Ptr;
    pub fn Smake_vector(n: Iptr, fill: Ptr) -> Ptr;
    pub fn Svector_set(x: Ptr, i: Iptr, v: Ptr);
    pub fn Smake_bytevector(n: Iptr, fill: c_int) -> Ptr;
    pub fn Sstring_utf8(s: *const c_char, n: Iptr) -> Ptr;
    pub fn Sinteger64(n: i64) -> Ptr;
    pub fn Sunsigned64(n: u64) -> Ptr;
    pub fn Stry_integer64_value(x: Ptr, out: *mut i64, why: *mut *const c_char) -> c_int;
    pub fn Stry_unsigned64_value(x: Ptr, out: *mut u64, why: *mut *const c_char) -> c_int;
    pub fn Stop_level_value(sym: Ptr) -> Ptr;
    pub fn Sset_top_level_value(sym: Ptr, v: Ptr);
    pub fn Slock_object(x: Ptr);
    pub fn Sunlock_object(x: Ptr);
    pub fn Sforeign_symbol(name: *const c_char, addr: *mut c_void);
    pub fn Sinitframe(n: Iptr);
    pub fn Sput_arg(i: Iptr, v: Ptr);
    pub fn Scall(proc_: Ptr, n: Iptr) -> Ptr;
    pub fn Sactivate_thread() -> c_int;
    pub fn Sdeactivate_thread();
    pub fn Sscheme_init(abnormal_exit: Option<unsafe extern "C" fn()>);
    pub fn Sregister_boot_file(name: *const c_char);
    pub fn Sbuild_heap(exec: *const c_char, custom_init: Option<unsafe extern "C" fn()>);
}
