# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check that the filesystem hosting the repo has sufficient free disk space."""

import os
import shutil
from pathlib import Path


ISSUE_INFORMATION = {
    "title": "Low disk space on repository filesystem",
    "platform": "All",
    "severity": "WARNING",
    "description": """
The filesystem where this repository is located is running low on free disk
space. Buck2 builds, artifact caching, and dotslash tool downloads can consume
significant amounts of storage. When disk space is exhausted, builds will fail
with cryptic I/O errors and cached artifacts may become corrupted.

A minimum of 10 GiB of free space is recommended for normal development.
""".strip(),
    "fix": """
1. Check current usage:
   - df -h .

2. Free up space:
   - Remove Buck2 build outputs: buck2 clean
   - Clear dotslash cache: rm -rf ~/.cache/dotslash
   - Remove unused container images or other large artifacts

3. If the disk is genuinely too small, consider:
   - Moving the repository to a larger volume
   - Expanding the current filesystem/partition
   - Using an external drive or network mount with sufficient space

4. After freeing space, re-run doctor.py to verify
""".strip(),
    "related_links": [
        "https://buck2.build/docs/users/faq/"
    ]
}

# 10 GiB in bytes
MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024


def run_check():
    """
    Check free disk space on the filesystem containing the repository.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    repo_root = Path(__file__).resolve().parent.parent.parent

    try:
        usage = shutil.disk_usage(repo_root)
    except Exception as e:
        return {
            "name": "Disk space",
            "status": "WARNING",
            "message": f"Could not determine disk usage: {e}",
            "help_text": "Unable to query filesystem usage for the repository root.",
        }

    free_gib = usage.free / (1024 ** 3)

    if usage.free >= MIN_FREE_BYTES:
        return {
            "name": "Disk space",
            "status": "OK",
            "message": f"{free_gib:.1f} GiB free",
        }
    else:
        return {
            "name": "Disk space",
            "status": "WARNING",
            "message": f"Only {free_gib:.1f} GiB free (recommend >= 10 GiB)",
            "help_text": "Free up disk space or move the repo to a larger volume.",
        }
