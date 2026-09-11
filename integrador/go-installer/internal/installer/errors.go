package installer

import "fmt"

type InstallError struct {
	Message string
}

func (e *InstallError) Error() string { return e.Message }

func fail(format string, args ...any) error {
	return &InstallError{Message: fmt.Sprintf(format, args...)}
}
