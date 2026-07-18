#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
IFS=$'\n\t'

die() {
    printf 'post-create: %s\n' "$*" >&2
    exit 1
}

for command_name in dirname git grep jq mktemp rm; do
    command -v "${command_name}" >/dev/null 2>&1 \
        || die "required command not found: ${command_name}"
done

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" \
    || die 'could not resolve the script directory'
readonly script_dir
repository="$(git -C "${script_dir}/.." rev-parse --show-toplevel 2>/dev/null)" \
    || die 'could not resolve the repository root'
readonly repository
readonly jj="${repository}/buck/bin/extra/jj"

[[ -x "${jj}" ]] || die "JJ launcher is not executable: ${jj}"

set_jj_user_string() {
    local key="$1"
    local value="$2"
    local toml_value

    toml_value="$(jq -Rn --arg value "${value}" '$value')"
    (
        cd -- /
        "${jj}" config set --user "${key}" "${toml_value}"
    )
}

ensure_jj_repo_config() {
    local config_directory
    local config_path
    local config_stderr
    local stderr_file
    local expected_warning

    stderr_file="$(mktemp "${TMPDIR:-/tmp}/post-create-jj-config.XXXXXX")" \
        || die 'could not create temporary storage for JJ diagnostics'
    if ! config_path="$(
        "${jj}" --repository "${repository}" --ignore-working-copy \
            --color never --no-pager config path --repo 2>"${stderr_file}"
    )"; then
        config_stderr="$(<"${stderr_file}")"
        rm -f -- "${stderr_file}"
        if [[ -n "${config_stderr}" ]]; then
            printf '%s\n' "${config_stderr}" >&2
        fi
        die 'could not initialize the JJ per-repository config'
    fi

    config_stderr="$(<"${stderr_file}")"
    rm -f -- "${stderr_file}"
    expected_warning=$'Warning: Per-repo config not found. Generating an empty one.\n'
    expected_warning+=$'Per-repo config is stored in the same directory as your user config for security reasons.\n'
    expected_warning+='If you work across multiple computers, you may want to keep your user config directory in sync.'
    if [[ -n "${config_stderr}" && "${config_stderr}" != "${expected_warning}" ]]; then
        printf '%s\n' "${config_stderr}" >&2
    fi
    [[ -n "${config_path}" ]] || die 'JJ returned an empty per-repository config path'
    config_directory="$(dirname -- "${config_path}")"
    [[ -d "${config_directory}" ]] \
        || die "JJ did not initialize its per-repository config directory: ${config_directory}"
}

if git_name="$(git -C "${repository}" config --get user.name 2>/dev/null)"; then
    if [[ -n "${git_name}" ]]; then
        set_jj_user_string user.name "${git_name}"
    fi
fi
if git_email="$(git -C "${repository}" config --get user.email 2>/dev/null)"; then
    if [[ -n "${git_email}" ]]; then
        set_jj_user_string user.email "${git_email}"
    fi
fi
set_jj_user_string ui.default-command log

if [[ ! -d "${repository}/.jj" ]]; then
    "${jj}" git init --colocate "${repository}"
fi
ensure_jj_repo_config

bookmark_template='if(remote, name ++ "@" ++ remote ++ "\n", "")'
remote_bookmarks="$(
    "${jj}" --repository "${repository}" --ignore-working-copy --color never --no-pager \
        bookmark list --all-remotes --template "${bookmark_template}"
)"
if grep -Fxq 'canon@origin' <<<"${remote_bookmarks}"; then
    tracked_bookmarks="$(
        "${jj}" --repository "${repository}" --ignore-working-copy --color never --no-pager \
            bookmark list --tracked --template "${bookmark_template}"
    )"
    if ! grep -Fxq 'canon@origin' <<<"${tracked_bookmarks}"; then
        "${jj}" --repository "${repository}" --ignore-working-copy \
            bookmark track canon@origin
    fi
fi
