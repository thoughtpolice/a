# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, system }:

let
  inherit (pkgs) lib;
  moldTarget =
    {
      aarch64-linux = "ARM64LE";
      x86_64-linux = "X86_64";
    }
    .${system};
in
pkgs.mold-unwrapped.overrideAttrs (previousAttrs: {
  # Build only the native backend, so a native-only development image does
  # not carry every linker backend supported by mold.
  cmakeFlags = (previousAttrs.cmakeFlags or [ ]) ++ [
    (lib.cmakeFeature "MOLD_TARGETS" moldTarget)
  ];
  postFixup = (previousAttrs.postFixup or "") + ''
    ${pkgs.binutils}/bin/strip --strip-unneeded \
      "$out/bin/mold" \
      "$out/lib/mold/mold-wrapper.so"
  '';
})
