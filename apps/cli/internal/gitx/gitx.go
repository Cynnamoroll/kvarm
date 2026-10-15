// Package gitx runs git children the way the CLI requires: credential
// helpers are disabled and prompts are off, so git never reads or stores a
// credential; the PAT travels only as a basic-auth header scoped to the
// platform URL, set through GIT_CONFIG_* environment variables (never argv,
// never written to the clone's config).
package gitx

import (
	"bytes"
	"encoding/base64"
	"os/exec"
	"strconv"
	"strings"
)

// Env builds the environment for git children. GIT_CONFIG_COUNT already in
// the parent is honored so earlier entries keep working.
func Env(parent map[string]string, baseURL, pat string) map[string]string {
	out := make(map[string]string, len(parent)+6)
	for k, v := range parent {
		out[k] = v
	}
	out["GIT_TERMINAL_PROMPT"] = "0"
	type entry struct{ key, value string }
	var entries []entry
	entries = append(entries, entry{"credential.helper", ""})
	if pat != "" {
		// user "kvarm" is the placeholder undici-style basic auth uses; the
		// platform authenticates only the password side.
		basic := base64.StdEncoding.EncodeToString([]byte("kvarm:" + pat))
		entries = append(entries, entry{
			key:   "http." + strings.TrimRight(baseURL, "/") + "/.extraHeader",
			value: "Authorization: Basic " + basic,
		})
	}
	n := 0
	if count, err := strconv.Atoi(parent["GIT_CONFIG_COUNT"]); err == nil {
		n = count
	}
	for _, e := range entries {
		out["GIT_CONFIG_KEY_"+strconv.Itoa(n)] = e.key
		out["GIT_CONFIG_VALUE_"+strconv.Itoa(n)] = e.value
		n++
	}
	out["GIT_CONFIG_COUNT"] = strconv.Itoa(n)
	return out
}

// Result is one git child's outcome. Stdout and Stderr are trimmed like the
// JS CLI's trim().
type Result struct {
	Code   int
	Stdout string
	Stderr string
}

// Run executes git with args in cwd under env. A git that cannot be started
// is code 127 with the error appended to Stderr.
func Run(args []string, cwd string, env map[string]string) Result {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	cmd.Env = envMapToSlice(env)
	cmd.Stdin = nil
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return Result{Code: exitErr.ExitCode(), Stdout: strings.TrimSpace(stdout.String()), Stderr: strings.TrimSpace(stderr.String())}
		}
		return Result{Code: 127, Stdout: strings.TrimSpace(stdout.String()), Stderr: strings.TrimSpace(stderr.String()) + err.Error()}
	}
	return Result{Code: 0, Stdout: strings.TrimSpace(stdout.String()), Stderr: strings.TrimSpace(stderr.String())}
}

func envMapToSlice(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}
