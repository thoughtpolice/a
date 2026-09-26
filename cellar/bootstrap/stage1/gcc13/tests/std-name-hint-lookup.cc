/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compile one std-name-hint.h inside a namespace and export its lookup.
 * HINT_NAMESPACE selects the shipped gperf header or the regenerated table.
 */
#include <stddef.h>
#include <string.h>

namespace HINT_NAMESPACE {
enum cxx_dialect { cxx_unset, cxx98, cxx11, cxx14, cxx17, cxx20, cxx23 };
#include "std-name-hint.h"
}

extern "C" int HINT_LOOKUP(const char *name, const char **header)
{
    const HINT_NAMESPACE::std_name_hint *entry =
        HINT_NAMESPACE::std_name_hint_lookup::find(name, strlen(name));
    if (!entry)
        return 0;
    *header = entry->header;
    return entry->min_dialect;
}

#ifdef HINT_TABLE
extern "C" const char *hint_name(unsigned i)
{
    return i < sizeof HINT_NAMESPACE::std_name_hint_lookup_table / sizeof HINT_NAMESPACE::std_name_hint_lookup_table[0]
               ? HINT_NAMESPACE::std_name_hint_lookup_table[i].name
               : 0;
}
#endif
