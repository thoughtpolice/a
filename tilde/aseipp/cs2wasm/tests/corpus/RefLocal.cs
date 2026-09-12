// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { int[] a = {1,2}; ref int r = ref a[1]; r = x; int y = 3; ref int q = ref y; q++; return a[1] + y; } }
