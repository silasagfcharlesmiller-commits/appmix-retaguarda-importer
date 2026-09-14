package agent

import "time"

const (
	ServiceName   = "MixFiscalAgent"
	ServiceLabel  = "Mix Fiscal - Agente do Integrador"
	LauncherTask  = "Mix Fiscal - Abrir Integrador"
	LegacyMonitor = "Mix Fiscal - Monitorar Integrador"
	DefaultAPI    = "https://appmix-retaguarda-importer.vercel.app/api/agents"
)

type Config struct {
	AgentExecutable  string         `json:"agent_executable"`
	InstallerSetup   string         `json:"installer_setup"`
	ManageIntegrator bool           `json:"manage_integrator"`
	InstallerRuntime string         `json:"installer_runtime"`
	LastResult       *commandResult `json:"last_result,omitempty"`
	ResultPending    bool           `json:"result_pending,omitempty"`
	APIBase          string         `json:"api_base"`
	AgentID          string         `json:"agent_id"`
	ProtectedSecret  string         `json:"protected_secret"`
	CNPJ             string         `json:"cnpj"`
	MachineID        string         `json:"machine_id"`
	IntegratorPath   string         `json:"integrator_path"`
	WindowsUser      string         `json:"windows_user"`
	AgentVersion     string         `json:"agent_version"`
	DesiredState     string         `json:"desired_state"`
	UpdatedAt        string         `json:"updated_at"`
}

type ProvisionInput struct {
	AgentExecutable  string
	InstallerSetup   string
	ManageIntegrator bool
	InstallerRuntime string
	ClientName       string
	Retaguarda       string
	SourceExecutable string
	APIBase          string
	MixBearer        string
	MixLogin         string
	CNPJ             string
	MachineID        string
	IntegratorPath   string
	WindowsUser      string
	AgentVersion     string
}

type enrollmentRequest struct {
	ClientName     string `json:"client_name"`
	Retaguarda     string `json:"retaguarda"`
	MixLogin       string `json:"mix_login"`
	CNPJ           string `json:"cnpj"`
	MachineID      string `json:"machine_id"`
	ComputerName   string `json:"computer_name"`
	WindowsUser    string `json:"windows_user"`
	IntegratorPath string `json:"integrator_path"`
	AgentVersion   string `json:"agent_version"`
}

type enrollmentResponse struct {
	AgentID string `json:"agent_id"`
	Secret  string `json:"secret"`
}

type Command struct {
	ID     int64  `json:"id"`
	Action string `json:"action"`
}

type HeartbeatResponse struct {
	DesiredState string   `json:"desired_state"`
	Command      *Command `json:"command"`
}

type heartbeatRequest struct {
	IntegratorObserved bool   `json:"integrator_observed"`
	Protocol           int    `json:"protocol"`
	AgentVersion       string `json:"agent_version"`
	IntegratorOnline   bool   `json:"integrator_online"`
	SessionReady       bool   `json:"session_ready"`
	IntegratorPath     string `json:"integrator_path"`
	WindowsUser        string `json:"windows_user"`
}

type commandResult struct {
	CommandID int64  `json:"command_id"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
}

func nowText() string { return time.Now().UTC().Format(time.RFC3339Nano) }
