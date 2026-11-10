// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// shim.c -- scheme.h's macros as functions, for Rust (sys.rs).
//
// Much of Chez Scheme's C interface is macros over its object layout,
// which scheme.h describes for one machine type. Compiling them here, against
// the scheme.h of the Chez Scheme the program links, keeps Rust out of the
// layout entirely. The exported functions (Scons, Sstring_utf8, Scall0, ...)
// Rust calls directly.
#include "scheme.h"

#include <stdint.h>

#define PRED(name, macro) \
  int chez_##name(ptr x) { return macro(x) ? 1 : 0; }

PRED(fixnump, Sfixnump)
PRED(charp, Scharp)
PRED(nullp, Snullp)
PRED(eof_objectp, Seof_objectp)
PRED(booleanp, Sbooleanp)
PRED(pairp, Spairp)
PRED(symbolp, Ssymbolp)
PRED(procedurep, Sprocedurep)
PRED(flonump, Sflonump)
PRED(vectorp, Svectorp)
PRED(bytevectorp, Sbytevectorp)
PRED(stringp, Sstringp)
PRED(bignump, Sbignump)
PRED(boxp, Sboxp)
PRED(recordp, Srecordp)

int chez_is_false(ptr x) { return x == Sfalse; }
int chez_is_void(ptr x) { return x == Svoid; }

iptr chez_fixnum_value(ptr x) { return Sfixnum_value(x); }
uint32_t chez_char_value(ptr x) { return (uint32_t)Schar_value(x); }
double chez_flonum_value(ptr x) { return Sflonum_value(x); }
ptr chez_car(ptr x) { return Scar(x); }
ptr chez_cdr(ptr x) { return Scdr(x); }
iptr chez_vector_length(ptr x) { return Svector_length(x); }
ptr chez_vector_ref(ptr x, iptr i) { return Svector_ref(x, i); }
iptr chez_bytevector_length(ptr x) { return Sbytevector_length(x); }
unsigned char* chez_bytevector_data(ptr x) { return (unsigned char*)Sbytevector_data(x); }
iptr chez_string_length(ptr x) { return Sstring_length(x); }
/* All of a string's characters, into out (chez_string_length of them):
   one call, not one a character. */
void chez_string_chars(ptr x, uint32_t* out) {
  iptr n = Sstring_length(x);
  for (iptr i = 0; i < n; i++) out[i] = (uint32_t)Sstring_ref(x, i);
}

ptr chez_fixnum(iptr n) { return Sfixnum(n); }
ptr chez_char(uint32_t c) { return Schar(c); }
ptr chez_nil(void) { return Snil; }
ptr chez_true(void) { return Strue; }
ptr chez_false(void) { return Sfalse; }
ptr chez_void(void) { return Svoid; }
ptr chez_eof(void) { return Seof_object; }
ptr chez_bwp(void) { return Sbwp_object; }
