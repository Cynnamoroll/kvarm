// Package errs carries the CLI's one error type: every failure the command
// tree reports to the user is a CliError with the exit code it maps to.
package errs

import "fmt"

// CliError is a failure with its exit status: 1 for API and network
// failures, 2 for usage errors. Anything else is a bug and panics the same
// way an unhandled error did in the JS CLI.
type CliError struct {
	Message  string
	ExitCode int
}

func (e *CliError) Error() string { return e.Message }

// NewUsage is a CliError with exit code 2.
func NewUsage(format string, args ...any) *CliError {
	return &CliError{Message: fmt.Sprintf(format, args...), ExitCode: 2}
}

// NewFailure is a CliError with exit code 1.
func NewFailure(format string, args ...any) *CliError {
	return &CliError{Message: fmt.Sprintf(format, args...), ExitCode: 1}
}

// From turns any error into a CliError, keeping one that already is.
func From(err error) *CliError {
	if cliErr, ok := err.(*CliError); ok {
		return cliErr
	}
	return &CliError{Message: err.Error(), ExitCode: 1}
}
