# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  grepRuntime,
  slimBinutilsUnwrapped,
}:

pkgs.wrapBintoolsWith {
  bintools = slimBinutilsUnwrapped;
  gnugrep = grepRuntime;
}
