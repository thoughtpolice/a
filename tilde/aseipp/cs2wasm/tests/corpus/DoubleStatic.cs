// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) => (double.IsInteger(x / 2.0) ? 1 : 0) + (double.IsNegative(-0.0) ? 2 : 0) + (int)double.Round(x / 3.0, 1) + (int)double.Floor(1.5) + (int)double.Clamp(x, 0, 4) + (double.IsSubnormal(1e-310) ? 8 : 0) + (int)double.Sqrt(x) + (int)double.Lerp(0, 10, 0.5); }
