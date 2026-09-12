// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { List<int> l = [1, 2, x]; int[] a = [..l, 4]; List<int> m = [..a, ..l]; return a.Length + m.Count; } }
