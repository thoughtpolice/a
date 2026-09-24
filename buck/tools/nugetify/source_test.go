// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseManifestSources(t *testing.T) {
	m, err := parseManifest(strings.NewReader(`[framework]
package = "P"
version = "1.0"

[sources]
dotnet-tools = "https://example.test/flat2"
`))
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Sources) != 1 || m.Sources[0] != "https://example.test/flat2/" {
		t.Fatalf("sources = %v", m.Sources)
	}
	if _, err := parseManifest(strings.NewReader("[framework]\npackage = \"P\"\nversion = \"1.0\"\n[sources]\nplain = \"http://example.test/\"\n")); err == nil {
		t.Fatal("an http source was accepted")
	}
}

// Packages come from nuget.org when it has them, and from the manifest's
// feeds, in order, when it answers 404; the origin names the feed.
func TestFlatContainerFallsBackToOtherFeeds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/main/common/1.0.0/common.1.0.0.nupkg":
			io.WriteString(writer, "common")
		case "/feed/rc/2.0.0-1/rc.2.0.0-1.nupkg":
			io.WriteString(writer, "rc")
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	feeds := newFlatContainer(server.URL+"/main", t.TempDir(), io.Discard)
	feeds.client = server.Client()
	feeds.extra = []string{server.URL + "/empty/", server.URL + "/feed/"}

	data, origin, err := feeds.fetch(context.Background(), "Common", "1.0.0")
	if err != nil || string(data) != "common" || origin != "" {
		t.Fatalf("nuget.org: %q %q %v", data, origin, err)
	}
	data, origin, err = feeds.fetch(context.Background(), "RC", "2.0.0-1")
	if err != nil || string(data) != "rc" || origin != server.URL+"/feed/" {
		t.Fatalf("feed: %q %q %v", data, origin, err)
	}
	// Cached by feed, so the origin survives a second resolution.
	data, origin, err = feeds.fetch(context.Background(), "RC", "2.0.0-1")
	if err != nil || string(data) != "rc" || origin != server.URL+"/feed/" {
		t.Fatalf("cached feed: %q %q %v", data, origin, err)
	}
	if _, _, err := feeds.fetch(context.Background(), "Missing", "1.0.0"); err == nil {
		t.Fatal("a missing package was found")
	}
}

func TestLockRecordsAndChecksSources(t *testing.T) {
	source := exampleGraph(t)
	source.origins = map[string]string{"top.csharp@5.9.0": "https://example.test/feed/"}
	m := &manifest{
		Framework: refPack(t, source),
		Packages:  []packageRef{{ID: "Top.CSharp", Version: "5.9.0"}},
		Sources:   []string{"https://example.test/feed/"},
	}
	lock, err := resolve(context.Background(), source, m)
	if err != nil {
		t.Fatal(err)
	}
	if lock.find("Top.CSharp").Source != "https://example.test/feed/" || lock.find("Top.Common").Source != "" {
		t.Fatalf("sources = %+v", lock.Packages)
	}
	if !lock.matches(m) {
		t.Fatal("the lock does not match its manifest")
	}
	m.Sources = nil
	if lock.matches(m) {
		t.Fatal("a lock with a feed the manifest no longer lists matches it")
	}
	if !strings.Contains(emitBuild(lock), "    source = \"https://example.test/feed/\",\n") {
		t.Fatalf("BUILD without the source:\n%s", emitBuild(lock))
	}
}

// A package from another feed is fetched with GET, checked and unpacked.
func TestFetchPackageChecksAndUnpacks(t *testing.T) {
	data := makeNupkg(t, "Feed.Only", "1.0.0-1", nil, "lib/net10.0/Feed.Only.dll=assembly")
	sum := sha256.Sum256(data)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			http.Error(writer, "GET only", http.StatusMethodNotAllowed)
			return
		}
		writer.Write(data)
	}))
	defer server.Close()
	output := t.TempDir()
	if err := fetchPackage(context.Background(), server.URL+"/p.nupkg", hex.EncodeToString(sum[:]), output); err != nil {
		t.Fatal(err)
	}
	if contents, err := os.ReadFile(filepath.Join(output, "lib", "net10.0", "Feed.Only.dll")); err != nil || string(contents) != "assembly" {
		t.Fatalf("unpacked %q, %v", contents, err)
	}
	if err := fetchPackage(context.Background(), server.URL+"/p.nupkg", strings.Repeat("0", 64), t.TempDir()); err == nil {
		t.Fatal("a package with the wrong hash was unpacked")
	}
}
