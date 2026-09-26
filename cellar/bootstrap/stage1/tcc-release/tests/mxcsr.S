/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
.text
.global large_immediate
large_immediate:
    mov $0x101010101010101, %rax
    ret
.global check_mxcsr
check_mxcsr:
    sub $16, %rsp
    stmxcsr (%rsp)
    mov (%rsp), %eax
    xor $0x6000, %eax
    mov %eax, 4(%rsp)
    ldmxcsr 4(%rsp)
    stmxcsr 8(%rsp)
    ldmxcsr (%rsp)
    mov 8(%rsp), %eax
    xor 4(%rsp), %eax
    add $16, %rsp
    ret
