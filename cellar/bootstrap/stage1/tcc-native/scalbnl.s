# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: MIT
# Transitional compiler runtime: the predecessor parsed musl scalbnl's large
# hexadecimal constants as doubles. Use x87 scaling until corrected TCC can
# rebuild the original musl C implementation from source.
.text
.globl scalbnl
.type scalbnl,@function
scalbnl:
    sub $16,%rsp
    mov %edi,(%rsp)
    fildl (%rsp)
    fldt 24(%rsp)
    fscale
    fstp %st(1)
    add $16,%rsp
    ret
.size scalbnl,.-scalbnl
.section .note.GNU-stack,"",@progbits
