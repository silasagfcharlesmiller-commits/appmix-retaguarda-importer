package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

var BuildVersion = "1.3.0-dev"
var errAlreadyCurrent = errors.New("agente já está na versão publicada ou em versão superior")

const updateHost = "appmix-retaguarda-importer.vercel.app"

type setupArtifact struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type setupManifest struct {
	Version       string        `json:"version"`
	AgentProtocol int           `json:"agent_protocol"`
	Installer     setupArtifact `json:"installer"`
}

func validArtifact(entry setupArtifact) bool {
	uri, err := url.Parse(entry.URL)
	hash, hashErr := hex.DecodeString(entry.SHA256)
	return err == nil && uri.Scheme == "https" && uri.Host == updateHost && uri.User == nil && entry.Size > 0 && entry.Size < 1<<30 && hashErr == nil && len(hash) == sha256.Size
}

func newerVersion(candidate, installed string) bool {
	parse := func(value string) ([]int, bool) {
		parts := strings.Split(strings.SplitN(value, "-", 2)[0], ".")
		if len(parts) != 3 {
			return nil, false
		}
		result := make([]int, 3)
		for i, part := range parts {
			n, err := strconv.Atoi(part)
			if err != nil || n < 0 {
				return nil, false
			}
			result[i] = n
		}
		return result, true
	}
	a, okA := parse(candidate)
	b, okB := parse(installed)
	if !okA || !okB {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func updateClient() *http.Client {
	return &http.Client{Timeout: 8 * time.Minute, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) > 5 || request.URL.Scheme != "https" || request.URL.Host != updateHost {
			return fmt.Errorf("redirecionamento de atualização não autorizado")
		}
		return nil
	}}
}

func fetchSetupManifest(ctx context.Context) (setupManifest, error) {
	var manifest setupManifest
	request, _ := http.NewRequestWithContext(ctx, "GET", "https://"+updateHost+"/integrador-updates/version.json?t="+strconv.FormatInt(time.Now().Unix(), 10), nil)
	response, err := updateClient().Do(request)
	if err != nil {
		return manifest, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return manifest, fmt.Errorf("manifesto: HTTP %d", response.StatusCode)
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&manifest)
	if err != nil {
		return manifest, err
	}
	if manifest.AgentProtocol < 2 || !validArtifact(manifest.Installer) {
		return manifest, fmt.Errorf("a versão publicada ainda não oferece atualização remota compatível do agente")
	}
	return manifest, nil
}

func downloadSetup(ctx context.Context, entry setupArtifact, destination string) error {
	if !validArtifact(entry) {
		return fmt.Errorf("artefato de atualização inválido")
	}
	request, _ := http.NewRequestWithContext(ctx, "GET", entry.URL, nil)
	response, err := updateClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("download: HTTP %d", response.StatusCode)
	}
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(output, hash), io.LimitReader(response.Body, entry.Size+1))
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil || size != entry.Size || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), entry.SHA256) {
		os.Remove(destination)
		return fmt.Errorf("download não passou na validação de tamanho e SHA-256")
	}
	file, err := os.Open(destination)
	if err != nil {
		return err
	}
	header := make([]byte, 2)
	_, err = io.ReadFull(file, header)
	file.Close()
	if err != nil || string(header) != "MZ" {
		os.Remove(destination)
		return fmt.Errorf("setup inválido")
	}
	return nil
}

func beginUpdate(config Config, commandID int64) error {
	// The helper is copied beside the protected agent executable. Its staging
	// files stay under the agent's private data directory, never in Downloads.
	helper := filepath.Join(filepath.Dir(config.AgentExecutable), "MixFiscalAgentUpdater.exe")
	if err := copyExecutable(config.AgentExecutable, helper); err != nil {
		return err
	}
	command := hiddenCommand(helper, "update", strconv.FormatInt(commandID, 10))
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func atomicAgentJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", data, 0o600); err != nil {
		return err
	}
	return windows.Rename(path+".tmp", path)
}

func stopServiceForUpdate() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(ServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Stopped {
		if _, err := service.Control(svc.Stop); err != nil {
			return err
		}
	}
	deadline := time.Now().Add(75 * time.Second)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == svc.Stopped {
			return nil
		}
		time.Sleep(400 * time.Millisecond)
	}
	return fmt.Errorf("serviço não parou; arquivos preservados")
}

func startExistingService() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(ServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	if err := service.Start(); err != nil {
		return err
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == svc.Running {
			return nil
		}
		if status.State == svc.Stopped {
			return fmt.Errorf("o agente encerrou durante a inicialização")
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("o agente não confirmou execução após iniciar")
}

func RunUpdate(commandID int64) error {
	mutexName, _ := windows.UTF16PtrFromString(`Global\MixFiscalAgentUpdate`)
	mutex, err := windows.CreateMutex(nil, true, mutexName)
	if err != nil {
		if mutex != 0 {
			windows.CloseHandle(mutex)
		}
		return err
	}
	defer windows.CloseHandle(mutex)
	config, secret, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	err = applyUpdate(ctx, config)
	message := "Agente e instalador atualizados; nova versão confirmou contato com a API."
	if errors.Is(err, errAlreadyCurrent) {
		message = err.Error()
		err = nil
	}
	if err != nil {
		message = "Atualização não concluída: " + err.Error()
	}
	result := commandResult{CommandID: commandID, Success: err == nil, Message: message}
	// Persist separately from config so a concurrent heartbeat cannot lose the ACK.
	if saveErr := atomicAgentJSON(filepath.Join(dataDirectory(), "update-result.json"), result); saveErr != nil {
		return saveErr
	}
	_ = reportResult(ctx, config, secret, result)
	return err
}

func applyUpdate(ctx context.Context, config Config) error {
	manifest, err := fetchSetupManifest(ctx)
	if err != nil {
		return err
	}
	if !newerVersion(manifest.Version, config.AgentVersion) {
		return errAlreadyCurrent
	}
	directory := filepath.Join(dataDirectoryForExecutable(config.AgentExecutable), "update")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	setup := filepath.Join(directory, "setup.exe")
	if err := downloadSetup(ctx, manifest.Installer, setup); err != nil {
		return err
	}
	// Extract into a protected staging directory first. No customer executable,
	// configuration or Machine ID is part of this remote maintenance operation.
	extraction := filepath.Join(directory, "staging")
	command := exec.CommandContext(ctx, setup, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/AGENTUPDATE=1", "/DIR="+extraction)
	command.SysProcAttr = hiddenCommand(setup).SysProcAttr
	if err := command.Run(); err != nil {
		return fmt.Errorf("extração do novo instalador: %w", err)
	}
	source := filepath.Join(extraction, ".mix-installer", "MixFiscalAgentService.exe")
	if _, err := os.Stat(source); err != nil {
		return fmt.Errorf("setup não contém agente: %w", err)
	}
	if err := stopServiceForUpdate(); err != nil {
		return err
	}
	// Reload after stopping to preserve commands/state received during the download.
	current, _, err := loadConfig()
	if err != nil {
		_ = startExistingService()
		return err
	}
	backup := current.AgentExecutable + ".previous"
	if err := copyExecutable(current.AgentExecutable, backup); err != nil {
		_ = startExistingService()
		return err
	}
	rollback := func(cause error) error {
		if err := stopServiceForUpdate(); err != nil {
			return fmt.Errorf("%v; recuperação pendente: %v", cause, err)
		}
		if err := copyExecutable(backup, current.AgentExecutable); err != nil {
			return fmt.Errorf("%v; restaurar agente: %v", cause, err)
		}
		if err := saveConfig(current); err != nil {
			return err
		}
		if err := startExistingService(); err != nil {
			return fmt.Errorf("%v; iniciar versão anterior: %v", cause, err)
		}
		return fmt.Errorf("%v; agente anterior restaurado", cause)
	}
	if err := copyExecutable(source, current.AgentExecutable); err != nil {
		return rollback(err)
	}
	updated := current
	updated.AgentVersion = manifest.Version
	if err := saveConfig(updated); err != nil {
		return rollback(err)
	}
	start := time.Now()
	if err := startExistingService(); err != nil {
		return rollback(err)
	}
	deadline := time.Now().Add(75 * time.Second)
	for time.Now().Before(deadline) {
		var proof struct {
			Version string
			At      time.Time
		}
		data, _ := os.ReadFile(filepath.Join(dataDirectory(), "heartbeat-proof.json"))
		if json.Unmarshal(data, &proof) == nil && proof.Version == manifest.Version && proof.At.After(start) {
			// Keep the verified setup next to the installed service; opening it restores
			// the complete latest installer UI, including for agent-only installations.
			if err := copyExecutable(setup, filepath.Join(filepath.Dir(current.AgentExecutable), "Instalador-Mix-Fiscal.exe")); err != nil {
				return err
			}
			if current.InstallerSetup != "" {
				if err := copyExecutable(setup, current.InstallerSetup); err != nil {
					return fmt.Errorf("agente atualizado; setup original em uso ou bloqueado: %w", err)
				}
			}
			runtimeDir := current.InstallerRuntime
			if runtimeDir != "" {
				// A UI still open may lock these files. Keep its existing copy and report
				// the failure rather than claiming all installer components were replaced.
				for _, name := range []string{"Instalador-Mix-Fiscal-App.exe", "MixFiscal-Bootstrap.exe", "MixFiscalAgentService.exe", "payload_manifest.json"} {
					if err := copyExecutable(filepath.Join(extraction, ".mix-installer", name), filepath.Join(runtimeDir, name)); err != nil {
						return fmt.Errorf("agente atualizado; instalador em uso ou bloqueado: %w", err)
					}
				}
				for _, name := range []string{"desktop-integrador.exe", "Painel_Mix.bat", "monitor_mix.ps1", "atualizador_mix.ps1", "integrador_version.json"} {
					if err := copyExecutable(filepath.Join(extraction, ".mix-installer", "payload", name), filepath.Join(runtimeDir, "payload", name)); err != nil {
						return err
					}
				}
			}
			if current.ManageIntegrator {
				if err := updateManagedIntegrator(current, filepath.Join(extraction, ".mix-installer", "payload"), filepath.Join(directory, "integrator-backup")); err != nil {
					return err
				}
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return rollback(ctx.Err())
		case <-time.After(time.Second):
		}
	}
	return rollback(fmt.Errorf("a nova versão não confirmou heartbeat na API"))
}

// Copies only the updater's existing allowlist. Machines enrolled in agent-only
// mode retain their Integrator executable and their existing maintenance policy.
func updateManagedIntegrator(config Config, sourceDir, backupDir string) (resultErr error) {
	if err := stopServiceForUpdate(); err != nil {
		return err
	}
	defer func() {
		if err := startExistingService(); err != nil {
			resultErr = fmt.Errorf("%v; reinício do agente pendente: %v", resultErr, err)
		}
	}()
	if err := stopIntegrator(config); err != nil {
		return err
	}
	defer func() {
		if config.DesiredState == "running" && sessionReadyForUser(config.WindowsUser) {
			_ = startIntegrator(config)
		}
	}()
	targetDir := filepath.Dir(config.IntegratorPath)
	names := []string{"desktop-integrador.exe", "Painel_Mix.bat", "monitor_mix.ps1", "atualizador_mix.ps1", "integrador_version.json"}
	if err := replaceComponentSet(sourceDir, targetDir, backupDir, names); err != nil {
		return err
	}
	if config.DesiredState == "running" && sessionReadyForUser(config.WindowsUser) {
		if err := startIntegrator(config); err != nil {
			// The component backup has all previous files after a successful copy.
			if restoreErr := replaceComponentSet(backupDir, targetDir, backupDir+"-failed", names); restoreErr != nil {
				return fmt.Errorf("%v; recuperação do Integrador pendente: %v", err, restoreErr)
			}
			return fmt.Errorf("%v; arquivos anteriores do Integrador restaurados", err)
		}
	}
	return nil
}

func replaceComponentSet(sourceDir, targetDir, backupDir string, names []string) error {
	for _, name := range names {
		if filepath.Base(name) != name {
			return fmt.Errorf("nome de componente inválido")
		}
		if _, err := os.Stat(filepath.Join(sourceDir, name)); err != nil {
			return err
		}
	}
	existed := map[string]bool{}
	for _, name := range names {
		target := filepath.Join(targetDir, name)
		if _, err := os.Stat(target); err == nil {
			existed[name] = true
			if err := copyExecutable(target, filepath.Join(backupDir, name)); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	changed := []string{}
	for _, name := range names {
		if err := copyExecutable(filepath.Join(sourceDir, name), filepath.Join(targetDir, name)); err != nil {
			for _, previous := range changed {
				if existed[previous] {
					if restoreErr := copyExecutable(filepath.Join(backupDir, previous), filepath.Join(targetDir, previous)); restoreErr != nil {
						return fmt.Errorf("%v; restauração de %s pendente: %v", err, previous, restoreErr)
					}
				} else {
					if removeErr := os.Remove(filepath.Join(targetDir, previous)); removeErr != nil {
						return fmt.Errorf("%v; remover componente parcial %s: %v", err, previous, removeErr)
					}
				}
			}
			return err
		}
		changed = append(changed, name)
	}
	return nil
}
