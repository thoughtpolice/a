# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""`git_fetch`, reimplemented on git-fetch instead of the `git` executable.

The rule is reached through `shims.git_fetch`, which is what reindeer emits
for git dependencies. Its attributes and outputs are the prelude's: the
default output is the work tree, named after the target minus `.git`, each
`sub_targets` path is a sub-target of it, and `[.git]` is the repository,
for consumers that want a git remote rather than files.

The prelude's rule runs whatever `git` is on the host, which reads the
user's and the system's git configuration (`url.*.insteadOf`, filter
drivers, credential helpers). git-fetch reads none of it; see README.md.
Only public repositories over HTTP(S) are supported.
"""

_GIT_FETCH = "root//buck/tools/git-fetch:git-fetch"

_HEX_DIGITS = "0123456789abcdef"

def _is_hex(rev: str, length: int) -> bool:
    if len(rev) != length:
        return False
    for digit in rev.elems():
        if digit not in _HEX_DIGITS:
            return False
    return True

def _git_fetch_impl(ctx: AnalysisContext) -> list[Provider]:
    object_format = ctx.attrs.object_format or "sha1"
    digits = 64 if object_format == "sha256" else 40
    if not _is_hex(ctx.attrs.rev, digits):
        fail("git_fetch's `rev` must be a {}-hex-digit {} object id: {}".format(digits, object_format, ctx.attrs.rev))
    if ctx.attrs.update_submodules:
        fail("git_fetch: `update_submodules` is not supported by git-fetch; submodules are checked out as empty directories")

    # Declared exactly as the prelude declares them.
    git_dir = ctx.actions.declare_output(".git", dir = True, has_content_based_path = False)
    work_tree = ctx.actions.declare_output(
        ctx.attrs.name.removesuffix(".git") or "work-tree",
        dir = True,
        has_content_based_path = False,
    )

    ctx.actions.run(
        cmd_args(
            ctx.attrs._git_fetch[RunInfo],
            cmd_args("--git-dir=", git_dir.as_output(), delimiter = ""),
            cmd_args("--work-tree=", work_tree.as_output(), delimiter = ""),
            cmd_args("--repo=", ctx.attrs.repo, delimiter = ""),
            cmd_args("--rev=", ctx.attrs.rev, delimiter = ""),
            cmd_args("--object-format=", object_format, delimiter = ""),
        ),
        category = "git_fetch",
        # The fetch needs the network, which remote executors don't promise.
        local_only = True,
        allow_cache_upload = ctx.attrs.allow_cache_upload,
    )

    sub_targets = {path: [DefaultInfo(default_output = work_tree.project(path))] for path in ctx.attrs.sub_targets}

    # git refuses to check out a path named ".git", so no work tree path
    # can claim this key.
    sub_targets[".git"] = [DefaultInfo(default_output = git_dir)]

    return [DefaultInfo(default_output = work_tree, sub_targets = sub_targets)]

git_fetch = rule(
    impl = _git_fetch_impl,
    attrs = {
        "allow_cache_upload": attrs.bool(default = True, doc = "Whether the fetched files may be written to the action cache and CAS."),
        "contacts": attrs.list(attrs.string(), default = []),
        "labels": attrs.list(attrs.string(), default = []),
        "licenses": attrs.list(attrs.source(), default = []),
        "object_format": attrs.option(attrs.enum(["sha1", "sha256"]), default = None, doc = "The repository's object format; sha1 if unset."),
        "repo": attrs.string(doc = "URL of the repository, over http or https."),
        "rev": attrs.string(doc = "Full commit id: 40 hex digits for sha1, 64 for sha256. An annotated tag's id checks out its commit."),
        "sub_targets": attrs.list(attrs.string(), default = [], doc = "Paths in the work tree to expose as sub-targets, e.g. `:serde.git[serde_derive]`."),
        "update_submodules": attrs.bool(default = False, doc = "Unsupported; accepted only so that setting it fails with an explanation."),
        "_git_fetch": attrs.default_only(attrs.exec_dep(default = _GIT_FETCH, providers = [RunInfo])),
    },
)
