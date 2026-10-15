//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package tarx

import (
	"os"
	"syscall"
)

const noFollow = syscall.O_NOFOLLOW

type fileID struct{ dev, ino uint64 }

func identity(_ string, st os.FileInfo) fileID {
	stat := st.Sys().(*syscall.Stat_t)
	return fileID{uint64(stat.Dev), uint64(stat.Ino)}
}
