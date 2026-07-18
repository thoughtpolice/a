# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  slimGlib,
  stripElfFiles,
}:

(pkgs.libsecret.override {
  glib = slimGlib;
  withIntrospection = false;
  withTpm2Tss = false;
  abrmdSupport = false;
}).overrideAttrs
  (
    previousAttrs:
    (stripElfFiles previousAttrs)
    // {
      postInstall = (previousAttrs.postInstall or "") + ''
        rm -rf "$out/bin" "$out/share"
      '';
    }
  )
