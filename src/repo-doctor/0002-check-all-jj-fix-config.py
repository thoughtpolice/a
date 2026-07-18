# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check JJ repository fix configuration for omnifix."""

import os
from pathlib import Path


ISSUE_INFORMATION = {
    "title": "JJ fix configuration problems",
    "platform": "All",
    "severity": "WARNING",
    "description": """
The Jujutsu (jj) repository has issues with the 'fix' configuration. This could be:
- Missing or incomplete fix.tools.omnifix configuration
- Unable to read .jj/repo/config.toml file
- Invalid TOML syntax or file permissions

The 'jj fix' command allows automatic code formatting on commit, helping maintain
consistent code style across the monorepo. Without this configuration, you'll need
to manually format code and may accidentally commit improperly formatted code.
""".strip(),
    "fix": """
1. Check if you're in a JJ repository:
   - ls .jj/repo/config.toml
   - Should exist if you're in a JJ repo

2. Verify file permissions:
   - chmod 644 .jj/repo/config.toml

3. Add or fix the omnifix configuration in .jj/repo/config.toml:

   [fix.tools.omnifix]
   command = ["./buck/bin/buck2", "run", "omnifix", "--", "$path"]
   patterns = ["glob:**/*"]

4. Verify TOML syntax is valid:
   - Check for unmatched quotes, brackets, or invalid escape sequences
   - Use a TOML validator if needed: https://www.toml-lint.com

5. Test the configuration:
   - Make a small change to a file
   - Run: jj fix
   - The file should be automatically formatted

6. Common usage patterns:
   - jj fix          : Format uncommitted changes
   - jj fix -s @     : Format the current commit
   - jj fix -s @-    : Format the parent commit

The omnifix tool will:
- Format Rust code with rustfmt
- Format Go code with gofmt
- Format Buck and Starlark code with buildifier
- Trim trailing whitespace
- Ensure files end with a newline
- Run on every file in the tree for consistent style
""".strip(),
    "related_links": [
        "https://jj-vcs.github.io/jj/latest/config/#fix-tools",
        "https://toml.io/en/"
    ]
}


def run_check():
    """
    Check if .jj/repo/config.toml has proper fix configuration for omnifix.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    # Find the .jj/repo/config.toml relative to current directory
    jj_config_path = Path(".jj/repo/config.toml")

    if not jj_config_path.exists():
        return {
            "name": "JJ fix configuration",
            "status": "SKIP",
            "message": "Not in a JJ repository (no .jj/repo/config.toml found)"
        }

    try:
        with open(jj_config_path, "r") as f:
            config_content = f.read()

        # Check for the presence of fix.tools.omnifix section
        has_fix_tools = "[fix.tools.omnifix]" in config_content
        has_command = "command = " in config_content and "omnifix" in config_content
        has_patterns = 'patterns = ["glob:**/*"]' in config_content or "patterns = " in config_content

        if has_fix_tools and has_command and has_patterns:
            return {
                "name": "JJ fix configuration",
                "status": "OK",
                "message": "omnifix is properly configured in .jj/repo/config.toml"
            }
        else:
            missing_parts = []
            if not has_fix_tools:
                missing_parts.append("[fix.tools.omnifix] section")
            if not has_command:
                missing_parts.append("command directive")
            if not has_patterns:
                missing_parts.append("patterns directive")

            message = f"Missing: {', '.join(missing_parts)}"

            return {
                "name": "JJ fix configuration",
                "status": "WARNING",
                "message": message,
                "help_text": "Add omnifix configuration to .jj/repo/config.toml for automatic code formatting."
            }

    except Exception as e:
        return {
            "name": "JJ fix configuration",
            "status": "ERROR",
            "message": f"Error reading config: {e}",
            "help_text": "Check file permissions and TOML syntax in .jj/repo/config.toml."
        }
