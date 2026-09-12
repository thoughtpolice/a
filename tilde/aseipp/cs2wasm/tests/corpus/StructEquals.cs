// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public struct S { public int X; }
public static class P { public static int F() => new S { X = 1 }.Equals(new S { X = 1 }) ? 1 : 0; }
