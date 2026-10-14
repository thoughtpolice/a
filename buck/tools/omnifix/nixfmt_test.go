// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"reflect"
	"testing"
)

func TestNixFormatter(t *testing.T) {
	var gotName, gotStdin string
	var gotArgs []string
	runner := func(_ context.Context, name string, args []string, stdin string) (string, string, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		gotStdin = stdin
		return "{ pkgs, ... }:\n{\n  environment.systemPackages = [ pkgs.hello ];\n}\n", "", nil
	}
	formatter := newNixFormatter(runner)

	if !formatter.handles("nix/flake.nix") {
		t.Fatal("Nix formatter did not handle a Nix source file")
	}
	if formatter.handles("nix/flake.lock") {
		t.Fatal("Nix formatter handled a non-Nix source file")
	}
	input := "{pkgs,...}:{environment.systemPackages=[pkgs.hello];}"
	got, err := formatter.format(context.Background(), "nix/flake.nix", input)
	if err != nil {
		t.Fatal(err)
	}
	if want := "{ pkgs, ... }:\n{\n  environment.systemPackages = [ pkgs.hello ];\n}\n"; got != want {
		t.Fatalf("format() = %q, want %q", got, want)
	}
	if gotName != "nixfmt" || gotStdin != input {
		t.Fatalf("runner got command %q and stdin %q", gotName, gotStdin)
	}
	if want := []string{"--filename=nix/flake.nix", "-"}; !reflect.DeepEqual(gotArgs, want) {
		t.Fatalf("runner args = %#v, want %#v", gotArgs, want)
	}
}
