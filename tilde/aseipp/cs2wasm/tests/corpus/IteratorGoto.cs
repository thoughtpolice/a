// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { static IEnumerable<int> Gen(int n) { int i = 0; again: yield return i; if (++i < n) goto again; }
public static int F(int x) { int s = 0; foreach (var v in Gen(x)) s += v; return s; } }
