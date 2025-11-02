# `jj` workspace root & dumping grounds

This empty directory is a convenient "workspace root" to place your various
different `jj` workspaces, repositories, and other various things that you want
that shouldn't be tracked by the repo directly.

Most importantly of all, the content under this directory (besides this README)
is ignored by the VCS, which is useful for various purposes outlined below.

## Case 1: workspaces for feature development

Simple idea: create a workspace for a feature, then go work on that feature
inside the workspace.

```bash
cd $ROOT_OF_REPOSITORY # go to the root of the default workspace
jj workspace add --name cool-new-feature work/new-feature # create first new workspace
cd work/new-feature
# do everything normally, here
```

This creates a new workspace in Jujutsu; you can refer to it with the syntax
`cool-new-name@` to refer to its working copy. That commit will also be returned
by the `working_copies()` revset. If you don't specify a `--name`, the default name
will be derived from the name of the directory (`new-feature` in this case).

You can specify a revision to put the new working copy on top of using the `-r`
argument to `workspace add`; for example, if you want to check a workspace out
on an older commit.

The default working copy is named `default`, and can always be referred to with
the syntax `default@` unambiguously (even if there are no other workspaces).

You can work on the workspace however much you want. Because its commit graph is
shared with the default workspace, you can then go back to `$ROOT_OF_REPOSITORY`
and run `jj log` and see it. You can then `jj rebase` or any other number of
things in order to move that commit around, like usual.

This makes it easy to have completely isolated working copies. It is particularly
useful for things like Agenic AI coding agents.

## Case 2: automation uses

There are some cases that we use in the repo right now that use this directory.
The most prominent example is **target determination**: the `quicktd` tool will
put workspaces at different commits under here, so that the graph of BUILD
files can be built and compared to figure out what targets have changed.

Other forms of automation could also leverage this directory, if needed.

## Case 3: cloning a third-party repo for examination

Sometimes it's useful to just clone another completely separate project into
`work/` so that you can then do things like "ripgrep for a symbol I use from
this library" across all the code. That's very easy:

```bash
jj git clone https://github.com/some-persons/cool-project work/cool-project
```

## Case 4: "Grafting" a third-party project into the repo

This is a more advanced and trickier version of case 3.

The basic idea is to add a remote repo for an upstream repository:

```bash
jj git remote add cool-project https://github.com/some-persons/cool-project
```

Then, fetch from that repo, and add a new workspace that points to it:

```bash
jj git fetch --remote=cool-project
jj workspace add \
  --name=cool-project \
  -r main@cool-project \
  work/cool-project
```

Now, `work/cool-project` is a clone of the third-party repository, but its
history is completely connected to your jj repository (thanks to the virtual
`root()` commit).

You can now do things like make local modifications on top of this history; for
example, if you are writing patches to a third-party project that you need to
test out first before submitting them.

This workflow is somewhat special, but powerful if done in the right way.

## (Silly) Case 5: Darcs-style branching

This idea is a bit silly and not useful for things like agents perhaps, but is
an interesting way of working.

The idea is something like this &mdash; while you are in a clean, empty working
copy commit, execute the following:

```bash
cd $(jj workspace root) # go to the root of the default workspace
jj sparse set --clear --add work # only leave work/ in in the working copy
```

This removes all files except the top-level `work/` directory, which is empty,
but it retains all the historical content of the repository. That's ideal. Now:

```bash
jj workspace add work/new-feature # create first new workspace
jj workspace add work/fix-bug-123 # create second new workspace
```

Now, your working copy is empty, but the the directory `work/new-feature` has a
copy of the whole repository instead, "linked" with the sparse copy above it.
`work/fix-bug-123` also is a copy of the repository, and they both share the
same root-level `.jj` directory. You can run `jj log` in either workspace and
see it connected to the top level repository, and work on the two workspaces
independently. You can run `jj workspace add` many more times to keep creating
entirely new build directories that are all sharing the root `.jj` repo.

This kind of workflow is useful for scenarios where you want to e.g. execute
some long running test or other tool while having another set of commits being
worked on separately. It also conceptually can replace any workflow where you
might have multiple copies of a repository checked out in different directories
for some reason.

In a sense, this turns the Git model for change management on its head, since
instead of branches you are just using whole checkouts in subdirectories.
Instead it looks more like the way **[Darcs]** works, where every branch of a
project was its own separate repository entirely.

[Darcs]: https://darcs.net

Run `jj workspace forget work/new-feature` when you are done with a workspace,
and the commits will still exist in the top level repository, but the workspace
is gone. You can delete the directories after that.
