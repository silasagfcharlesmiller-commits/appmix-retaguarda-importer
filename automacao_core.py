import os
import re
import asyncio
import hashlib
import json
import unicodedata
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PASTA_APLICACAO = Path(os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__)))
PASTA_PLAYWRIGHT = PASTA_APLICACAO / "playwright-browsers"
PASTA_PERFIL_PLAYWRIGHT = PASTA_APLICACAO / "playwright-profile"
CACHE_MODAIS = PASTA_APLICACAO / "cache_modais.json"
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(PASTA_PLAYWRIGHT)

from playwright.async_api import async_playwright, Page
from playwright._impl._driver import compute_driver_executable, get_driver_env
from bs4 import BeautifulSoup

from automacao_tabela import preencher_tabelas_mix
from automacao_compara_divergencia import configurar_divergencias

UF_VALIDAS = {"ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg", "pa", "pb", "pr", "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to"}

CHAVES_VIEWS_COM_EXCECOES = (
    "pis_cofins", "icms_saida", "icms_entrada", "ibs_cbs",
)


def _codigos_excecao_do_cnpj(excecoes_produtos, cnpj):
    """Retorna somente codigos inteiros validos configurados para o CNPJ."""
    if not isinstance(excecoes_produtos, dict):
        return []
    mapa = excecoes_produtos.get("excecoes_por_cnpj", excecoes_produtos)
    if not isinstance(mapa, dict):
        return []
    cnpj_normalizado = re.sub(r"\D", "", str(cnpj or ""))
    configuracao = mapa.get(cnpj_normalizado)
    if configuracao is None:
        configuracao = next(
            (
                valor for chave, valor in mapa.items()
                if re.sub(r"\D", "", str(chave)) == cnpj_normalizado
            ),
            {},
        )
    if not isinstance(configuracao, dict) or not configuracao.get("ativo", True):
        return []
    codigos = configuracao.get("codigos_produto", [])
    if not isinstance(codigos, list):
        return []
    resultado = set()
    for codigo in codigos:
        texto = str(codigo).strip()
        if re.fullmatch(r"\d+", texto):
            resultado.add(int(texto))
    return sorted(resultado)


def _cnpj_tem_configuracao_excecao(excecoes_produtos, cnpj):
    if not isinstance(excecoes_produtos, dict):
        return False
    mapa = excecoes_produtos.get("excecoes_por_cnpj", excecoes_produtos)
    if not isinstance(mapa, dict):
        return False
    cnpj_normalizado = re.sub(r"\D", "", str(cnpj or ""))
    return any(
        re.sub(r"\D", "", str(chave)) == cnpj_normalizado
        for chave in mapa
    )


def _adicionar_excecoes_view(sql_base, codigos):
    """Remove o filtro antigo e aplica as excecoes ao SELECT em memoria.

    Se o cadastro por CNPJ ainda nao estiver disponivel, reaproveita os codigos
    existentes no NOT IN legado do proprio SELECT.
    """
    sql_original = str(sql_base or "")
    if not sql_original:
        return sql_original

    filtro_antigo = re.search(
        r"\bcodigo_produto\s+NOT\s+IN\s*\(([^)]*)\)",
        sql_original,
        flags=re.IGNORECASE | re.DOTALL,
    )
    codigos_legados = []
    if filtro_antigo:
        codigos_legados = sorted({
            int(valor)
            for valor in re.findall(r"\d+", filtro_antigo.group(1))
        })

    # Remove primeiro um NOT IN antigo. Quando ele e a unica condicao, remove
    # tambem o WHERE; quando vem depois de outra condicao, remove AND/OR + filtro.
    sql = re.sub(
        r"\s+\b(?:AND|OR)\s+codigo_produto\s+NOT\s+IN\s*\([^)]*\)",
        "",
        sql_original,
        flags=re.IGNORECASE,
    )
    sql = re.sub(
        r"\s+\bWHERE\s+codigo_produto\s+NOT\s+IN\s*\([^)]*\)",
        "",
        sql,
        flags=re.IGNORECASE,
    )

    # None significa que o CNPJ nao possui cadastro e permite o fallback legado.
    # Uma lista vazia significa cadastro explicito vazio/inativo e remove o legado.
    codigos_aplicar = (
        codigos_legados if codigos is None
        else sorted(set(codigos_legados) | set(codigos))
    )
    if not codigos_aplicar:
        return sql

    # A nova clausula precisa ficar antes de um eventual ponto e virgula final.
    sql = re.sub(r";\s*$", "", sql).rstrip()
    possui_where = re.search(r"\bWHERE\b", sql, re.IGNORECASE) is not None
    operador = "AND" if possui_where else "WHERE"
    lista_sql = ", ".join(str(codigo) for codigo in codigos_aplicar)
    return f"{sql}\n{operador} codigo_produto NOT IN ({lista_sql})"

class MixAutomation:
    """
    Classe central que encapsula toda a lógica de automação do Mix Fiscal,
    independente de interface gráfica.
    """
    def __init__(self, config, log_callback=print):
        self.config = config
        self.log = log_callback
        self.browser = None
        self.context = None
        self.page = None
        self.playwright = None
        self.delay_multiplier = float(config.get("delay_multiplier", 0.5))

    def _usar_headless(self) -> bool:
        """Normaliza a configuracao, inclusive quando vier como texto."""
        valor = self.config.get("headless", True)
        if isinstance(valor, str):
            return valor.strip().lower() in {"1", "true", "yes", "sim"}
        return bool(valor)

    async def _patch_page_timeout(self, page: Page):
        """Aplica um multiplicador de delay a todas as esperas da página."""
        original_wait = page.wait_for_timeout
        async def patched_wait_for_timeout(timeout):
            delay_ms = int(timeout * self.delay_multiplier)
            if delay_ms > 0:
                await original_wait(delay_ms)
        page.wait_for_timeout = patched_wait_for_timeout

    def _normalizar_cnpj(self, cnpj):
        return re.sub(r"\D", "", str(cnpj))

    def _normalizar_nome_empresa(self, nome: str) -> str:
        """Converte o nome da empresa para snake_case sem acentos."""
        texto = unicodedata.normalize("NFKD", str(nome or "").strip())
        texto = "".join(c for c in texto if not unicodedata.combining(c))
        texto = re.sub(r"[^a-zA-Z0-9]+", "_", texto).strip("_")
        return texto.lower()

    async def extrair_dados_cliente_appmix(self, page: Page) -> dict:
        """Extrai CNPJ, regime, UF e nome da empresa do detalhe do cliente."""
        try:
            html_content = await page.content()
            soup = BeautifulSoup(html_content, "html.parser")
            dados = {"cnpj": None, "regime_tributario": None, "uf": None, "nome_empresa": None}

            # Na listagem filtrada do portal, a coluna do nome da empresa usa
            # atualmente este ID. Ela é a fonte prioritária porque o formulário
            # de detalhes pode não manter um input de nome no DOM.
            empresa_celula = soup.find(id="cell-3-undefined")
            if empresa_celula:
                valor_empresa = empresa_celula.get_text(" ", strip=True)
                if valor_empresa and valor_empresa.lower() != "não informado":
                    dados["nome_empresa"] = valor_empresa

            if not dados["nome_empresa"]:
                campo_empresa = soup.find(
                    "input",
                    attrs={"placeholder": re.compile(
                        r"nome\s+(?:da\s+)?empresa|raz[aã]o\s+social|nome\s+fantasia",
                        re.IGNORECASE,
                    )},
                )
                if campo_empresa and campo_empresa.get("value", "").strip():
                    dados["nome_empresa"] = campo_empresa.get("value").strip()

            if not dados["nome_empresa"]:
                rotulo_empresa = soup.find(
                    ["label", "span", "div", "strong"],
                    string=re.compile(
                        r"^\s*(?:nome\s+(?:da\s+)?empresa|raz[aã]o\s+social|nome\s+fantasia)\s*:?\s*$",
                        re.IGNORECASE,
                    ),
                )
                if rotulo_empresa:
                    controle = None
                    if rotulo_empresa.get("for"):
                        controle = soup.find(id=rotulo_empresa.get("for"))
                    if controle is None:
                        pai = rotulo_empresa.parent
                        controle = pai.find(["input", "textarea"]) if pai else None
                    if controle is None:
                        controle = rotulo_empresa.find_next(["input", "textarea"])
                    if controle:
                        valor = controle.get("value") or controle.get_text(" ", strip=True)
                        if valor and valor.strip():
                            dados["nome_empresa"] = valor.strip()
                    if not dados["nome_empresa"]:
                        proximo = rotulo_empresa.find_next_sibling()
                        if proximo:
                            valor = proximo.get_text(" ", strip=True)
                            if valor:
                                dados["nome_empresa"] = valor

            padrao_cnpj = re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b|\b\d{14}\b")
            for elemento in soup.find_all(["div", "span", "td"], string=padrao_cnpj):
                texto = elemento.get_text(strip=True)
                if len(re.sub(r"\D", "", texto)) == 14:
                    dados["cnpj"] = self._normalizar_cnpj(texto)
                    break

            padrao_regime = re.compile(r"Lucro\s+Real|Lucro\s+Presumido|Simples\s+Nacional", re.IGNORECASE)
            regime_elem = soup.find(["div", "span"], class_=re.compile(r"rdt_TableCell|badge", re.I), string=padrao_regime)
            if regime_elem:
                texto_regime = regime_elem.get_text(strip=True)
                dados["regime_tributario"] = texto_regime.lower().replace(" ", "_")

            for elem in soup.find_all(["div", "span"], class_=re.compile(r"rdt_TableCell|badge", re.I)):
                texto = elem.get_text(strip=True).lower()
                if texto in UF_VALIDAS:
                    dados["uf"] = texto
                    break
            
            return dados
        except Exception as e:
            self.log(f"⚠️ Erro ao extrair dados com BeautifulSoup: {e}")
            return {"cnpj": None, "regime_tributario": None, "uf": None, "nome_empresa": None}

    def _substituir_template_por_cliente(
        self, template_base, estado: str, cnpj: str,
        regime_tributario: str, nome_empresa: str = "",
    ):
        """Substitui as variáveis dinâmicas do cliente no template."""
        substituicoes = {
            "{estado}": estado or "",
            "{cnpj}": cnpj or "",
            "{regime_tributario}": regime_tributario or "",
            "{lucro_real}": regime_tributario or "",
            "{nome_empresa}": nome_empresa or "",
        }

        def substituir(valor):
            if isinstance(valor, str):
                for variavel, conteudo in substituicoes.items():
                    valor = valor.replace(variavel, conteudo)
                return valor
            if isinstance(valor, dict):
                return {chave: substituir(item) for chave, item in valor.items()}
            if isinstance(valor, list):
                return [substituir(item) for item in valor]
            return valor

        return substituir(template_base)

    async def setup(self):
        """Inicializa um contexto persistente compartilhado pela GUI e worker."""
        self.log("🚀 Inicializando automação...")
        self.playwright = await async_playwright().start()
        pasta_perfil = Path(self.config.get("user_data_dir", PASTA_PERFIL_PLAYWRIGHT))
        pasta_perfil.mkdir(parents=True, exist_ok=True)

        self.context = await self.playwright.chromium.launch_persistent_context(
            user_data_dir=str(pasta_perfil),
            headless=self._usar_headless(),
            no_viewport=True,
            args=["--start-maximized"],
        )
        self.browser = None
        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        await self._patch_page_timeout(self.page)
        self.log(f"📁 Perfil persistente do navegador: {pasta_perfil}")

    async def teardown(self):
        """Fecha o navegador e finaliza o Playwright."""
        try:
            if self.context:
                await self.context.close()
                self.log("✅ Navegador fechado.")
        finally:
            self.browser = None
            self.context = None
            self.page = None
            if self.playwright:
                await self.playwright.stop()
                self.playwright = None

    async def login(self):
        """Executa o login no portal Mix Fiscal."""
        self.log("🌐 Acessando Portal Mix Fiscal para login...")
        await self.page.goto(self.config.get("url", "https://app.mixfiscal.com.br/login"))
        campo_usuario = self.page.get_by_role("textbox", name="Email ou CPF/CNPJ")
        tela_login_visivel = False
        if "login" in self.page.url:
            try:
                await campo_usuario.wait_for(state="visible", timeout=3_000)
                tela_login_visivel = True
            except Exception:
                if "login" in self.page.url:
                    raise RuntimeError("Página de login não carregou e a sessão persistente não foi reconhecida")

        if tela_login_visivel:
            await campo_usuario.fill(self.config.get("user", ""))
            await self.page.get_by_role("textbox", name="············").fill(self.config.get("pass", ""))
            await self.page.get_by_role("button", name="Entrar").click()
            try:
                await self.page.wait_for_url(lambda u: "login" not in u, timeout=10000)
            except Exception:
                self.log("❌ Falha no login. Verifique suas credenciais.")
                raise RuntimeError("Falha no login")
        else:
            self.log("🔐 Sessão existente carregada do perfil persistente.")
        self.log("✅ Login realizado com sucesso.")
        try:
            await self.fechar_modais_comunicados(self.page, aguardar_renderizacao=True)
        except Exception as erro:
            # Um comunicado inesperado não deve transformar um login válido em
            # falha de autenticação; a navegação fará nova tentativa de limpeza.
            self.log(f"⚠️ Não foi possível tratar comunicado após o login: {erro}")

    async def fechar_modais_comunicados(self, page: Page, aguardar_renderizacao: bool = False) -> int:
        """Fecha, aprende e registra comunicados que bloqueiam a navegação."""
        total_fechados = 0
        if aguardar_renderizacao:
            # Espera real, sem o multiplicador de velocidade da automação.
            await asyncio.sleep(2)

        seletores_modal = (
            ".modal.show:visible",
            ".modal:visible",
            ".modal-content:visible",
            "[role='dialog']:visible",
            ".swal2-popup:visible",
            ".joyride-tooltip:visible",
        )
        seletores_botao = (
            "button:has-text('Marcar como visualizado')",
            "button:has-text('Fechar')",
            "button:has-text('OK')",
            "button.btn-close",
            "button.close",
            ".close",
            "[data-dismiss='modal']",
            "[data-bs-dismiss='modal']",
            "[aria-label='Close']",
            "[aria-label='Fechar']",
        )

        vazias_consecutivas = 0
        for _ in range(16):
            modal = page.locator(", ".join(seletores_modal)).first
            if not await modal.count() or not await modal.is_visible():
                # ESC também fecha players/overlays que não usam marcação de modal.
                await page.keyboard.press("Escape")
                await page.evaluate("""() => {
                    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
                    document.body.classList.remove('modal-open');
                    document.body.style.overflow = 'auto';
                }""")
                vazias_consecutivas += 1
                if not aguardar_renderizacao or vazias_consecutivas >= 3:
                    break
                await asyncio.sleep(0.25)
                continue

            vazias_consecutivas = 0

            # Guarda uma assinatura sem o HTML completo, suficiente para a IA
            # reconhecer reincidências e mudanças futuras do comunicado.
            try:
                detalhes = await modal.evaluate("""el => ({
                    texto: (el.innerText || '').trim().slice(0, 500),
                    classe: el.className || '',
                    iframe: el.querySelector('iframe')?.src || ''
                })""")
                base = json.dumps(detalhes, ensure_ascii=False, sort_keys=True)
                assinatura = hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]
                cache = {}
                if CACHE_MODAIS.exists():
                    try:
                        cache = json.loads(CACHE_MODAIS.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        cache = {}
                registro = cache.get(assinatura, {"ocorrencias": 0})
                registro.update({
                    "ocorrencias": int(registro.get("ocorrencias", 0)) + 1,
                    "ultima_ocorrencia": datetime.now(timezone.utc).isoformat(),
                    "detalhes": detalhes,
                })
                cache[assinatura] = registro
                CACHE_MODAIS.write_text(
                    json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            except Exception as erro_cache:
                self.log(f"⚠️ Não foi possível registrar o modal no cache: {erro_cache}")

            clicou = False
            for seletor in seletores_botao:
                botao = modal.locator(seletor).first
                if await botao.count() and await botao.is_visible():
                    try:
                        await botao.click(timeout=1_500)
                    except Exception:
                        await botao.click(force=True, timeout=1_500)
                    clicou = True
                    total_fechados += 1
                    self.log("ℹ️ Modal/comunicado fechado automaticamente.")
                    await page.wait_for_timeout(150)
                    break

            if not clicou:
                await page.keyboard.press("Escape")
                await asyncio.sleep(0.15)

            # Remove o modal já registrado e qualquer overlay associado. O
            # seletor de .show fica restrito a diálogos para não apagar menus.
            removidos = await page.evaluate("""() => {
                const seletores = [
                    '.modal', '.modal-backdrop', '.modal.show',
                    '[role="dialog"].show', '.swal2-container',
                    '.joyride-tooltip',
                    '[class*="overlay"]:has(iframe[src*="youtube"])'
                ];
                const elementos = document.querySelectorAll(seletores.join(','));
                elementos.forEach(el => el.remove());
                document.body.classList.remove('modal-open');
                document.body.style.overflow = 'auto';
                return elementos.length;
            }""")
            if removidos or clicou:
                total_fechados += 0 if clicou else 1
            await asyncio.sleep(0.2)

        await page.evaluate("""() => {
            document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            document.body.classList.remove('modal-open');
            document.body.style.overflow = 'auto';
        }""")

        return total_fechados

    async def processar_cliente(self, cnpj: str, template_dados: dict, progress_callback=None, pause_callback=None):
        """
        Executa todo o fluxo de automação para um único CNPJ:
        Navega, busca, extrai dados, preenche tabelas e configurações.
        """
        max_retries = 3
        for tentativa in range(1, max_retries + 1):
            etapa_atual = "abertura do cliente"
            try:
                if pause_callback: await pause_callback()

                await self.page.goto("https://app.mixfiscal.com.br/painel-controle", wait_until="domcontentloaded")
                await self.page.locator("button:has-text('FILTRO'), button:has-text('Filtro')").first.wait_for(state="visible", timeout=12000)
                await self.fechar_modais_comunicados(self.page)

                # Limpa o filtro anterior
                btn_limpar_filtro = self.page.get_by_role("button", name="Limpar Filtro")
                if await btn_limpar_filtro.is_visible():
                    await btn_limpar_filtro.click(force=True)
                    await self.page.wait_for_timeout(200)

                btn_filtro = self.page.locator("button:has-text('FILTRO'), button:has-text('Filtro')").first
                await btn_filtro.click(force=True, timeout=3_000)
                await self.page.wait_for_timeout(100)

                cnpj_solicitado = self._normalizar_cnpj(cnpj)
                input_cnpj = self.page.locator("input[placeholder*='CNPJ'], input[name*='cnpj']").first
                await input_cnpj.fill(cnpj_solicitado)
                await self.page.get_by_role("button", name="Filtrar").last.click(force=True)
                await self.page.wait_for_timeout(500)

                self.log("👁️ Acessando detalhes do cliente...")
                await self.fechar_modais_comunicados(self.page)
                # Localiza o botao somente dentro da linha do CNPJ solicitado.
                # O primeiro botao da pagina pode ainda ser do filtro anterior.
                padrao_cnpj_linha = re.compile(
                    rf"{cnpj_solicitado[0:2]}\.?{cnpj_solicitado[2:5]}\.?"
                    rf"{cnpj_solicitado[5:8]}/?{cnpj_solicitado[8:12]}-?"
                    rf"{cnpj_solicitado[12:14]}"
                )
                linha_cliente = self.page.locator(
                    "div.rdt_TableRow:visible, [role='row']:visible"
                ).filter(has_text=padrao_cnpj_linha).first
                await linha_cliente.wait_for(state="visible", timeout=12_000)
                btn_olho = linha_cliente.locator(
                    "div.avatar[title='Detalhes'], [title='Detalhes']"
                ).first
                await btn_olho.wait_for(state="visible", timeout=8000)
                await btn_olho.click(force=True)

                # As classes sc-* são geradas dinamicamente e mudam entre
                # versões. Confirma a tela pelos títulos semânticos estáveis.
                titulo_view = self.page.get_by_text("VIEW", exact=True).last
                titulo_tmp = self.page.get_by_text("TMP", exact=True).last
                try:
                    await titulo_view.wait_for(state="visible", timeout=12000)
                    await titulo_tmp.wait_for(state="visible", timeout=5000)
                except Exception:
                    pasta_erros = PASTA_APLICACAO / "erros_automacao"
                    pasta_erros.mkdir(parents=True, exist_ok=True)
                    screenshot = pasta_erros / f"erro_abertura_detalhes_{int(datetime.now().timestamp())}.png"
                    await self.page.screenshot(path=str(screenshot), full_page=True)
                    raise RuntimeError(
                        "Detalhes do cliente não exibiram os títulos VIEW/TMP; "
                        f"screenshot salvo em {screenshot}"
                    )
                self.log("✅ Tela de tabelas VIEW/TMP carregada.")

                self.log("   🔎 Extraindo dados (CNPJ, UF, Regime e Empresa) da página do cliente...")
                dados_extraidos = await self.extrair_dados_cliente_appmix(self.page)
                # O HTML mantem linhas ocultas de outros clientes. A referencia
                # segura e o CNPJ da fila, confirmado na linha antes do clique.
                cnpj_extraido_html = dados_extraidos.get("cnpj")
                cnpj_uso = cnpj_solicitado
                estado_uso = dados_extraidos.get("uf")
                regime_uso = dados_extraidos.get("regime_tributario")
                nome_empresa_uso = self._normalizar_nome_empresa(
                    dados_extraidos.get("nome_empresa")
                )
                self.log(
                    f"   ↳ CNPJ: {cnpj_uso or 'Não encontrado'} | "
                    f"UF: {estado_uso or 'Não encontrado'} | "
                    f"Regime: {regime_uso or 'Não encontrado'} | "
                    f"Empresa: {nome_empresa_uso or 'Não encontrada'}"
                )
                if cnpj_extraido_html and cnpj_extraido_html != cnpj_solicitado:
                    self.log(
                        f"   ⚠️ CNPJ global ignorado no HTML: {cnpj_extraido_html}; "
                        f"cliente confirmado pela linha: {cnpj_solicitado}."
                    )

                # Preenchimento das tabelas VIEW e TMP
                etapa_atual = "tabelas VIEW/TMP"
                dados_tabelas = template_dados.get("tabelas", {})
                usa_nome_empresa = "{nome_empresa}" in json.dumps(
                    dados_tabelas, ensure_ascii=False
                )
                if usa_nome_empresa and not nome_empresa_uso:
                    raise RuntimeError(
                        "O template usa {nome_empresa}, mas o nome não foi extraído de #cell-3-undefined."
                    )
                template_cliente = self._substituir_template_por_cliente(
                    dados_tabelas, estado_uso, cnpj_uso, regime_uso,
                    nome_empresa_uso,
                )
                excecoes_produtos = template_dados.get("excecoes_produtos", {})
                # Usa o CNPJ solicitado na fila. O HTML pode manter outro CNPJ
                # oculto ou residual e impedir a localizacao das excecoes.
                cnpj_excecao = self._normalizar_cnpj(cnpj)
                cnpj_normalizado = cnpj_excecao
                self.log(
                    f"[DEBUG] CNPJ Processado: '{cnpj_uso}' | "
                    f"Normalizado: '{cnpj_normalizado}'"
                )
                self.log(
                    f"[DEBUG] Dicionario de Excecoes Carregado: "
                    f"{excecoes_produtos}"
                )
                codigos_excecao = _codigos_excecao_do_cnpj(
                    excecoes_produtos, cnpj_excecao
                )
                self.log(
                    f"[DEBUG] Codigos encontrados para o CNPJ: "
                    f"{codigos_excecao}"
                )
                tem_config_excecao = _cnpj_tem_configuracao_excecao(
                    excecoes_produtos, cnpj_excecao
                )
                codigos_para_sql = codigos_excecao if tem_config_excecao else None
                for chave_view in CHAVES_VIEWS_COM_EXCECOES:
                    dados_view = template_cliente.get(chave_view, {})
                    if isinstance(dados_view, dict):
                        sql_antes = dados_view.get("view_sql", "")
                        dados_view["view_sql"] = _adicionar_excecoes_view(
                            sql_antes, codigos_para_sql
                        )
                if codigos_excecao:
                    self.log(
                        f"   Excecoes do CNPJ aplicadas nas VIEWs: "
                        f"{len(codigos_excecao)} codigo(s)."
                    )
                elif not tem_config_excecao:
                    self.log(
                        "   CNPJ sem cadastro no JSON; filtros NOT IN legados "
                        "das VIEWs foram normalizados e preservados."
                    )
                else:
                    self.log("   CNPJ sem excecoes de produtos ativas; VIEWs mantidas limpas.")
                template_serializado = json.dumps(template_cliente, ensure_ascii=False)
                if "{nome_empresa}" in template_serializado:
                    raise RuntimeError(
                        "A variável {nome_empresa} permaneceu sem substituição; preenchimento cancelado."
                    )
                sucesso_tabelas = await preencher_tabelas_mix(
                    self.page, template_cliente, self.log, progress_callback,
                    pause_callback, cnpj_uso,
                )

                if not sucesso_tabelas:
                    raise RuntimeError("Falha no preenchimento das tabelas para o cliente")

                self.log(f"🎯 Etapa de tabelas concluída para o CNPJ {cnpj_uso}.")

                # Preenchimento da configuração de divergências
                etapa_atual = "configuração de divergências"
                self.log("   ⚙️ Acessando a área de 'Configuração' do cliente...")

                # O portal pode fechar o modal de detalhes automaticamente ao
                # salvar a última TMP. Se isso ocorrer, reabre somente o detalhe
                # do cliente já filtrado, sem repetir o preenchimento das tabelas.
                xpath_configuracao = "/html/body/div[4]/div/div[1]/div/div/div[1]/h5/ul/li[4]/a"
                link_configuracao = self.page.locator(f"xpath={xpath_configuracao}")
                link_semantico = self.page.locator(
                    "a.nav-link:has-text('Configuração'), "
                    "a:has-text('Configuração'), "
                    "a.nav-link:has-text('Configuracao')"
                ).first

                link_disponivel = (
                    await link_configuracao.count() > 0
                    and await link_configuracao.first.is_visible()
                ) or (
                    await link_semantico.count() > 0
                    and await link_semantico.is_visible()
                )

                if not link_disponivel:
                    self.log(
                        "   ℹ️ O portal fechou os detalhes após a última tabela; reabrindo pelo olho..."
                    )
                    btn_olho_config = self.page.locator("div.avatar[title='Detalhes']").first
                    await btn_olho_config.wait_for(state="visible", timeout=10_000)
                    await btn_olho_config.click(force=True)
                    await link_semantico.wait_for(state="visible", timeout=12_000)
                    link_configuracao = link_semantico
                elif not (
                    await link_configuracao.count() > 0
                    and await link_configuracao.first.is_visible()
                ):
                    link_configuracao = link_semantico
                else:
                    link_configuracao = link_configuracao.first

                await link_configuracao.click(force=True)

                botao_editar = self.page.get_by_role(
                    "button", name=re.compile(r"^Editar$", re.IGNORECASE)
                ).first
                await botao_editar.wait_for(state="visible", timeout=10_000)
                await botao_editar.click(force=True)

                await self.page.locator("input[type='checkbox']").first.wait_for(
                    state="attached", timeout=10_000
                )
                self.log("   ✅ Formulário de Configuração aberto para edição.")
                
                dados_divergencia = template_dados.get("comparar_divergencia", {})
                sucesso_divergencia = await configurar_divergencias(self.page, dados_divergencia, self.log, pause_callback)

                if not sucesso_divergencia:
                    raise RuntimeError("Falha na configuração de divergências")

                self.log(f"🎉 Cliente {cnpj_uso} processado completamente.")
                return True # Sucesso, sai do loop de tentativas

            except Exception as e:
                self.log(
                    f"❌ Erro na etapa '{etapa_atual}' do cliente {cnpj}: {str(e)}"
                )

                if etapa_atual == "tabelas VIEW/TMP":
                    self.log(
                        "🚫 Uma tabela não pôde ser concluída; as tabelas já salvas não serão repetidas."
                    )
                    return False

                # As tabelas já foram gravadas. Uma falha posterior na tela de
                # Configuração não deve repetir todo o preenchimento desde o início.
                if etapa_atual == "configuração de divergências":
                    try:
                        pasta_erros = PASTA_APLICACAO / "erros_automacao"
                        pasta_erros.mkdir(parents=True, exist_ok=True)
                        screenshot = pasta_erros / f"erro_configuracao_{self._normalizar_cnpj(cnpj)}_{int(datetime.now().timestamp())}.png"
                        await self.page.screenshot(path=str(screenshot), full_page=True)
                        self.log(f"📷 Tela do erro salva em: {screenshot}")
                    except Exception as erro_screenshot:
                        self.log(f"⚠️ Não foi possível salvar a tela do erro: {erro_screenshot}")
                    self.log(
                        "🚫 A etapa de Configuração falhou; o cliente não será reiniciado para evitar repetir as tabelas."
                    )
                    return False

                self.log(
                    f"   Tentativa {tentativa}/{max_retries} da etapa anterior à Configuração."
                )
                if tentativa < max_retries:
                    self.log(f"🔁 Tentando novamente o cliente {cnpj}...")
                    await asyncio.sleep(2)
                    continue
                else:
                    self.log(f"🚫 Falha definitiva para o cliente {cnpj}. Pulando para o próximo.")
                    return False

def chromium_playwright_instalado() -> bool:
    """Confirma a revisao exata exigida pelo Playwright deste aplicativo."""
    try:
        _, playwright_cli = compute_driver_executable()
        browsers_file = Path(playwright_cli).with_name("browsers.json")
        dados = json.loads(browsers_file.read_text(encoding="utf-8"))
        revisoes = {
            item["name"]: str(item["revision"])
            for item in dados.get("browsers", [])
            if item.get("name") in {"chromium", "chromium-headless-shell"}
        }
        if "chromium" not in revisoes:
            return False
        pastas = [PASTA_PLAYWRIGHT / f"chromium-{revisoes['chromium']}"]
        if "chromium-headless-shell" in revisoes:
            pastas.append(
                PASTA_PLAYWRIGHT / f"chromium_headless_shell-{revisoes['chromium-headless-shell']}"
            )
        return all((pasta / "INSTALLATION_COMPLETE").is_file() for pasta in pastas)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def garantir_chromium_instalado(log_callback=print, progress_callback=None):
    """Verifica e baixa o Chromium se necessário, de forma síncrona."""
    if chromium_playwright_instalado():
        log_callback(f"Chromium do Playwright pronto em: {PASTA_PLAYWRIGHT}")
        return True
    try:
        log_callback("🌐 Primeiro uso: baixando o Chromium do Playwright. Isso acontece apenas uma vez...")
        if progress_callback: progress_callback(0)
        
        # No executavel criado pelo PyInstaller, sys.executable aponta para o
        # APP-MIX.exe e nao para python.exe. Usar o driver interno funciona
        # tanto no codigo-fonte quanto no executavel empacotado.
        node_executable, playwright_cli = compute_driver_executable()
        comando = [node_executable, playwright_cli, "install", "chromium"]
        env_driver = get_driver_env()
        env_driver["PLAYWRIGHT_BROWSERS_PATH"] = str(PASTA_PLAYWRIGHT)
        PASTA_PLAYWRIGHT.mkdir(parents=True, exist_ok=True)
        with subprocess.Popen(
            comando,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env_driver,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        ) as proc:
            for linha in iter(proc.stdout.readline, ''):
                log_callback(linha.strip())
                match = re.search(r"(\d+)%", linha)
                if match and progress_callback:
                    progress_callback(int(match.group(1)))
        
        if proc.returncode != 0:
            log_callback("❌ Não foi possível baixar o Chromium.")
            return False

        if not chromium_playwright_instalado():
            log_callback("O download terminou, mas a versao exigida do Chromium nao foi encontrada.")
            return False
        if progress_callback:
            progress_callback(100)

        log_callback(f"✅ Chromium instalado em: {PASTA_PLAYWRIGHT}")
        return True
    except Exception as e:
        log_callback(f"❌ Erro ao preparar o Chromium do Playwright: {e}")
        return False
