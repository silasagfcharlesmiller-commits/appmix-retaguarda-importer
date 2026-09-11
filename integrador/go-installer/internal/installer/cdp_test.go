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
