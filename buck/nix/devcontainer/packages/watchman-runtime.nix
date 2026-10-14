# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  slimBoost,
  slimWatchman,
}:

pkgs.runCommand "devcontainer-watchman-${slimWatchman.version}"
  {
    nativeBuildInputs = [
      pkgs.binutils
      pkgs.patchelf
      pkgs.removeReferencesTo
    ];
    inherit (slimWatchman) meta;
    passthru.version = slimWatchman.version;
  }
  ''
    install -Dm755 ${slimWatchman}/bin/watchman "$out/bin/watchman"
    install -Dm755 ${pkgs.edencommon}/lib/libedencommon_utils.so \
      "$out/lib/libedencommon_utils.so"
    folly_file="$(readlink -f ${pkgs.folly}/lib/libfolly.so)"
    install -Dm755 "$folly_file" "$out/lib/$(basename "$folly_file")"

    # Folly and edencommon link only a small subset of Boost's runtime
    # libraries. Copy those SONAMEs instead of retaining Boost's 54-library
    # output, including its development-only static archives.
    for elf in "$out/bin/watchman" "$out/lib/"*.so*; do
      patchelf --print-needed "$elf"
    done | grep '^libboost_.*\.so' | sort -u \
      | while read -r library; do
        install -Dm755 ${slimBoost}/lib/"$library" \
          "$out/lib/$library"
      done

    for elf in "$out/bin/watchman" "$out/lib/"*.so*; do
      old_rpath="$(patchelf --print-rpath "$elf")"
      new_rpath="$(printf '%s' "$old_rpath" | sed \
        -e 's#${pkgs.edencommon}/lib#$ORIGIN/../lib#g' \
        -e 's#${pkgs.folly}/lib#$ORIGIN/../lib#g' \
        -e 's#${pkgs.boost}/lib#$ORIGIN/../lib#g' \
        -e 's#${slimBoost}/lib#$ORIGIN/../lib#g')"
      if [[ "$elf" == "$out/lib/"* ]]; then
        new_rpath="''${new_rpath//\$ORIGIN\/..\/lib/\$ORIGIN}"
      fi
      patchelf --set-rpath "$new_rpath" "$elf"
    done

    strip --strip-unneeded "$out/bin/watchman" "$out/lib/"*.so*
    for source in \
      ${slimWatchman} \
      ${pkgs.edencommon} \
      ${pkgs.folly} \
      ${pkgs.boost} \
      ${slimBoost}; do
      remove-references-to -t "$source" \
        "$out/bin/watchman" \
        "$out/lib/"*.so*
    done
  ''
