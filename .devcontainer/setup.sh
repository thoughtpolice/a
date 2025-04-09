#!/usr/bin/env bash

# The rust devcontainer feature sets these variables to /usr/local/bin, but then
# buck2 unsets them when running builds, so it looks like the toolchains aren't
# initialized and the build fails. instead use the default values, which are
# $HOME
export CARGO_HOME="$HOME/.cargo"
export RUSTUP_HOME="$HOME/.rustup"
echo 'unset CARGO_HOME' >> $HOME/.bashrc
echo 'unset RUSTUP_HOME' >> $HOME/.bashrc
rustup default stable
rustup target add \
  x86_64-unknown-uefi x86_64-unknown-linux-gnu \
  aarch64-unknown-uefi aarch64-unknown-linux-gnu

# init if .jj dir is not present
#
# if it is, we assume they probably have a configured working copy, so don't do
# anything.
if [ ! -d "$PWD/.jj" ]; then
  $PWD/buck/bin/extra/jj config set --user user.name  "$(git config --system user.name)"
  $PWD/buck/bin/extra/jj config set --user user.email "$(git config --system user.email)"
  $PWD/buck/bin/extra/jj config set --user ui.default-command log

  $PWD/buck/bin/extra/jj git init --colocate || true
  $PWD/buck/bin/extra/jj branch track main@origin
fi

$PWD/buck/bin/buck2 run depot//.vscode/extensions/depot-buck2:build
