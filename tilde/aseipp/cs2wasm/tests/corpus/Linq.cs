// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Linq;
public static class P { public static int F(int x) { int[] a = {1,2,3,x}; return a.Where(v => v > 1).Select(v => v * 2).Sum() + a.Count() + a.Max(); } }
