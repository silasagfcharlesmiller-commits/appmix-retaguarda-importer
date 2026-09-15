"""Browser checks against a local production build, with every API response mocked.

Run from web/: python tests/robots-browser.py (requires a local Playwright Chromium).
No production credentials, database, portal or robot commands are used.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SECRET = "robots-browser-isolated-session-secret-2026"
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
base = f"http://127.0.0.1:{port}"
env = {**os.environ, "NODE_ENV": "production", "APP_MIX_SESSION_SECRET": SECRET,
       "DATABASE_URL": "postgresql://test:test@127.0.0.1:9/test", "APP_MIX_API_URL": "http://127.0.0.1:9",
       "APP_MIX_API_KEY": "isolated-test", "APP_MIX_CREDENTIAL_SECRET": "isolated-test-credential-secret-2026"}
process = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", str(port)],
                           cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
try:
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.2):
                break
        except OSError:
            time.sleep(.1)
    payload = base64.b64encode(json.dumps({"email": "test@example.invalid", "exp": int(time.time() * 1000) + 3600000}).encode()).decode()
    cookie = payload + "." + hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    robots = [{"id": f"robot-{i}", "cnpj": "11222333000181" if i < 2 else f"{i:014d}", "machine_id": f"{i+1:064x}",
               "computer_name": f"PC-{i}", "windows_user": "test", "agent_version": "2.0.0", "agent_protocol": 1 if i == 3 else 2,
               "desired_state": "running", "connection_status": "online", "integrator_observed": True,
               "integrator_online": True, "session_ready": True, "agent_online": True, "last_seen": "2026-09-15T12:00:00Z",
               "last_command_status": "pending" if i == 4 else "completed"} for i in range(18)]
    robots[5].update(desired_state="paused", integrator_online=False)
    robots[6].update(agent_online=False, connection_status="offline")
    robots[7].update(connection_status="delayed")
    robots[8].update(integrator_observed=False)
    commands, lookups, errors = [], [], []
    flags = {"status_error": False, "client_error": False}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, service_workers="block")
        context.add_cookies([{"name": "appmix_session", "value": cookie, "url": base}])

        def route(request):
            url = urlparse(request.request.url)
            if url.netloc != f"127.0.0.1:{port}":
                return request.abort()
            if url.path == "/api/agents/clients":
                cnpj = parse_qs(url.query)["cnpj"][0]
                lookups.append(cnpj)
                if flags["client_error"]:
                    return request.fulfill(status=502, json={"detail": "Cadastro indisponível (teste)."})
                return request.fulfill(json={"cnpj": cnpj, "client_name": "Teste Victor" if cnpj == "11222333000181" else f"Cliente {cnpj}",
                                             "retaguarda": "Arius", "status": "loaded"})
            if url.path == "/api/agents":
                if request.request.method == "GET":
                    if flags["status_error"]:
                        return request.fulfill(status=503, json={"detail": "Falha simulada de status."})
                    return request.fulfill(json={"items": robots})
                body = request.request.post_data_json
                commands.append(body)
                if body["agent_id"] == "robot-1":
                    return request.fulfill(status=422, json={"detail": "Falha simulada de comando."})
                agent = next(item for item in robots if item["id"] == body["agent_id"])
                agent.update(last_command_status="pending", last_action=body["action"], last_command_at="2026-09-15T12:01:00Z")
                return request.fulfill(status=201, json={"requested_at": agent["last_command_at"], "status": "pending"})
            if url.path.startswith("/api/"):
                return request.fulfill(status=500, json={"detail": "Unmocked API blocked"})
            return request.continue_()

        context.route("**/*", route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/painel/robos")
        rows = page.locator("tbody tr")
        expect(rows).to_have_count(18)
        expect(page.get_by_text("Teste Victor", exact=True)).to_have_count(2)
        assert lookups.count("11222333000181") == 1
        assert rows.first.locator("td").count() == 6
        expect(page.get_by_role("columnheader", name="Retaguarda", exact=True)).to_have_count(0)
        assert rows.first.get_by_role("button").count() == 3
        assert max(rows.nth(i).bounding_box()["height"] for i in range(18)) <= 52
        expect(page.get_by_text("Identificar cliente")).to_have_count(0)
        expect(rows.nth(3).get_by_role("button", name="Atualizar", exact=True)).to_be_disabled()
        expect(rows.nth(4).get_by_role("button", name="Iniciar", exact=True)).to_be_disabled()

        search = page.get_by_role("searchbox")
        select_all = page.get_by_role("checkbox", name="Selecionar todos os robôs do filtro")
        search.fill("victor")
        expect(rows).to_have_count(2)
        rows.first.get_by_role("checkbox").check()
        assert select_all.evaluate("el => el.indeterminate")
        select_all.check()
        search.fill("00.000.000/0000-02")
        expect(rows).to_have_count(1)
        expect(page.get_by_role("button", name="Pausar Selecionados")).to_be_disabled()
        select_all.check()
        page.get_by_role("button", name="Pausar Selecionados").click()
        expect(page.get_by_text("1 de 1 solicitação(ões) de pausa aceita(s).", exact=False)).to_be_visible()
        assert commands == [{"agent_id": "robot-2", "action": "pause"}]

        search.fill("victor")
        page.get_by_role("button", name="Iniciar Selecionados").click()
        expect(page.get_by_text("1 de 2 solicitação(ões) de início aceita(s).", exact=False)).to_be_visible()
        expect(page.get_by_text("Falha simulada de comando.", exact=False)).to_be_visible()
        assert {item["agent_id"] for item in commands[1:]} == {"robot-0", "robot-1"}
        expect(rows.first.get_by_role("button", name="Iniciar", exact=True)).to_be_disabled()
        search.fill("xxxxxxxx")
        expect(page.get_by_text("Nenhum robô corresponde à pesquisa.")).to_be_visible()
        search.fill("")
        page.get_by_role("button", name="Limpar seleção").click()
        expect(rows).to_have_count(18)
        rows.nth(9).get_by_role("button", name="Atualizar", exact=True).click()
        expect(page.get_by_text("1 de 1 solicitação(ões) de atualização aceita(s).", exact=False)).to_be_visible()
        assert commands[-1] == {"agent_id": "robot-9", "action": "update"}

        # Polling may reorder robots; checkbox identity must stay with the agent ID.
        checkbox = rows.nth(10).get_by_role("checkbox")
        selected_label = checkbox.get_attribute("aria-label")
        checkbox.check()
        robots.reverse()
        page.get_by_role("button", name="Atualizar lista").click()
        expect(page.get_by_role("checkbox", name=selected_label, exact=True)).to_be_checked()
        page.get_by_role("button", name="Limpar seleção").click()

        artifacts = ROOT.parent / ".tmp-robots-ui"
        artifacts.mkdir(exist_ok=True)
        page.screenshot(path=str(artifacts / "desktop.png"), full_page=True)
        page.evaluate("document.documentElement.dataset.theme = 'dark'")
        page.screenshot(path=str(artifacts / "dark.png"), full_page=True)
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        scroll = page.get_by_role("region", name="Tabela de robôs", exact=False)
        assert scroll.evaluate("el => el.scrollWidth > el.clientWidth")
        scroll.evaluate("el => el.scrollLeft = el.scrollWidth")
        page.screenshot(path=str(artifacts / "mobile.png"), full_page=True)
        flags.update(status_error=True, client_error=True)
        page.get_by_role("button", name="Atualizar lista").click()
        expect(page.get_by_text("Falha simulada de status.", exact=False)).to_be_visible()
        expect(page.get_by_text("Cadastro indisponível para", exact=False)).to_be_visible()
        expect(rows).to_have_count(18)
        expect(page.get_by_text("Processo aberto", exact=True)).to_have_count(0)
        expect(page.get_by_text("Teste Victor", exact=True)).to_have_count(2)
        assert not errors, errors
        browser.close()
        print("PASS: 18 compact rows; API deduplication; search; selection; bulk scope; partial failure; pending/legacy guards; desktop/dark/mobile; stale status and cadastro fallback; no browser errors.")
finally:
    process.terminate()
    process.wait(timeout=10)
