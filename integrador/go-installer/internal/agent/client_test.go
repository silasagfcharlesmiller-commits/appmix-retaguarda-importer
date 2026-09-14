package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEnrollUsesTemporaryMixBearerAndReturnsDeviceSecret(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/enroll" || request.Header.Get("Authorization") != "Bearer mix-temporary-token" {
			t.Fatalf("requisicao de vinculo inesperada: %s %s", request.Method, request.URL.Path)
		}
		var body enrollmentRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.CNPJ != "52703958000142" || body.MachineID == "" || body.MixLogin != "operador" {
			t.Fatalf("dados de vinculo incompletos: %+v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"agent_id":"0e46bc10-068b-4b97-8c6b-7568791a4b1c","secret":"12345678901234567890123456789012"}`))
	}))
	defer server.Close()
	previous := apiClient
	apiClient = server.Client()
	defer func() { apiClient = previous }()

	result, err := enroll(context.Background(), ProvisionInput{
		APIBase: server.URL, MixBearer: "mix-temporary-token", MixLogin: "operador",
		CNPJ: "52703958000142", MachineID: "a123", IntegratorPath: `C:\Mix\desktop-integrador.exe`,
		WindowsUser: `SERVIDOR\Administrador`, AgentVersion: "1.3.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.AgentID == "" || result.Secret == "" {
		t.Fatalf("identidade nao retornada: %+v", result)
	}
}

func TestHeartbeatAuthenticatesAgentAndReceivesPause(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Mix-Agent-ID") != "agent-1" || request.Header.Get("X-Mix-Agent-Token") != "device-secret" {
			t.Fatal("cabecalhos do Agente ausentes")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"desired_state":"paused","command":{"id":17,"action":"pause"}}`))
	}))
	defer server.Close()
	previous := apiClient
	apiClient = server.Client()
	defer func() { apiClient = previous }()

	response, err := heartbeat(context.Background(), Config{
		APIBase: server.URL, AgentID: "agent-1", AgentVersion: "1.3.0",
		IntegratorPath: `C:\Mix\desktop-integrador.exe`, WindowsUser: `SERVIDOR\Administrador`,
	}, "device-secret", true, true)
	if err != nil {
		t.Fatal(err)
	}
	if response.DesiredState != "paused" || response.Command == nil || response.Command.ID != 17 {
		t.Fatalf("comando inesperado: %+v", response)
	}
}
