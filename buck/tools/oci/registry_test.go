// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json/v2"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type storedManifest struct {
	mediaType string
	data      []byte
}

// fakeRegistry serves the parts of the distribution API the tool uses,
// with bearer tokens from its own token service. When user is set, the
// token service hands out tokens only for that user's password.
type fakeRegistry struct {
	t        *testing.T
	srv      *httptest.Server
	user     string
	password string

	mu        sync.Mutex
	blobs     map[string][]byte
	manifests map[string]map[string]storedManifest // repository -> tag or digest
	uploads   map[string]string                    // session -> repository
	uploaded  []string                             // digests of blobs pushed
	fail      int                                  // requests to answer with 503 first
}

func newFakeRegistry(t *testing.T) *fakeRegistry {
	r := &fakeRegistry{
		t:         t,
		blobs:     map[string][]byte{},
		manifests: map[string]map[string]storedManifest{},
		uploads:   map[string]string{},
	}
	r.srv = httptest.NewTLSServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.srv.Close)
	oldClient, oldDelay := httpClient, retryDelay
	httpClient, retryDelay = r.srv.Client(), time.Millisecond
	t.Cleanup(func() { httpClient, retryDelay = oldClient, oldDelay })
	// No credentials from the machine running the tests.
	t.Setenv("REGISTRY_AUTH_FILE", "")
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("DOCKER_CONFIG", "")
	return r
}

func (r *fakeRegistry) host() string { return strings.TrimPrefix(r.srv.URL, "https://") }

func (r *fakeRegistry) addBlob(data []byte) Descriptor {
	r.mu.Lock()
	defer r.mu.Unlock()
	d := sha256Digest(data)
	r.blobs[d] = data
	return Descriptor{Digest: d, Size: int64(len(data))}
}

func (r *fakeRegistry) addManifest(repo, ref, mediaType string, data []byte) Descriptor {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.manifests[repo] == nil {
		r.manifests[repo] = map[string]storedManifest{}
	}
	d := sha256Digest(data)
	r.manifests[repo][d] = storedManifest{mediaType, data}
	if ref != "" {
		r.manifests[repo][ref] = storedManifest{mediaType, data}
	}
	return Descriptor{MediaType: mediaType, Digest: d, Size: int64(len(data))}
}

func (r *fakeRegistry) serve(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	if r.fail > 0 {
		r.fail--
		r.mu.Unlock()
		http.Error(w, "try again", http.StatusServiceUnavailable)
		return
	}
	r.mu.Unlock()

	if req.URL.Path == "/token" {
		if r.user != "" {
			if u, p, ok := req.BasicAuth(); !ok || u != r.user || p != r.password {
				http.Error(w, "bad credentials", http.StatusUnauthorized)
				return
			}
		}
		if req.URL.Query().Get("service") != "fake" || req.URL.Query().Get("scope") == "" {
			http.Error(w, "bad token request", http.StatusBadRequest)
			return
		}
		json.MarshalWrite(w, map[string]any{"token": "secret-token", "expires_in": 300})
		return
	}
	if req.Header.Get("Authorization") != "Bearer secret-token" {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s/token",service="fake",scope="ignored"`, r.srv.URL))
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if strings.HasPrefix(req.URL.Path, "/upload/") {
		r.finishUpload(w, req)
		return
	}
	path := strings.TrimPrefix(req.URL.Path, "/v2/")
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case strings.Contains(path, "/blobs/uploads/") && req.Method == http.MethodPost:
		session := fmt.Sprint(len(r.uploads))
		r.uploads[session] = strings.Split(path, "/blobs/")[0]
		w.Header().Set("Location", "/upload/"+session)
		w.WriteHeader(http.StatusAccepted)
	case strings.Contains(path, "/blobs/"):
		data, ok := r.blobs[path[strings.LastIndex(path, "/")+1:]]
		if !ok {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		if req.Method == http.MethodGet {
			w.Write(data)
		}
	case strings.Contains(path, "/manifests/"):
		repo, ref, _ := strings.Cut(path, "/manifests/")
		if req.Method == http.MethodPut {
			data, _ := io.ReadAll(req.Body)
			if r.manifests[repo] == nil {
				r.manifests[repo] = map[string]storedManifest{}
			}
			m := storedManifest{req.Header.Get("Content-Type"), data}
			r.manifests[repo][ref] = m
			r.manifests[repo][sha256Digest(data)] = m
			w.Header().Set("Docker-Content-Digest", sha256Digest(data))
			w.WriteHeader(http.StatusCreated)
			return
		}
		m, ok := r.manifests[repo][ref]
		if !ok {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Type", m.mediaType)
		w.Write(m.data)
	default:
		http.NotFound(w, req)
	}
}

func (r *fakeRegistry) finishUpload(w http.ResponseWriter, req *http.Request) {
	data, _ := io.ReadAll(req.Body)
	digest := req.URL.Query().Get("digest")
	if req.Method != http.MethodPut || sha256Digest(data) != digest {
		http.Error(w, "bad upload", http.StatusBadRequest)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.blobs[digest] = data
	r.uploaded = append(r.uploaded, digest)
	w.WriteHeader(http.StatusCreated)
}

// addImage stores a single-layer image for arch in repo and returns its
// manifest descriptor. docker picks the Docker schema 2 media types.
func (r *fakeRegistry) addImage(t *testing.T, repo, arch string, docker bool) Descriptor {
	layerData := gzipBytes(t, tarBytes(t, map[string]string{"etc/arch": arch}))
	layer := r.addBlob(layerData)
	config := r.addBlob(marshal(map[string]any{
		"architecture": arch,
		"os":           "linux",
		"rootfs":       map[string]any{"type": "layers", "diff_ids": []string{sha256Digest(tarBytes(t, map[string]string{"etc/arch": arch}))}},
	}))
	manifestType, configType, layerType := mediaTypeManifest, mediaTypeConfig, mediaTypeLayerGzip
	if docker {
		manifestType, configType, layerType = mediaTypeDockerManifest, mediaTypeDockerConfig, mediaTypeDockerLayer
	}
	config.MediaType, layer.MediaType = configType, layerType
	data := marshal(Manifest{SchemaVersion: 2, MediaType: manifestType, Config: config, Layers: []Descriptor{layer}})
	return r.addManifest(repo, "", manifestType, data)
}

func TestPullIndex(t *testing.T) {
	reg := newFakeRegistry(t)
	amd := reg.addImage(t, "library/thing", "amd64", true)
	arm := reg.addImage(t, "library/thing", "arm64", true)
	amd.Platform = &Platform{OS: "linux", Architecture: "amd64"}
	arm.Platform = &Platform{OS: "linux", Architecture: "arm64", Variant: "v8"}
	attestation := Descriptor{MediaType: mediaTypeManifest, Digest: amd.Digest, Size: amd.Size, Platform: &Platform{OS: "unknown", Architecture: "unknown"}}
	list := reg.addManifest("library/thing", "v1", mediaTypeDockerList,
		marshal(Index{SchemaVersion: 2, MediaType: mediaTypeDockerList, Manifests: []Descriptor{attestation, amd, arm}}))
	reg.fail = 2 // retried

	out := filepath.Join(t.TempDir(), "out")
	mustRun(t, "pull", "--image", reg.host()+"/library/thing:v1", "--platform", "linux/arm64", "--output", out)
	mustRun(t, "validate", out)
	m, config := readConfig(t, Layout{out})
	if config["architecture"] != "arm64" {
		t.Errorf("pulled %v", config["architecture"])
	}
	if m.MediaType != mediaTypeManifest || m.Config.MediaType != mediaTypeConfig || m.Layers[0].MediaType != mediaTypeLayerGzip {
		t.Errorf("Docker media types were not converted: %+v", m)
	}

	// By the index digest, which has to match.
	byDigest := filepath.Join(t.TempDir(), "by-digest")
	mustRun(t, "pull", "--image", reg.host()+"/library/thing", "--digest", list.Digest, "--platform", "linux/amd64", "--output", byDigest)
	if _, config := readConfig(t, Layout{byDigest}); config["architecture"] != "amd64" {
		t.Errorf("pulled %v", config["architecture"])
	}
	wrong := "sha256:" + strings.Repeat("0", 64)
	if _, stderr, code := runTool(t, "pull", "--image", reg.host()+"/library/thing@"+list.Digest, "--digest", wrong, "--output", t.TempDir()); code != 2 || !strings.Contains(stderr, "--digest") {
		t.Errorf("conflicting digests gave exit %d: %s", code, stderr)
	}
	if _, stderr, code := runTool(t, "pull", "--image", reg.host()+"/library/thing:v1", "--platform", "linux/s390x", "--output", t.TempDir()); code != 1 || !strings.Contains(stderr, "no image for linux/s390x") {
		t.Errorf("a missing platform gave exit %d: %s", code, stderr)
	}
}

func TestPullKeepsOCIManifest(t *testing.T) {
	reg := newFakeRegistry(t)
	desc := reg.addImage(t, "me/app", "amd64", false)
	reg.addManifest("me/app", "latest", mediaTypeManifest, reg.manifests["me/app"][desc.Digest].data)
	out := filepath.Join(t.TempDir(), "out")
	mustRun(t, "pull", "--image", reg.host()+"/me/app", "--output", out)
	got, err := Layout{out}.Resolve("latest")
	if err != nil {
		t.Fatal(err)
	}
	if got.Digest != desc.Digest {
		t.Errorf("manifest digest changed from %s to %s", desc.Digest, got.Digest)
	}
}

func TestPullRejectsCorruptBlob(t *testing.T) {
	reg := newFakeRegistry(t)
	desc := reg.addImage(t, "me/app", "amd64", false)
	var m Manifest
	decodeJSON(reg.manifests["me/app"][desc.Digest].data, &m)
	reg.blobs[m.Layers[0].Digest] = []byte("not the layer")
	_, stderr, code := runTool(t, "pull", "--image", reg.host()+"/me/app@"+desc.Digest, "--output", t.TempDir())
	if code != 1 || !strings.Contains(stderr, "digest mismatch") {
		t.Errorf("a corrupt layer gave exit %d: %s", code, stderr)
	}
}

func TestPullWithCredentials(t *testing.T) {
	reg := newFakeRegistry(t)
	reg.user, reg.password = "me", "hunter2"
	desc := reg.addImage(t, "me/private", "amd64", false)
	out := filepath.Join(t.TempDir(), "out")
	if _, stderr, code := runTool(t, "pull", "--image", reg.host()+"/me/private@"+desc.Digest, "--output", out); code != 1 || !strings.Contains(stderr, "Unauthorized") {
		t.Errorf("an anonymous pull gave exit %d: %s", code, stderr)
	}
	auth := filepath.Join(t.TempDir(), "auth.json")
	os.WriteFile(auth, []byte(`{"auths":{"`+reg.host()+`":{"auth":"bWU6aHVudGVyMg=="}}}`), 0o600)
	t.Setenv("REGISTRY_AUTH_FILE", auth)
	mustRun(t, "pull", "--image", reg.host()+"/me/private@"+desc.Digest, "--output", out)
}

func TestParseReference(t *testing.T) {
	for in, want := range map[string]reference{
		"alpine":                              {domain: "docker.io", repository: "library/alpine"},
		"docker.io/library/busybox:latest":    {domain: "docker.io", repository: "library/busybox", tag: "latest"},
		"localhost:5000/app:v1":               {domain: "localhost:5000", repository: "app", tag: "v1"},
		"ghcr.io/me/app@sha256:" + hex64("a"): {domain: "ghcr.io", repository: "me/app", digest: "sha256:" + hex64("a")},
		"me/app:1.0":                          {domain: "docker.io", repository: "me/app", tag: "1.0"},
	} {
		got, err := parseReference(in)
		if err != nil || got != want {
			t.Errorf("parseReference(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"UPPER/case", "app@sha256:short", "ghcr.io/me/app:bad tag"} {
		if _, err := parseReference(bad); err == nil {
			t.Errorf("parseReference(%q) succeeded", bad)
		}
	}
}

func hex64(c string) string { return strings.Repeat(c, 64) }

func TestParseChallenge(t *testing.T) {
	scheme, params := parseChallenge(`Bearer realm="https://auth.example/token",service="registry.example",scope="repository:a/b:pull,push"`)
	if scheme != "bearer" || params["realm"] != "https://auth.example/token" || params["service"] != "registry.example" || params["scope"] != "repository:a/b:pull,push" {
		t.Errorf("got %s %v", scheme, params)
	}
}
