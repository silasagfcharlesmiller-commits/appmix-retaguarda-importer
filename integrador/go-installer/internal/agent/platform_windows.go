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

func processState(target string) (uint32, bool, bool) {
	target, err := filepath.Abs(target)
	if err != nil {
		return 0, false, false
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, false, false
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafeSizeofProcessEntry())}
	unknown := false
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if !strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(target)) {
			continue
		}
		process, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
		if openErr != nil {
			unknown = true
			continue
		}
		buffer := make([]uint16, 32768)
		size := uint32(len(buffer))
		queryErr := windows.QueryFullProcessImageName(process, 0, &buffer[0], &size)
		windows.CloseHandle(process)
		if queryErr != nil {
			unknown = true
		}
		if queryErr == nil && strings.EqualFold(filepath.Clean(windows.UTF16ToString(buffer[:size])), filepath.Clean(target)) {
			return entry.ProcessID, true, true
		}
	}
	if err != nil && !errors.Is(err, errNoMoreFiles) {
		return 0, false, false
	}
	return 0, false, !unknown
}

func processByPath(target string) (uint32, bool) {
	pid, running, _ := processState(target)
	return pid, running
}

func unsafeSizeofProcessEntry() uintptr {
	var entry windows.ProcessEntry32
	return unsafe.Sizeof(entry)
}

func sessionReadyForUser(user string) bool {
	// WTS works on Windows Server without explorer.exe and checks the launcher's
	// account, rather than incorrectly accepting another user's desktop.
	type sessionInfo struct {
		ID      uint32
		Station *uint16
		State   uint32
	}
	dll := windows.NewLazySystemDLL("wtsapi32.dll")
	var buffer *sessionInfo
	var count uint32
	ok, _, _ := dll.NewProc("WTSEnumerateSessionsW").Call(0, 0, 1, uintptr(unsafe.Pointer(&buffer)), uintptr(unsafe.Pointer(&count)))
	if ok == 0 {
		return false
	}
	defer dll.NewProc("WTSFreeMemory").Call(uintptr(unsafe.Pointer(buffer)))
	value := func(id, class uint32) string {
		var text *uint16
		var size uint32
		ok, _, _ := dll.NewProc("WTSQuerySessionInformationW").Call(0, uintptr(id), uintptr(class), uintptr(unsafe.Pointer(&text)), uintptr(unsafe.Pointer(&size)))
		if ok == 0 || text == nil {
			return ""
		}
		defer dll.NewProc("WTSFreeMemory").Call(uintptr(unsafe.Pointer(text)))
		return windows.UTF16PtrToString(text)
	}
	for _, session := range unsafe.Slice(buffer, int(count)) {
		if session.ID == 0 {
			continue
		}
		username, domain := value(session.ID, 5), value(session.ID, 7)
		if username != "" && (strings.EqualFold(domain+`\`+username, user) || strings.EqualFold(username, user)) {
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
	pid, running, observed := processState(config.IntegratorPath)
	if !observed {
		return fmt.Errorf("consulta de processo bloqueada; encerramento não confirmado. TI: liberar consulta do caminho do executável para o serviço")
	}
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
	_, running, observed := processState(config.IntegratorPath)
	if !observed {
		return fmt.Errorf("consulta do processo indisponível; abertura não confirmada para evitar instância duplicada")
	}
	setNativeTasks(true)
	if !running {
		if err := hiddenCommand("schtasks.exe", "/Run", "/TN", LauncherTask).Run(); err != nil {
			return fmt.Errorf("nao foi possivel iniciar o lancador do Integrador: %w", err)
		}
	}
	if awaitStableProcess(func() bool { _, found := processByPath(config.IntegratorPath); return found }, 30*time.Second, 3*time.Second, 300*time.Millisecond) {
		return nil
	}
	return fmt.Errorf("o Windows aceitou a tarefa, mas a abertura está inconclusiva: processo não confirmado por 30 s. TI: verificar a conta %s, a tarefa %s, antivírus e permissão do executável %s", config.WindowsUser, LauncherTask, config.IntegratorPath)
}

func awaitStableProcess(probe func() bool, timeout, stable, interval time.Duration) bool {
	deadline := time.Now().Add(timeout)
	var stableSince time.Time
	for time.Now().Before(deadline) {
		if probe() {
			if stableSince.IsZero() {
				stableSince = time.Now()
			}
			if time.Since(stableSince) >= stable {
				return true
			}
		} else {
			stableSince = time.Time{}
		}
		time.Sleep(interval)
	}
	return false
}
