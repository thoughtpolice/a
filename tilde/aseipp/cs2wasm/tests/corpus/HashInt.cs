// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) => x.GetHashCode() + 5L.GetHashCode() + 'c'.GetHashCode() + true.GetHashCode(); }
