/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
OUTPUT_FORMAT(elf64-x86-64)
ENTRY(_start)
MEMORY { code (rx) : ORIGIN = 0x400000, LENGTH = 64K }
SECTIONS {
    .text : { *(.text) } > code
    /DISCARD/ : { *(.discard_me) *(.note.GNU-stack) }
}
wide_constant = (0x12345678 << 32) | 0x9abcdef0;
ASSERT(SIZEOF(.text) > 0 && SIZEOF(.text) < 4096, "text section bounds")
ASSERT(wide_constant == 0x123456789abcdef0, "64-bit linker expression")
