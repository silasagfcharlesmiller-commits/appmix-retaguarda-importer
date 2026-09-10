"""Cliente mínimo do Chrome DevTools Protocol usado pelo WebView2 local."""

from __future__ import annotations

import json
import time
import urllib.request

import websocket

from instalador_core import InstallError


def _quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


class CdpPage:
    def __init__(self, port: int):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=4) as response:
                targets = json.loads(response.read())
            target = next(
                item for item in targets
                if item.get("type") == "page" and item.get("webSocketDebuggerUrl")
            )
            self.url = str(target.get("url", ""))
            self.socket = websocket.create_connection(
                target["webSocketDebuggerUrl"], timeout=8,
                suppress_origin=True, http_proxy_host=None,
            )
            self.socket.settimeout(40)
        except Exception as exc:
            raise InstallError("Não foi possível conectar à automação local do WebView2.") from exc
        self.sequence = 0
        self.call("Runtime.enable")

    def close(self) -> None:
        try:
            self.socket.close()
        except Exception:
            pass

    def call(self, method: str, params: dict | None = None) -> dict:
        self.sequence += 1
        request_id = self.sequence
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            try:
                message = json.loads(self.socket.recv())
            except Exception as exc:
                raise InstallError(f"A comunicação local com o WebView2 falhou em {method}.") from exc
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise InstallError(f"O WebView2 recusou a etapa {method}.")
            return message.get("result", {})

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
            "userGesture": True,
        })
        if result.get("exceptionDetails"):
            description = (
                result.get("exceptionDetails", {}).get("exception", {}).get("description")
                or result.get("exceptionDetails", {}).get("text")
                or "erro JavaScript"
            )
            raise InstallError(f"A interface do Integrador recusou uma etapa: {description}")
        remote = result.get("result", {})
        return remote.get("value")

    def navigate(self, url: str) -> None:
        self.call("Page.enable")
        self.call("Page.navigate", {"url": url})

    def wait(self, predicate: str, timeout: float = 20, message: str = "Elemento não encontrado") -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.evaluate(f"Boolean({predicate})"):
                return
            time.sleep(0.2)
        raise InstallError(message)

    @staticmethod
    def _visible(element: str) -> str:
        return (
            f"(()=>{{const e={element};if(!e)return false;const s=getComputedStyle(e);"
            "const r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'"
            "&&r.width>0&&r.height>0})()"
        )

    @staticmethod
    def _placeholder(value: str, index: int = 0) -> str:
        return (
            "[...document.querySelectorAll('input,textarea')]"
            f".filter(e=>e.getAttribute('placeholder')==={_quoted(value)})[{index}]"
        )

    @staticmethod
    def _text(value: str, tags: str = "button,a", normalize: bool = False) -> str:
        if normalize:
            expected = _quoted(value.casefold())
            comparison = (
                "(e.innerText||'').trim().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')"
                f".toLowerCase()==={expected}"
            )
        else:
            comparison = f"(e.innerText||'').trim()==={_quoted(value)}"
        return f"[...document.querySelectorAll({_quoted(tags)})].find(e=>{comparison})"

    def visible_placeholder(self, value: str, index: int = 0) -> bool:
        return bool(self.evaluate(self._visible(self._placeholder(value, index))))

    def wait_placeholder(self, value: str, timeout: float = 20, index: int = 0) -> None:
        expression = self._placeholder(value, index)
        self.wait(self._visible(expression), timeout, f"O campo {value!r} não apareceu.")

    def wait_placeholder_hidden(self, value: str, timeout: float = 20, index: int = 0) -> None:
        expression = self._placeholder(value, index)
        self.wait(f"!({self._visible(expression)})", timeout, f"O campo {value!r} continuou aberto.")

    def fill_placeholder(self, placeholder: str, value: str, index: int = 0) -> None:
        element = self._placeholder(placeholder, index)
        script = f"""(()=>{{
            const e={element}; if(!e) return false;
            const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto,'value').set.call(e,{_quoted(value)});
            e.dispatchEvent(new Event('input',{{bubbles:true}}));
            e.dispatchEvent(new Event('change',{{bubbles:true}})); return true;
        }})()"""
        if not self.evaluate(script):
            raise InstallError(f"Não foi possível preencher o campo {placeholder!r}.")

    def fill_password(self, value: str) -> None:
        script = f"""(()=>{{
            const e=document.querySelector('input[type=password]'); if(!e) return false;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,{_quoted(value)});
            e.dispatchEvent(new Event('input',{{bubbles:true}}));
            e.dispatchEvent(new Event('change',{{bubbles:true}})); return true;
        }})()"""
        if not self.evaluate(script):
            raise InstallError("Não foi possível preencher a senha na interface do Integrador.")

    def visible_text(self, value: str, tags: str = "button,a", normalize: bool = False) -> bool:
        return bool(self.evaluate(self._visible(self._text(value, tags, normalize))))

    def wait_text(self, value: str, timeout: float = 20, tags: str = "button,a") -> None:
        expression = self._text(value, tags)
        self.wait(self._visible(expression), timeout, f"A opção {value!r} não apareceu.")

    def click_text(self, value: str, tags: str = "button,a", normalize: bool = False) -> None:
        element = self._text(value, tags, normalize)
        if not self.evaluate(
            f"(()=>{{const e={element};if(!e)return false;e.scrollIntoView({{block:'center'}});e.click();return true}})()"
        ):
            raise InstallError(f"Não foi possível clicar em {value!r}.")

    def wait_text_hidden(self, value: str, timeout: float = 15, tags: str = "h1,h2,h3") -> None:
        expression = self._text(value, tags)
        self.wait(f"!({self._visible(expression)})", timeout, f"A tela {value!r} não foi fechada.")

    def input_value(self, selector: str) -> str:
        return str(self.evaluate(f"document.querySelector({_quoted(selector)})?.value||''"))

    def wait_css(self, selector: str, timeout: float = 20) -> None:
        expression = f"document.querySelector({_quoted(selector)})"
        self.wait(self._visible(expression), timeout, f"O elemento {selector!r} não apareceu.")

    def add_select_option(self, option_value: str, button_text: str) -> None:
        script = f"""(()=>{{
            const select=[...document.querySelectorAll('select')]
                .find(e=>[...e.options].some(o=>o.value==={_quoted(option_value)}));
            if(!select) return false;
            select.value={_quoted(option_value)};
            select.dispatchEvent(new Event('input',{{bubbles:true}}));
            select.dispatchEvent(new Event('change',{{bubbles:true}}));
            const scope=select.parentElement||document;
            const button=[...scope.querySelectorAll('button')]
                .find(e=>(e.innerText||'').trim()==={_quoted(button_text)});
            if(!button) return false; button.click(); return true;
        }})()"""
        if not self.evaluate(script):
            raise InstallError(f"Não foi possível adicionar o serviço {option_value!r}.")
