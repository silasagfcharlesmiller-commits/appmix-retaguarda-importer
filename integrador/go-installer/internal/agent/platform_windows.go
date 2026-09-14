package agent

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

var errNoMoreFiles = syscall.ERROR_NO_MORE_FILES

func hostname() (string, error) { return os.Hostname() }

func hiddenCommand(name string, args ...string) *exec.Cmd {
	command := exec.Command(name, args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return command
}

func processByPath(target string) (uint32, bool) {
	target, err := filepath.Abs(target)
	if err != nil {
		return 0, false
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, false
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafeSizeofProcessEntry())}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		process, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
		if openErr != nil {
			continue
		}
		buffer := make([]uint16, 32768)
		size := uint32(len(buffer))
		queryErr := windows.QueryFullProcessImageName(process, 0, &buffer[0], &size)
		windows.CloseHandle(process)
		if queryErr == nil && strings.EqualFold(filepath.Clean(windows.UTF16ToString(buffer[:size])), filepath.Clean(target)) {
			return entry.ProcessID, true
		}
	}
	if err != nil && !errors.Is(err, errNoMoreFiles) {
		return 0, false
	}
	return 0, false
}

func unsafeSizeofProcessEntry() uintptr {
	var entry windows.ProcessEntry32
	return unsafe.Sizeof(entry)
}

func sessionReady() bool {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafeSizeofProcessEntry())}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), "explorer.exe") {
			return true
		}
	}
	return false
}

func setNativeTasks(enabled bool) {
	operation := "/Disable"
	if enabled {
		operation = "/Enable"
	}
	for _, name := range []string{`\MixFiscalIntegrador\BootStart`, `\MixFiscalIntegrador\Startup`, `\MixFiscalIntegrador\Watchdog`} {
		_ = hiddenCommand("schtasks.exe", "/Change", "/TN", name, operation).Run()
	}
}

func stopIntegrator(config Config) error {
	setNativeTasks(false)
	pid, running := processByPath(config.IntegratorPath)
	if !running {
		return nil
	}
	if err := hiddenCommand("taskkill.exe", "/PID", fmt.Sprint(pid), "/T", "/F").Run(); err != nil {
		return fmt.Errorf("nao foi possivel encerrar o Integrador: %w", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, found := processByPath(config.IntegratorPath); !found {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("o Integrador permaneceu aberto apos o comando de parada")
}

func startIntegrator(config Config) error {
	if _, err := os.Stat(config.IntegratorPath); err != nil {
		return fmt.Errorf("executavel do Integrador nao encontrado: %w", err)
	}
	setNativeTasks(true)
	if _, running := processByPath(config.IntegratorPath); running {
		return nil
	}
	if err := hiddenCommand("schtasks.exe", "/Run", "/TN", LauncherTask).Run(); err != nil {
		return fmt.Errorf("nao foi possivel iniciar o lancador do Integrador: %w", err)
	}
	return nil
}
