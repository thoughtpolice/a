// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func fragment(label string, srcs []string, imports map[string]any, types ...string) *Fragment {
	typeList := []any{}
	for _, t := range types {
		typeList = append(typeList, t)
	}
	return &Fragment{
		Label: label,
		Srcs:  srcs,
		Files: srcs,
		Config: map[string]any{
			"lock":            false,
			"imports":         imports,
			"compilerOptions": map[string]any{"strict": true, "types": typeList},
		},
	}
}

func TestMergeUnionsImportsAndTypes(t *testing.T) {
	a := fragment("//a:a", nil, map[string]any{"@a": "./a/mod.ts", "cloudflare:x": "cloudflare:x"}, "./types/celld.d.ts")
	b := fragment("//b:b", nil, map[string]any{"@b": "./b/mod.ts", "@a": "./a/mod.ts"}, "./types/celld.d.ts", "./b/extra.d.ts")
	var warnings []string
	got := Merge("/repo", []*Fragment{a, b}, func(w string) { warnings = append(warnings, w) })
	want := map[string]any{
		"lock": false,
		"imports": map[string]string{
			"@a":           "/repo/a/mod.ts",
			"@b":           "/repo/b/mod.ts",
			"cloudflare:x": "cloudflare:x",
		},
		"compilerOptions": map[string]any{
			"strict": true,
			"types":  []string{"/repo/types/celld.d.ts", "/repo/b/extra.d.ts"},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged config\n got %#v\nwant %#v", got, want)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings %q", warnings)
	}
}

func TestMergeCollisionKeepsTheFirst(t *testing.T) {
	a := fragment("//a:a", nil, map[string]any{"@x": "./a/mod.ts"})
	b := fragment("//b:b", nil, map[string]any{"@x": "./b/mod.ts"})
	var warnings []string
	got := Merge("/repo", []*Fragment{a, b}, func(w string) { warnings = append(warnings, w) })
	if imports := got["imports"].(map[string]string); imports["@x"] != "/repo/a/mod.ts" {
		t.Fatalf("@x -> %s, want the first fragment's file", imports["@x"])
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "//a:a") || !strings.Contains(warnings[0], "//b:b") {
		t.Fatalf("warnings %q should name both units", warnings)
	}
}

func TestMergeOfNothingIsEmpty(t *testing.T) {
	if got := Merge("/repo", nil, func(string) {}); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestWriteConfigOnlyWritesChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "deno.json")
	for i, want := range []bool{true, false} {
		changed, err := WriteConfig(path, map[string]any{"a": 1})
		if err != nil || changed != want {
			t.Fatalf("write %d: changed=%v err=%v, want changed=%v", i, changed, err, want)
		}
	}
	if changed, _ := WriteConfig(path, map[string]any{"a": 2}); !changed {
		t.Fatal("a different config was not written")
	}
}

// end is one side of a pipe pair speaking the base protocol.
type end struct {
	t        *testing.T
	w        io.WriteCloser
	messages chan map[string]any
}

func newEnd(t *testing.T, r io.Reader, w io.WriteCloser) *end {
	e := &end{t: t, w: w, messages: make(chan map[string]any, 100)}
	go func() {
		reader := bufio.NewReader(r)
		for {
			body, err := ReadMessage(reader)
			if err != nil {
				close(e.messages)
				return
			}
			message, err := decode(body)
			if err != nil {
				t.Errorf("bad message %s", body)
				continue
			}
			e.messages <- message
		}
	}()
	return e
}

func (e *end) send(message map[string]any) {
	message["jsonrpc"] = "2.0"
	body, _ := json.Marshal(message)
	if err := WriteMessage(e.w, body); err != nil {
		e.t.Fatal(err)
	}
}

// next returns the next message satisfying match, skipping others.
func (e *end) next(match func(map[string]any) bool) map[string]any {
	e.t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case message, ok := <-e.messages:
			if !ok {
				e.t.Fatal("stream closed")
			}
			if match(message) {
				return message
			}
		case <-timeout:
			e.t.Fatal("timed out waiting for a message")
		}
	}
}

func method(name string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["method"] == name }
}

// quiet fails if a message satisfying match arrives within a moment.
func (e *end) quiet(match func(map[string]any) bool) {
	e.t.Helper()
	timeout := time.After(300 * time.Millisecond)
	for {
		select {
		case message := <-e.messages:
			if match(message) {
				e.t.Fatalf("unexpected message %v", message)
			}
		case <-timeout:
			return
		}
	}
}

type harness struct {
	proxy    *Proxy
	client   *end
	server   *end
	discover *StaticDiscoverer
	rounds   chan struct{}
	root     string
}

// gated makes a Discoverer wait until the test lets it go.
type gated struct {
	Discoverer
	gate chan struct{}
}

func (g *gated) Discover(files []string) ([]*Fragment, error) {
	<-g.gate
	return g.Discoverer.Discover(files)
}

func newHarness(t *testing.T, fragments ...*Fragment) *harness {
	root := t.TempDir()
	for _, f := range fragments {
		for _, src := range f.Srcs {
			path := filepath.Join(root, src)
			os.MkdirAll(filepath.Dir(path), 0o755)
			os.WriteFile(path, []byte("export {};\n"), 0o644)
		}
	}
	h := &harness{root: root, rounds: make(chan struct{}, 10)}
	h.discover = &StaticDiscoverer{Root: root, Fragments: fragments}
	h.proxy = &Proxy{
		Root:         root,
		ConfigPath:   filepath.Join(root, "buck-out", "lsp", "deno.json"),
		Discover:     h.discover,
		OnDiscovered: func() { h.rounds <- struct{}{} },
	}
	clientIn, toProxy := io.Pipe()
	fromProxy, clientOut := io.Pipe()
	serverIn, toServer := io.Pipe()
	fromServer, serverOut := io.Pipe()
	h.client = newEnd(t, fromProxy, toProxy)
	h.server = newEnd(t, serverIn, serverOut)
	go h.proxy.Run(clientIn, clientOut, toServer, fromServer)
	t.Cleanup(func() {
		toProxy.Close()
		serverOut.Close()
	})
	return h
}

func (h *harness) round(t *testing.T) {
	t.Helper()
	select {
	case <-h.rounds:
	case <-time.After(10 * time.Second):
		t.Fatal("no discovery round")
	}
}

func (h *harness) open(path string) {
	h.client.send(map[string]any{
		"method": "textDocument/didOpen",
		"params": map[string]any{"textDocument": map[string]any{
			"uri": pathURI(filepath.Join(h.root, path)), "languageId": "typescript", "version": 1, "text": "",
		}},
	})
}

func (h *harness) initialize(dynamic bool) map[string]any {
	h.client.send(map[string]any{
		"id":     1,
		"method": "initialize",
		"params": map[string]any{
			"initializationOptions": map[string]any{"enable": true, "lint": false},
			"capabilities": map[string]any{"workspace": map[string]any{
				"configuration":         true,
				"didChangeWatchedFiles": map[string]any{"dynamicRegistration": dynamic},
			}},
		},
	})
	return h.server.next(method("initialize"))
}

func TestInitializeKeepsOptionsAndAddsConfig(t *testing.T) {
	h := newHarness(t)
	got := object(h.initialize(false)["params"])["initializationOptions"]
	want := map[string]any{"enable": true, "lint": false, "config": h.proxy.ConfigPath}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("initializationOptions %v, want %v", got, want)
	}
	if _, err := os.Stat(h.proxy.ConfigPath); err != nil {
		t.Fatalf("no config before the server starts: %v", err)
	}
}

func TestConfigurationAnswersCarryTheConfig(t *testing.T) {
	h := newHarness(t)
	h.initialize(false)
	h.server.send(map[string]any{"id": 7, "method": "workspace/configuration", "params": map[string]any{
		"items": []any{
			map[string]any{"section": "deno"},
			map[string]any{"section": "typescript"},
			map[string]any{"section": "deno", "scopeUri": "file:///x"},
		},
	}})
	h.client.next(method("workspace/configuration"))
	h.client.send(map[string]any{"id": 7, "result": []any{
		map[string]any{"enable": true, "unstable": []any{"kv"}},
		map[string]any{"inlayHints": 1},
		nil,
	}})
	got := h.server.next(func(m map[string]any) bool { return m["method"] == nil })["result"]
	config := h.proxy.ConfigPath
	want := []any{
		map[string]any{"enable": true, "unstable": []any{"kv"}, "config": config},
		map[string]any{"inlayHints": json.Number("1")},
		map[string]any{"config": config},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("result %#v, want %#v", got, want)
	}
}

func TestDidChangeConfigurationCarriesTheConfig(t *testing.T) {
	h := newHarness(t)
	h.initialize(false)
	h.client.send(map[string]any{"method": "workspace/didChangeConfiguration", "params": map[string]any{
		"settings": map[string]any{"deno": map[string]any{"enable": true}},
	}})
	got := h.server.next(method("workspace/didChangeConfiguration"))
	deno := object(object(object(got["params"])["settings"])["deno"])
	if deno["config"] != h.proxy.ConfigPath || deno["enable"] != true {
		t.Fatalf("settings %v", deno)
	}
}

func TestOpeningAFileDiscoversItsUnitAndReloads(t *testing.T) {
	lib := fragment("//lib:lib", []string{"lib/mod.ts"}, map[string]any{"@lib": "./lib/mod.ts"}, "./types.d.ts")
	app := fragment("//app:app", []string{"app/main.ts", "app/util.ts"}, map[string]any{"@lib": "./lib/mod.ts"}, "./types.d.ts")
	app.Files = []string{"app/main.ts", "app/util.ts", "lib/mod.ts"}
	h := newHarness(t, lib, app)
	h.initialize(false)
	h.client.send(map[string]any{"method": "initialized", "params": map[string]any{}})
	h.server.next(method("initialized"))

	h.open("app/main.ts")
	h.server.next(method("textDocument/didOpen"))
	h.round(t)
	reload := h.server.next(method("workspace/didChangeWatchedFiles"))
	changes := object(reload["params"])["changes"].([]any)
	if object(changes[0])["uri"] != pathURI(h.proxy.ConfigPath) {
		t.Fatalf("reload names %v", changes)
	}
	data, _ := os.ReadFile(h.proxy.ConfigPath)
	var config map[string]any
	json.Unmarshal(data, &config)
	if object(config["imports"])["@lib"] != filepath.Join(h.root, "lib/mod.ts") {
		t.Fatalf("config %s", data)
	}

	// Same directory, and a file of the closure: both already answered.
	h.open("app/util.ts")
	h.open("lib/mod.ts")
	h.server.quiet(method("workspace/didChangeWatchedFiles"))
	if calls := h.discover.Calls(); len(calls) != 1 {
		t.Fatalf("discovery ran %d times: %v", len(calls), calls)
	}
}

func TestFilesOutsideTheProjectAreNotLookedUp(t *testing.T) {
	h := newHarness(t)
	h.initialize(false)
	h.client.send(map[string]any{"method": "textDocument/didOpen", "params": map[string]any{"textDocument": map[string]any{
		"uri": "file:///elsewhere/x.ts", "languageId": "typescript", "version": 1, "text": "",
	}}})
	os.MkdirAll(filepath.Join(h.root, "buck-out"), 0o755)
	os.WriteFile(filepath.Join(h.root, "buck-out", "gen.ts"), nil, 0o644)
	h.open("buck-out/gen.ts")
	h.open("missing.ts")
	h.server.next(method("textDocument/didOpen"))
	h.server.quiet(method("workspace/didChangeWatchedFiles"))
	if calls := h.discover.Calls(); len(calls) != 0 {
		t.Fatalf("discovery ran: %v", calls)
	}
}

func TestBuildFileChangesRediscover(t *testing.T) {
	app := fragment("//app:app", []string{"app/main.ts"}, map[string]any{"@a": "./app/main.ts"})
	h := newHarness(t, app)
	h.initialize(true)
	h.client.send(map[string]any{"method": "initialized", "params": map[string]any{}})
	register := h.client.next(method("client/registerCapability"))
	// The editor's answer is the proxy's, not the server's.
	h.client.send(map[string]any{"id": register["id"], "result": nil})

	h.open("app/main.ts")
	h.round(t)
	h.server.next(method("workspace/didChangeWatchedFiles"))

	// The unit's exports change; the editor reports the BUILD file.
	app.Config["imports"] = map[string]any{"@b": "./app/main.ts"}
	h.client.send(map[string]any{"method": "workspace/didChangeWatchedFiles", "params": map[string]any{
		"changes": []any{map[string]any{"uri": pathURI(filepath.Join(h.root, "app", "BUILD")), "type": 2}},
	}})
	h.round(t)
	h.server.next(func(m map[string]any) bool {
		if m["method"] != "workspace/didChangeWatchedFiles" {
			return false
		}
		changes := object(m["params"])["changes"].([]any)
		return object(changes[0])["uri"] == pathURI(h.proxy.ConfigPath)
	})
	data, _ := os.ReadFile(h.proxy.ConfigPath)
	if !strings.Contains(string(data), `"@b"`) || strings.Contains(string(data), `"@a"`) {
		t.Fatalf("config after the BUILD change: %s", data)
	}
	if calls := h.discover.Calls(); len(calls) != 2 {
		t.Fatalf("discovery calls %v", calls)
	}
}

func TestResponsesToTheProxyAreNotForwarded(t *testing.T) {
	h := newHarness(t)
	h.initialize(true)
	h.client.send(map[string]any{"method": "initialized", "params": map[string]any{}})
	register := h.client.next(method("client/registerCapability"))
	if !strings.HasPrefix(register["id"].(string), ownRequest) {
		t.Fatalf("id %v", register["id"])
	}
	h.client.send(map[string]any{"id": register["id"], "result": nil})
	h.client.send(map[string]any{"id": 99, "result": nil})
	got := h.server.next(func(m map[string]any) bool { return m["method"] == nil })
	if got["id"] != json.Number("99") {
		t.Fatalf("forwarded %v", got)
	}
}

func TestDocumentsWaitForTheirDiscovery(t *testing.T) {
	app := fragment("//app:app", []string{"app/main.ts"}, map[string]any{"@a": "./app/main.ts"})
	h := newHarness(t, app)
	gate := make(chan struct{})
	h.proxy.Discover = &gated{h.discover, gate}
	h.proxy.Hold = time.Minute
	h.initialize(false)

	h.open("app/main.ts")
	uri := pathURI(filepath.Join(h.root, "app", "main.ts"))
	h.client.send(map[string]any{"id": 2, "method": "textDocument/hover", "params": map[string]any{
		"textDocument": map[string]any{"uri": uri}, "position": map[string]any{"line": 0, "character": 0},
	}})
	h.client.send(map[string]any{"id": 3, "method": "workspace/symbol", "params": map[string]any{"query": ""}})
	// Other traffic flows while the document waits.
	h.server.next(method("workspace/symbol"))
	h.server.quiet(func(m map[string]any) bool { return m["method"] == "textDocument/didOpen" })

	close(gate)
	h.round(t)
	h.server.next(method("workspace/didChangeWatchedFiles"))
	// Not until the server has reloaded the config.
	h.server.quiet(func(m map[string]any) bool { return m["method"] == "textDocument/didOpen" })
	h.server.send(map[string]any{"method": "deno/didChangeDenoConfiguration", "params": map[string]any{
		"changes": []any{map[string]any{"fileUri": pathURI(h.proxy.ConfigPath), "type": "changed", "configurationType": "denoJson"}},
	}})
	h.client.next(method("deno/didChangeDenoConfiguration"))
	var order []string
	for len(order) < 2 {
		m := h.server.next(func(map[string]any) bool { return true })
		order = append(order, m["method"].(string))
	}
	want := []string{"textDocument/didOpen", "textDocument/hover"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("server saw %v, want %v", order, want)
	}
}

func TestHeldDocumentsGoOnAfterTheHold(t *testing.T) {
	app := fragment("//app:app", []string{"app/main.ts"}, nil)
	h := newHarness(t, app)
	gate := make(chan struct{})
	h.proxy.Discover = &gated{h.discover, gate}
	h.proxy.Hold = 100 * time.Millisecond
	h.initialize(false)
	h.open("app/main.ts")
	h.server.next(method("textDocument/didOpen"))
	// Let the round finish before the temporary directory goes.
	close(gate)
	h.round(t)
}

func TestPruneStaleKeepsLiveProxies(t *testing.T) {
	state := t.TempDir()
	live := strconv.Itoa(os.Getpid())
	// Beyond the default pid_max, so no process has it.
	dead := "4194305"
	for _, name := range []string{live, dead, "command"} {
		if err := os.Mkdir(filepath.Join(state, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	pruneStale(state)
	for name, want := range map[string]bool{live: true, dead: false, "command": true} {
		_, err := os.Stat(filepath.Join(state, name))
		if got := err == nil; got != want {
			t.Errorf("%s exists = %v, want %v", name, got, want)
		}
	}
}
