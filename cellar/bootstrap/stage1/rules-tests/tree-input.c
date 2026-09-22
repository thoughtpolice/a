/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
#include "private.h"
#include <public.h>

int main(void)
{
    return PRIVATE_VALUE + PUBLIC_VALUE != 42;
}
