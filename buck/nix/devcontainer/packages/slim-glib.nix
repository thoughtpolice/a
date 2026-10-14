# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, stripElfFiles }:

(pkgs.glib.override {
  withIntrospection = false;
}).overrideAttrs
  (
    previousAttrs:
    (stripElfFiles previousAttrs)
    // {
      mesonFlags = (previousAttrs.mesonFlags or [ ]) ++ [
        # GLib's optimized charset-alias lookup stores overlapping fragments
        # of this path in libglib. With a Nix-store libdir, the reference
        # scanner mistakes one fragment for a differently named store path,
        # which replaceDependencies cannot rewrite. The image ships no
        # charset.alias file, so use its conventional non-store location.
        "-Dcharsetalias_dir=/usr/lib"
        "-Ddtrace=disabled"
        "-Dnls=disabled"
        "-Dsystemtap=disabled"
        "-Dtests=false"
      ];
      postInstall = (previousAttrs.postInstall or "") + ''
        rm -rf "$out/share/locale"
      '';
    }
  )
