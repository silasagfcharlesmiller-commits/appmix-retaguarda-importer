package agent

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func Provision(ctx context.Context, input ProvisionInput) (Config, error) {
	if strings.TrimSpace(input.SourceExecutable) == "" || strings.TrimSpace(input.IntegratorPath) == "" || strings.TrimSpace(input.AgentExecutable) == "" {
		return Config{}, fmt.Errorf("caminhos do Agente e do Integrador sao obrigatorios")
	}
	if input.APIBase == "" {
		input.APIBase = DefaultAPI
	}
	registration, err := enroll(ctx, input)
	if err != nil {
		return Config{}, fmt.Errorf("nao foi possivel vincular o Agente ao painel: %w", err)
	}
	protected, err := protectSecret(registration.Secret)
	registration.Secret = ""
	if err != nil {
		return Config{}, fmt.Errorf("o Windows nao protegeu a credencial do Agente: %w", err)
	}
	config := Config{
		AgentExecutable:  input.AgentExecutable,
		InstallerSetup:   input.InstallerSetup,
		ManageIntegrator: input.ManageIntegrator,
		InstallerRuntime: input.InstallerRuntime,
		APIBase:          strings.TrimRight(input.APIBase, "/"), AgentID: registration.AgentID,
		ProtectedSecret: protected, CNPJ: input.CNPJ, MachineID: input.MachineID,
		IntegratorPath: input.IntegratorPath, WindowsUser: input.WindowsUser,
		AgentVersion: input.AgentVersion, DesiredState: "running",
	}
	if err := stopAndRemoveService(); err != nil {
		return Config{}, err
	}
	destination := filepath.Clean(input.AgentExecutable)
	if !strings.EqualFold(filepath.Dir(destination), filepath.Dir(input.IntegratorPath)) || !strings.EqualFold(filepath.Base(destination), "MixFiscalAgentService.exe") {
		return Config{}, fmt.Errorf("o executável do Agente precisa ficar ao lado do desktop-integrador.exe")
	}
	if err := copyExecutable(input.SourceExecutable, destination); err != nil {
		return Config{}, fmt.Errorf("nao foi possivel instalar o executavel do Agente: %w", err)
	}
	dataDirectory := dataDirectoryForExecutable(destination)
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		return Config{}, fmt.Errorf("nao foi possivel preparar os dados protegidos do Agente: %w", err)
	}
	if err := restrictDataDirectory(dataDirectory); err != nil {
		return Config{}, fmt.Errorf("nao foi possivel proteger os arquivos do Agente: %w", err)
	}
	if err := saveConfigAt(config, dataDirectory); err != nil {
		return Config{}, fmt.Errorf("nao foi possivel salvar a configuracao protegida do Agente: %w", err)
	}
	if err := installLauncher(input.IntegratorPath); err != nil {
		return Config{}, err
	}
	_ = hiddenCommand("schtasks.exe", "/End", "/TN", LegacyMonitor).Run()
	_ = hiddenCommand("schtasks.exe", "/Delete", "/TN", LegacyMonitor, "/F").Run()
	if err := createAndStartService(destination); err != nil {
		return Config{}, err
	}
	return config, nil
}

func restrictDataDirectory(directory string) error {
	output, err := hiddenCommand("icacls.exe", directory, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(output)))
	}
	return nil
}

func copyExecutable(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	temporary := destination + ".new"
	output, err := os.Create(temporary)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	return windows.Rename(temporary, destination)
}

func installLauncher(integratorPath string) error {
	_ = hiddenCommand("schtasks.exe", "/End", "/TN", LauncherTask).Run()
	_ = hiddenCommand("schtasks.exe", "/Delete", "/TN", LauncherTask, "/F").Run()
	command := fmt.Sprintf("\"%s\"", integratorPath)
	output, err := hiddenCommand(
		"schtasks.exe", "/Create", "/TN", LauncherTask, "/TR", command,
		"/SC", "ONCE", "/ST", "00:00", "/SD", "01/01/2000", "/IT", "/RL", "HIGHEST", "/F",
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("nao foi possivel criar o lancador interativo: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func stopAndRemoveService() error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("nao foi possivel acessar os Servicos do Windows: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(ServiceName)
	if err != nil {
		return nil
	}
	defer service.Close()
	_, _ = service.Control(svc.Stop)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status, queryErr := service.Query()
		if queryErr != nil || status.State == svc.Stopped {
			break
		}
		time.Sleep(400 * time.Millisecond)
	}
	if err := service.Delete(); err != nil {
		return fmt.Errorf("nao foi possivel substituir o servico anterior: %w", err)
	}
	return nil
}

func createAndStartService(executable string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.CreateService(ServiceName, executable, mgr.Config{
		DisplayName: ServiceLabel, Description: "Monitora e controla o Integrador Mix Fiscal pelo App Mix.",
		StartType: mgr.StartAutomatic, DelayedAutoStart: true,
	}, "service")
	if err != nil {
		return fmt.Errorf("nao foi possivel registrar o servico Mix Fiscal: %w", err)
	}
	defer service.Close()
	_ = hiddenCommand("sc.exe", "failure", ServiceName, "reset=", "86400", "actions=", "restart/5000/restart/15000/restart/60000").Run()
	_ = hiddenCommand("sc.exe", "failureflag", ServiceName, "1").Run()
	if err := service.Start(); err != nil {
		return fmt.Errorf("o servico foi instalado, mas nao iniciou: %w", err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status, queryErr := service.Query()
		if queryErr == nil && status.State == svc.Running {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("o servico Mix Agent nao confirmou o estado em execucao")
}

func Installed() bool {
	manager, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(ServiceName)
	if err != nil {
		return false
	}
	service.Close()
	return true
}

func Running() bool {
	manager, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(ServiceName)
	if err != nil {
		return false
	}
	defer service.Close()
	status, err := service.Query()
	return err == nil && status.State == svc.Running
}
