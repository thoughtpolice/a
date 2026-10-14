// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// oci builds, inspects, and moves OCI images for the rules in
// buck/lib/oci and buck/lib/tar. It reads and writes OCI image layouts
// directly, speaks the registry HTTP API itself, and needs nothing but Go's
// standard library and golang.org/x, so the toolchain has no skopeo, umoci,
// patchelf or Python behind it. See buck/lib/oci/README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
)

type command struct {
	summary string
	run     func(ctx context.Context, args []string, stdout, stderr io.Writer) error
}

var commands = map[string]command{
	"archive":      {"write a layout's image as a tar that docker load accepts", runArchive},
	"image":        {"stack layers and configuration on a base image", runImage},
	"index":        {"combine single-platform images into one multi-platform index", runIndex},
	"load":         {"load a layout's image into the docker daemon", runLoad},
	"native-layer": {"package a native ELF executable and its Nix runtime as a layer", runNativeLayer},
	"pull":         {"copy an image from a registry into a layout", runPull},
	"push":         {"copy a layout's image to registries, layouts or archives", runPush},
	"repack":       {"turn a bundle's root filesystem back into an image", runRepack},
	"smoke":        {"run an image under docker until it logs readiness", runSmoke},
	"tar":          {"write a reproducible tar of files and directories", runTar},
	"unpack":       {"apply an image's layers to a root filesystem bundle", runUnpack},
	"validate":     {"check a layout's descriptors, digests and configs", runValidate},
}

// usageError is reported with the command's usage rather than as a failure.
type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

func usagef(format string, args ...any) error {
	return usageError{fmt.Sprintf(format, args...)}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		usage(stderr)
		if len(args) == 0 {
			return 2
		}
		return 0
	}
	name := args[0]
	cmd, ok := commands[name]
	if !ok {
		fmt.Fprintf(stderr, "oci: unknown command %q\n\n", name)
		usage(stderr)
		return 2
	}
	err := cmd.run(ctx, args[1:], stdout, stderr)
	switch {
	case err == nil:
		return 0
	case errors.Is(err, flag.ErrHelp):
		return 0
	case errors.As(err, new(usageError)):
		fmt.Fprintf(stderr, "oci %s: %v\n", name, err)
		return 2
	default:
		fmt.Fprintf(stderr, "oci %s: %v\n", name, err)
		return 1
	}
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: oci COMMAND [FLAGS]")
	fmt.Fprintln(w)
	names := make([]string, 0, len(commands))
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(w, "  %-12s %s\n", name, commands[name].summary)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Run 'oci COMMAND -h' for a command's flags.")
}

// newFlags returns a flag set whose parse errors come back as usage errors.
func newFlags(name, synopsis string, stderr io.Writer) *flag.FlagSet {
	flags := flag.NewFlagSet("oci "+name, flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {
		fmt.Fprintf(stderr, "usage: oci %s %s\n\n", name, synopsis)
		flags.PrintDefaults()
	}
	return flags
}

func parseFlags(flags *flag.FlagSet, args []string) error {
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		// The flag package has already printed the problem and the usage.
		return usageError{"invalid arguments"}
	}
	return nil
}

// required reports the first named flag that was left empty.
func required(flags *flag.FlagSet, names ...string) error {
	for _, name := range names {
		if flags.Lookup(name).Value.String() == "" {
			return usagef("--%s is required", name)
		}
	}
	return nil
}

// listFlag collects every use of a repeatable flag, in order.
type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }

func (l *listFlag) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// keyValues splits KEY=VALUE arguments, keeping their order.
func keyValues(flagName string, values []string) ([][2]string, error) {
	pairs := make([][2]string, 0, len(values))
	for _, v := range values {
		key, value, ok := strings.Cut(v, "=")
		if !ok || key == "" {
			return nil, usagef("--%s %q is not KEY=VALUE", flagName, v)
		}
		pairs = append(pairs, [2]string{key, value})
	}
	return pairs, nil
}
