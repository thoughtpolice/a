// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

// The proxy in front of the real `deno lsp`, serving the fixture package
// buck/toolchains/celld/tests/lib from its units' `[ide]` fragments
// (CELLD_FRAGMENTS) with the toolchain's Deno (CELLD_DENO). The sources are
// copied into a temporary project so the test can add files.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const fixture = "buck/toolchains/celld/tests/lib"

func copyFile(t *testing.T, from, to string) {
	data, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Dir(to), 0o755)
	if err := os.WriteFile(to, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, text string) {
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// lspClient is an editor: it answers the server's requests and records
// diagnostics.
type lspClient struct {
	t           *testing.T
	w           io.Writer
	mu          sync.Mutex
	diagnostics map[string][]map[string]any
	updated     map[string]time.Time
	responses   chan map[string]any
	nextID      int
}

func (c *lspClient) send(message map[string]any) {
	message["jsonrpc"] = "2.0"
	body, _ := json.Marshal(message)
	c.mu.Lock()
	defer c.mu.Unlock()
	WriteMessage(c.w, body)
}

func (c *lspClient) read(r io.Reader) {
	reader := bufio.NewReader(r)
	for {
		body, err := ReadMessage(reader)
		if err != nil {
			close(c.responses)
			return
		}
		var message map[string]any
		json.Unmarshal(body, &message)
		method, _ := message["method"].(string)
		switch {
		case method == "" && message["id"] != nil:
			c.responses <- message
		case method == "workspace/configuration":
			items := object(message["params"])["items"].([]any)
			result := make([]any, len(items))
			for i := range items {
				result[i] = map[string]any{"enable": true, "lint": false}
			}
			c.send(map[string]any{"id": message["id"], "result": result})
		case message["id"] != nil:
			c.send(map[string]any{"id": message["id"], "result": nil})
		case method == "textDocument/publishDiagnostics":
			params := object(message["params"])
			var list []map[string]any
			for _, d := range params["diagnostics"].([]any) {
				list = append(list, object(d))
			}
			c.mu.Lock()
			c.diagnostics[params["uri"].(string)] = list
			c.updated[params["uri"].(string)] = time.Now()
			c.mu.Unlock()
		}
	}
}

func (c *lspClient) request(method string, params map[string]any) any {
	c.t.Helper()
	c.mu.Lock()
	c.nextID++
	id := float64(c.nextID)
	c.mu.Unlock()
	c.send(map[string]any{"id": id, "method": method, "params": params})
	timeout := time.After(60 * time.Second)
	for {
		select {
		case response, ok := <-c.responses:
			if !ok {
				c.t.Fatalf("%s: server went away", method)
			}
			if response["id"] == id {
				return response["result"]
			}
		case <-timeout:
			c.t.Fatalf("%s: no response", method)
		}
	}
}

// settled waits until uri has diagnostics that satisfy ok and then have not
// changed for a few seconds, and returns them.
func (c *lspClient) settled(uri string, ok func([]map[string]any) bool) []map[string]any {
	c.t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		diagnostics, seen := c.diagnostics[uri]
		updated := c.updated[uri]
		c.mu.Unlock()
		if seen && ok(diagnostics) && time.Since(updated) > 3*time.Second {
			return diagnostics
		}
		time.Sleep(100 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t.Fatalf("diagnostics of %s never settled; last %v", uri, c.diagnostics[uri])
	return nil
}

func codes(diagnostics []map[string]any) []any {
	var result []any
	for _, d := range diagnostics {
		result = append(result, d["code"])
	}
	return result
}

func (c *lspClient) open(path string) (string, string) {
	c.t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		c.t.Fatal(err)
	}
	uri := pathURI(path)
	c.send(map[string]any{"method": "textDocument/didOpen", "params": map[string]any{"textDocument": map[string]any{
		"uri": uri, "languageId": "typescript", "version": 1, "text": string(data),
	}}})
	return uri, string(data)
}

func (c *lspClient) definition(uri, text, needle string, offset int) string {
	c.t.Helper()
	for line, content := range strings.Split(text, "\n") {
		if column := strings.Index(content, needle); column >= 0 {
			result, _ := c.request("textDocument/definition", map[string]any{
				"textDocument": map[string]any{"uri": uri},
				"position":     map[string]any{"line": line, "character": column + offset},
			}).([]any)
			if len(result) == 0 {
				c.t.Fatalf("no definition for %q", needle)
			}
			location := object(result[0])
			if target, ok := location["targetUri"].(string); ok {
				return target
			}
			return location["uri"].(string)
		}
	}
	c.t.Fatalf("%q not found", needle)
	return ""
}

func TestDenoLanguageServer(t *testing.T) {
	deno := os.Getenv("CELLD_DENO")
	fragments := strings.Fields(os.Getenv("CELLD_FRAGMENTS"))
	if deno == "" || len(fragments) == 0 {
		t.Skip("CELLD_DENO and CELLD_FRAGMENTS are set by buck2 test")
	}
	// Go tests run in their package's directory; fragment paths are relative
	// to the project root.
	cwd, _ := os.Getwd()
	project, err := findRoot(cwd)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for i, path := range fragments {
		if !filepath.IsAbs(path) {
			path = filepath.Join(project, path)
		}
		fragment, err := LoadFragment(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range fragment.Files {
			copyFile(t, filepath.Join(project, file), filepath.Join(root, file))
		}
		for _, item := range object(fragment.Config["compilerOptions"])["types"].([]any) {
			copyFile(t, filepath.Join(project, item.(string)), filepath.Join(root, item.(string)))
		}
		fragments[i] = path
	}
	package_ := filepath.Join(root, fixture)
	writeFile(t, filepath.Join(package_, "top", "bad.ts"), "export const WRONG: number = \"text\";\n")
	// A Deno package with its own config, which must keep working.
	writeFile(t, filepath.Join(root, "other", "deno.json"), `{"imports": {"@other/z": "./z.ts"}}`+"\n")
	writeFile(t, filepath.Join(root, "other", "z.ts"), "export const z: number = 1;\n")
	writeFile(t, filepath.Join(root, "other", "main.ts"), "import { z } from \"@other/z\";\nconst n: number = z;\nconsole.log(n);\n")

	discover, err := LoadStaticDiscoverer(root, fragments)
	if err != nil {
		t.Fatal(err)
	}
	rounds := make(chan struct{}, 10)
	proxy := &Proxy{
		Root:         root,
		ConfigPath:   filepath.Join(root, "buck-out", "celld-project-lsp", "test", "deno.json"),
		Discover:     discover,
		Hold:         30 * time.Second,
		OnDiscovered: func() { rounds <- struct{}{} },
	}
	if !filepath.IsAbs(deno) {
		deno = filepath.Join(project, deno)
	}
	server := exec.Command(deno, "lsp")
	server.Dir = root
	server.Env = append(os.Environ(), "DENO_NO_UPDATE_CHECK=1", "NO_COLOR=1")
	server.Stderr = os.Stderr
	serverIn, _ := server.StdinPipe()
	serverOut, _ := server.StdoutPipe()
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	clientIn, toProxy := io.Pipe()
	fromProxy, clientOut := io.Pipe()
	go proxy.Run(clientIn, clientOut, serverIn, serverOut)
	client := &lspClient{
		t: t, w: toProxy,
		diagnostics: map[string][]map[string]any{},
		updated:     map[string]time.Time{},
		responses:   make(chan map[string]any, 100),
	}
	go client.read(fromProxy)
	defer func() {
		client.request("shutdown", map[string]any{})
		client.send(map[string]any{"method": "exit"})
		done := make(chan error, 1)
		go func() { done <- server.Wait() }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			server.Process.Kill()
		}
	}()

	rootURI := pathURI(root)
	client.request("initialize", map[string]any{
		"processId":        os.Getpid(),
		"rootUri":          rootURI,
		"workspaceFolders": []any{map[string]any{"uri": rootURI, "name": "root"}},
		"capabilities": map[string]any{"workspace": map[string]any{
			"configuration":         true,
			"didChangeWatchedFiles": map[string]any{"dynamicRegistration": true},
		}},
		"initializationOptions": map[string]any{"enable": true, "lint": false},
	})
	client.send(map[string]any{"method": "initialized", "params": map[string]any{}})

	none := func(d []map[string]any) bool { return len(d) == 0 }
	var topURI, topText string
	t.Run("DiscoveredUnitsResolve", func(t *testing.T) {
		client.t = t
		// Nothing is known yet: the document reaches Deno once discovery has
		// rewritten the config.
		topURI, topText = client.open(filepath.Join(package_, "top", "mod.ts"))
		select {
		case <-rounds:
		case <-time.After(30 * time.Second):
			t.Fatal("no discovery round")
		}
		client.settled(topURI, none)
	})
	t.Run("TypeErrorsAreReported", func(t *testing.T) {
		client.t = t
		uri, _ := client.open(filepath.Join(package_, "top", "bad.ts"))
		client.settled(uri, func(d []map[string]any) bool {
			for _, code := range codes(d) {
				if code == float64(2322) {
					return true
				}
			}
			return false
		})
	})
	t.Run("DefinitionLandsInTheDependency", func(t *testing.T) {
		client.t = t
		got := client.definition(topURI, topText, "double(add(", len("double("))
		if want := pathURI(filepath.Join(package_, "base", "mod.ts")); got != want {
			t.Fatalf("definition in %s, want %s", got, want)
		}
	})
	t.Run("NestedDenoPackagesKeepTheirConfig", func(t *testing.T) {
		client.t = t
		uri, text := client.open(filepath.Join(root, "other", "main.ts"))
		client.settled(uri, none)
		got := client.definition(uri, text, "const n: number = z", len("const n: number = "))
		if want := pathURI(filepath.Join(root, "other", "z.ts")); got != want {
			t.Fatalf("definition in %s, want %s", got, want)
		}
	})
}
