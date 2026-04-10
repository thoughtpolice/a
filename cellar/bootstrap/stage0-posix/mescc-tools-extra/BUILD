load(":defs.bzl", "create_all")

# mescc-tools-extra is compiled with M2-Mesoplanet, producing native binaries
# for the host architecture. The select() and target_compatible_with logic
# lives in defs.bzl because the cellar cell's noprelude shim overrides the
# built-in select() in BUILD files.
create_all(glob(["*.c"]))
