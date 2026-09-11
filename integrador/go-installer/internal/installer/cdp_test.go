package installer

import (
	"strings"
	"testing"
)

func TestVisibleExpressionBalanced(t *testing.T) {
	expression := visibleExpression("document.body")
	if !strings.HasPrefix(expression, "(()=>{") || !strings.HasSuffix(expression, "})()") {
		t.Fatalf("expressão inesperada: %s", expression)
	}
}

func TestTextExpressionNormalizesPortuguese(t *testing.T) {
	expression := textExpression("Configuração", "button,a", true)
	if !strings.Contains(expression, `"configuracao"`) || !strings.Contains(expression, "normalize('NFD')") {
		t.Fatalf("normalização ausente: %s", expression)
	}
}

func TestCDPExceptionDescription(t *testing.T) {
	details := map[string]any{
		"text":      "Uncaught",
		"exception": map[string]any{"description": "TypeError: ponte ainda não carregada"},
	}
	if got := cdpExceptionDescription(details); got != "TypeError: ponte ainda não carregada" {
		t.Fatalf("detalhe da exceção não preservado: %q", got)
	}
}

func TestIntegratorBridgeWaitChecksRequiredMethods(t *testing.T) {
	for _, method := range []string{"LoadSavedMachineID", "GetLocalSettings", "SaveLocalSettings", "EnsureMachineIDForNewClient", "GetWindowsServiceStatus"} {
		if !strings.Contains(integratorBridgePredicate, method) {
			t.Fatalf("a espera da ponte não cobre %s", method)
		}
	}
}
