// SPDX-FileCopyrightText: © 2005-2020 Rich Felker, et al.
// SPDX-License-Identifier: MIT

#include "libm.h"

double __math_uflow(uint32_t sign)
{
	return __math_xflow(sign, 0x1p-767);
}
