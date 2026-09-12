// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P {
  static void Inc(ref int v) => v++;
  public static int F(int x) {
    int seen = x;
    Inc(ref seen);
    try { throw new InvalidOperationException(); }
    catch (Exception) when (seen > 0) { return seen; }
  }
}
