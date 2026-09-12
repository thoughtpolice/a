// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { IEnumerable<int> Gen() { yield return x; yield break; } int s = 0; foreach (var v in Gen()) s += v; return s; } }
