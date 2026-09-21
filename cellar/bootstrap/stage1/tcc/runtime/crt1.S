/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/* Linux enters with argc at rsp, followed by argv, NULL, and envp. */
.text
.globl _start
_start:
    xor %ebp, %ebp
    mov %rsp, %r12
    and $-16, %rsp
    mov (%r12), %rdi
    lea 8(%r12), %rsi
    lea 16(%r12,%rdi,8), %rdx
    call __init_io
    /* __init_io may clobber every caller-saved argument register. */
    mov (%r12), %rdi
    lea 8(%r12), %rsi
    lea 16(%r12,%rdi,8), %rdx
    call main
    mov %eax, %edi
    call exit
    hlt
