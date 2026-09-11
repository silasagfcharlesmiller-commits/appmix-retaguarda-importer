package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	authURL    = "https://authentication-builder.mixfiscal.com.br/v1/login"
	apiBase    = "https://api.mixfiscal.com.br/integrador/api/v1"
	robotProxy = "https://api.mixfiscal.com.br/interno/v1/proxy/robot"
)

var nonDigit = regexp.MustCompile(`\D`)
var machineIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{32,128}$`)

func NormalizeCNPJ(value string) (string, error) {
	cnpj := nonDigit.ReplaceAllString(value, "")
	if len(cnpj) != 14 || allSame(cnpj) {
		return "", fail("Informe um CNPJ válido.")
	}
	weights := [][]int{
		{5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2},
		{6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2},
	}
	for index, list := range weights {
		length := 12 + index
		sum := 0
		for i, weight := range list {
			sum += int(cnpj[i]-'0') * weight
		}
		remainder := sum % 11
		digit := 0
		if remainder >= 2 {
			digit = 11 - remainder
		}
		if int(cnpj[length]-'0') != digit {
			return "", fail("Os dígitos verificadores do CNPJ estão incorretos.")
		}
	}
	return cnpj, nil
}

func allSame(value string) bool {
	for index := 1; index < len(value); index++ {
		if value[index] != value[0] {
			return false
		}
	}
	return true
}

func ValidateMachineID(value string) (string, error) {
	if !machineIDPattern.MatchString(value) {
		return "", fail("Machine ID local inválido; configuração preservada.")
	}
	return value, nil
}

func readJSONObject(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fail("Não foi possível ler %s; arquivo preservado.", filepath.Base(path))
	}
	data = trimUTF8BOM(data)
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil || result == nil {
		return nil, fail("Formato inesperado em %s; arquivo preservado.", filepath.Base(path))
	}
	return result, nil
}

func trimUTF8BOM(data []byte) []byte {
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		return data[3:]
	}
	return data
}

func atomicJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err = temporary.Write(data); err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceFile(temporaryPath, path)
}

func SHA256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return "", err
	}
	return strings.ToUpper(hex.EncodeToString(hash.Sum(nil))), nil
}

func hasMZHeader(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	buffer := make([]byte, 2)
	_, err = io.ReadFull(file, buffer)
	return err == nil && string(buffer) == "MZ"
}

func versionTuple(value string) []int {
	parts := strings.Split(strings.TrimSpace(value), ".")
	result := make([]int, len(parts))
	for index, part := range parts {
		result[index], _ = strconv.Atoi(part)
	}
	return result
}

func compareVersions(left, right string) int {
	a, b := versionTuple(left), versionTuple(right)
	length := len(a)
	if len(b) > length {
		length = len(b)
	}
	for index := 0; index < length; index++ {
		av, bv := 0, 0
		if index < len(a) {
			av = a[index]
		}
		if index < len(b) {
			bv = b[index]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}

type MixAPI struct {
	client *http.Client
	token  string
}

func NewMixAPI() *MixAPI {
	return &MixAPI{client: &http.Client{Timeout: 35 * time.Second}}
}

func (api *MixAPI) request(method, endpoint string, payload any, target any) error {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = strings.NewReader(string(data))
	}
	request, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "MixFiscalInstallerGo/1")
	if api.token != "" {
		request.Header.Set("Authorization", "Bearer "+api.token)
	}
	response, err := api.client.Do(request)
	if err != nil {
		return fail("Não foi possível comunicar com a API. Verifique a conexão e tente novamente.")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &APIError{Status: response.StatusCode, Message: fmt.Sprintf("A API retornou HTTP %d na etapa %s.", response.StatusCode, method)}
	}
	if target == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16<<20))
	if err := decoder.Decode(target); err != nil {
		return fail("A API retornou um documento que não é JSON válido.")
	}
	return nil
}

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

func (api *MixAPI) Login(username, password string) error {
	api.token = ""
	var response map[string]any
	err := api.request(http.MethodPost, authURL, map[string]string{
		"email": strings.TrimSpace(username), "password": password, "browser_id": "integrador",
	}, &response)
	if err != nil {
		return err
	}
	token, _ := response["token"].(string)
	token = strings.TrimSpace(token)
	if len(token) >= 7 && strings.EqualFold(token[:7], "Bearer ") {
		token = strings.TrimSpace(token[7:])
	}
	if token == "" {
		return fail("O login não retornou um token válido.")
	}
	api.token = token
	return nil
}

func (api *MixAPI) Settings(machineID string) (map[string]any, error) {
	if _, err := ValidateMachineID(machineID); err != nil {
		return nil, err
	}
	var response map[string]any
	err := api.request(http.MethodGet, apiBase+"/settings/details/"+machineID, nil, &response)
	if apiErr, ok := err.(*APIError); ok && apiErr.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(response) == 0 {
		return nil, nil
	}
	if value, _ := response["machine_id"].(string); value != machineID {
		return nil, fail("A consulta retornou uma identidade inesperada; nenhuma configuração foi gravada.")
	}
	return response, nil
}

func (api *MixAPI) ClientMachines(cnpj string) ([]map[string]any, error) {
	normalized, err := NormalizeCNPJ(cnpj)
	if err != nil {
		return nil, err
	}
	query := url.Values{"search": {normalized}, "page_size": {"100"}}
	var response map[string]any
	if err := api.request(http.MethodGet, apiBase+"/clients/list?"+query.Encode(), nil, &response); err != nil {
		return nil, err
	}
	items, _ := response["clients"].([]any)
	seen := map[string]bool{}
	result := make([]map[string]any, 0)
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		itemCNPJ := nonDigit.ReplaceAllString(fmt.Sprint(item["cnpj_cpf"]), "")
		machineID, _ := item["machine_id"].(string)
		if _, err := ValidateMachineID(machineID); err != nil || itemCNPJ != normalized || seen[machineID] {
			continue
		}
		seen[machineID] = true
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool {
		return fmt.Sprint(result[i]["machine_id"]) < fmt.Sprint(result[j]["machine_id"])
	})
	return result, nil
}

func (api *MixAPI) clientMachine(cnpj, machineID string) (map[string]any, error) {
	items, err := api.ClientMachines(cnpj)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item["machine_id"] == machineID {
			return item, nil
		}
	}
	return nil, nil
}

func (api *MixAPI) VerifyRegistration(cnpj, machineID string) error {
	normalized, err := NormalizeCNPJ(cnpj)
	if err != nil {
		return err
	}
	current, err := api.Settings(machineID)
	if err != nil {
		return err
	}
	if current == nil || nonDigit.ReplaceAllString(fmt.Sprint(current["cnpj_cpf"]), "") != normalized {
		return fail("Não foi confirmado o vínculo deste Machine ID com o CNPJ informado.")
	}
	metadata, _ := current["metadata"].(map[string]any)
	if !containsString(metadata["tag_service"], "mixfiscal") {
		return fail("O cadastro existente não contém o serviço Mix Fiscal; foi preservado.")
	}
	return nil
}

func containsString(value any, expected string) bool {
	switch list := value.(type) {
	case []any:
		for _, item := range list {
			if fmt.Sprint(item) == expected {
				return true
			}
		}
	case []string:
		for _, item := range list {
			if item == expected {
				return true
			}
		}
	case string:
		return list == expected
	}
	return false
}

func (api *MixAPI) WaitUntilOnline(cnpj, machineID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		item, err := api.clientMachine(cnpj, machineID)
		if err != nil {
			return err
		}
		status := strings.ToLower(strings.TrimSpace(fmt.Sprint(item["status"])))
		if status == "active" || status == "online" || status == "connected" || status == "conectado" {
			return nil
		}
		time.Sleep(time.Second)
	}
	return fail("O Machine ID foi cadastrado, mas ainda não apareceu online para o App Mix.")
}
