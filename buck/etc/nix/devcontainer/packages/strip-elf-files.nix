# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

previousAttrs: {
  nativeBuildInputs = (previousAttrs.nativeBuildInputs or [ ]) ++ [ pkgs.binutils ];
  postFixup = (previousAttrs.postFixup or "") + ''
    find "$out" -type f -print0 \
      | while IFS= read -r -d $'\0' file; do
        if ${pkgs.binutils}/bin/readelf -h "$file" >/dev/null 2>&1; then
          ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
        fi
    done
  '';
}
