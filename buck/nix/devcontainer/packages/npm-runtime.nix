# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  bashRuntime,
  nodeBase,
  nodeRuntime,
}:

pkgs.runCommand nodeBase.npm.name { inherit (nodeBase.npm) meta; } ''
  mkdir -p "$out"
  cp -a ${nodeBase.npm}/bin ${nodeBase.npm}/lib "$out/"
  chmod -R u+w "$out"
  rm -rf \
    "$out/lib/node_modules/npm/docs" \
    "$out/lib/node_modules/npm/man"
  find "$out/lib/node_modules/npm" -type f -name '*.orig' -delete

  old_node=${nodeBase}/bin/node
  while IFS= read -r -d $'\0' file; do
    sed -i "s|$old_node|${nodeRuntime}/bin/node|g" "$file"
  done < <(grep -rlZ -F "$old_node" "$out")
  if grep -rF "$old_node" "$out"; then
    exit 1
  fi

  # npm includes a few generated shell helpers alongside its Node entry
  # points. Keep them on the image's stripped Bash output.
  old_bash=${pkgs.bashInteractive}
  while IFS= read -r -d $'\0' file; do
    sed -i "s|$old_bash|${bashRuntime}|g" "$file"
  done < <(grep -rlZ -F "$old_bash" "$out")
  if grep -rF "$old_bash" "$out"; then
    exit 1
  fi
''
