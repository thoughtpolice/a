# OmniFix™️

`jj fix` is a really useful tool for things like formatting your patches
automatically. But it's kind of annoying to configure because you often need a
lot of repo-specific fix rules, but you can't commit those configuration rules
to the repository. And the tools all don't work the same way; jj fix requires
"in memory" usage, so the file input is fed over stdin. Some tools therefore
need a wrapper that writes the file to a temporary path.

OmniFix™️ papers over these problems and lets you use a single command named
`omnifix` that you then configure with `jj config --repo`. OmniFix™️ solves every
problem you had and others you didn't. OmniFix™️ knows all. OmniFix™️ is watching
you.

OmniFix currently trims trailing whitespace, ensures a final newline, formats
Rust source with `rustfmt`, formats Go source with `gofmt`, formats Nix source
with `nixfmt`, and formats Buck and Starlark source with `buildifier`.
