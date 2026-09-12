// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { var a = new int[2, 3]; a[1, 2] = x; return a[1, 2] + a.GetLength(1) + a.Length; } }
