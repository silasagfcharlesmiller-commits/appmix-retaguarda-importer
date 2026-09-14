package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"golang.org/x/sys/windows"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func TestDownloadRejectsTamperingAndCleansPartialFile(t *testing.T) {
	original := "MZverified-setup"
	hash := sha256.Sum256([]byte(original))
	entry := setupArtifact{URL: "https://" + updateHost + "/setup.exe", Size: int64(len(original)), SHA256: hex.EncodeToString(hash[:])}
	previous := http.DefaultTransport
	defer func() { http.DefaultTransport = previous }()
	for _, payload := range []string{"MZaltered--setup", original + "oversized", original} {
		http.DefaultTransport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(payload))}, nil
		})
		destination := filepath.Join(t.TempDir(), "setup.exe")
		err := downloadSetup(context.Background(), entry, destination)
		if payload == original {
			if err != nil {
				t.Fatal(err)
			}
		} else {
			if err == nil {
				t.Fatal("tampered download accepted")
			}
			if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatal("partial download retained")
			}
		}
	}
}

func TestComponentSwapRestoresEarlierFilesWhenLaterFileIsLocked(t *testing.T) {
	root := t.TempDir()
	source, target, backup := filepath.Join(root, "source"), filepath.Join(root, "target"), filepath.Join(root, "backup")
	for _, dir := range []string{source, target} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"a.exe", "b.exe"} {
		if err := os.WriteFile(filepath.Join(source, name), []byte("new"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, name), []byte("previous"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	locked, _ := windows.UTF16PtrFromString(filepath.Join(target, "b.exe"))
	handle, err := windows.CreateFile(locked, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if err := replaceComponentSet(source, target, backup, []string{"a.exe", "b.exe"}); err == nil {
		t.Fatal("locked file was replaced")
	}
	data, err := os.ReadFile(filepath.Join(target, "a.exe"))
	if err != nil || string(data) != "previous" {
		t.Fatal("earlier component was not restored")
	}
}

func TestLaunchMustRemainAliveToPass(t *testing.T) {
	calls := 0
	if awaitStableProcess(func() bool { calls++; return calls == 1 }, 80*time.Millisecond, 20*time.Millisecond, 5*time.Millisecond) {
		t.Fatal("process that immediately exited was accepted")
	}
	if !awaitStableProcess(func() bool { return true }, time.Second, 20*time.Millisecond, 5*time.Millisecond) {
		t.Fatal("stable process rejected")
	}
}

func TestAgentDataUsesOnlyTheIntegratorExceptionRoot(t *testing.T) {
	root := `C:\Sistemas\Cliente\Integrador`
	executable := filepath.Join(root, "MixFiscalAgentService.exe")
	data := dataDirectoryForExecutable(executable)
	if filepath.Dir(executable) != root {
		t.Fatal("agent executable should stay in the selected Integrator directory")
	}
	if data != filepath.Join(root, ".mixfiscal-agent") {
		t.Fatalf("unexpected agent data directory: %s", data)
	}
	if strings.Contains(strings.ToLower(data), "program files") || strings.Contains(strings.ToLower(data), "programdata") {
		t.Fatal("agent requires a second antivirus exception path")
	}
}

func TestUpdateRejectsUntrustedArtifacts(t *testing.T) {
	valid := setupArtifact{URL: "https://" + updateHost + "/downloads/setup.exe", Size: 1024, SHA256: strings.Repeat("a", 64)}
	if !validArtifact(valid) {
		t.Fatal("valid published artifact rejected")
	}
	for _, address := range []string{"http://" + updateHost + "/a.exe", "https://" + updateHost + ".evil.invalid/a.exe", "https://user@" + updateHost + "/a.exe", "https://" + updateHost + ":443/a.exe"} {
		entry := valid
		entry.URL = address
		if validArtifact(entry) {
			t.Fatalf("untrusted artifact accepted: %s", address)
		}
	}
	for _, hash := range []string{"", strings.Repeat("z", 64), strings.Repeat("0", 62)} {
		entry := valid
		entry.SHA256 = hash
		if validArtifact(entry) {
			t.Fatal("invalid digest accepted")
		}
	}
	entry := valid
	entry.Size = 1 << 30
	if validArtifact(entry) {
		t.Fatal("unbounded artifact accepted")
	}
}

func TestUpdateOnlyAcceptsHigherSemver(t *testing.T) {
	for _, pair := range [][2]string{{"1.3.1", "1.3.0"}, {"2.0.0", "1.99.99"}, {"1.10.0", "1.9.9"}} {
		if !newerVersion(pair[0], pair[1]) {
			t.Fatal(pair)
		}
	}
	for _, version := range []string{"1.3.0", "1.2.9", "garbage", "../../setup", "1.-2.4"} {
		if newerVersion(version, "1.3.0") {
			t.Fatal(version)
		}
	}
}

func TestRedirectCannotLeaveUpdateHost(t *testing.T) {
	req, _ := http.NewRequest("GET", "https://evil.invalid/setup.exe", nil)
	if updateClient().CheckRedirect(req, nil) == nil {
		t.Fatal("cross-host redirect permitted")
	}
}

func TestProcessStateObservesCurrentExecutable(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, running, observed := processState(executable)
	if !running || !observed {
		t.Fatal("current process should be observed through native Windows API")
	}
}

func TestHeartbeatReportsUnknownProcessWithoutPretendingItStopped(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"integrator_observed":false`) {
			t.Errorf("missing observation state: %s", body)
		}
		_, _ = w.Write([]byte(`{"desired_state":"running","command":null}`))
	}))
	defer server.Close()
	previous := apiClient
	apiClient = server.Client()
	defer func() { apiClient = previous }()
	if _, err := heartbeat(context.Background(), Config{APIBase: server.URL}, "test-only", false, true, false); err != nil {
		t.Fatal(err)
	}
}
