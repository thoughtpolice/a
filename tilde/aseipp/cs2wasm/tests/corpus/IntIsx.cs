// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) => (int.IsPow2(x) ? 1 : 0) + (int.IsEvenInteger(x) ? 2 : 0) + (int.IsNegative(x) ? 4 : 0) + int.LeadingZeroCount(x) + int.TrailingZeroCount(x) + int.RotateLeft(x, 3); }
