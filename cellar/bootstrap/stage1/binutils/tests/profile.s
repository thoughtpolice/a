# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
.text
.globl profile_child
.type profile_child,@function
profile_child:
    mov $42, %eax
    ret
.size profile_child,.-profile_child
.balign 16
.globl profile_parent
.type profile_parent,@function
profile_parent:
    call profile_child
    ret
.size profile_parent,.-profile_parent
.balign 16
.globl _start
.type _start,@function
_start:
    xor %edi, %edi
    mov $60, %eax
    syscall
.size _start,.-_start
# An incomplete call opcode at the end must not be read as a five-byte call.
.globl profile_tail
.type profile_tail,@function
profile_tail:
    .byte 0xe8
.size profile_tail,.-profile_tail
.section .note.GNU-stack,"",@progbits
