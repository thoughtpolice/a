// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) => HashCode.Combine(x, 2) == HashCode.Combine(x, 2) ? 1 : 0; }
