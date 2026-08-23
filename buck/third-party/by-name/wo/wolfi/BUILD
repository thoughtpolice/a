# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":wolfi.bzl", "wolfi_apks")

shims.python_binary(
    name = "update",
    base_module = "",
    main = "update.py",
    visibility = ["PUBLIC"],
)

# The test does a plain 'import update', so the module has to land at the root
# of the package rather than under the default by-name/wo/wolfi base module.
shims.python_library(
    name = "update-lib",
    srcs = ["update.py"],
    base_module = "",
)

shims.python_binary(
    name = "update-test",
    base_module = "",
    main = "update_test.py",
    deps = [":update-lib"],
)

shims.run_test(
    name = "test-update",
    dep = ":update-test",
)

# Pinned Wolfi packages: {package: (version, sha256 of the .apk)}.
# Grouped by consumer; the groups are documentation only — every pin
# becomes a `<package>.apk` target. See wolfi.bzl for the refresh story.

# The minimos base layer (src/images/minimos): systemd + dbus + the
# exe.dev boot contract's shells and mount tools, plus the shared
# libraries they link or dlopen.
MINIMOS_BASE = {
    "bash": ("5.3-r12", "04db98c81192d3a52ece091fac002d5abd1bae97b43ef042c80196b7a9f8cc36"),
    "ca-certificates-bundle": ("20260413-r1", "355058d6dd75143315159800147cc778e1305bd7202b36dca57b2c9c12766bfe"),
    "dash": ("0.5.13.5-r0", "7ecdc997a8228e3354cf46f6226968e37b3de0458af59d334733122acdfa19db"),
    "dbus": ("1.16.2-r5", "2fbec887c9fa27c9810e2752284abf19f93fcd4baddac5509c8496bb9f174687"),
    "dbus-libs": ("1.16.2-r5", "40c4d6e64bd4e19a5e2217f469b9ac66bf2d7d82837ae7b5ff3adb08cb1fea1d"),
    "glibc": ("2.43-r13", "495a506a1630939614ac7aa98cc63af8b76762ee981864310b800374ef1652cd"),
    "glibc-locale-posix": ("2.43-r13", "5b28c532c3d2af5e8086da69ece4277ef2e0958f4576805aebd25474240a60c2"),
    "ld-linux": ("2.43-r13", "f49b25afb455a17c0a6335bc97ade76be8b7b0674354a21b12d95a3a4e63e219"),
    "libacl1": ("2.4.0-r2", "5c90bbed522e68f58a187869bf625bdd65a9aa0e2861f31965a08d3972c864cd"),
    "libaudit": ("4.2.1-r0", "62cd1c8939e454af76e11d2c3b70da429424649d619364fed9f943a867b68826"),
    "libblkid": ("2.42.2-r3", "2daf511003e21f43d081bd79eba2cafa44943f7ac657604cf35efae53af7e491"),
    "libcap-ng": ("0.9.5-r1", "ea7381e8f562238bd3c7216ae2f0877741145c14fd9a3ab139d7522325498120"),
    "libexpat1": ("2.8.3-r0", "baa1f2845d7f1a52b2b7685b7560287bf8a433ca8961181ae463a0150c63c445"),
    "libgcc": ("16.2.0-r0", "49a3a96bfe09a0920c3db46d5bb5118870674a4f3a603d228d355a238cacecee"),
    "liblz4-1": ("1.10.0-r9", "afe5b234bf1723224d07cdddf5b6dc39e9deda91987c0300c5aaf2515bd43030"),
    "libmount": ("2.42.2-r3", "be888e1e6a30e8b6cb3516c7f8396809a028d17db78169d281ddd2fb83b58c3e"),
    "libpcre2-8-0": ("10.47-r0", "579084d2b3f53f6f7224f5eb0e050fbbd01e7a535bdf50551cf51eb74e29b8aa"),
    "libseccomp": ("2.6.1-r0", "23cd1145d43c626a2ecbea66e1a1c3310d4825284078054d035f58fa761e5337"),
    "libselinux": ("3.11-r0", "6a03897e1a50cfea06e8575c532591e0e39b8f966797ca2532d08c165aab1606"),
    "libsepol": ("3.11-r0", "d8ff742c93586933f063b2cec5208fd143681f79cff1ba617d39de04e822d5e2"),
    "libsystemd": ("261.2-r1", "3b479b164cd8f857e695db9cf9fa7ed016703b0614594d621bd4ca1179360ef7"),
    "libsystemd-shared": ("261.2-r1", "c09de561eea8c57c1ee1fad77d27ed6da34245e7d0c777a9277b3ee35c76c66a"),
    "libzstd1": ("1.5.7-r8", "c69353cfdd6d47169a53333be562384f28ad596027a63fc9630802396da007b2"),
    "mount": ("2.42.2-r3", "4aa458c8fa2f301c38991e0e510339f8a281e96a86f3a85aeb1acae0eaa0f523"),
    "ncurses": ("6.6.20260822-r0", "d4314e5d0aab7983435ebfcc1450b49bb2e6d1eed72c37971932310f4216048a"),
    "ncurses-terminfo-base": ("6.6.20260822-r0", "f88090170563cdadd687aca27fa5a03c31d574c81d7f5e255485644813e748ba"),
    "systemd": ("261.2-r1", "5cb9494726a9ba51df2092f33816cd23facbc833e1e5bc681a3912955920213d"),
    "systemd-logind-service": ("261.2-r1", "c430cb1279daa8c2fc9a2f76ade5573c0534244b2e8f60c34902efde7aebdd76"),
    "systemd-systemctl": ("261.2-r1", "ef2d17d01c5c399ec979559b4921bf3ad0bb63d55df42e67525712851378aa0f"),
    "umount": ("2.42.2-r3", "ffd03f00f78fb37e8f9d0cd755f4c3d5e87600127c664021b34d5c3c807f6a15"),
    "util-linux-login": ("2.42.2-r3", "5fc7ef2f17130627adbfde54a6bccfc4a5ed59a9fd09e667e240539fdeaa0255"),
    "wolfi-baselayout": ("20230201-r29", "c7aef94f6c8e3060cac5a6b1dfa6257ad0d2d4d0a6ff93d02bba26e0ea518457"),
}

# TLS libraries shared by the minimos example services.
CRYPTO = {
    "libcrypto3": ("3.6.3-r5", "17a61ce7da5caee3ad5c530e26c4b93561f9a3ead7d1ce488637f834894b79c4"),
    "libssl3": ("3.6.3-r5", "4121585f3eeb673a783f5f0b57632b7ada358232960b9cb15edbd12738c5111f"),
}

# minimos example: valkey.
VALKEY = {
    "valkey": ("8.1.2-r0", "e316c0b3c704f7aa470a135c053f140bd6ce1f6204dcedd855c98f68cbc212b6"),
    # The server package ships only valkey-server (+symlinks); the CLI —
    # the image's in-VM verification tool — is its own package.
    "valkey-cli": ("8.1.2-r0", "e61c8f3bbd42cca24f1bbedce0d293d0488405930a891c15bc57663e90d55302"),
}

# minimos example: memcached. libsasl2 itself only needs libc — the
# krb5/gdbm/sqlite tails hang off SASL plugins the cull never keeps.
MEMCACHED = {
    "cyrus-sasl-mit-libs": ("2.1.28-r1", "5ccce3a075b97798b805b309e5728db7f880c80c1652a14f233c8fb865bb4545"),
    "libevent": ("2.1.13-r0", "d02c787923cbf496ce7bc7863b14dbf0e24d2e19b3542075547b72c66c4976e2"),
    "memcached": ("1.6.45-r2", "5c95485ebbfefde06e4e826f660df73e913dd4259571fb47080565adfb8af014"),
}

# minimos example: nginx. libxcrypt, not the empty libcrypt1
# transition package, is what actually ships libcrypt.so.1.
NGINX = {
    "libxcrypt": ("4.5.2-r4", "08fcbcec72ef514e48d6bffc1348e02d9a4763f2a26be59da4b4e2a6ec973b5d"),
    "nginx-mainline": ("1.31.4-r0", "391acd98a0d35be30f544c13fb29e4e35c8884a57048865983b741a0dd5d24d5"),
    "nginx-mainline-mime-types": ("1.31.4-r0", "6c35967b5e4b4d1edd6633b8810a81c91643ef755e5a79ffe5b19944382ec89e"),
    "zlib": ("1.3.2-r4", "421dfb6b878c9b8453fdf5e73a830eba29a8fb06260c69e39592759326212166"),
}

# minimos dev/agent images (src/images/minimos/examples/dev): an
# interactive userland — coreutils and friends, git, jq, ripgrep —
# plus the runtime libraries they link. GNU tar is packaged as
# "gnutar"; the krb5/ldap/sasl/gdbm/sqlite tail hangs off Wolfi's
# libcurl, which is built with GSSAPI and LDAP support.
DEVTOOLS = {
    # bwrap is the sandbox launcher Codex (and other agents) use for
    # command execution; it works unprivileged because minimos keeps
    # user namespaces enabled.
    "bubblewrap": ("0.11.2-r0", "92e4644298be253e29f66793e087b5c77e569a6dd39b7d3238302508874a427d"),
    "coreutils": ("9.11-r3", "8c4fa14bd0f057ab22e7089a842b7f57a15acf34ec4c63488660c0e05fac22a7"),
    "curl": ("8.21.0-r2", "83b6bd81a592643796229ff516748e2cc9980ab93f76770fcfea42f86412ec63"),
    "diffutils": ("3.12-r6", "59f5a44cc11c3a88c4ac587748758ab2416247056b4dee5d7ab319b5031711d4"),
    "findutils": ("4.11.0-r1", "28c342bc2d3bf10b23e6de8544bdcb16fe0d7387ffc57d89391716df051cea88"),
    "gawk": ("5.4.1-r0", "2b2d4389aa720ce3baf6d8889fc2589d207828318e55552ba6469c822b6ed392"),
    "gdbm": ("1.26-r5", "0f349182ec9d27fb409642da2171ac9b709075f2086e9a8b34ac32d02f87eedb"),
    "git": ("2.55.0-r4", "8abd79c3afd70632e1255bce70b7ee8c9214cc4531131291bb430280b65ab884"),
    "gnutar": ("1.35-r11", "215d27a7eb59adea92a177d8200e233246ce3d11b9223de396da26e165537d1f"),
    "grep": ("3.12-r7", "ebe5686e11f2f0d1825b94d7a411a82b2d8d912ebaa33f29a70febe4be32e5b3"),
    "gzip": ("1.14-r8", "94fdaa7360019856611322c179f0c32cdcca7824f6d764c94f3588db7b919391"),
    "jq": ("1.8.2-r1", "52fb174001c73244cdfffb0b1bd7fa00276bf3a086b026ffc97ea363e29ca530"),
    "keyutils-libs": ("1.6.3-r39", "a24f381476c14c21b69d4ce9d2604a88c539d89d9a797406a8c029a9f51aa9b9"),
    "krb5-libs": ("1.22.2-r2", "aca1e742c46bb25b18a729183be16f09a95aeb5bc64a863354b6ba362e13171f"),
    "less": ("709-r0", "b156804f8151b86c47487bf8725eacae2b879a49f3b50495b80e5c36d400fd17"),
    "libattr1": ("2.6.0-r2", "e410602d23eb15a636c0aa218669c1588c7ff0481589be2ae26d16461af2e6f9"),
    "libbrotlicommon1": ("1.2.0-r3", "49dbcc31d5126eece677200ef3c777be224c493ea4cd7a03cf3d36e27e9715f8"),
    "libbrotlidec1": ("1.2.0-r3", "1031104cad23db551bd510baf7fa0f9b419dfef9f7947eba2d6ec3f23528cddc"),
    # The apk metadata says libpam, but that's pam_cap.so; the culled
    # layer only ever keeps libcap.so.2, which needs nothing but libc.
    "libcap": ("2.78-r2", "ff51c2e9cbf1aa933d7661ada364d53ba26e4c09e2603a2700d79a69306e7e04"),
    "libcom_err": ("1.47.4-r1", "b2b7020631a41f6ce01c34d0ea9b839d860c42356e23b026c9fb84f8332a478c"),
    "libcurl-openssl4": ("8.21.0-r2", "72e5f29625e9226ca8cee202d81a35c418bc356da2d66dc56772e3032582bcfa"),
    "libidn2": ("2.3.8-r8", "8570420f03521d3ed026f3ef988bab340f91ffe406826c1a638478207058a515"),
    "libldap": ("2.6.10-r5", "140df3743ee774109bec62bf0531321d2fbb501327cfbd855ab5a535ce3c4c90"),
    "libnghttp2-14": ("1.70.0-r2", "6218d0c490d7310694c161d78b4f9ab2d4a2d743408a8e6b26cad9cc02ff21bd"),
    "libproc-2-0": ("4.0.7-r0", "e635846cee44d3d96195af13a6fd6df4a27fd60954b230bc3b11712ecc260d8a"),
    "libpsl": ("0.23.3-r0", "4d50e3b3c03962109885bb47f9239d17854d35b2a6fda0eda3032323b74c5c29"),
    "libunistring": ("1.4.2-r2", "7923969e5333292e479263b39f3fa9b2f40eea3b759fb1f5b58db78eb0735fc0"),
    "libverto": ("0.3.2-r7", "7761dbf3d9520eb5d5acf5c88a2f2a625f4566e3ee7ae46ada397023af6cb555"),
    "nghttp3": ("1.18.0-r0", "bc0dbc34ae1e52ba3cd43b93f3b4b7d369f4b0317589299dae1bd0c3b0977310"),
    "ngtcp2": ("1.25.0-r1", "8d4af514ca52379fac1f754b25bd2c9f60a1c76910ab7037a1f8e8f55e1748be"),
    "oniguruma": ("6.9.10-r4", "1e400831160d9e97a8542d44ecc54a6bd2c8aaa5e60cd20b1c9477e2a67b6e43"),
    "patch": ("2.8-r8", "d115934beb53344ff602353f8d63bd33a4cc043ccb430d7f43d360a3ab776e74"),
    "procps": ("4.0.7-r0", "2c8f8dd8508e1a30506c59cef7de1a43da731a5ce1376d1db642c678e88f608a"),
    "ripgrep": ("15.2.0-r2", "2e5a61f1341d2ea6b25ff2090ec25717624a5d31d8b205bd6486a7e491615ae7"),
    "sed": ("4.10-r1", "64f97fb24d76be3d835114b93ef77385c82a8f3b432a775ed72394e86171f28c"),
    "sqlite-libs": ("3.53.4-r0", "09010a1a174b03b3f73ee13d22a1b5399796a9aaa9be53a18d8a045bebd4e499"),
    "xz": ("5.8.3-r2", "4dd47f59b1b32b1ba9d7b6007421153f13fbf6a75dba320637371da361cd742c"),
}

wolfi_apks(MINIMOS_BASE)

wolfi_apks(CRYPTO)

wolfi_apks(VALKEY)

wolfi_apks(MEMCACHED)

wolfi_apks(NGINX)

wolfi_apks(DEVTOOLS)
