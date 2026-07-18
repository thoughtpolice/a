# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, stripElfFiles }:

(pkgs.procps.override {
  # Unit-name columns are not useful without systemd as PID 1. Avoid linking
  # every procps utility to libsystemd and its runtime closure.
  withSystemd = false;
}).overrideAttrs
  (
    previousAttrs:
    (stripElfFiles previousAttrs)
    // {
      configureFlags = (previousAttrs.configureFlags or [ ]) ++ [ "--disable-nls" ];
      postInstall = (previousAttrs.postInstall or "") + ''
        rm -rf "$out/include" "$out/lib/pkgconfig" "$out/share"
      '';
    }
  )
