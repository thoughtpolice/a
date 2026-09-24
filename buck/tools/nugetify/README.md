# nugetify

`nugetify` is to `third-party//csharp` what reindeer is to
`third-party//rust`: it turns a manifest of NuGet packages into a lock file
and a generated `BUILD`.

```sh
buck2 run root//buck/tools/nugetify -- buckify
```

- `buck/third-party/csharp/nuget.toml` names the targeting pack and the
  packages first-party code may reference, each pinned to one version, and
  under `[sources]` the feeds besides nuget.org (NuGet V3 flat-container
  base URLs) a package may come from, tried in order after nuget.org.
- `buck/third-party/csharp/nuget.lock` is the resolved graph: every package
  with its hashes, the `lib/` folder the framework consumes, the assemblies
  and symbols in it, and its dependencies. `buck/tests/osv.io` scans it.
- `buck/third-party/csharp/BUILD` is rendered from the lock alone as
  `nuget.package(...)` calls; `buck/shims/third_party_csharp.bzl` turns each
  into the archive download and the prebuilt library. A package from another
  feed carries its `source`; since buck2's downloads start with a HEAD
  request, which Azure DevOps feeds refuse, `nugetify fetch` downloads it
  with GET, checks its SHA-256 and unpacks it, in a local action.

Resolution follows NuGet's restore: a dependency is taken at the lowest
version its range allows, a package two dependents disagree on gets the
higher floor, and a package the targeting pack's `PackageOverrides.txt`
supplies at that version or newer is left to the framework. The manifest's
own pins are never moved; a pin below a dependency's floor is an error. The
`lib/` folder and nuspec dependency group are chosen as NuGet's nearest
framework, so `net11.0` takes `net10.0` over `netstandard2.0`.

`buckify` leaves the lock alone when its framework and direct pins still
match the manifest, so a regeneration after a macro change touches no
network; `-relock` forces a fresh resolution. Downloads are cached under the
user cache directory (`-cache` to move it).

The generated BUILD ends in `nuget.check`, a test that fails when the three
files stop agreeing:

```sh
buck2 test third-party//csharp:buckify-check
```

Not modeled: packages with only `ref/` or `runtimes/` assets, content files,
build props, source generators as package assets, and version ranges with
no inclusive lower bound.
