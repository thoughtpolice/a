<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Example npm project

`package-lock.json` here is the file `3p-osv` scans in `npm` mode by default.
Nothing installs or builds it: it exists so the npm capability runs against a
real dependency set until the monorepo has npm packages of its own, at which
point `-npm-lock` should point at those instead.

The entries are real. Every version, tarball URL, and integrity hash comes from
`registry.npmjs.org`, and each package was clean in osv.dev when the file was
written. Only direct dependencies are listed rather than a full install
closure, so the file is a valid lockfile shape but not a reproducible install.

Alongside the popular packages it carries one of each entry the scanner has to
classify:

| entry                                            | classification               |
| ------------------------------------------------ | ---------------------------- |
| `""`                                              | local, the root project      |
| `node_modules/zod-v3` (`"name": "zod"`)           | registry, an aliased install |
| `node_modules/@sveltejs/kit/node_modules/cookie`  | registry, a nested install   |
| `node_modules/is-plain-obj` (`git+https://…`)     | non-registry, a git checkout |

Advisories that land against these packages fail the `npm-packages` case, the
same as any other dependency set. Refresh the versions to clear one, or add an
entry to `npmExceptions` in `model.go` when the fix has to wait.
