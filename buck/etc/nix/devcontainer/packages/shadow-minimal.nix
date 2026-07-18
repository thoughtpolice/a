# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, stripElfFiles }:

(pkgs.shadow.override {
  pam = null;
  withLibbsd = false;
  withTcb = false;
}).overrideAttrs
  (
    previousAttrs:
    (stripElfFiles previousAttrs)
    // {
      configureFlags = previousAttrs.configureFlags ++ [ "--disable-nls" ];
      postInstall = (previousAttrs.postInstall or "") + ''
        rm -rf "$out/share/locale"
      '';
    }
  )
