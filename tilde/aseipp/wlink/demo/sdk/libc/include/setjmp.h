// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_SETJMP_H
#define CONSOLE_LIBC_SETJMP_H

#ifdef __cplusplus
extern "C" {
#endif

// WebAssembly cannot capture a call stack and return into it, so a jump is
// made out of the one unwinding mechanism the machine does have: the compiler
// rewrites every function that calls setjmp into a loop that catches a thrown
// exception, asks whether the jump was meant for it, and re-enters at the
// right place. A jump buffer therefore holds no registers -- only which call
// to setjmp filled it, and which invocation of the enclosing function that
// was. src/setjmp.c has the rest of it.
struct __console_jump {
  void *__invocation;
  unsigned __label;
};

typedef struct __console_jump jmp_buf[1];

int setjmp(jmp_buf environment) __attribute__((returns_twice));
_Noreturn void longjmp(jmp_buf environment, int value);

#ifdef __cplusplus
}
#endif

#endif
