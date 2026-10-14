# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, stripElfFiles }:

(pkgs.iproute2.override {
  db = null;
  elfutils = null;
  iptables = null;
  libbpf = null;
  python3 = null;
}).overrideAttrs
  (
    previousAttrs:
    (stripElfFiles previousAttrs)
    // {
      configureFlags = previousAttrs.configureFlags ++ [ "--libbpf_force=off" ];
    }
  )
