// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// credentials for one registry. An identity token is an OAuth2 refresh
// token, which a credential helper hands back with the user "<token>".
type credentials struct {
	username, password, identityToken string
}

func (c credentials) empty() bool {
	return c.username == "" && c.password == "" && c.identityToken == ""
}

type authConfig struct {
	Auths map[string]struct {
		Auth          string `json:"auth"`
		Username      string `json:"username"`
		Password      string `json:"password"`
		IdentityToken string `json:"identitytoken"`
	} `json:"auths"`
	CredHelpers map[string]string `json:"credHelpers"`
	CredsStore  string            `json:"credsStore"`
}

// authFiles lists where credentials are looked up, in the order skopeo,
// podman and docker use: the containers auth file and then docker's.
// An explicit authfile replaces them all.
func authFiles(authfile string) []string {
	if authfile != "" {
		return []string{authfile}
	}
	var files []string
	if f := os.Getenv("REGISTRY_AUTH_FILE"); f != "" {
		files = append(files, f)
	}
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		files = append(files, filepath.Join(dir, "containers", "auth.json"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		config := os.Getenv("XDG_CONFIG_HOME")
		if config == "" {
			config = filepath.Join(home, ".config")
		}
		files = append(files, filepath.Join(config, "containers", "auth.json"))
		docker := os.Getenv("DOCKER_CONFIG")
		if docker == "" {
			docker = filepath.Join(home, ".docker")
		}
		files = append(files, filepath.Join(docker, "config.json"))
	}
	return files
}

// normalizeAuthKey strips what docker's config keys sometimes carry, as in
// https://index.docker.io/v1/.
func normalizeAuthKey(key string) string {
	key = strings.TrimPrefix(strings.TrimPrefix(key, "https://"), "http://")
	key = strings.TrimSuffix(strings.TrimSuffix(key, "/"), "/v1")
	switch key {
	case "index.docker.io", "registry-1.docker.io":
		return "docker.io"
	}
	return key
}

// lookupCredentials finds credentials for ref. A key naming a repository
// or namespace wins over one naming the whole registry, and the first file
// with a match wins over later ones. None found means anonymous access.
func lookupCredentials(ctx context.Context, ref reference, authfile string) (credentials, error) {
	scopes := []string{}
	parts := strings.Split(ref.repository, "/")
	for i := len(parts); i > 0; i-- {
		scopes = append(scopes, ref.domain+"/"+strings.Join(parts[:i], "/"))
	}
	scopes = append(scopes, normalizeAuthKey(ref.domain))

	for _, file := range authFiles(authfile) {
		data, err := os.ReadFile(file)
		if errors.Is(err, os.ErrNotExist) && authfile == "" {
			continue
		} else if err != nil {
			return credentials{}, err
		}
		var config authConfig
		if err := json.Unmarshal(data, &config); err != nil {
			return credentials{}, fmt.Errorf("%s: %w", file, err)
		}
		for _, scope := range scopes {
			if helper, ok := config.CredHelpers[scope]; ok {
				return helperCredentials(ctx, helper, ref.domain)
			}
			for key, entry := range config.Auths {
				if normalizeAuthKey(key) != scope {
					continue
				}
				c := credentials{username: entry.Username, password: entry.Password, identityToken: entry.IdentityToken}
				if entry.Auth != "" {
					decoded, err := base64.StdEncoding.DecodeString(entry.Auth)
					if err != nil {
						return credentials{}, fmt.Errorf("%s: auth for %s: %w", file, key, err)
					}
					c.username, c.password, _ = strings.Cut(string(decoded), ":")
				}
				return c, nil
			}
		}
		if config.CredsStore != "" {
			c, err := helperCredentials(ctx, config.CredsStore, ref.domain)
			if err != nil || !c.empty() {
				return c, err
			}
		}
	}
	return credentials{}, nil
}

// helperCredentials asks docker-credential-HELPER for a registry's
// credentials, using docker's credential helper protocol.
func helperCredentials(ctx context.Context, helper, domain string) (credentials, error) {
	server := domain
	if domain == "docker.io" {
		server = "https://index.docker.io/v1/"
	}
	cmd := exec.CommandContext(ctx, "docker-credential-"+helper, "get")
	cmd.Stdin = strings.NewReader(server)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// Helpers report a registry they know nothing about this way.
		if strings.Contains(string(out)+stderr.String(), "credentials not found") {
			return credentials{}, nil
		}
		return credentials{}, fmt.Errorf("docker-credential-%s: %v: %s", helper, err, strings.TrimSpace(stderr.String()))
	}
	var reply struct {
		Username string `json:"Username"`
		Secret   string `json:"Secret"`
	}
	if err := json.Unmarshal(out, &reply); err != nil {
		return credentials{}, fmt.Errorf("docker-credential-%s: %w", helper, err)
	}
	if reply.Username == "<token>" {
		return credentials{identityToken: reply.Secret}, nil
	}
	return credentials{username: reply.Username, password: reply.Secret}, nil
}
