package installer

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

type cdpTarget struct {
	Type                 string `json:"type"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

type CDPPage struct {
	connection *websocket.Conn
	sequence   int
	URL        string
}

const integratorBridgePredicate = `document.readyState!=='loading'&&typeof window.go==='object'&&window.go.app&&window.go.app.App&&typeof window.go.app.App.LoadSavedMachineID==='function'&&typeof window.go.app.App.GetLocalSettings==='function'&&typeof window.go.app.App.SaveLocalSettings==='function'&&typeof window.go.app.App.EnsureMachineIDForNewClient==='function'&&typeof window.go.app.App.GetWindowsServiceStatus==='function'`

func NewCDPPage(port int) (*CDPPage, error) {
	client := &http.Client{Timeout: 4 * time.Second}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/list", port))
	if err != nil {
		return nil, fail("Não foi possível consultar a automação local do WebView2.")
	}
	defer response.Body.Close()
	var targets []cdpTarget
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&targets) != nil {
		return nil, fail("O WebView2 não retornou uma página de automação válida.")
	}
	var selected cdpTarget
	for _, target := range targets {
		if target.Type == "page" && target.WebSocketDebuggerURL != "" {
			selected = target
			break
		}
	}
	if selected.WebSocketDebuggerURL == "" {
		return nil, fail("O WebView2 não expôs uma página para automação.")
	}
	dialer := websocket.Dialer{Proxy: nil, HandshakeTimeout: 8 * time.Second}
	connection, _, err := dialer.Dial(selected.WebSocketDebuggerURL, nil)
	if err != nil {
		return nil, fail("Não foi possível conectar à automação local do WebView2.")
	}
	page := &CDPPage{connection: connection, URL: selected.URL}
	if _, err := page.Call("Runtime.enable", nil); err != nil {
		page.Close()
		return nil, err
	}
	return page, nil
}

func (page *CDPPage) Close() {
	if page.connection != nil {
		_ = page.connection.Close()
	}
}

func (page *CDPPage) Call(method string, params map[string]any) (map[string]any, error) {
	page.sequence++
	requestID := page.sequence
	_ = page.connection.SetWriteDeadline(time.Now().Add(40 * time.Second))
	if err := page.connection.WriteJSON(map[string]any{"id": requestID, "method": method, "params": params}); err != nil {
		return nil, fail("A comunicação local com o WebView2 falhou em %s.", method)
	}
	for {
		_ = page.connection.SetReadDeadline(time.Now().Add(40 * time.Second))
		var message map[string]any
		if err := page.connection.ReadJSON(&message); err != nil {
			return nil, fail("A comunicação local com o WebView2 falhou em %s.", method)
		}
		id, _ := message["id"].(float64)
		if int(id) != requestID {
			continue
		}
		if message["error"] != nil {
			return nil, fail("O WebView2 recusou a etapa %s.", method)
		}
		result, _ := message["result"].(map[string]any)
		return result, nil
	}
}

func (page *CDPPage) Evaluate(expression string) (any, error) {
	result, err := page.Call("Runtime.evaluate", map[string]any{
		"expression": expression, "awaitPromise": true, "returnByValue": true, "userGesture": true,
	})
	if err != nil {
		return nil, err
	}
	if details := result["exceptionDetails"]; details != nil {
		return nil, fail("A interface do Integrador recusou uma etapa: %s", cdpExceptionDescription(details))
	}
	remote, _ := result["result"].(map[string]any)
	return remote["value"], nil
}

func (page *CDPPage) EvaluateRetry(expression string, attempts int, interval time.Duration) (any, error) {
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		value, err := page.Evaluate(expression)
		if err == nil {
			return value, nil
		}
		lastErr = err
		if attempt+1 < attempts {
			time.Sleep(interval)
		}
	}
	return nil, lastErr
}

func cdpExceptionDescription(value any) string {
	details, _ := value.(map[string]any)
	if exception, ok := details["exception"].(map[string]any); ok {
		if description := safeText(exception["description"], 500); description != "<nil>" && description != "" {
			return description
		}
	}
	if description := safeText(details["text"], 500); description != "<nil>" && description != "" {
		return description
	}
	return "erro JavaScript sem detalhe informado pelo WebView2"
}

func (page *CDPPage) Navigate(target string) error {
	if _, err := page.Call("Page.enable", nil); err != nil {
		return err
	}
	_, err := page.Call("Page.navigate", map[string]any{"url": target})
	return err
}

func (page *CDPPage) Wait(predicate string, timeout time.Duration, message string) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		value, err := page.Evaluate("Boolean(" + predicate + ")")
		if err == nil {
			if visible, ok := value.(bool); ok && visible {
				return nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fail("%s", message)
}

func (page *CDPPage) WaitIntegratorBridge(timeout time.Duration) error {
	return page.Wait(integratorBridgePredicate, timeout, "O Integrador abriu, mas a ponte nativa ainda não ficou pronta. Tente novamente; o mesmo Machine ID será reaproveitado.")
}

func jsQuote(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func visibleExpression(element string) string {
	return fmt.Sprintf("(()=>{const e=%s;if(!e)return false;const s=getComputedStyle(e);const r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0})()", element)
}

func placeholderExpression(value string, index int) string {
	return fmt.Sprintf("[...document.querySelectorAll('input,textarea')].filter(e=>e.getAttribute('placeholder')===%s)[%d]", jsQuote(value), index)
}

func textExpression(value, tags string, normalize bool) string {
	comparison := fmt.Sprintf("(e.innerText||'').trim()===%s", jsQuote(value))
	if normalize {
		comparison = fmt.Sprintf("(e.innerText||'').trim().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase()===%s", jsQuote(lowerWithoutAccents(value)))
	}
	return fmt.Sprintf("[...document.querySelectorAll(%s)].find(e=>%s)", jsQuote(tags), comparison)
}

func lowerWithoutAccents(value string) string {
	replacer := map[rune]rune{
		'á': 'a', 'à': 'a', 'ã': 'a', 'â': 'a', 'ä': 'a',
		'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
		'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
		'ó': 'o', 'ò': 'o', 'õ': 'o', 'ô': 'o', 'ö': 'o',
		'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ç': 'c',
	}
	runes := []rune(value)
	for index, item := range runes {
		if replacement, ok := replacer[item]; ok {
			runes[index] = replacement
		}
	}
	for index, item := range runes {
		if item >= 'A' && item <= 'Z' {
			runes[index] = item + ('a' - 'A')
		}
	}
	return string(runes)
}

func (page *CDPPage) VisiblePlaceholder(value string, index int) bool {
	result, err := page.Evaluate(visibleExpression(placeholderExpression(value, index)))
	visible, _ := result.(bool)
	return err == nil && visible
}

func (page *CDPPage) WaitPlaceholder(value string, timeout time.Duration, index int) error {
	return page.Wait(visibleExpression(placeholderExpression(value, index)), timeout, fmt.Sprintf("O campo %q não apareceu.", value))
}

func (page *CDPPage) WaitPlaceholderHidden(value string, timeout time.Duration, index int) error {
	return page.Wait("!("+visibleExpression(placeholderExpression(value, index))+")", timeout, fmt.Sprintf("O campo %q continuou aberto.", value))
}

func (page *CDPPage) FillPlaceholder(placeholder, value string, index int) error {
	element := placeholderExpression(placeholder, index)
	script := fmt.Sprintf(`(()=>{const e=%s;if(!e)return false;const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,%s);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`, element, jsQuote(value))
	result, err := page.Evaluate(script)
	if ok, _ := result.(bool); err != nil || !ok {
		return fail("Não foi possível preencher o campo %q.", placeholder)
	}
	return nil
}

func (page *CDPPage) FillPassword(value string) error {
	script := fmt.Sprintf(`(()=>{const e=document.querySelector('input[type=password]');if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,%s);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`, jsQuote(value))
	result, err := page.Evaluate(script)
	if ok, _ := result.(bool); err != nil || !ok {
		return fail("Não foi possível preencher a senha na interface do Integrador.")
	}
	return nil
}

func (page *CDPPage) VisibleText(value, tags string, normalize bool) bool {
	result, err := page.Evaluate(visibleExpression(textExpression(value, tags, normalize)))
	visible, _ := result.(bool)
	return err == nil && visible
}

func (page *CDPPage) WaitText(value string, timeout time.Duration, tags string) error {
	return page.Wait(visibleExpression(textExpression(value, tags, false)), timeout, fmt.Sprintf("A opção %q não apareceu.", value))
}

func (page *CDPPage) ClickText(value, tags string, normalize bool) error {
	element := textExpression(value, tags, normalize)
	result, err := page.Evaluate(fmt.Sprintf("(()=>{const e=%s;if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()", element))
	if ok, _ := result.(bool); err != nil || !ok {
		return fail("Não foi possível clicar em %q.", value)
	}
	return nil
}

func (page *CDPPage) WaitTextHidden(value string, timeout time.Duration, tags string) error {
	return page.Wait("!("+visibleExpression(textExpression(value, tags, false))+")", timeout, fmt.Sprintf("A tela %q não foi fechada.", value))
}

func (page *CDPPage) InputValue(selector string) string {
	result, _ := page.Evaluate(fmt.Sprintf("document.querySelector(%s)?.value||''", jsQuote(selector)))
	value, _ := result.(string)
	return value
}

func (page *CDPPage) WaitCSS(selector string, timeout time.Duration) error {
	expression := fmt.Sprintf("document.querySelector(%s)", jsQuote(selector))
	return page.Wait(visibleExpression(expression), timeout, fmt.Sprintf("O elemento %q não apareceu.", selector))
}

func (page *CDPPage) AddSelectOption(optionValue, buttonText string) error {
	script := fmt.Sprintf(`(()=>{const select=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value===%s));if(!select)return false;select.value=%s;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));const scope=select.parentElement||document;const button=[...scope.querySelectorAll('button')].find(e=>(e.innerText||'').trim()===%s);if(!button)return false;button.click();return true})()`, jsQuote(optionValue), jsQuote(optionValue), jsQuote(buttonText))
	result, err := page.Evaluate(script)
	if ok, _ := result.(bool); err != nil || !ok {
		return fail("Não foi possível adicionar o serviço %q.", optionValue)
	}
	return nil
}
