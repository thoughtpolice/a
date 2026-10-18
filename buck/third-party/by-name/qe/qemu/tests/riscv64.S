/*
 * SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * A bare-metal program for the riscv64 virt machine, run with -bios none:
 * QEMU starts it in M-mode at its entry point. It prints "ok" on the 16550
 * UART and powers the machine off through the SiFive test device, which
 * makes QEMU exit with status 0.
 */

    .section .text
    .globl _start
_start:
    li t0, 0x10000000       /* UART0's transmit holding register */
    la t1, msg
1:  lbu t2, 0(t1)
    beqz t2, 2f
    sb t2, 0(t0)
    addi t1, t1, 1
    j 1b
2:  li t0, 0x100000         /* sifive_test */
    li t1, 0x5555           /* FINISHER_PASS */
    sw t1, 0(t0)
3:  wfi
    j 3b

msg:
    .asciz "ok\n"
