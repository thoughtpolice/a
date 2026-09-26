/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
/* SysV function arguments -> Linux x86_64 syscall arguments. All callee-saved
 * registers are preserved. Kernel negative errno results pass through unchanged.
 */
.text
.global __syscall_tcc
.hidden __syscall_tcc
.type __syscall_tcc,@function
__syscall_tcc:
    mov %rdi, %rax
    mov %rsi, %rdi
    mov %rdx, %rsi
    mov %rcx, %rdx
    mov %r8, %r10
    mov %r9, %r8
    mov 8(%rsp), %r9
    syscall
    ret
