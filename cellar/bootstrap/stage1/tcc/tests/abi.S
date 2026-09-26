/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
.text
.globl entry_alignment
entry_alignment:
    lea 8(%rsp), %rax
    and $15, %rax
    ret

.globl probe_setjmp
probe_setjmp:
    push %rbx
    push %rbp
    push %r12
    push %r13
    push %r14
    push %r15
    sub $72, %rsp
    mov $17, %ebx
    mov $19, %ebp
    mov $23, %r12d
    mov $29, %r13d
    mov $31, %r14d
    mov $37, %r15d
    mov %rsp, %rdi
    call setjmp
    test %eax, %eax
    jne 1f
    xor %ebx, %ebx
    xor %ebp, %ebp
    xor %r12d, %r12d
    xor %r13d, %r13d
    xor %r14d, %r14d
    xor %r15d, %r15d
    mov %rsp, %rdi
    xor %esi, %esi
    call longjmp
1:
    cmp $1, %eax
    jne 2f
    cmp $17, %ebx
    jne 2f
    cmp $19, %ebp
    jne 2f
    cmp $23, %r12d
    jne 2f
    cmp $29, %r13d
    jne 2f
    cmp $31, %r14d
    jne 2f
    cmp $37, %r15d
    jne 2f
    xor %eax, %eax
    jmp 3f
2:
    mov $1, %eax
3:
    add $72, %rsp
    pop %r15
    pop %r14
    pop %r13
    pop %r12
    pop %rbp
    pop %rbx
    ret
