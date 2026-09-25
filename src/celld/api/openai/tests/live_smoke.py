# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run the live smoke test on an exe.dev VM.

Usage (through `buck2 run root//src/celld/api/openai:live-smoke-run -- VM [ARGS]`):

  VM    an ssh destination for a VM with the ChatGPT-backed LLM integration
        attached, such as `my-vm.exe.xyz`
  ARGS  passed to the script: --integration NAME, --models a,b,c, --jev NAME

The bundle is copied to `~/.cache/celld-live` on the VM. Deno is fetched
there once, pinned to the version and digest in the repository's
`buck/bin/deno` DotSlash file, since the VM may be a different architecture
from this machine. The JSON report goes to stdout, progress to stderr, and
the exit status is the script's.
"""

import json
import shlex
import subprocess
import sys

REMOTE_DIR = ".cache/celld-live"

PLATFORMS = {
    "x86_64": "linux-x86_64",
    "aarch64": "linux-aarch64",
}


def ssh(dest: str, command: str, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", dest, command], check=False, **kwargs
    )


def deno_release(dotslash_path: str, platform: str) -> dict:
    with open(dotslash_path, encoding="utf-8") as f:
        text = f.read()
    manifest = json.loads(text[text.index("{") :])
    entry = manifest["platforms"][platform]
    if entry["hash"] != "sha256" or entry["format"] != "zip":
        sys.exit(f"live-smoke: unexpected deno entry for {platform}: {entry}")
    return {
        "url": entry["providers"][0]["url"],
        "digest": entry["digest"],
        "path": entry["path"],
    }


def main() -> int:
    if len(sys.argv) < 4:
        sys.exit("usage: live_smoke.py BUNDLE DENO_DOTSLASH VM [ARGS...]")
    bundle, dotslash, dest, *args = sys.argv[1:]

    arch = ssh(dest, "uname -m", capture_output=True, text=True)
    if arch.returncode != 0:
        sys.stderr.write(arch.stderr)
        return arch.returncode
    platform = PLATFORMS.get(arch.stdout.strip())
    if platform is None:
        sys.exit(f"live-smoke: unsupported VM architecture {arch.stdout.strip()!r}")
    deno = deno_release(dotslash, platform)

    # The digest names the install directory, so a Deno bump fetches anew.
    deno_dir = f"{REMOTE_DIR}/deno-{deno['digest'][:16]}"
    install = f"""set -eu
mkdir -p {deno_dir}
cd {deno_dir}
if [ ! -x deno ]; then
  curl -sSfL -o deno.zip {shlex.quote(deno["url"])}
  echo {shlex.quote(deno["digest"] + "  deno.zip")} | sha256sum -c --quiet
  python3 -c 'import sys, zipfile; zipfile.ZipFile("deno.zip").extract(sys.argv[1])' {shlex.quote(deno["path"])}
  chmod +x deno
  rm deno.zip
fi
"""
    done = ssh(dest, install)
    if done.returncode != 0:
        return done.returncode

    copied = subprocess.run(
        ["scp", "-q", "-o", "BatchMode=yes", bundle, f"{dest}:{REMOTE_DIR}/live-smoke.js"],
        check=False,
    )
    if copied.returncode != 0:
        return copied.returncode

    run = " ".join(
        [f"{deno_dir}/deno", "run", "--allow-net", f"{REMOTE_DIR}/live-smoke.js"]
        + [shlex.quote(arg) for arg in args]
    )
    return ssh(dest, run).returncode


if __name__ == "__main__":
    sys.exit(main())
