// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int a, int b) => (a, b) switch { (1, _) => 1, (_, 2) => 2, _ => 0 }; }
