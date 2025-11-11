# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check Windows file watching configuration."""

import platform


ISSUE_INFORMATION = {
    "title": "Windows file watching performance optimization",
    "platform": "Windows",
    "severity": "INFO",
    "description": """
While Windows file watching generally works without manual configuration,
performance can be significantly improved by excluding the monorepo directory
from antivirus scanning and search indexing.

Without these optimizations, you may experience:
- Slow build times (can be 2-10x slower)
- High CPU usage from Windows Defender
- Delayed file change detection
- Disk thrashing from indexing service
- General sluggishness in the development environment

These are optional optimizations, but highly recommended for large monorepos.
""".strip(),
    "fix": """
1. Exclude from Windows Defender (highly recommended):
   - Open Windows Security (Start → Settings → Privacy & Security → Windows Security)
   - Click "Virus & threat protection"
   - Under "Virus & threat protection settings", click "Manage settings"
   - Scroll to "Exclusions" and click "Add or remove exclusions"
   - Click "Add an exclusion" → "Folder"
   - Navigate to your monorepo directory and select it
   - Confirm the exclusion

2. Exclude from Windows Search Indexing (recommended):
   - Open "Indexing Options" (Start → search for "Indexing Options")
   - Click "Modify"
   - Uncheck your monorepo directory location
   - Click OK
   - Windows will stop indexing that directory

3. Consider using WSL2 for better performance (optional but recommended):
   - WSL2 provides significantly better I/O performance for development
   - Install WSL2: wsl --install
   - Install Ubuntu or your preferred distribution
   - Clone the monorepo in WSL2 filesystem (~/projects/), NOT Windows filesystem
   - IMPORTANT: Store code in WSL2 filesystem, not /mnt/c/ (Windows drives)
   - Windows filesystem access from WSL2 is much slower
   - Use Windows Terminal to access WSL2
   - Use VS Code with WSL extension for best experience

4. If using WSL2:
   - Access from Windows: \\\\wsl$\\Ubuntu\\home\\username\\projects
   - Mount network drive for easy access
   - Run builds inside WSL2 for best performance
   - Can still use Windows GUI tools via network path

5. Additional optimizations:
   - Disable Windows Search service entirely if not needed:
     services.msc → Windows Search → Disabled
   - Use SSD for source code storage (NVMe preferred)
   - Ensure sufficient RAM (16GB+ recommended, 32GB+ ideal)
   - Close OneDrive sync if repo is in OneDrive folder (or move it out)

6. Verify improvements:
   - Run a Buck2 build before and after exclusions
   - Monitor with Task Manager: CPU and disk usage should be significantly lower
   - Build times should improve by 2-5x in many cases

7. Security considerations:
   - Excluding from Defender means antivirus won't scan that directory
   - Only do this for directories you trust
   - Don't download or run untrusted code in excluded directories
   - Consider re-scanning manually if downloading third-party dependencies
""".strip(),
    "related_links": [
        "https://learn.microsoft.com/en-us/windows/wsl/install",
        "https://learn.microsoft.com/en-us/microsoft-365/security/defender-endpoint/configure-exclusions-microsoft-defender-antivirus",
        "https://code.visualstudio.com/docs/remote/wsl"
    ]
}


def run_check():
    """
    Check Windows file watching configuration.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    if platform.system() != "Windows":
        return {
            "name": "Windows file watching",
            "status": "SKIP",
            "message": "Not applicable on this platform (Windows only)",
        }

    # Windows file watching is generally less problematic than Linux/macOS
    # but there can be issues with antivirus, indexing services, etc.
    return {
        "name": "Windows file watching",
        "status": "OK",
        "message": "No known issues (consider disabling antivirus/indexing for repo directory)",
        "help_text": "For better performance, exclude repo from Defender/indexing and consider WSL2.\n",
    }
