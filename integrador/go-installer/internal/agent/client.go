package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var apiClient = &http.Client{Timeout: 25 * time.Second}

func apiRequest(ctx context.Context, method, endpoint string, body any, headers map[string]string, target any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "MixFiscalAgent/1")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := apiClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("API do Agente retornou HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	if target == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target)
}

func enroll(ctx context.Context, input ProvisionInput) (enrollmentResponse, error) {
	computer, _ := computerName()
	request := enrollmentRequest{
		ClientName: input.ClientName, Retaguarda: input.Retaguarda,
		MixLogin: input.MixLogin, CNPJ: input.CNPJ, MachineID: input.MachineID,
		ComputerName: computer, WindowsUser: input.WindowsUser,
		IntegratorPath: input.IntegratorPath, AgentVersion: input.AgentVersion,
	}
	base := strings.TrimRight(input.APIBase, "/")
	if base == "" {
		base = DefaultAPI
	}
	var response enrollmentResponse
	err := apiRequest(ctx, http.MethodPost, base+"/enroll", request, map[string]string{
		"Authorization": "Bearer " + input.MixBearer,
	}, &response)
	if err != nil {
		return response, err
	}
	if response.AgentID == "" || len(response.Secret) < 32 {
		return response, fmt.Errorf("a API nao retornou uma identidade valida para o Agente")
	}
	return response, nil
}

func heartbeat(ctx context.Context, config Config, secret string, online, session bool, observation ...bool) (HeartbeatResponse, error) {
	var response HeartbeatResponse
	observed := len(observation) == 0 || observation[0]
	err := apiRequest(ctx, http.MethodPost, strings.TrimRight(config.APIBase, "/")+"/heartbeat", heartbeatRequest{Protocol: 2, IntegratorObserved: observed,
		AgentVersion: config.AgentVersion, IntegratorOnline: online, SessionReady: session,
		IntegratorPath: config.IntegratorPath, WindowsUser: config.WindowsUser,
	}, agentHeaders(config.AgentID, secret), &response)
	return response, err
}

func reportResult(ctx context.Context, config Config, secret string, result commandResult) error {
	return apiRequest(ctx, http.MethodPost, strings.TrimRight(config.APIBase, "/")+"/result", result, agentHeaders(config.AgentID, secret), nil)
}

func agentHeaders(id, secret string) map[string]string {
	return map[string]string{"X-Mix-Agent-ID": id, "X-Mix-Agent-Token": secret}
}

func computerName() (string, error) { return hostname() }
