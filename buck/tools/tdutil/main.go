// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

type application struct {
	runner   processRunner
	getwd    func() (string, error)
	tempDir  func() string
	pidAlive func(int) bool
}

func defaultApplication() application {
	return application{
		runner:   osProcessRunner{},
		getwd:    os.Getwd,
		tempDir:  os.TempDir,
		pidAlive: processIsAlive,
	}
}

func main() {
	os.Exit(programMain(os.Args[1:], os.Stdout, os.Stderr))
}

func programMain(argv []string, stdout, stderr io.Writer) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runApplication(ctx, defaultApplication(), argv, stdout, stderr); err != nil {
		_, _ = fmt.Fprintf(stderr, "tdutil: %v\n", err)
		return 1
	}
	return 0
}

func runApplication(ctx context.Context, app application, argv []string, stdout, stderr io.Writer) error {
	action, err := parseCLI(argv)
	if err != nil {
		return err
	}
	switch action.kind {
	case actionHelp:
		_, err := io.WriteString(stdout, helpText)
		return err
	case actionVersion:
		_, err := fmt.Fprintf(stdout, "tdutil %s\n", tdutilVersion)
		return err
	case actionRun:
		// Continue below.
	default:
		return fmt.Errorf("unknown command action")
	}
	args := action.args

	logProgress(stderr, &args, "discovering JJ repository")
	currentDir, err := app.getwd()
	if err != nil {
		return fmt.Errorf("finding the current directory: %w", err)
	}
	jj, err := discoverJJ(ctx, app.runner, args.jj, currentDir)
	if err != nil {
		return err
	}

	logProgress(stderr, &args, "resolving %s .. %s", args.base, args.head)
	revisions, err := jj.resolvePair(ctx, args.base, args.head, args.ignoreWorkingCopy)
	if err != nil {
		return err
	}
	changed, err := jj.changedPaths(ctx, revisions.base, revisions.head, true)
	if err != nil {
		return err
	}
	logProgress(stderr, &args, "%d changed path(s)", len(changed))

	var affected []affectedTarget
	if len(changed) != 0 {
		pidAlive := app.pidAlive
		if pidAlive == nil {
			pidAlive = processIsAlive
		}
		sweepOrphanedWorkspaces(ctx, jj, pidAlive, func(format string, values ...any) {
			logProgress(stderr, &args, format, values...)
		})

		if args.quick {
			// Quick mode consults only the working-copy graph: no base
			// materialization, one Buck query, and the documented blind spots
			// around deleted targets and hash-level definition changes.
			workingCopyCommit, err := jj.resolveOne(ctx, "@", true)
			if err != nil {
				return err
			}
			if workingCopyCommit != revisions.head {
				return fmt.Errorf(
					"--quick analyzes only the working copy: head revset `%s` resolves to %s, not the working-copy commit %s; drop --quick or target `@`",
					args.head,
					revisions.head,
					workingCopyCommit,
				)
			}
			logProgress(stderr, &args, "quick: querying the working-copy Buck graph (%s)", strings.Join(args.universe, " "))
			quickSnapshot, err := collectQuickSnapshot(
				ctx,
				app.runner,
				jj.repository,
				args.buck,
				append([]string(nil), args.buckArgs...),
				args.isolationDir,
				args.universe,
			)
			if err != nil {
				return err
			}
			logProgress(stderr, &args, "parsed %d working-copy targets", len(quickSnapshot.targets))
			affected, err = determine(
				&quickSnapshot,
				&quickSnapshot,
				changed,
				determineOptions{depth: args.depth},
			)
			if err != nil {
				return err
			}
		} else {
			// The head graph is queried directly in the invoking workspace when the
			// requested head is the working-copy commit: the tree on disk already is
			// that revision, so a second materialization would only duplicate it.
			headInPlace := false
			if !args.noHeadInPlace {
				workingCopyCommit, err := jj.resolveOne(ctx, "@", true)
				if err != nil {
					return err
				}
				headInPlace = workingCopyCommit == revisions.head
			}

			localConfig, err := snapshotBuckLocalConfig(jj.repository)
			if err != nil {
				return err
			}
			baseWorkspace, err := createWorkspace(ctx, jj, revisions.base, app.tempDir(), currentDir, localConfig)
			if err != nil {
				return err
			}
			cleanupContext := context.WithoutCancel(ctx)
			defer func() { _ = baseWorkspace.close(cleanupContext) }()

			var headWorkspace *workspace
			headCheckout := jj.repository
			if headInPlace {
				logProgress(stderr, &args, "querying head in place at %s", jj.repository)
			} else {
				headWorkspace, err = createWorkspace(ctx, jj, revisions.head, app.tempDir(), currentDir, localConfig)
				if err != nil {
					return finishOneWorkspace(cleanupContext, baseWorkspace, args.keepWorkspaces, err, "base", stderr)
				}
				defer func() { _ = headWorkspace.close(cleanupContext) }()
				headCheckout = headWorkspace.checkout
			}

			logProgress(
				stderr,
				&args,
				"querying base/head Buck graphs in parallel (%s)",
				strings.Join(args.universe, " "),
			)
			buckArgs := append([]string(nil), args.buckArgs...)
			baseSnapshot, headSnapshot, analysisErr := collectSnapshotPair(
				ctx,
				app.runner,
				baseWorkspace.checkout,
				headCheckout,
				args.buck,
				buckArgs,
				args.isolationDir,
				args.universe,
			)
			if analysisErr == nil {
				logProgress(
					stderr,
					&args,
					"parsed %d base and %d head targets",
					len(baseSnapshot.targets),
					len(headSnapshot.targets),
				)
				affected, analysisErr = determine(
					&baseSnapshot,
					&headSnapshot,
					changed,
					determineOptions{depth: args.depth},
				)
			}
			affected, err = finishWorkspacePair(
				cleanupContext,
				baseWorkspace,
				headWorkspace,
				args.keepWorkspaces,
				affected,
				analysisErr,
				stderr,
			)
			if err != nil {
				return err
			}
		}
	}

	logProgress(stderr, &args, "%d affected target(s)", len(affected))
	meta := metadata{
		baseRevset: args.base,
		headRevset: args.head,
		baseCommit: revisions.base,
		headCommit: revisions.head,
		universe:   args.universe,
	}
	if args.output == nil {
		return render(stdout, args.format, &meta, affected)
	}
	output, err := os.Create(*args.output)
	if err != nil {
		return fmt.Errorf("creating output file `%s`: %w", *args.output, err)
	}
	defer func() { _ = output.Close() }()
	return render(output, args.format, &meta, affected)
}

// finishWorkspacePair releases both endpoint workspaces. A nil head means the
// head graph was queried in place and there is nothing to retain or clean.
func finishWorkspacePair(
	ctx context.Context,
	base, head *workspace,
	keep bool,
	result []affectedTarget,
	resultErr error,
	stderr io.Writer,
) ([]affectedTarget, error) {
	if keep {
		basePath := base.keep()
		if head == nil {
			_, _ = fmt.Fprintf(stderr, "tdutil: retained base workspace %s; head was queried in place\n", basePath)
		} else {
			headPath := head.keep()
			_, _ = fmt.Fprintf(stderr, "tdutil: retained workspaces %s and %s\n", basePath, headPath)
		}
		return result, resultErr
	}

	baseErr := base.close(ctx)
	if baseErr != nil {
		baseErr = fmt.Errorf("cleaning base workspace: %w", baseErr)
	}
	var headErr error
	if head != nil {
		headErr = head.close(ctx)
		if headErr != nil {
			headErr = fmt.Errorf("cleaning head workspace: %w", headErr)
		}
	}
	cleanupErr := joinAdditionalErrors(baseErr, headErr)
	return result, combineCleanupError(resultErr, cleanupErr)
}

func finishOneWorkspace(
	ctx context.Context,
	workspace *workspace,
	keep bool,
	resultErr error,
	endpoint string,
	stderr io.Writer,
) error {
	if keep {
		path := workspace.keep()
		_, _ = fmt.Fprintf(stderr, "tdutil: retained %s workspace %s\n", endpoint, path)
		return resultErr
	}
	cleanupErr := workspace.close(ctx)
	if cleanupErr != nil {
		cleanupErr = fmt.Errorf("cleaning %s workspace: %w", endpoint, cleanupErr)
	}
	return combineCleanupError(resultErr, cleanupErr)
}

func combineCleanupError(resultErr, cleanupErr error) error {
	if cleanupErr == nil {
		return resultErr
	}
	if resultErr == nil {
		return cleanupErr
	}
	return fmt.Errorf("%v; additionally, workspace cleanup failed: %w", resultErr, cleanupErr)
}

func logProgress(output io.Writer, args *cliArgs, format string, values ...any) {
	if !args.verbose {
		return
	}
	_, _ = fmt.Fprintf(output, "tdutil: "+format+"\n", values...)
}
