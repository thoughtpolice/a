// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Numerics;
public static class P { public static int F(uint x) => BitOperations.PopCount(x) + BitOperations.LeadingZeroCount(x) + BitOperations.TrailingZeroCount(x) + (int)BitOperations.RotateLeft(x, 3); }
