/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every name in either table must give the same header and dialect from
 * both lookups, and names that are absent, prefixes or extensions of entries
 * must fail in both. The regenerated table is sorted for bisection and has as
 * many entries as gperf's word list, which repeats two identical entries.
 */
#include <stdio.h>
#include <string.h>

extern "C" int shipped_lookup(const char *, const char **);
extern "C" int generated_lookup(const char *, const char **);
extern "C" const char *hint_name(unsigned);

static const char *const shipped_names[] = {
#include "shipped-names.h"
};

static int agree(const char *name)
{
    const char *shipped_header, *generated_header;
    int generated = generated_lookup(name, &generated_header);
    return generated && generated == shipped_lookup(name, &shipped_header) &&
           !strcmp(generated_header, shipped_header);
}

int main()
{
    static const char *const absent[] = {
        "", "a", "an", "vecto", "vectors", "string_vie", "numbers::pi_", "cout2", "std", "optional_",
    };
    unsigned i, count = 0;
    const char *name, *previous = "", *header;
    for (i = 0; (name = hint_name(i)); previous = name, i++, count++) {
        if (strcmp(previous, name) > 0) {
            fprintf(stderr, "out of order: %s\n", name);
            return 1;
        }
        if (!agree(name)) {
            fprintf(stderr, "mismatch for %s\n", name);
            return 1;
        }
    }
    for (i = 0; i < sizeof shipped_names / sizeof shipped_names[0]; i++) {
        if (!agree(shipped_names[i])) {
            fprintf(stderr, "missing %s\n", shipped_names[i]);
            return 1;
        }
    }
    for (i = 0; i < sizeof absent / sizeof absent[0]; i++) {
        if (shipped_lookup(absent[i], &header) || generated_lookup(absent[i], &header)) {
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
