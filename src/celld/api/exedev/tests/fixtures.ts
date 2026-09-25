// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A throwaway Ed25519 key and signatures made once with OpenSSH, for the
 * token tests. The key signs nothing else and is on no exe.dev account.
 *
 * Generated with OpenSSH's own tools, as the exe.dev docs describe:
 *
 * ```sh
 * ssh-keygen -q -t ed25519 -N '' -C exedev-test-fixture -f key
 * printf '%s' "$PERMISSIONS" > perms.json
 * ssh-keygen -Y sign -f key -n v0@exe.dev perms.json
 * printf '%s' "$VM_PERMISSIONS" > vmperms.json
 * ssh-keygen -Y sign -f key -n v0@fixture-vm.exe.xyz vmperms.json
 * b64url() { tr -d '\n=' | tr '+/' '-_'; }
 * echo "exe0.$(base64 < perms.json | b64url).$(sed '1d;$d' perms.json.sig | b64url)"
 * ```
 *
 * The values below are those files verbatim. Ed25519 signatures are
 * deterministic, so minting the same payload with this key must reproduce
 * these tokens byte for byte.
 *
 * @module
 */

/** `key`: the unencrypted OpenSSH private key. */
export const PRIVATE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACC4fgG13Z4+ux2HldkDa3VTx0uEHIMDSYSwFJYnL042CAAAAJjeF3Ka3hdy\nmgAAAAtzc2gtZWQyNTUxOQAAACC4fgG13Z4+ux2HldkDa3VTx0uEHIMDSYSwFJYnL042CA\nAAAECt2vGc9ybMzAyv1+MwpiRYY9OrMV8NugiGdQyyR0vydLh+AbXdnj67HYeV2QNrdVPH\nS4QcgwNJhLAUlicvTjYIAAAAE2V4ZWRldi10ZXN0LWZpeHR1cmUBAg==\n-----END OPENSSH PRIVATE KEY-----\n";

/** `key.pub`. */
export const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILh+AbXdnj67HYeV2QNrdVPHS4QcgwNJhLAUlicvTjYI exedev-test-fixture";

/** `ssh-keygen -lf key.pub`. */
export const FINGERPRINT = "SHA256:/5702PjT/lCqUsfXCq+uxEWBonTQO0Jhz22hFZ/P3ro";

/** `perms.json`, signed in namespace `v0@exe.dev`. */
export const PERMISSIONS =
  '{"exp":4102444799,"cmds":["ls","whoami","ssh fixture-vm"],"ctx":{"role":"ci"}}';

/** `perms.json.sig`. */
export const SIGNATURE =
  "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAguH4Btd2ePrsdh5XZA2t1U8dLhB\nyDA0mEsBSWJy9ONggAAAAKdjBAZXhlLmRldgAAAAAAAAAGc2hhNTEyAAAAUwAAAAtzc2gt\nZWQyNTUxOQAAAECq+rK+CaFFN4evE8dJx2rMRhwl7NTkVWToWH0/bw/hlMWdoX6lqaCT9c\nZJTZ3s2a16egb0Ufuf7YjHWOb/gmgK\n-----END SSH SIGNATURE-----\n";

/** The exe0 token assembled from them as the docs do. */
export const TOKEN =
  "exe0.eyJleHAiOjQxMDI0NDQ3OTksImNtZHMiOlsibHMiLCJ3aG9hbWkiLCJzc2ggZml4dHVyZS12bSJdLCJjdHgiOnsicm9sZSI6ImNpIn19.U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAguH4Btd2ePrsdh5XZA2t1U8dLhByDA0mEsBSWJy9ONggAAAAKdjBAZXhlLmRldgAAAAAAAAAGc2hhNTEyAAAAUwAAAAtzc2gtZWQyNTUxOQAAAECq-rK-CaFFN4evE8dJx2rMRhwl7NTkVWToWH0_bw_hlMWdoX6lqaCT9cZJTZ3s2a16egb0Ufuf7YjHWOb_gmgK";

/** The VM of the VM-scoped token. */
export const VM_NAME = "fixture-vm";

/** `vmperms.json`, signed in namespace `v0@fixture-vm.exe.xyz`. */
export const VM_PERMISSIONS = '{"ctx":{"user":"alice"}}';

/** `vmperms.json.sig`. */
export const VM_SIGNATURE =
  "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAguH4Btd2ePrsdh5XZA2t1U8dLhB\nyDA0mEsBSWJy9ONggAAAAVdjBAZml4dHVyZS12bS5leGUueHl6AAAAAAAAAAZzaGE1MTIA\nAABTAAAAC3NzaC1lZDI1NTE5AAAAQJqIe/FpYuleiZ9NAW+Lhncvmu7fpw0WTI01PRWJj3\nqTtl7rs1rrwDko9ogwYbtw6ZnxMKTZ4wHW6csV0bjKLw0=\n-----END SSH SIGNATURE-----\n";

/** The VM-scoped exe0 token. */
export const VM_TOKEN =
  "exe0.eyJjdHgiOnsidXNlciI6ImFsaWNlIn19.U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAguH4Btd2ePrsdh5XZA2t1U8dLhByDA0mEsBSWJy9ONggAAAAVdjBAZml4dHVyZS12bS5leGUueHl6AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5AAAAQJqIe_FpYuleiZ9NAW-Lhncvmu7fpw0WTI01PRWJj3qTtl7rs1rrwDko9ogwYbtw6ZnxMKTZ4wHW6csV0bjKLw0";
