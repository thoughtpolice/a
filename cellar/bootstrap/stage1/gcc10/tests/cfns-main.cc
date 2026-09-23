/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every name in either table must give the same result from both lookups,
 * and names that are absent, prefixes or extensions of entries must fail in
 * both. The regenerated table is sorted for bisection and has as many
 * entries as gperf's word list.
 */
#include <stdio.h>
#include <string.h>

static const char *const shipped_names[] = {
#include "shipped-names.h"
};

extern "C" int shipped_lookup(const char *);
extern "C" int generated_lookup(const char *);
extern "C" const char *cfns_name(unsigned);

int main()
{
    static const char *const absent[] = {
        "", "a", "ab", "abort", "main", "abso", "strcpyx", "memcpy_s", "c32rtom", "printf_",
    };
    unsigned i, count = 0;
    const char *name, *previous = "";
    for (i = 0; (name = cfns_name(i)); previous = name, i++, count++) {
        if (strcmp(previous, name) > 0) {
            fprintf(stderr, "out of order: %s\n", name);
            return 1;
        }
        if (!generated_lookup(name) || generated_lookup(name) != shipped_lookup(name)) {
            fprintf(stderr, "mismatch for %s\n", name);
            return 1;
        }
    }
    for (i = 0; i < sizeof shipped_names / sizeof shipped_names[0]; i++) {
        name = shipped_names[i];
        if (!shipped_lookup(name) || generated_lookup(name) != shipped_lookup(name)) {
            fprintf(stderr, "missing %s\n", name);
            return 1;
        }
    }
    for (i = 0; i < sizeof absent / sizeof absent[0]; i++) {
        if (shipped_lookup(absent[i]) || generated_lookup(absent[i])) {
            fprintf(stderr, "unexpected entry %s\n", absent[i]);
            return 1;
        }
    }
    if (count != sizeof shipped_names / sizeof shipped_names[0]) {
        fprintf(stderr, "%u entries, gperf has %u\n", count, (unsigned)(sizeof shipped_names / sizeof shipped_names[0]));
        return 1;
    }
    return 0;
}
