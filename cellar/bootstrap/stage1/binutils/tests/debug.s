# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
.file 1 "bootstrap-fixture.c"
.text
.globl known_function
.type known_function,@function
known_function:
.loc 1 41 0
    mov $42, %eax
.loc 1 42 0
    ret
.size known_function,.-known_function
.section .rodata
.asciz "bootstrap-readable-string"
.section .note.GNU-stack,"",@progbits
