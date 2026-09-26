/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
/* Keep the SysV status in edi while selecting the Linux exit syscall. */
.text
.globl _exit
_exit:
    mov $60, %eax
    syscall
    hlt
