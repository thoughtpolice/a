/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "getdate.h"

int main(void)
{
    static const struct { const char *text; time_t expected; } cases[] = {
        { "2000-01-01 00:00:00 UTC", 946684800 },
        { "2000-01-01 00:00:00 +0200", 946677600 },
        { "29 February 2000 00:00 UTC", 951782400 },
        { "2 days", 946857600 },
        { "1 hour ago", 946681200 },
        { "this is not a date", -1 },
    };
    time_t now = 946684800;
    unsigned int i;
    tzset();
    for (i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        time_t actual = get_date(cases[i].text, &now);
        if (actual != cases[i].expected) {
            fprintf(stderr, "%s: got %ld, expected %ld\n", cases[i].text,
                    (long)actual, (long)cases[i].expected);
            return 1;
        }
    }
    return 0;
}
