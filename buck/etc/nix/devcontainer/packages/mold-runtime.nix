# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  grepRuntime,
  moldUnwrapped,
}:

pkgs.wrapBintoolsWith {
  bintools = moldUnwrapped;
  gnugrep = grepRuntime;
  extraBuildCommands = ''
    wrap \
      ${pkgs.targetPackages.stdenv.cc.bintools.targetPrefix}ld.mold \
      ${pkgs.path}/pkgs/build-support/bintools-wrapper/ld-wrapper.sh \
      ${moldUnwrapped}/bin/ld.mold
    wrap \
      ${pkgs.targetPackages.stdenv.cc.bintools.targetPrefix}mold \
      ${pkgs.path}/pkgs/build-support/bintools-wrapper/ld-wrapper.sh \
      ${moldUnwrapped}/bin/mold
  '';
}
