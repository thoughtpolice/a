// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F() { int[] a = {1,2,3}; Span<int> s = a; s[0] = 9; return a[0] + s.Length; } }
