// The kvarm command: a git platform client for teams of people and coding
// agents. Everything happens in internal/app; this file only bridges the
// process to it.
package main

import (
	"os"
	"strings"

	"kvarm/cli/internal/app"
)

func main() {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if key, value, found := strings.Cut(entry, "="); found {
			env[key] = value
		}
	}
	os.Exit(app.Main(os.Args[1:], env, os.Stdout, os.Stderr))
}
