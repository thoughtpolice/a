<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# git-fetch

`git-fetch` fetches one commit of a public git repository over HTTP(S) and
checks it out, without running `git`. It is written in Go with nothing but
the standard library, so it builds in a couple of seconds once Go's
standard library is built, and is always compiled with optimizations.

```console
$ git-fetch --git-dir=out/.git --work-tree=out/jj \
    --repo=https://github.com/martinvonz/jj \
    --rev=7c41cdeb16b6b321c64e789a966b6adf723816a5
```

## Why not git

`git` reads `~/.gitconfig` and `/etc/gitconfig`, so `url.*.insteadOf` can
redirect a fetch, a globally configured filter driver such as git-lfs can
change the bytes checked out, and a credential helper or a terminal prompt
can run in the middle of a build. `git-fetch` reads no configuration and
no `GIT_*` variables, and never sends credentials: a server that asks for
them fails the fetch. What it writes depends on the URL, the commit, and
the files in that commit.

Two things still come from the host: TLS trusts the system's CA bundle,
which `SSL_CERT_FILE` and `SSL_CERT_DIR` can point elsewhere, as Go's
`crypto/x509` allows, and `HTTPS_PROXY` and friends are honored.

## What it does

1. Asks the server for its capabilities over git's protocol version 2,
   following redirects only for this first request, as git does.
2. Asks for `--rev` by id at depth 1, which gets the commit and its tree
   but no history, like `git fetch --depth=1 origin <rev>`.
3. Reads the pack as it arrives, hashing every object, so that each
   object's id is checked against its contents and the commit id vouches
   for every file. Deltas are resolved once the whole pack is in.
4. Writes a bare repository to `--git-dir`: the pack and its index, `HEAD`
   detached at the commit, and the `shallow` file. git can read it, and
   `git clone` from it reproduces the work tree. It has no index file,
   since its stat data would only describe this machine.
5. Checks the commit out into `--work-tree`, as `git checkout` would with
   no configuration on Linux: executable bits and symlinks are kept,
   submodules become empty directories, and the names git refuses (`.git`
   in any case, NTFS aliases of it, `..`) are refused.

An annotated tag's id also works as `--rev`; its commit is checked out.

Network errors other than bad certificates and unknown hosts, and HTTP
408, 429, 500, 502, 503 and 504 replies, are retried up to five times, a
second apart and doubling. A request is abandoned after two minutes in which the server
sends nothing. `--verbose` reports how long each step took.

## .gitattributes

The checkout applies `.gitattributes` from the tree as git does with
`core.autocrlf` and `core.eol` unset: `text`, `eol`, the older `crlf`,
`binary` and other macros, `ident`, and every pattern form, through a port
of git's wildmatch. A few details follow git's behavior rather than its
documentation:

- git reads `.gitattributes` from the index while checking out, so a
  symlinked one is read too, as its target's text. A byte-order mark is
  not stripped, and a NUL ends the file.
- `ident` goes through one of two conversions in git. Files marked
  `text=auto` are converted in memory; every other file is streamed, and
  the streaming filter leaves `$$Id$` alone, treats tabs as marking
  another system's id, and drops text pending before an id in `$Idx$Id:$`.
- Filter attributes do nothing, as in git without the filter's driver
  installed: git-lfs files check out as their pointers.

`working-tree-encoding` needs iconv, which the Go standard library lacks.
A file that asks for an encoding other than UTF-8 fails the checkout,
rather than checking out differently from git.

## Limitations

- HTTP(S) only, and only repositories that need no credentials. Other
  URLs are refused, including any with credentials in them.
- The server must speak protocol version 2 and allow fetching a commit by
  id, as GitHub does.
- No submodule fetching.

## Tests

`buck2 test //buck/tools/git-fetch:unit` runs unit tests against packs
built in the test, including a fake HTTP server for the protocol.
`cases_test.go` records what git itself checks out for a set of
`.gitattributes` cases, and which paths `git check-attr` matches for a set
of patterns. It is generated, and can be regenerated with any git:

```console
$ python3 tests/gen-cases.py > cases_test.go
```
