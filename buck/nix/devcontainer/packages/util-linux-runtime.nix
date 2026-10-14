# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

let
  inherit (pkgs) lib;
  utilLinuxBin = lib.getBin pkgs.util-linuxMinimal;
in
pkgs.runCommand "util-linux-minimal-${pkgs.util-linuxMinimal.version}-bin"
  {
    nativeBuildInputs = [ pkgs.binutils ];
    inherit (pkgs.util-linuxMinimal) meta;
    passthru.version = pkgs.util-linuxMinimal.version;
  }
  ''
    cp -a ${utilLinuxBin}/. "$out/"
    chmod -R u+w "$out"

    # Rebuilding util-linux merely to strip its binaries also changes its
    # library-output store path, duplicating a library already retained by
    # GLib and wget. Copy and strip the stock bin output while preserving its
    # shared library references. eject embeds its own prefix, so rewrite that
    # equal-length store path before severing the original bin output.
    test "$(printf %s ${utilLinuxBin} | wc -c)" \
      -eq "$(printf %s "$out" | wc -c)"
    find "$out" -type f -print0 \
      | while IFS= read -r -d $'\0' file; do
        if grep -aF ${utilLinuxBin} "$file" >/dev/null; then
          sed -i "s|${utilLinuxBin}|$out|g" "$file"
        fi
        if readelf -h "$file" >/dev/null 2>&1; then
          strip --strip-unneeded "$file"
        fi
      done
    if grep -R -a -F ${utilLinuxBin} "$out"; then
      exit 1
    fi
  ''
