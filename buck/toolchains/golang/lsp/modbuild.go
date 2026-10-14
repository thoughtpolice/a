// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Command modbuild builds a Go command from its module's source with the go
// command, offline: modules come from a directory laid out as a module proxy,
// checked against the module's go.sum, and nothing else is fetched.
//
// The go command wants absolute paths in GOPROXY and the cache variables, and
// a Buck action only knows its inputs by relative ones, hence this wrapper.
//
// Usage:
//
//	modbuild -go GO -proxy DIR -src DIR -o FILE [-goos GOOS] [-goarch GOARCH] [-ldflags FLAGS] [PACKAGE]
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	goBin := flag.String("go", "", "the go command")
	proxy := flag.String("proxy", "", "the module proxy directory")
	src := flag.String("src", "", "the main module's source")
	out := flag.String("o", "", "the binary to write")
	goos := flag.String("goos", "", "GOOS to build for")
	goarch := flag.String("goarch", "", "GOARCH to build for")
	ldflags := flag.String("ldflags", "", "flags for the linker")
	flag.Parse()
	if *goBin == "" || *proxy == "" || *src == "" || *out == "" || flag.NArg() > 1 {
		fatalf("usage: modbuild -go GO -proxy DIR -src DIR -o FILE [-goos GOOS] [-goarch GOARCH] [-ldflags FLAGS] [PACKAGE]")
	}
	pkg := "."
	if flag.NArg() == 1 {
		pkg = flag.Arg(0)
	}

	// Buck gives every action a scratch directory; outside of one, make one.
	scratch := os.Getenv("BUCK_SCRATCH_PATH")
	if scratch == "" {
		dir, err := os.MkdirTemp("", "modbuild-")
		if err != nil {
			fatalf("%v", err)
		}
		defer os.RemoveAll(dir)
		scratch = dir
	}
	scratch = abs(scratch)

	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + scratch,
		"TMPDIR=" + scratch,
		// Each variable the go command would otherwise take from the user's
		// go env file, the network, or a newer toolchain it downloads.
		"GOENV=off",
		"GOTOOLCHAIN=local",
		"GOTELEMETRY=off",
		"GO111MODULE=on",
		"GOWORK=off",
		"GOPROXY=file://" + filepath.ToSlash(abs(*proxy)),
		"GOSUMDB=off",
		// -modcacherw leaves the extracted modules deletable, so Buck can clear
		// the scratch directory afterwards.
		"GOFLAGS=-mod=readonly -modcacherw",
		"GOPATH=" + filepath.Join(scratch, "gopath"),
		"GOMODCACHE=" + filepath.Join(scratch, "modcache"),
		"GOCACHE=" + filepath.Join(scratch, "cache"),
		"CGO_ENABLED=0",
	}
	if *goos != "" {
		env = append(env, "GOOS="+*goos)
	}
	if *goarch != "" {
		env = append(env, "GOARCH="+*goarch)
	}

	cmd := exec.Command(abs(*goBin), "-C", abs(*src), "build", "-trimpath", "-buildvcs=false", "-ldflags="+*ldflags, "-o", abs(*out), pkg)
	cmd.Env = env
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fatalf("%v", err)
	}
}

func abs(path string) string {
	p, err := filepath.Abs(path)
	if err != nil {
		fatalf("%v", err)
	}
	return p
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "modbuild: "+format+"\n", args...)
	os.Exit(1)
}
