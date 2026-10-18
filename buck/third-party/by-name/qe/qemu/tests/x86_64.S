/*
 * SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * A 64 KiB firmware image for the x86 PC machines, loaded with -bios: the
 * CPU starts in real mode at the reset vector in its last 16 bytes. It
 * prints "ok" on isa-debugcon's port and writes 0 to an isa-debug-exit at
 * port 0xf4, which makes QEMU exit with status (0 << 1) | 1 = 1.
 */

    .code16
    .section .text
    .globl _start
_start:
    mov $0xe9, %dx
    mov $'o', %al
    out %al, %dx
    mov $'k', %al
    out %al, %dx
    mov $'\n', %al
    out %al, %dx
    mov $0xf4, %dx
    xor %al, %al
    out %al, %dx
1:  hlt
    jmp 1b

    /* The reset vector, at 0xffff:fff0 */
    .org 0xfff0
    jmp _start

    .org 0x10000
