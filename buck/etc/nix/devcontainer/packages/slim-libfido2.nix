# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  libudevRuntime,
  stripElfFiles,
}:

(pkgs.libfido2.override {
  udev = libudevRuntime;
}).overrideAttrs
  (
    previousAttrs:
    (stripElfFiles previousAttrs)
    // {
      postInstall = (previousAttrs.postInstall or "") + ''
        # OpenSSH links only libfido2.so. Its standalone utilities, static
        # archive, and host udev rules are not useful inside the container.
        rm -rf "$out/bin" "$out/etc"
        rm -f "$out/lib/libfido2.a"
      '';
    }
  )
