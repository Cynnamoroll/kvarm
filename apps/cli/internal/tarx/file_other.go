//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package tarx

import "os"

const noFollow = 0

type fileID struct {
	path string
	size int64
}

func identity(path string, st os.FileInfo) fileID {
	return fileID{path: path, size: st.Size()}
}
