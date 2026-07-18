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
  # MOLD_TARGETS was added immediately after the locked release. Backport the
  # upstream change so a native-only development image does not carry every
  # linker backend supported by mold.
  patches = (previousAttrs.patches or [ ]) ++ [
    (pkgs.fetchpatch {
      url = "https://github.com/rui314/mold/commit/dce9ac1e5c9165484c39fda2a4abf443871d1f95.patch";
      hash = "sha256-qimLuH9vnhTLvYScqUYklLxkMeVlbSA2UoDK553T2gE=";
    })
  ];
  cmakeFlags = (previousAttrs.cmakeFlags or [ ]) ++ [
    (lib.cmakeFeature "MOLD_TARGETS" moldTarget)
  ];
  postFixup = (previousAttrs.postFixup or "") + ''
    ${pkgs.binutils}/bin/strip --strip-unneeded \
      "$out/bin/mold" \
      "$out/lib/mold/mold-wrapper.so"
  '';
})
