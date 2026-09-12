// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) => int.Abs(x) + int.Max(x, 3) + int.Min(x, 2) + int.Clamp(x, 0, 5) + int.Sign(x) + int.Log2(x) + int.PopCount(x) + (int)long.Abs(x) + (int)double.Abs(x) + (int)float.Max(1f, 2f); }
