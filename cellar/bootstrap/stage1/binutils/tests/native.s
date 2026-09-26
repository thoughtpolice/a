# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
.file "native-bootstrap.s"
.text
.p2align 4
.macro add_to_result reg
    add \reg, %rax
.endm
.globl bootstrap_sum
.type bootstrap_sum,@function
bootstrap_sum:
.cfi_startproc
    lea (%rdi,%rdi,2),%rax
    add_to_result %rsi
    ret
.cfi_endproc
.size bootstrap_sum,.-bootstrap_sum
.intel_syntax noprefix
.globl bootstrap_intel
.type bootstrap_intel,@function
bootstrap_intel:
    imul rax,rdi,5
    ret
.size bootstrap_intel,.-bootstrap_intel
.att_syntax prefix
.data
.p2align 3
.globl bootstrap_pointer
bootstrap_pointer: .quad external_value
.weak bootstrap_weak
bootstrap_weak: .long 13
.globl bootstrap_float
bootstrap_float: .float 0.1
.globl bootstrap_double
bootstrap_double: .double 1.25e300
.globl bootstrap_large
bootstrap_large: .tfloat 1e4000
.globl bootstrap_small
bootstrap_small: .tfloat 1e-4000
.if (0x123456789abcdef0 >> 32) != 0x12345678
.error "64-bit constant expression"
.endif
.section .note.GNU-stack,"",@progbits
