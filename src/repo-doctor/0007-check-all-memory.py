# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check that the system has sufficient RAM for development builds."""

import platform


ISSUE_INFORMATION = {
    "title": "Low system memory (RAM)",
    "platform": "All",
    "severity": "WARNING",
    "description": """
This system has very little RAM available. Buck2 builds, especially for large
Rust projects, can be memory-intensive. With less than 4 GiB of total RAM, you
may experience build failures due to out-of-memory conditions, excessive
swapping that makes builds extremely slow, or compiler/linker crashes.

A minimum of 4 GiB of total system RAM is recommended for development.
""".strip(),
    "fix": """
1. Check current memory:
   - Linux: free -h
   - macOS: sysctl hw.memsize

2. If running in a VM or container:
   - Increase the memory allocation to at least 4 GiB
   - For Docker: docker run -m 4g ...
   - For VMs: adjust the VM settings in your hypervisor

3. Reduce memory pressure during builds:
   - Limit parallel build jobs: buck2 build -j2 <target>
   - Close other memory-heavy applications during builds

4. If hardware is constrained and cannot be upgraded:
   - Add swap space (slower but prevents OOM kills)
   - Consider using a remote build environment with more resources
""".strip(),
    "related_links": [
        "https://buck2.build/docs/users/faq/"
    ]
}

# 4 GiB in bytes
MIN_RAM_BYTES = 4 * 1024 * 1024 * 1024


def _get_total_ram():
    """Return total physical RAM in bytes, or None if it cannot be determined."""
    system = platform.system()

    if system == "Linux":
        try:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        # Value is in kB
                        kb = int(line.split()[1])
                        return kb * 1024
        except Exception:
            pass

    if system in ("Linux", "Darwin"):
        import os
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            if pages > 0 and page_size > 0:
                return pages * page_size
        except (ValueError, OSError, AttributeError):
            pass

    if system == "Darwin":
        import subprocess
        try:
            out = subprocess.check_output(
                ["sysctl", "-n", "hw.memsize"],
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            return int(out.strip())
        except Exception:
            pass

    return None


def run_check():
    """
    Check total system RAM.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    total = _get_total_ram()

    if total is None:
        return {
            "name": "System memory",
            "status": "WARNING",
            "message": "Could not determine total system RAM",
            "help_text": "Unable to query system memory. Ensure you have at least 4 GiB.",
        }

    total_gib = total / (1024 ** 3)

    if total >= MIN_RAM_BYTES:
        return {
            "name": "System memory",
            "status": "OK",
            "message": f"{total_gib:.1f} GiB total RAM",
        }
    else:
        return {
            "name": "System memory",
            "status": "WARNING",
            "message": f"Only {total_gib:.1f} GiB total RAM (recommend >= 4 GiB)",
            "help_text": "Consider adding more memory or limiting build parallelism.",
        }
