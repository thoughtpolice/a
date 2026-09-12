// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Linq;
public static class P { public static int F(int x) { var q = from a in Enumerable.Range(0, 5) from b in Enumerable.Range(0, a) where (a + b) % 2 == x % 2 orderby b descending select a * 10 + b; return q.Aggregate(0, (acc, v) => acc * 3 + v); } }
