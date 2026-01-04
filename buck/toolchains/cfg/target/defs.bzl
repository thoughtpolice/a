# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

def get_default_target_triple():
    if host_info().arch.is_aarch64:
        if host_info().os.is_linux: return "aarch64-unknown-linux-gnu"
        elif host_info().os.is_macos: return "aarch64-apple-darwin"
        else: fail('OS not supported')

    elif host_info().arch.is_x86_64:
        if host_info().os.is_linux: return "x86_64-unknown-linux-gnu"
        else: fail('OS not supported')
    else:
        fail('Architecture not supported')
