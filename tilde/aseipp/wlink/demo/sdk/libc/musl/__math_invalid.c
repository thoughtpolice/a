// SPDX-FileCopyrightText: © 2005-2020 Rich Felker, et al.
// SPDX-License-Identifier: MIT

#include "libm.h"

double __math_invalid(double x)
{
	return (x - x) / (x - x);
}
