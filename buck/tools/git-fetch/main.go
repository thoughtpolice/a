// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// git-fetch fetches one commit of a public git repository over HTTP(S) and
// checks it out, without running git and without reading any git
// configuration. It is the tool behind shims.git_fetch; see README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

const version = "0.1.0"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

type options struct {
	gitDir, workTree, repo, rev, objectFormat string
	verbose                                   bool
}

func run(args []string, stdout, stderr io.Writer) int {
	var o options
	flags := flag.NewFlagSet("git-fetch", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&o.gitDir, "git-dir", "", "where to write the repository, which holds the fetched objects")
	flags.StringVar(&o.workTree, "work-tree", "", "where to check the commit out")
	flags.StringVar(&o.repo, "repo", "", "the repository's http or https URL")
	flags.StringVar(&o.rev, "rev", "", "the commit to fetch, as a full object id (an annotated tag's id also works)")
	flags.StringVar(&o.objectFormat, "object-format", "sha1", "the repository's object format: sha1 or sha256")
	flags.BoolVar(&o.verbose, "verbose", false, "report how long each step took")
	showVersion := flags.Bool("version", false, "print the version and exit")
	flags.Usage = func() {
		fmt.Fprintf(stderr, "usage: git-fetch --git-dir=DIR --work-tree=DIR --repo=URL --rev=ID [--object-format=sha1|sha256]\n\n")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if *showVersion {
		fmt.Fprintln(stdout, "git-fetch", version)
		return 0
	}
	if flags.NArg() > 0 || o.gitDir == "" || o.workTree == "" || o.repo == "" || o.rev == "" {
		flags.Usage()
		return 2
	}
	if err := fetchAndCheckout(context.Background(), o, stderr); err != nil {
		fmt.Fprintf(stderr, "git-fetch: %v\n", err)
		return 1
	}
	return 0
}

func fetchAndCheckout(ctx context.Context, o options, log io.Writer) error {
	format, ok := objectFormats[o.objectFormat]
	if !ok {
		return fmt.Errorf("--object-format must be sha1 or sha256, not %q", o.objectFormat)
	}
	want, ok := format.parseHex(o.rev)
	if !ok {
		return fmt.Errorf("--rev must be a full %s object id (%d hex digits), not %q", format.name, 2*format.size, o.rev)
	}
	for _, dir := range []string{o.gitDir, o.workTree} {
		if empty, err := isEmptyDir(dir); err != nil {
			return err
		} else if !empty {
			return fmt.Errorf("%s is not empty", dir)
		}
	}

	start := time.Now()
	step := func(what string) {
		if o.verbose {
			now := time.Now()
			fmt.Fprintf(log, "git-fetch: %s in %v\n", what, now.Sub(start).Round(time.Millisecond))
			start = now
		}
	}
	res, err := fetch(ctx, o.repo, format, want, log)
	if err != nil {
		return fmt.Errorf("fetching %s from %s: %w", o.rev, displayURL(o.repo), err)
	}
	p := res.pack
	step(fmt.Sprintf("fetched %d objects in a %d-byte pack", len(p.entries), len(p.data)))
	commit, err := peelToCommit(p, want)
	if err != nil {
		return err
	}
	if err := writeRepository(o.gitDir, p, commit, res.shallow); err != nil {
		return fmt.Errorf("writing %s: %w", o.gitDir, err)
	}
	step("wrote the repository")
	if err := checkout(p, commit, o.workTree); err != nil {
		return fmt.Errorf("checking out %s: %w", format.hex(commit), err)
	}
	step("checked out the work tree")
	return nil
}
