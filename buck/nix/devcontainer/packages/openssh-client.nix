# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  slimLibfido2,
  stripElfFiles,
}:

(pkgs.openssh.override {
  libfido2 = slimLibfido2;
  withLdns = false;
  withPAM = false;
}).overrideAttrs
  (
    previousAttrs:
    (stripElfFiles previousAttrs)
    // {
      doInstallCheck = false;
      postInstall = (previousAttrs.postInstall or "") + ''
        rm -f \
          "$out/bin/sshd" \
          "$out/libexec/sshd-auth" \
          "$out/libexec/sshd-session" \
          "$out/libexec/sftp-server" \
          "$out/etc/ssh/moduli" \
          "$out/etc/ssh/sshd_config"
      '';
    }
  )
