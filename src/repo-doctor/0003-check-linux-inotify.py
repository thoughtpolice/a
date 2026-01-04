# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check Linux inotify max_user_watches limit."""

import os
import platform


ISSUE_INFORMATION = {
    "title": "Linux inotify configuration problems",
    "platform": "Linux",
    "severity": "ERROR",
    "description": """
The Linux kernel's inotify file watching system has configuration issues. This could be:
- fs.inotify.max_user_watches value too low (most common)
- /proc/sys/fs/inotify/max_user_watches file not readable
- Permission denied accessing inotify settings
- Kernel doesn't support inotify (very rare)

The inotify system controls how many files can be watched simultaneously. When this
limit is too low or inaccessible, file watching will fail, causing:
- Buck2 builds to not detect file changes
- Development tools to miss file updates
- Hot reload and watch modes to malfunction
- General development workflow breakage

The current monorepo requires at least 128,000 watches to function properly.
""".strip(),
    "fix": """
1. Check current value:
   - cat /proc/sys/fs/inotify/max_user_watches
   - Should show 128000 or higher

2. If value is too low, set temporarily (until reboot):
   - sudo sysctl fs.inotify.max_user_watches=128000

3. Set permanently:

   For NixOS:
   - Add to your configuration.nix:
     boot.kernel.sysctl = {
       "fs.inotify.max_user_watches" = 128000;
     };
   - Rebuild: sudo nixos-rebuild switch

   For other Linux distributions:
   - Create/edit /etc/sysctl.d/99-inotify.conf:
     fs.inotify.max_user_watches=128000
   - Apply: sudo sysctl -p /etc/sysctl.d/99-inotify.conf
   - Or apply all: sudo sysctl --system

4. If file doesn't exist or permission denied:
   - Verify /proc is mounted: mount | grep proc
   - Check kernel support: cat /boot/config-$(uname -r) | grep INOTIFY
   - Should see: CONFIG_INOTIFY_USER=y
   - If in Docker/container: Set limits on host system, not in container
   - If SELinux/AppArmor: Check for denials with ausearch or aa-status

5. Verify the change:
   - cat /proc/sys/fs/inotify/max_user_watches
   - Should show 128000 or higher

6. No reboot required - changes take effect immediately

7. If problems persist:
   - Check dmesg for kernel errors: dmesg | grep -i inotify
   - Verify you're not in a restricted environment
   - Consult your distribution's documentation
""".strip(),
    "related_links": [
        "https://man7.org/linux/man-pages/man7/inotify.7.html",
        "https://buck2.build/docs/users/faq/",
        "https://www.kernel.org/doc/Documentation/security/SELinux.txt"
    ]
}


def get_distro_name():
    """Attempt to detect the Linux distribution name."""
    if platform.system() != "Linux":
        return None

    try:
        if os.path.exists("/etc/os-release"):
            with open("/etc/os-release", "r") as f:
                for line in f:
                    if line.startswith("ID="):
                        return line.split("=")[1].strip().strip('"')
    except Exception:
        pass

    return None


def run_check():
    """
    Check if fs.inotify.max_user_watches is set high enough.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    if platform.system() != "Linux":
        return {
            "name": "inotify max_user_watches",
            "status": "SKIP",
            "message": "Not applicable on this platform (Linux only)",
        }

    try:
        with open("/proc/sys/fs/inotify/max_user_watches", "r") as f:
            current_value = int(f.read().strip())

        MIN_RECOMMENDED = 128000
        distro = get_distro_name()

        if current_value >= MIN_RECOMMENDED:
            return {
                "name": "inotify max_user_watches",
                "status": "OK",
                "message": f"Set to {current_value:,} (>= {MIN_RECOMMENDED:,})",
            }
        else:
            return {
                "name": "inotify max_user_watches",
                "status": "ERROR",
                "message": f"Too low: {current_value:,} (need >= {MIN_RECOMMENDED:,})",
                "help_text": f"Increase fs.inotify.max_user_watches to {MIN_RECOMMENDED} to fix file watching.",
            }

    except FileNotFoundError:
        return {
            "name": "inotify max_user_watches",
            "status": "WARNING",
            "message": "Could not read /proc/sys/fs/inotify/max_user_watches",
            "help_text": "File not found - kernel may not support inotify.",
        }
    except PermissionError:
        return {
            "name": "inotify max_user_watches",
            "status": "WARNING",
            "message": "Permission denied reading inotify settings",
            "help_text": "Permission denied accessing inotify settings.",
        }
    except Exception as e:
        return {
            "name": "inotify max_user_watches",
            "status": "ERROR",
            "message": f"Error checking: {e}",
            "help_text": "Unexpected error checking inotify settings.",
        }
