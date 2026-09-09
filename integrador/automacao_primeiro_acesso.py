"""Automação do primeiro acesso do Desktop Integrador.

O fluxo usa a própria interface e a ponte nativa Wails do aplicativo. A porta de
depuração é habilitada somente durante a instalação e removida no bloco finally.
"""

from __future__ import annotations

from contextlib import contextmanager
import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Callable
import urllib.request
import winreg

from instalador_core import (
    InstallError, MixApi, normalize_cnpj, read_json, validate_machine_id,
)

def installer_directory() -> Path:
    """Usa a pasta do instalador empacotado como destino da instalação."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    development_dir = Path(__file__).resolve().parent
    return Path(os.environ.get("MIX_INSTALL_DIR", str(development_dir))).resolve()


TARGET_DIR = installer_directory()
TARGET_EXE = TARGET_DIR / "desktop-integrador.exe"
APP_SETTINGS = Path(os.environ["APPDATA"]) / "mixfiscal-integrador" / "local_settings.json"
DEBUG_KEY = r"SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
DEBUG_VALUE = "desktop-integrador.exe"
DEBUG_PORT = 19327
MONITOR_TASK = "Mix Fiscal - Monitorar Integrador"

Progress = Callable[[str], None]


def _source_exe() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    source = base / "desktop-integrador.exe"
    if not source.is_file():
        raise InstallError("desktop-integrador.exe não foi encontrado junto do instalador.")
    return source


def _source_asset(name: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    source = base / name
    if not source.is_file():
        raise InstallError(f"{name} não foi encontrado junto do instalador.")
    return source


def require_admin() -> None:
    if os.name != "nt" or not ctypes.windll.shell32.IsUserAnAdmin():
        raise InstallError("Execute o instalador como administrador.")


def _stop_integrator() -> None:
    target = str(TARGET_EXE).replace("'", "''")
    # O filtro usa o destino atual e só encerra esta instalação.
    command = (
        f"$target='{target}';"
        "Get-CimInstance Win32_Process -Filter \"Name='desktop-integrador.exe'\" | "
        "Where-Object {$_.ExecutablePath -eq $target} | "
        "ForEach-Object {Stop-Process -Id $_.ProcessId -Force}"
    )
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
        check=False, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )


def _optional_machine_id(path: Path) -> str:
    if not path.is_file():
        return ""
    value = read_json(path).get("machine_id", "")
    return validate_machine_id(value) if value else ""


def find_local_machine_id() -> str:
    config_id = _optional_machine_id(TARGET_DIR / "config" / "machine_id.json")
    app_id = _optional_machine_id(APP_SETTINGS)
    if config_id and app_id and config_id != app_id:
        raise InstallError(
            "Os arquivos locais contêm Machine IDs diferentes. Eles foram preservados para revisão."
        )
    return config_id or app_id


def prepare_files(progress: Progress) -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    _stop_integrator()
    source_exe = _source_exe()
    if source_exe.resolve() != TARGET_EXE.resolve():
        shutil.copy2(source_exe, TARGET_EXE)
    for name in (
        "Painel_Mix.bat", "atualizador_mix.ps1", "monitor_mix.ps1",
        "run_silent.vbs", "integrador_version.json",
    ):
        destination = TARGET_DIR / name
        source = _source_asset(name)
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
        if not destination.is_file():
            raise InstallError(f"{name} não foi copiado para a pasta de instalação.")
    progress(f"Aplicativo preparado em {TARGET_DIR}")


def install_monitor(progress: Progress) -> None:
    """Instala o monitor do Painel Mix sem abrir o menu interativo do BAT."""
    progress("Instalando o monitor automático do Integrador")
    script = TARGET_DIR / "monitor_mix.ps1"
    monitor_source = _source_asset("monitor_mix.ps1")
    if monitor_source.resolve() != script.resolve():
        shutil.copy2(monitor_source, script)
    launcher = TARGET_DIR / "run_silent.vbs"
    launcher_source = _source_asset("run_silent.vbs")
    if launcher_source.resolve() != launcher.resolve():
        shutil.copy2(launcher_source, launcher)
    if not script.is_file() or not launcher.is_file():
        raise InstallError("Os arquivos do monitor não foram instalados.")
    task_command = (
        'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass '
        f'-File "{script}"'
    )
    result = subprocess.run(
        [
            "schtasks.exe", "/Create", "/TN", MONITOR_TASK, "/TR", task_command,
            "/SC", "MINUTE", "/MO", "5", "/RL", "HIGHEST", "/F",
        ],
        check=False, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode:
        raise InstallError("Não foi possível instalar a tarefa do Monitor Mix Fiscal.")
    check = subprocess.run(
        ["schtasks.exe", "/Query", "/TN", MONITOR_TASK],
        check=False, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if check.returncode:
        raise InstallError("A tarefa do Monitor Mix Fiscal não foi encontrada após a instalação.")
    progress("Monitor do Windows instalado e verificado")


@contextmanager
def temporary_webview_debug():
    """Habilita CDP em HKLM; WebView2 elevado ignora HKCU e variáveis de usuário."""
    existed = False
    previous = None
    access = winreg.KEY_READ | winreg.KEY_WRITE | winreg.KEY_WOW64_64KEY
    key = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, DEBUG_KEY, 0, access)
    try:
        try:
            previous, _ = winreg.QueryValueEx(key, DEBUG_VALUE)
            existed = True
        except FileNotFoundError:
            pass
        winreg.SetValueEx(
            key, DEBUG_VALUE, 0, winreg.REG_SZ,
            f"--remote-debugging-port={DEBUG_PORT} --remote-debugging-address=127.0.0.1",
        )
        yield
    finally:
        if existed:
            winreg.SetValueEx(key, DEBUG_VALUE, 0, winreg.REG_SZ, previous)
        else:
            try:
                winreg.DeleteValue(key, DEBUG_VALUE)
            except FileNotFoundError:
                pass
        key.Close()


def _wait_debug_port(timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{DEBUG_PORT}/json/version"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.25)
    raise InstallError("O WebView2 não abriu a porta temporária de automação.")


def _click_dom(locator) -> None:
    # A janela fica oculta; clique por coordenadas falha quando está fora do viewport.
    locator.evaluate("element => element.click()")


def _visible(locator) -> bool:
    try:
        return locator.count() > 0 and locator.first.is_visible()
    except Exception:
        return False


def _persist_native_id(page, machine_id: str) -> None:
    result = page.evaluate(
        """async id => {
            const settings = await window.go.app.App.GetLocalSettings();
            await window.go.app.App.SaveLocalSettings({...settings, machine_id: id});
            return await window.go.app.App.LoadSavedMachineID();
        }""",
        machine_id,
    )
    if result != machine_id:
        raise InstallError("O Integrador não confirmou o Machine ID no disco.")


def _open_settings_with_login(page, username: str, password: str, progress: Progress) -> None:
    """Abre Configurações pelo menu e conclui a confirmação de acesso."""
    heading = page.get_by_role("heading", name="Configurações", exact=True)

    # A busca inicial pode encaminhar diretamente para Configurações. Voltamos ao
    # Dashboard para que o clique no menu execute a confirmação de acesso prevista pelo app.
    if _visible(heading):
        dashboard = page.get_by_text("Dashboard", exact=True)
        if not _visible(dashboard):
            raise InstallError("Não foi possível retornar ao Dashboard para confirmar o acesso.")
        _click_dom(dashboard)
        heading.wait_for(state="hidden", timeout=15_000)

    if not _visible(heading):
        progress("Abrindo Configurações do Integrador")
        config_link = page.get_by_text("Configurações", exact=True)
        config_link.wait_for(state="visible", timeout=20_000)
        _click_dom(config_link)

        page.wait_for_function(
            """() => {
                const confirm = [...document.querySelectorAll('button')]
                    .some(e => e.innerText.trim() === 'Confirmar');
                const title = [...document.querySelectorAll('h1,h2,h3')]
                    .some(e => e.innerText.trim() === 'Configurações');
                return confirm || title;
            }""",
            timeout=20_000,
        )

    confirm = page.get_by_role("button", name="Confirmar", exact=True)
    if _visible(confirm):
        progress("Confirmando o login em Configurações")
        protected_login = page.get_by_placeholder("Email ou CPF/CNPJ", exact=True)
        protected_login.fill(username)
        page.get_by_placeholder("Senha", exact=True).fill(password)
        _click_dom(confirm)

    heading.wait_for(state="visible", timeout=25_000)


def _install_from_settings(page, progress: Progress) -> None:
    progress("Instalando a inicialização automática")
    status = page.evaluate("() => window.go.app.App.GetWindowsServiceStatus()")
    install_button = page.get_by_role("button", name="Instalar", exact=True)
    if status == "not_installed":
        install_button.wait_for(state="visible", timeout=15_000)
        install_button.scroll_into_view_if_needed()
        progress("Clicando em Instalar")
        _click_dom(install_button)

    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        status = page.evaluate("() => window.go.app.App.GetWindowsServiceStatus()")
        if status == "running":
            return
        if status == "stopped":
            start_button = page.get_by_role("button", name="Iniciar", exact=True)
            if start_button.count():
                _click_dom(start_button)
        time.sleep(0.5)
    raise InstallError(f"A inicialização não ficou ativa; estado atual: {status!r}.")


def _automate_ui(cnpj: str, username: str, password: str,
                 expected_id: str, progress: Progress) -> str:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise InstallError("O componente Playwright não está incluído no instalador.") from exc

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        page = browser.contexts[0].pages[0]
        if page.url == "about:blank":
            page.goto("http://wails.localhost/", wait_until="domcontentloaded")

        login = page.get_by_placeholder("Email ou CPF/CNPJ", exact=True)
        if _visible(login):
            progress("Autenticando no Integrador")
            login.fill(username)
            page.locator("input[type=password]").fill(password)
            _click_dom(page.get_by_role("button", name="Entrar", exact=True))
            login.wait_for(state="detached", timeout=25_000)

        progress("Aproveitando a identidade gerada pelo Integrador")
        saved_id = page.evaluate("() => window.go.app.App.LoadSavedMachineID()")
        new_setup = page.get_by_role("button", name="Iniciar nova configuracao", exact=True)
        if expected_id:
            machine_id = expected_id
            if saved_id and saved_id != expected_id:
                raise InstallError(
                    "O Integrador apresentou um Machine ID diferente do arquivo local. "
                    "Nenhum cadastro foi alterado."
                )
        elif saved_id:
            machine_id = saved_id
        elif _visible(new_setup):
            # Este clique chama EnsureMachineIDForNewClient dentro da própria tela.
            # Lemos o valor exibido; não chamamos o gerador uma segunda vez.
            _click_dom(new_setup)
            generated = page.locator("input.machine-generated-id-input")
            generated.wait_for(state="visible", timeout=15_000)
            machine_id = generated.input_value()
        else:
            # Retomada defensiva caso uma versão futura não mostre o modal inicial.
            machine_id = page.evaluate("() => window.go.app.App.EnsureMachineIDForNewClient()")
        machine_id = validate_machine_id(machine_id)

        # O ID é salvo antes de qualquer clique posterior. Se houver falha, a nova
        # execução retoma exatamente a mesma identidade.
        _persist_native_id(page, machine_id)

        legacy = page.get_by_placeholder("Informe o machine_id legado", exact=True)
        if _visible(legacy):
            legacy.fill(machine_id)
            _click_dom(page.get_by_role("button", name="Buscar e configurar aplicacao", exact=True))
            page.wait_for_function(
                """() => {
                    const config = [...document.querySelectorAll('h1,h2,h3')]
                        .some(e => e.innerText.trim() === 'Configurações');
                    const dashboard = [...document.querySelectorAll('a,button')]
                        .some(e => e.innerText.trim() === 'Dashboard');
                    return config || dashboard;
                }""",
                timeout=25_000,
            )

        _open_settings_with_login(page, username, password, progress)

        progress("Vinculando o CNPJ ao serviço Mix Fiscal")
        cnpj_input = page.get_by_placeholder("00.000.000/0001-00", exact=True).first
        cnpj_input.wait_for(state="visible", timeout=20_000)
        cnpj_input.fill(cnpj)
        has_service = page.evaluate(
            """() => { try {
                const config = JSON.parse(localStorage.getItem('mxf_config') || '{}');
                return (config.tag_service || []).includes('mixfiscal');
            } catch { return false; } }"""
        )
        if not has_service:
            service = page.locator("select").filter(has=page.locator("option[value=mixfiscal]"))
            service.select_option("mixfiscal")
            _click_dom(service.locator("..").get_by_role("button", name="Adicionar", exact=True))
        save_button = page.get_by_role("button", name="Salvar Configurações", exact=True)
        save_button.scroll_into_view_if_needed()
        page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
        progress("Salvando CNPJ e serviço Mix Fiscal")
        _click_dom(save_button)
        page.wait_for_function(
            """cnpj => { try {
                const config = JSON.parse(localStorage.getItem('mxf_config') || '{}');
                return config.cnpj_cpf === cnpj && (config.tag_service || []).includes('mixfiscal');
            } catch { return false; } }""",
            arg=cnpj, timeout=30_000,
        )

        _persist_native_id(page, machine_id)

        _install_from_settings(page, progress)
        progress("Instalação ativa; preparando a abertura da interface")
        return machine_id


def install(cnpj: str, username: str, password: str, *, progress: Progress = print) -> dict:
    require_admin()
    cnpj = normalize_cnpj(cnpj)
    if not username.strip() or not password:
        raise InstallError("Informe usuário e senha do Integrador.")

    progress("Validando o acesso à API")
    api = MixApi()
    api.login(username, password)
    local_machine_id = find_local_machine_id()
    prepare_files(progress)
    machine_id = ""
    try:
        with temporary_webview_debug():
            _stop_integrator()
            subprocess.Popen(
                [str(TARGET_EXE)], cwd=str(TARGET_DIR),
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            _wait_debug_port()
            machine_id = _automate_ui(
                cnpj, username, password, local_machine_id, progress
            )

        # A interface nativa já instalou suas tarefas. Ativamos o monitor antes
        # das consultas finais para que uma demora da API não deixe o cliente sem proteção.
        install_monitor(progress)
        progress("Confirmando cadastro na API")
        api.verify_registration(cnpj, machine_id)
        local_id = read_json(TARGET_DIR / "config" / "machine_id.json").get("machine_id")
        app_id = read_json(APP_SETTINGS).get("machine_id")
        if local_id != machine_id or app_id != machine_id:
            raise InstallError("O Machine ID não ficou igual nos dois arquivos locais.")
        progress("Aguardando o Machine ID ficar online no App Mix")
        api.wait_until_online(cnpj, machine_id)
        return {"cnpj": cnpj, "machine_id": machine_id, "monitor": MONITOR_TASK}
    finally:
        # Fecha o processo com CDP e reabre visível, como "Abrir Interface" no ícone da bandeja.
        _stop_integrator()
        if machine_id and TARGET_EXE.exists():
            subprocess.Popen(
                [str(TARGET_EXE)], cwd=str(TARGET_DIR),
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
