/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdarg.h>
long add_many(int count, ...)
{
    int i;
    long value = 0;
    va_list args;
    va_start(args, count);
    for (i = 0; i < count; ++i) value += va_arg(args, long);
    va_end(args);
    return value;
}
