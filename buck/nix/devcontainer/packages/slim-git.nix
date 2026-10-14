# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  bashRuntime,
  gawkRuntime,
  grepRuntime,
  sedRuntime,
  slimCurl,
}:

(pkgs.gitMinimal.override {
  bash = bashRuntime;
  curl = slimCurl;
  gawk = gawkRuntime;
  gnugrep = grepRuntime;
  gnused = sedRuntime;
  nlsSupport = false;
  doInstallCheck = false;
}).overrideAttrs
  (previousAttrs: {
    nativeBuildInputs = (previousAttrs.nativeBuildInputs or [ ]) ++ [ pkgs.binutils ];
    makeFlags = (previousAttrs.makeFlags or [ ]) ++ [
      "CFLAGS=-Os -ffunction-sections -fdata-sections -flto=1"
      "LDFLAGS=-Wl,--gc-sections -flto=1"
      "AR=${pkgs.stdenv.cc.cc}/bin/gcc-ar"
      "NM=${pkgs.stdenv.cc.cc}/bin/gcc-nm"
      "RANLIB=${pkgs.stdenv.cc.cc}/bin/gcc-ranlib"
    ];
    separateDebugInfo = false;
    postFixup = (previousAttrs.postFixup or "") + ''
      # NO_GETTEXT hardcodes the English fallthrough implementation, but the
      # patched shell helper otherwise retains an unreachable gettext path.
      substituteInPlace "$out/libexec/git-core/git-sh-i18n" \
        --replace-fail '${pkgs.gettext}' /nonexistent

      # guiSupport=false already omits the entry points. Discard the remaining
      # payload, and represent Git's duplicate hardlinks as relative symlinks so
      # NAR and OCI serialization do not store full copies of each executable.
      rm -rf "$out/share/git-gui" "$out/share/gitk"
      rm -f \
        "$out/bin/git-http-backend" \
        "$out/bin/git-shell" \
        "$out/bin/scalar" \
        "$out/libexec/git-core/git-citool" \
        "$out/libexec/git-core/git-daemon" \
        "$out/libexec/git-core/git-gui--askpass" \
        "$out/libexec/git-core/git-gui--askyesno" \
        "$out/libexec/git-core/git-http-backend" \
        "$out/libexec/git-core/git-imap-send" \
        "$out/libexec/git-core/git-shell" \
        "$out/libexec/git-core/scalar"
      rm "$out/bin/git"
      ln -s ../libexec/git-core/git "$out/bin/git"

      find "$out" -type f -print0 \
        | while IFS= read -r -d $'\0' file; do
          if ${pkgs.binutils}/bin/readelf -h "$file" >/dev/null 2>&1; then
            ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
          fi
        done
    '';
  })
