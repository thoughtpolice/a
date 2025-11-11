# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check macOS file watching limits."""

import platform
import subprocess


ISSUE_INFORMATION = {
    "title": "macOS file watching limits problems",
    "platform": "macOS",
    "severity": "ERROR",
    "description": """
The macOS system has issues with file descriptor limits for file watching. This could be:
- kern.maxfiles and/or kern.maxfilesperproc values too low (most common)
- Unable to query sysctl values
- sysctl command not available or permission issues

These limits control how many files can be opened simultaneously. When these limits
are too low, you'll experience:
- Buck2 build failures with "too many open files" errors
- Development tools crashing or hanging
- File watching failures
- General instability in development workflows

macOS defaults (typically 12,288 files) are far too low for modern development
workflows, especially with large monorepos that have thousands of source files.
Recommended values are 524,288 or higher.
""".strip(),
    "fix": """
1. Check current limits:
   - sysctl kern.maxfiles
   - sysctl kern.maxfilesperproc
   - Both should be 524288 or higher

2. Create a LaunchDaemon to set limits at boot:

   Create /Library/LaunchDaemons/limit.maxfiles.plist with:

   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
             "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
     <dict>
       <key>Label</key>
       <string>limit.maxfiles</string>
       <key>ProgramArguments</key>
       <array>
         <string>launchctl</string>
         <string>limit</string>
         <string>maxfiles</string>
         <string>524288</string>
         <string>524288</string>
       </array>
       <key>RunAtLoad</key>
       <true/>
       <key>ServiceIPC</key>
       <false/>
     </dict>
   </plist>

3. Set correct permissions:
   - sudo chown root:wheel /Library/LaunchDaemons/limit.maxfiles.plist
   - sudo chmod 644 /Library/LaunchDaemons/limit.maxfiles.plist

4. Load the daemon:
   - sudo launchctl load -w /Library/LaunchDaemons/limit.maxfiles.plist

5. Reboot for changes to take full effect:
   - Some changes may work immediately, but reboot ensures everything is set

6. Verify after reboot:
   - sysctl kern.maxfiles
   - Should show 524288
   - sysctl kern.maxfilesperproc
   - Should show 524288 (or your configured value)

7. Alternative for per-session (temporary, not recommended):
   - sudo launchctl limit maxfiles 524288 524288
   - This only lasts until next reboot

8. If sysctl command not found:
   - Verify PATH includes /usr/sbin: echo $PATH
   - Try with full path: /usr/sbin/sysctl kern.maxfiles
   - Check system integrity: sudo /usr/libexec/repair_packages --verify --standard-pkgs

9. If running in VM or container:
   - These limits may need to be set on the host system
   - Consult your virtualization platform's documentation
""".strip(),
    "related_links": [
        "https://wilsonmar.github.io/maximum-limits/",
        "https://buck2.build/docs/users/faq/",
        "https://ss64.com/osx/sysctl.html"
    ]
}


def run_check():
    """
    Check macOS file watching limits using sysctl.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    if platform.system() != "Darwin":
        return {
            "name": "macOS file watching",
            "status": "SKIP",
            "message": "Not applicable on this platform (macOS only)",
        }

    try:
        # Check kern.maxfiles and kern.maxfilesperproc
        result = subprocess.run(
            ["sysctl", "-n", "kern.maxfiles"],
            capture_output=True,
            text=True,
            check=True
        )
        max_files = int(result.stdout.strip())

        result = subprocess.run(
            ["sysctl", "-n", "kern.maxfilesperproc"],
            capture_output=True,
            text=True,
            check=True
        )
        max_files_per_proc = int(result.stdout.strip())

        MIN_RECOMMENDED_FILES = 524288
        MIN_RECOMMENDED_PER_PROC = 200000

        issues = []
        if max_files < MIN_RECOMMENDED_FILES:
            issues.append(f"kern.maxfiles too low: {max_files:,} (need >= {MIN_RECOMMENDED_FILES:,})")
        if max_files_per_proc < MIN_RECOMMENDED_PER_PROC:
            issues.append(f"kern.maxfilesperproc too low: {max_files_per_proc:,} (need >= {MIN_RECOMMENDED_PER_PROC:,})")

        if not issues:
            return {
                "name": "macOS file watching",
                "status": "OK",
                "message": f"kern.maxfiles={max_files:,}, kern.maxfilesperproc={max_files_per_proc:,}",
            }
        else:
            return {
                "name": "macOS file watching",
                "status": "ERROR",
                "message": "; ".join(issues),
                "help_text": f"Increase file descriptor limits to {MIN_RECOMMENDED_FILES} via LaunchDaemon.\n",
            }

    except subprocess.CalledProcessError:
        return {
            "name": "macOS file watching",
            "status": "WARNING",
            "message": "Could not query sysctl values",
            "help_text": "Failed to run sysctl command.\n",
        }
    except Exception as e:
        return {
            "name": "macOS file watching",
            "status": "ERROR",
            "message": f"Error checking: {e}",
            "help_text": "Unexpected error checking file limits.\n",
        }
