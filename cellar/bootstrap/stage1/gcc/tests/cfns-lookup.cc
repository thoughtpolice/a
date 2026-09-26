/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compile one cfns.h inside a namespace and export its lookup. CFNS_NAMESPACE
 * selects the shipped gperf header or the regenerated table.
 */
#include <string.h>

namespace CFNS_NAMESPACE {
#include "cfns.h"
}

extern "C" int CFNS_LOOKUP(const char *name)
{
    const CFNS_NAMESPACE::libc_name_struct *entry =
        CFNS_NAMESPACE::libc_name::libc_name_p(name, strlen(name));
    return entry ? entry->c_ver : 0;
}

#ifdef CFNS_TABLE
extern "C" const char *cfns_name(unsigned i)
{
    return i < sizeof CFNS_NAMESPACE::libc_name_table / sizeof CFNS_NAMESPACE::libc_name_table[0]
               ? CFNS_NAMESPACE::libc_name_table[i].name
               : 0;
}
#endif
