# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

(pkgs.binutils-unwrapped.override {
  # LLD and mold cover the alternative-linker use cases. Retain the BFD
  # linker and the ordinary GNU inspection/manipulation tools.
  enableGold = false;
}).overrideAttrs
  (previousAttrs: {
    configureFlags = (previousAttrs.configureFlags or [ ]) ++ [ "--disable-nls" ];
    postInstall = (previousAttrs.postInstall or "") + ''
      # Split-DWARF packaging and gprof are not useful without the deliberately
      # omitted debugger/profiler stack. Keep the ordinary BFD tool suite.
      find "$out" \( -type f -o -type l \) \
        \( -name dwp -o -name gprof \) -delete
    '';
  })
