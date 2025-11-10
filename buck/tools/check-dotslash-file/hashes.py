#!/usr/bin/env python3

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Check that all dotslash files in buck/bin have valid platform entries by downloading
and verifying their hashes and sizes.
"""

import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError


def verify_hash(file_path: Path, hash_type: str, expected_digest: str) -> bool:
    """Verify file hash using Python's hashlib."""
    try:
        with open(file_path, 'rb') as f:
            file_data = f.read()

        if hash_type == "sha256":
            actual_digest = hashlib.sha256(file_data).hexdigest()
        else:
            print(f"    ERROR: Unsupported hash type: {hash_type}")
            return False

        return actual_digest == expected_digest
    except Exception as e:
        print(f"    ERROR: Failed to compute {hash_type} hash: {e}")
        return False


def download_with_retry(url: str, max_retries: int = 3, base_delay: float = 1.0) -> bytes:
    """Download file with exponential backoff retry logic."""
    headers = {}

    # Check for GitHub token for authentication to avoid rate limiting
    github_token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    if github_token and 'github.com' in url:
        headers['Authorization'] = f'Bearer {github_token}'

    for attempt in range(max_retries):
        try:
            request = Request(url, headers=headers)
            with urlopen(request) as response:
                return response.read()
        except HTTPError as e:
            if e.code in [500, 502, 503, 504, 429]:  # Server errors and rate limiting
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)  # Exponential backoff
                    print(f"HTTP {e.code} error, retrying in {delay:.1f}s... (attempt {attempt + 1}/{max_retries})")
                    time.sleep(delay)
                    continue
            raise
        except URLError as e:
            if attempt < max_retries - 1:
                delay = base_delay * (2 ** attempt)
                print(f"Network error, retrying in {delay:.1f}s... (attempt {attempt + 1}/{max_retries})")
                time.sleep(delay)
                continue
            raise

    # This should never be reached due to the raise statements above
    raise Exception("Max retries exceeded")


def download_and_verify_platform(platform_name: str, platform_info: dict) -> bool:
    """Download and verify a single platform binary."""
    print(f"  Checking platform {platform_name}...", end=" ")

    size = platform_info.get("size")
    hash_type = platform_info.get("hash")
    expected_digest = platform_info.get("digest")
    providers = platform_info.get("providers", [])

    if not providers:
        print("✗")
        print(f"    ERROR: No providers found for platform {platform_name}")
        return False

    # FIXME: Use first provider
    url = providers[0].get("url")
    if not url:
        print("✗")
        print(f"    ERROR: No URL found in provider for platform {platform_name}")
        return False

    try:
        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)

            print(f"downloading...", end=" ")
            data = download_with_retry(url)
            tmp_file.write(data)

        actual_size = tmp_path.stat().st_size
        if actual_size != size:
            print("✗")
            print(f"    ERROR: Size mismatch for platform {platform_name}")
            print(f"           Expected: {size} bytes")
            print(f"           Actual:   {actual_size} bytes")
            tmp_path.unlink()
            return False

        print(f"verifying {hash_type}...", end=" ")
        if not verify_hash(tmp_path, hash_type, expected_digest):
            print("✗")
            print(f"    ERROR: Hash mismatch for platform {platform_name}")
            print(f"           Expected {hash_type}: {expected_digest}")
            # Get actual hash for comparison
            try:
                with open(tmp_path, 'rb') as f:
                    file_data = f.read()
                if hash_type == "sha256":
                    actual_digest = hashlib.sha256(file_data).hexdigest()
                    print(f"           Actual {hash_type}:   {actual_digest}")
                else:
                    print(f"           Cannot compute actual hash for unsupported type: {hash_type}")
            except:
                pass
            tmp_path.unlink()
            return False

        tmp_path.unlink()
        print("✓")
        return True

    except (URLError, HTTPError) as e:
        print("✗")
        if isinstance(e, HTTPError):
            print(f"    ERROR: HTTP {e.code} error downloading from {url}: {e}")
        else:
            print(f"    ERROR: Failed to download from {url}: {e}")
        return False
    except Exception as e:
        print("✗")
        print(f"    ERROR: Unexpected error for platform {platform_name}: {e}")
        return False


def check_dotslash_file(file_path: Path) -> bool:
    """Check a single dotslash file by parsing JSON and verifying all platforms."""
    print(f"Checking {file_path.name}...")

    try:
        content = file_path.read_text()
        if content.startswith("#!"):
            # Find first line that starts with {
            lines = content.split('\n')
            json_start = None
            for i, line in enumerate(lines):
                if line.strip().startswith('{'):
                    json_start = i
                    break
            if json_start is None:
                print(f"  ERROR: Could not find JSON content in {file_path.name}")
                return False
            json_content = '\n'.join(lines[json_start:])
        else:
            json_content = content

        config = json.loads(json_content)

        # Get platforms
        platforms = config.get("platforms", {})
        if not platforms:
            print(f"  ERROR: No platforms found in {file_path.name}")
            return False

        all_passed = True
        for platform_name, platform_info in platforms.items():
            if not download_and_verify_platform(platform_name, platform_info):
                all_passed = False

        if all_passed:
            print(f"  All {len(platforms)} platforms verified successfully!")

        return all_passed

    except json.JSONDecodeError as e:
        print(f"  ERROR: Invalid JSON in {file_path.name}: {e}")
        return False
    except Exception as e:
        print(f"  ERROR: Failed to process {file_path.name}: {e}")
        return False


def main():
    """Check a single dotslash file specified as command-line argument"""

    if len(sys.argv) != 2:
        print("Usage: hashes.py <dotslash-file-path>")
        print("Example: hashes.py buck/bin/buck2")
        return 1

    # Get the file path from command line - can be relative or absolute
    file_path_arg = sys.argv[1]

    # Find repository root
    current_dir = Path(__file__).parent
    repo_root = current_dir
    while repo_root != repo_root.parent:
        if (repo_root / ".buckroot").exists():
            break
        repo_root = repo_root.parent
    else:
        print("ERROR: Could not find repository root (no .buckroot found)")
        return 1

    # Resolve the file path (support both relative to repo root and absolute paths)
    file_path = Path(file_path_arg)
    if not file_path.is_absolute():
        file_path = repo_root / file_path

    # Verify the file exists
    if not file_path.exists():
        print(f"ERROR: File not found: {file_path}")
        return 1

    if not file_path.is_file():
        print(f"ERROR: Not a file: {file_path}")
        return 1

    # Verify it's a dotslash file
    try:
        first_line = file_path.read_text().split('\n')[0]
        if "dotslash" not in first_line:
            print(f"ERROR: {file_path.name} does not appear to be a dotslash file")
            print(f"       First line: {first_line}")
            return 1
    except Exception as e:
        print(f"ERROR: Failed to read {file_path}: {e}")
        return 1

    # Check the file
    if not check_dotslash_file(file_path):
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
