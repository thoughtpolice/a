# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
.text
.globl _start
_start:
    movabs $wide_constant, %rax
    movabs $0x123456789abcdef0, %rdx
    cmp %rdx, %rax
    jne 1f
    xor %edi, %edi
    mov $60, %eax
    syscall
1:  mov $1, %edi
    mov $60, %eax
    syscall
.section .discard_me,"ax",@progbits
    ud2
.section .note.GNU-stack,"",@progbits
