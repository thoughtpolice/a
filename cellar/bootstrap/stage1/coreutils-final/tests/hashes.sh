# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
trap 'echo "coreutils test failed at line $LINENO" >&2' ERR
bin=$1
export PATH="$bin"
printf abc > input
[[ $(md5sum input) == '900150983cd24fb0d6963f7d28e17f72  input' ]]
[[ $(sha1sum input) == 'a9993e364706816aba3e25717850c26c9cd0d89d  input' ]]
[[ $(sha224sum input) == '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7  input' ]]
[[ $(sha256sum input) == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  input' ]]
[[ $(sha384sum input) == 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7  input' ]]
[[ $(sha512sum input) == 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f  input' ]]
for digest in md5sum sha1sum sha224sum sha256sum sha384sum sha512sum; do
 "$digest" input > checksum
 "$digest" -c checksum > checked
 [[ $(cat checked) == 'input: OK' ]]
done
[[ $(cksum input) == '1219131554 3 input' ]]
printf 'a\0b\377c' > binary
base64 binary > encoded
base64 -d encoded > decoded
[[ $(od -An -tx1 decoded | tr -d ' \n') == 610062ff63 ]]
printf 'passed\n' > passed
