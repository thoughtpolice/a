/*
 * SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * A bare-metal program for the aarch64 virt machine, loaded with -kernel:
 * QEMU starts it at EL1 at its entry point. It prints "ok" on the PL011 and
 * exits through semihosting's SYS_EXIT, which makes QEMU exit with status 0.
 */

    .section .text
    .globl _start
_start:
    mov x0, #0x09000000     /* UART0's data register */
    adr x1, msg
1:  ldrb w2, [x1], #1
    cbz w2, 2f
    strb w2, [x0]
    b 1b
2:  mov x0, #0x18           /* SYS_EXIT */
    adr x1, exit_block
    hlt #0xf000
3:  wfi
    b 3b

    .balign 8
exit_block:
    .quad 0x20026           /* ADP_Stopped_ApplicationExit */
    .quad 0                 /* the exit status */

msg:
    .asciz "ok\n"
