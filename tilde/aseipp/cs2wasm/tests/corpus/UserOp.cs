// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public struct V { public int X; public static V operator +(V a, V b) => new V { X = a.X + b.X }; public static bool operator ==(V a, V b) => a.X == b.X; public static bool operator !=(V a, V b) => a.X != b.X; public override bool Equals(object o) => o is V v && v.X == X; public override int GetHashCode() => X; public static V operator ++(V a) => new V { X = a.X + 1 }; }
public static class P { public static int F() { var v = new V { X = 1 }; v++; v += v; return v == new V { X = 4 } ? 1 : 0; } }
