package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows/svc"
)

type serviceHandler struct {
	mu        sync.Mutex
	lastStart time.Time
}

func RunService() error { return svc.Run(ServiceName, &serviceHandler{}) }

func (handler *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		handler.loop(ctx)
		close(done)
	}()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			changes <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			cancel()
			<-done
			return false, 0
		}
	}
	cancel()
	<-done
	return false, 0
}

func (handler *serviceHandler) loop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		handler.cycle(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (handler *serviceHandler) cycle(ctx context.Context) {
	config, secret, err := loadConfig()
	if err != nil {
		appendLog("ERRO", "Configuracao do Agente indisponivel: "+err.Error())
		return
	}
	_, online, observed := processState(config.IntegratorPath)
	ready := sessionReadyForUser(config.WindowsUser)
	if config.ResultPending && config.LastResult != nil {
		if err := reportResult(ctx, config, secret, *config.LastResult); err != nil {
			// A failed acknowledgement must not make a functioning service look
			// offline, nor consume another command before this one is acknowledged.
			_ = apiRequest(ctx, "POST", config.APIBase+"/status", heartbeatRequest{Protocol: 2, IntegratorObserved: observed, AgentVersion: config.AgentVersion, IntegratorOnline: online, SessionReady: ready}, agentHeaders(config.AgentID, secret), nil)
			return
		}
		config.ResultPending = false
		if err := saveConfig(config); err != nil {
			return
		}
	}
	response, err := heartbeat(ctx, config, secret, online, ready, observed)
	if err != nil {
		appendLog("ATENCAO", "Heartbeat falhou: "+err.Error())
		handler.enforce(config, online, ready && observed)
		return
	}
	_ = atomicAgentJSON(filepath.Join(dataDirectory(), "heartbeat-proof.json"), struct {
		Version string
		At      time.Time
	}{BuildVersion, time.Now()})
	if data, err := os.ReadFile(filepath.Join(dataDirectory(), "update-result.json")); err == nil {
		var result commandResult
		if json.Unmarshal(data, &result) == nil && reportResult(ctx, config, secret, result) == nil {
			_ = os.Remove(filepath.Join(dataDirectory(), "update-result.json"))
		}
	}
	if response.DesiredState == "running" || response.DesiredState == "paused" {
		changed := config.DesiredState != response.DesiredState
		config.DesiredState = response.DesiredState
		if err := func() error {
			if changed {
				return saveConfig(config)
			}
			return nil
		}(); err != nil {
			appendLog("ATENCAO", "Nao foi possivel persistir o estado: "+err.Error())
		}
	}
	if response.Command != nil {
		if config.LastResult != nil && config.LastResult.CommandID == response.Command.ID {
			_ = reportResult(ctx, config, secret, *config.LastResult)
			return
		}
		if response.Command.Action == "update" {
			if err := beginUpdate(config, response.Command.ID); err == nil {
				return
			} else {
				config.LastResult = &commandResult{CommandID: response.Command.ID, Success: false, Message: err.Error()}
			}
		} else {
			success, message := handler.execute(config, *response.Command, ready)
			config.LastResult = &commandResult{CommandID: response.Command.ID, Success: success, Message: message}
		}
		config.ResultPending = true
		if err := saveConfig(config); err != nil {
			appendLog("ERRO", "Resultado não persistido: "+err.Error())
			return
		}
		if err := reportResult(ctx, config, secret, *config.LastResult); err == nil {
			config.ResultPending = false
			_ = saveConfig(config)
		}
		_, online, observed = processState(config.IntegratorPath)
		_ = apiRequest(ctx, "POST", config.APIBase+"/status", heartbeatRequest{Protocol: 2, IntegratorObserved: observed, AgentVersion: config.AgentVersion, IntegratorOnline: online, SessionReady: sessionReadyForUser(config.WindowsUser)}, agentHeaders(config.AgentID, secret), nil)
		return
	}
	handler.enforce(config, online, ready && observed)
}

func (handler *serviceHandler) execute(config Config, command Command, ready bool) (bool, string) {
	appendLog("INFO", fmt.Sprintf("Executando comando %d: %s", command.ID, command.Action))
	switch command.Action {
	case "pause":
		if err := stopIntegrator(config); err != nil {
			return false, err.Error()
		}
		return true, "Integrador pausado e reinicializacao automatica desativada."
	case "start":
		if !ready {
			return false, "Comando preservado; aguardando uma sessao do Windows ficar disponivel."
		}
		if err := startIntegrator(config); err != nil {
			return false, err.Error()
		}
		handler.lastStart = time.Now()
		return true, "Processo do Integrador aberto e confirmado na máquina."
	case "restart":
		if !ready {
			return false, "Aguardando a sessão da conta configurada; o Integrador foi preservado."
		}
		if err := stopIntegrator(config); err != nil {
			return false, err.Error()
		}
		if !ready {
			return false, "Integrador fechado; aguardando uma sessao do Windows para reabrir."
		}
		if err := startIntegrator(config); err != nil {
			return false, err.Error()
		}
		handler.lastStart = time.Now()
		return true, "Integrador reiniciado."
	default:
		return false, "Comando desconhecido."
	}
}

func (handler *serviceHandler) enforce(config Config, online, ready bool) {
	if _, _, observed := processState(config.IntegratorPath); !observed {
		return
	}
	if config.DesiredState == "paused" {
		if online {
			if err := stopIntegrator(config); err != nil {
				appendLog("ERRO", err.Error())
			}
		}
		return
	}
	if online || !ready || time.Since(handler.lastStart) < time.Minute {
		return
	}
	if err := startIntegrator(config); err != nil {
		appendLog("ERRO", err.Error())
		return
	}
	handler.lastStart = time.Now()
	appendLog("INFO", "Integrador estava parado; abertura solicitada.")
}

func appendLog(level, message string) {
	_ = os.MkdirAll(dataDirectory(), 0o700)
	if info, err := os.Stat(LogPath()); err == nil && info.Size() > 2<<20 {
		_ = os.Remove(LogPath() + ".1")
		_ = os.Rename(LogPath(), LogPath()+".1")
	}
	message = strings.ReplaceAll(strings.ReplaceAll(message, "\r", " "), "\n", " ")
	line := fmt.Sprintf("[%s] [%s] %s\r\n", time.Now().Format(time.RFC3339), level, message)
	file, err := os.OpenFile(LogPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		_, _ = file.WriteString(line)
		_ = file.Close()
	}
}
