// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// nugetify generates third-party//csharp from nuget.toml, the way reindeer
// generates third-party//rust from Cargo.toml: `buckify` resolves the
// manifest against nuget.org into nuget.lock and writes the BUILD file from
// the lock, and `check` verifies that the three files still agree.
package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	manifestName = "nuget.toml"
	lockName     = "nuget.lock"
	buildName    = "BUILD"
	defaultDir   = "buck/third-party/csharp"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(realMain(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func usage(stderr io.Writer, flags *flag.FlagSet) {
	fmt.Fprintln(stderr, "Usage: nugetify [flags] buckify")
	fmt.Fprintln(stderr, "       nugetify [flags] check [-manifest FILE] [-lock FILE] [-build FILE]")
	fmt.Fprintln(stderr, "buckify resolves nuget.toml into nuget.lock and regenerates BUILD;")
	fmt.Fprintln(stderr, "check exits 1 when the manifest, the lock and BUILD disagree.")
	flags.PrintDefaults()
}

func realMain(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("nugetify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	dir := flags.String("third-party-dir", "", "directory holding nuget.toml (default: "+defaultDir+" under the repository root)")
	source := flags.String("source", defaultFlatContainer, "NuGet V3 flat-container base URL")
	cache := flags.String("cache", "", "directory to keep downloaded packages in (default: nugetify under the user cache directory)")
	relock := flags.Bool("relock", false, "resolve again even when nuget.lock already matches nuget.toml")
	flags.Usage = func() { usage(stderr, flags) }
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	rest := flags.Args()
	if len(rest) == 0 {
		usage(stderr, flags)
		return 2
	}
	switch rest[0] {
	case "buckify":
		if len(rest) != 1 {
			fmt.Fprintln(stderr, "ERROR: buckify takes no arguments")
			return 2
		}
		root, err := resolveDir(*dir)
		if err != nil {
			fmt.Fprintf(stderr, "ERROR: %v\n", err)
			return 2
		}
		cacheDir, err := resolveCache(*cache)
		if err != nil {
			fmt.Fprintf(stderr, "ERROR: %v\n", err)
			return 2
		}
		if err := buckify(ctx, root, newFlatContainer(*source, cacheDir, stderr), *relock, stdout); err != nil {
			fmt.Fprintf(stderr, "ERROR: %v\n", err)
			return 1
		}
		return 0
	case "check":
		checkFlags := flag.NewFlagSet("nugetify check", flag.ContinueOnError)
		checkFlags.SetOutput(stderr)
		manifestPath := checkFlags.String("manifest", "", "nuget.toml to check (default: in the third-party directory)")
		lockPath := checkFlags.String("lock", "", "nuget.lock to check")
		buildPath := checkFlags.String("build", "", "BUILD file to check")
		if err := checkFlags.Parse(rest[1:]); err != nil {
			return 2
		}
		if *manifestPath == "" || *lockPath == "" || *buildPath == "" {
			root, err := resolveDir(*dir)
			if err != nil {
				fmt.Fprintf(stderr, "ERROR: %v\n", err)
				return 2
			}
			if *manifestPath == "" {
				*manifestPath = filepath.Join(root, manifestName)
			}
			if *lockPath == "" {
				*lockPath = filepath.Join(root, lockName)
			}
			if *buildPath == "" {
				*buildPath = filepath.Join(root, buildName)
			}
		}
		if err := check(*manifestPath, *lockPath, *buildPath); err != nil {
			fmt.Fprintf(stderr, "ERROR: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, "nuget.toml, nuget.lock and BUILD agree.")
		return 0
	}
	fmt.Fprintf(stderr, "ERROR: unknown command %q\n", rest[0])
	usage(stderr, flags)
	return 2
}

// resolveDir finds the third-party directory: the flag as given, or the
// default under the repository root, found by walking up from the working
// directory to the .buckconfig, so the tool works from any subdirectory.
func resolveDir(flagValue string) (string, error) {
	if flagValue != "" {
		return flagValue, nil
	}
	current, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(current, ".buckconfig")); err == nil {
			return filepath.Join(current, filepath.FromSlash(defaultDir)), nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("no .buckconfig above the working directory; pass -third-party-dir")
		}
		current = parent
	}
}

func resolveCache(flagValue string) (string, error) {
	if flagValue != "" {
		return flagValue, nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("no user cache directory; pass -cache: %w", err)
	}
	return filepath.Join(base, "nugetify"), nil
}

func buckify(ctx context.Context, dir string, source packageSource, relock bool, stdout io.Writer) error {
	m, err := loadManifest(filepath.Join(dir, manifestName))
	if err != nil {
		return err
	}
	lockPath := filepath.Join(dir, lockName)
	var lock *lockFile
	if !relock {
		existing, err := loadLock(lockPath)
		switch {
		case err == nil && existing.matches(m):
			lock = existing
			fmt.Fprintf(stdout, "%s matches %s; not resolving again.\n", lockName, manifestName)
		case err != nil && !errors.Is(err, os.ErrNotExist):
			return err
		}
	}
	if lock == nil {
		if lock, err = resolve(ctx, source, m); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "Resolved %d packages for %s.\n", len(lock.Packages), lock.Framework.TFM)
	}
	encoded, err := lock.encode()
	if err != nil {
		return err
	}
	if err := writeIfChanged(lockPath, encoded, stdout); err != nil {
		return err
	}
	return writeIfChanged(filepath.Join(dir, buildName), []byte(emitBuild(lock)), stdout)
}

func writeIfChanged(path string, content []byte, stdout io.Writer) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, content) {
		fmt.Fprintf(stdout, "%s is up to date.\n", path)
		return nil
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Wrote %s.\n", path)
	return nil
}

func check(manifestPath, lockPath, buildPath string) error {
	m, err := loadManifest(manifestPath)
	if err != nil {
		return err
	}
	lock, err := loadLock(lockPath)
	if err != nil {
		return err
	}
	if !lock.matches(m) {
		return fmt.Errorf("%s was not resolved from %s; run `buck2 run root//buck/tools/nugetify -- buckify`", lockPath, manifestPath)
	}
	build, err := os.ReadFile(buildPath)
	if err != nil {
		return err
	}
	if want := emitBuild(lock); string(build) != want {
		return fmt.Errorf("%s differs from what %s generates; run `buck2 run root//buck/tools/nugetify -- buckify`:\n%s", buildPath, lockPath, firstDifference(string(build), want))
	}
	return nil
}

// firstDifference points at the first line where two renderings diverge.
func firstDifference(have, want string) string {
	haveLines := strings.Split(have, "\n")
	wantLines := strings.Split(want, "\n")
	for index := 0; index < len(haveLines) || index < len(wantLines); index++ {
		var haveLine, wantLine string
		if index < len(haveLines) {
			haveLine = haveLines[index]
		}
		if index < len(wantLines) {
			wantLine = wantLines[index]
		}
		if haveLine != wantLine {
			return fmt.Sprintf("line %d:\n  have: %s\n  want: %s", index+1, haveLine, wantLine)
		}
	}
	return "(identical)"
}
