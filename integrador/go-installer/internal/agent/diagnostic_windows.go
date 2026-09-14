package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func ProbeCredential() error {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return err
	}
	original := hex.EncodeToString(data)
	protected, err := protectSecret(original)
	if err != nil {
		return err
	}
	plain, err := unprotectSecret(protected)
	if err != nil {
		return err
	}
	if plain != original {
		return fmt.Errorf("o Windows não recuperou a credencial temporária")
	}
	return nil
}

func CheckConnectivity(timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var result struct {
		OK bool `json:"ok"`
	}
	if err := apiRequest(ctx, http.MethodPost, DefaultAPI+"/health", map[string]string{"probe": "installer"}, nil, &result); err != nil {
		return err
	}
	if !result.OK {
		return fmt.Errorf("a API não confirmou o teste HTTPS")
	}
	return nil
}

type SelfTestReport struct {
	Complete bool   `json:"complete"`
	Success  bool   `json:"success"`
	Message  string `json:"message"`
}

// The installer only polls results. The Windows service must receive and execute
// both commands through its own connection, under SYSTEM, and acknowledge them.
func VerifyRemoteControl(ctx context.Context, config Config, progress func(string)) (SelfTestReport, error) {
	secret, err := unprotectSecret(config.ProtectedSecret)
	if err != nil {
		return SelfTestReport{}, err
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return SelfTestReport{}, err
	}
	body := map[string]string{"test_id": hex.EncodeToString(nonce)}
	endpoint := strings.TrimRight(config.APIBase, "/") + "/self-test"
	deadline, cancel := context.WithTimeout(ctx, 150*time.Second)
	defer cancel()
	for {
		var report SelfTestReport
		if err := apiRequest(deadline, http.MethodPost, endpoint, body, agentHeaders(config.AgentID, secret), &report); err == nil {
			if report.Complete {
				return report, nil
			}
			progress("Teste 7/7: aguardando o serviço receber, executar e confirmar início/reinício pela API")
		}
		select {
		case <-deadline.Done():
			return SelfTestReport{}, fmt.Errorf("controle remoto inconclusivo após 150 s; o agente foi instalado. TI: conferir proxy/HTTPS na conta SYSTEM, proteção do executável e permissão da tarefa %s", LauncherTask)
		case <-time.After(2 * time.Second):
		}
	}
}
