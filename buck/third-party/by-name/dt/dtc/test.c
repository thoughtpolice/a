// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Build a tree from fdt_create_empty_tree, add a node with properties and a
// phandle, pack it, and read everything back, as QEMU does when it describes a
// virt machine to its guest.

#include <libfdt.h>
#include <stdio.h>
#include <string.h>

#define CHECK(expr)                                                            \
    do {                                                                       \
        int err_ = (expr);                                                     \
        if (err_ < 0)                                                          \
            return fprintf(stderr, "%s: %s\n", #expr, fdt_strerror(err_)), 1;  \
    } while (0)

int main(void) {
    /* libfdt wants the tree 8-byte aligned (FDT_ERR_ALIGNMENT), which a
     * char array only happens to be on some targets. */
    static _Alignas(8) char buf[4096];
    CHECK(fdt_create_empty_tree(buf, sizeof buf));

    int node = fdt_add_subnode(buf, 0, "uart@10000000");
    CHECK(node);
    CHECK(fdt_setprop_string(buf, node, "compatible", "ns16550a"));
    CHECK(fdt_setprop_u32(buf, node, "clock-frequency", 3686400));
    CHECK(fdt_setprop_u32(buf, node, "phandle", 7));
    CHECK(fdt_pack(buf));
    CHECK(fdt_check_full(buf, fdt_totalsize(buf)));

    int found = fdt_path_offset(buf, "/uart@10000000");
    CHECK(found);
    int len;
    const char *compat = fdt_getprop(buf, found, "compatible", &len);
    if (compat == NULL || strcmp(compat, "ns16550a") != 0)
        return fprintf(stderr, "compatible: %s\n", compat ? compat : "(missing)"), 1;
    const fdt32_t *freq = fdt_getprop(buf, found, "clock-frequency", &len);
    if (freq == NULL || len != sizeof *freq || fdt32_to_cpu(*freq) != 3686400)
        return fprintf(stderr, "clock-frequency is wrong\n"), 1;

    uint32_t max_phandle;
    CHECK(fdt_find_max_phandle(buf, &max_phandle));
    if (max_phandle != 7 || fdt_node_offset_by_phandle(buf, 7) != found)
        return fprintf(stderr, "phandle %u\n", max_phandle), 1;

    printf("ok: %d bytes\n", fdt_totalsize(buf));
    return 0;
}
