// Package repo parses the <owner>/<name> repository identifiers the API,
// the runner and the workdir slots all use.
package repo

import (
	"regexp"

	"kvarm/cli/internal/errs"
)

var repoRe = regexp.MustCompile(`^([A-Za-z0-9][\w.-]*)/([\w.-]+?)(?:\.git)?$`)

// Parsed is an <owner>/<name> repository identifier.
type Parsed struct {
	Owner string
	Name  string
}

// Parse validates a repository identifier. A name of "." or ".." resolves
// outside the repo under the host's path rules, so it is refused too.
func Parse(r string) (Parsed, error) {
	m := repoRe.FindStringSubmatch(r)
	if m == nil {
		return Parsed{}, errs.NewUsage("invalid repository %q, expected <owner>/<repo>", r)
	}
	if m[2] == "." || m[2] == ".." {
		return Parsed{}, errs.NewUsage("invalid repository %q, expected <owner>/<repo>", r)
	}
	return Parsed{Owner: m[1], Name: m[2]}, nil
}
