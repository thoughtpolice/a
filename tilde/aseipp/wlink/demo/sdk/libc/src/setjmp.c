// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The runtime half of setjmp and longjmp on WebAssembly.
//
// Neither of the two functions a program calls is defined here, because the
// compiler does not leave them as calls. Its SjLj pass rewrites a function
// that calls setjmp so that the calls which might jump out of it are wrapped
// in a `try_table` catching the `__c_longjmp` tag, and replaces the setjmp
// itself with `__wasm_setjmp`. When that tag is caught, the pass asks
// `__wasm_setjmp_test` whether the jump buffer the throw carried belongs to
// this invocation of this function: if it does, control branches to the point
// where that setjmp returns, carrying the value; if it does not, the
// exception is thrown onwards and the next frame out gets its turn.
//
// So a buffer only needs to say which setjmp filled it -- `__label`, which
// the pass numbers from one -- and which invocation of the enclosing function
// it was filled in, an address the pass makes unique to that invocation.
// Comparing the invocation is what makes a jump into a frame that has already
// returned fail to match, rather than return into a stack that is gone.
//
// The tag has no spelling in C, and the compiler names it rather than
// indexing it, so it is declared below in module-level assembly. A program
// that never calls setjmp never refers to it, and the linker leaves this
// whole object out.
#include <setjmp.h>
#include <stdint.h>

__asm__(".tagtype __c_longjmp i32\n"
        ".globl __c_longjmp\n"
        "__c_longjmp:\n");

// What the throw carries: the buffer being jumped to and the value setjmp is
// to return. One is enough, because a longjmp runs to its catch without
// returning here and the console runs one thread. The layout is the
// compiler's: it reads the buffer at zero and the value at four.
static struct {
  void *environment;
  int value;
} console_jump;

void __wasm_setjmp(void *environment, uint32_t label, void *invocation) {
  struct __console_jump *buffer = environment;
  buffer->__invocation = invocation;
  buffer->__label = label;
}

uint32_t __wasm_setjmp_test(void *environment, void *invocation) {
  struct __console_jump *buffer = environment;
  // Zero means "not this invocation", which is why labels start at one.
  return buffer->__invocation == invocation ? buffer->__label : 0;
}

_Noreturn void __wasm_longjmp(void *environment, int value) {
  console_jump.environment = environment;
  // Jumping with zero makes setjmp return one, as it does everywhere else.
  console_jump.value = value ? value : 1;
  // One names the C longjmp tag, which the compiler turns into the symbol
  // declared above rather than a tag index of its own.
  __builtin_wasm_throw(1, &console_jump);
}

// The pass rewrites calls to longjmp, so this is only here for code that
// takes its address or was compiled without the pass -- and in the second
// case the setjmp it pairs with will have failed to link, loudly, first.
_Noreturn void longjmp(jmp_buf environment, int value) {
  __wasm_longjmp(environment, value);
}
