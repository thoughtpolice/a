// SPDX-FileCopyrightText: © 2005-2020 Rich Felker, et al.
// SPDX-License-Identifier: MIT

#include "libm.h"

double __math_xflow(uint32_t sign, double y)
{
	return eval_as_double(fp_barrier(sign ? -y : y) * y);
}
