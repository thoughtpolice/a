// SPDX-FileCopyrightText: © 2005-2020 Rich Felker, et al.
// SPDX-License-Identifier: MIT

#include <math.h>

double ldexp(double x, int n)
{
	return scalbn(x, n);
}
