import asyncio
import json
import os
import re
import time
from pathlib import Path


SCREENSHOT_DIR = "erros_automacao"
MAPEAMENTO_FILE = Path(__file__).resolve().with_name("mapeamento_portal_mix.json")
PRESERVACAO_FILE = Path.cwd() / "excecoes_preservadas.json"
PRESERVACAO_INICIAL_FILE = Path(__file__).resolve().with_name("excecoes_preservadas.json")


def _extrair_codigos_not_in(sql):
    """Extrai codigos do filtro legado atualmente salvo na VIEW da web."""
    if not isinstance(sql, str):
        return []
    filtros = re.findall(
        r"(?:[a-zA-Z_]\w*\s*\.\s*)?[\"`\[]?codigo_produto[\"`\]]?\s+NOT\s+IN\s*\(([^)]*)\)",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return sorted({
        int(valor)
        for conteudo in filtros
        for valor in re.findall(r"\d+", conteudo)
    })


async def _ler_sql_atual_estavel(area, page):
    """Aguarda o React terminar de hidratar o SQL existente no textarea."""
    leituras = []
    for _ in range(5):
        valor = await area.input_value()
        if valor:
            leituras.append(valor)
        await page.wait_for_timeout(150)
    # Durante a abertura o portal pode expor primeiro um valor parcial/vazio.
    # A versao mais longa e a melhor fotografia antes da sobrescrita.
    return max(leituras, key=len) if leituras else ""


def _extrair_filtros_descritivo_not_like(sql):
    """Preserva filtros de descricao existentes na VIEW atual do cliente."""
    if not isinstance(sql, str):
        return []
    filtros = re.findall(
        r"\b(?:[a-zA-Z_][\w]*\.)?descritivo_produto\s+NOT\s+LIKE\s+(?:'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\")",
        sql,
        flags=re.IGNORECASE,
    )
    resultado = []
    vistos = set()
    for filtro in filtros:
        filtro = re.sub(r"\s+", " ", filtro).strip()
        chave = filtro.casefold()
        if chave not in vistos:
            vistos.add(chave)
            resultado.append(filtro)
    return resultado


def _aplicar_filtros_descritivo(sql_template, filtros):
    """Acrescenta filtros raspados sem duplicar e sem alterar SQL vazio."""
    sql = str(sql_template or "")
    if not sql or not filtros:
        return sql
    existentes = {
        re.sub(r"\s+", " ", filtro).strip().casefold()
        for filtro in _extrair_filtros_descritivo_not_like(sql)
    }
    novos = [
        filtro for filtro in filtros
        if re.sub(r"\s+", " ", filtro).strip().casefold() not in existentes
    ]
    if not novos:
        return sql
    sql = re.sub(r";\s*$", "", sql).rstrip()
    for filtro in novos:
        operador = "AND" if re.search(r"\bWHERE\b", sql, re.IGNORECASE) else "WHERE"
        sql = f"{sql}\n{operador} {filtro}"
    return sql


def _carregar_preservacao_cnpj(cnpj):
    try:
        origem = PRESERVACAO_FILE if PRESERVACAO_FILE.exists() else PRESERVACAO_INICIAL_FILE
        dados = json.loads(origem.read_text(encoding="utf-8"))
        registro = dados.get(re.sub(r"\D", "", str(cnpj)), {})
        return (
            registro.get("codigos_produto", []),
            registro.get("filtros_descritivo", []),
        )
    except (OSError, ValueError, TypeError, AttributeError):
        return [], []


def _salvar_preservacao_cnpj(cnpj, codigos, filtros):
    chave = re.sub(r"\D", "", str(cnpj))
    if not chave:
        return
    try:
        origem = PRESERVACAO_FILE if PRESERVACAO_FILE.exists() else PRESERVACAO_INICIAL_FILE
        dados = json.loads(origem.read_text(encoding="utf-8")) if origem.exists() else {}
        if not isinstance(dados, dict):
            dados = {}
    except (OSError, ValueError, TypeError):
        dados = {}
    antigos = dados.get(chave, {}) if isinstance(dados.get(chave, {}), dict) else {}
    codigos_unidos = sorted(
        set(antigos.get("codigos_produto", [])) | set(codigos or [])
    )
    filtros_unidos = []
    vistos = set()
    for filtro in list(antigos.get("filtros_descritivo", [])) + list(filtros or []):
        normalizado = re.sub(r"\s+", " ", str(filtro)).strip()
        if normalizado and normalizado.casefold() not in vistos:
            vistos.add(normalizado.casefold())
            filtros_unidos.append(normalizado)
    dados[chave] = {
        "codigos_produto": codigos_unidos,
        "filtros_descritivo": filtros_unidos,
    }
    PRESERVACAO_FILE.write_text(
        json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _montar_sql_view_preservando_excecoes(
    sql_template, sql_atual_web, codigos_herdados=None,
    filtros_descritivo_herdados=None, sql_original_referencia="",
):
    """Une template, portal e PIS/COFINS sem apagar excecoes existentes."""
    if not str(sql_template or "").strip():
        return "", [], []
    codigos = sorted(
        set(_extrair_codigos_not_in(sql_template))
        | set(_extrair_codigos_not_in(sql_atual_web))
        | set(_extrair_codigos_not_in(sql_original_referencia))
        | set(codigos_herdados or [])
    )
    filtros = []
    vistos = set()
    for origem in (
        _extrair_filtros_descritivo_not_like(sql_template),
        _extrair_filtros_descritivo_not_like(sql_atual_web),
        _extrair_filtros_descritivo_not_like(sql_original_referencia),
        filtros_descritivo_herdados or [],
    ):
        for filtro in origem:
            chave = re.sub(r"\s+", " ", filtro).strip().casefold()
            if chave not in vistos:
                vistos.add(chave)
                filtros.append(filtro)
    sql_final = _aplicar_codigos_da_view_web(sql_template, codigos)
    sql_final = _aplicar_filtros_descritivo(sql_final, filtros)
    return sql_final, codigos, filtros


def _aplicar_codigos_da_view_web(sql_template, codigos_web):
    """Anexa ao template limpo os codigos preservados da VIEW existente."""
    sql = str(sql_template or "")
    if not sql:
        return sql
    codigos_template = _extrair_codigos_not_in(sql)
    codigos_finais = sorted(set(codigos_template) | set(codigos_web or []))
    if not codigos_finais:
        return sql
    sql = re.sub(
        r"\s+\b(?:AND|OR)\s+codigo_produto\s+NOT\s+IN\s*\([^)]*\)",
        "", sql, flags=re.IGNORECASE,
    )
    sql = re.sub(
        r"\s+\bWHERE\s+codigo_produto\s+NOT\s+IN\s*\([^)]*\)",
        "", sql, flags=re.IGNORECASE,
    )
    sql = re.sub(r";\s*$", "", sql).rstrip()
    operador = (
        "AND" if re.search(r"\bWHERE\b", sql, flags=re.IGNORECASE)
        else "WHERE"
    )
    lista = ", ".join(str(codigo) for codigo in codigos_finais)
    return f"{sql}\n{operador} codigo_produto NOT IN ({lista})"


def _carregar_tributos_mapeados():
    """Carrega do JSON a correspondência entre template e texto do portal."""
    fallback = (
        ("pis_cofins", "PIS E COFINS"),
        ("icms_saida", "ICMS SAIDA"),
        ("icms_entrada", "ICMS ENTRADA"),
        ("ibs_cbs", "IBS E CBS"),
    )
    try:
        dados = json.loads(MAPEAMENTO_FILE.read_text(encoding="utf-8"))
        itens = dados["tabelas"]["tributos"]
        resultado = tuple(
            (str(item["template_key"]).strip(), str(item["texto_portal"]).strip())
            for item in itens
        )
        if len(resultado) != 4 or any(not chave or not texto for chave, texto in resultado):
            raise ValueError("o mapa deve conter os quatro tributos")
        return resultado
    except Exception:
        return fallback


TABELAS_MAPEADAS = _carregar_tributos_mapeados()


async def _screenshot(page, label):
    try:
        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        path = os.path.join(SCREENSHOT_DIR, f"{label}_{int(time.time())}.png")
        await page.screenshot(path=path, full_page=True)
    except Exception:
        pass


async def preencher_campo_texto(locator, valor):
    """Preenche e verifica campos controlados pelo React, inclusive valor vazio."""
    valor_esperado = "" if valor is None else str(valor)
    await locator.wait_for(state="visible", timeout=10_000)
    await locator.scroll_into_view_if_needed()

    for tentativa in range(3):
        # O setter nativo atualiza inputs/textarea grandes mais rapidamente e o
        # evento input comunica a alteração ao estado interno do React.
        await locator.fill(valor_esperado)
        await locator.press("Tab")
        # Nao usa page.wait_for_timeout: o modo Ultra reduz essa espera e o
        # React pode ainda nao ter consolidado o valor no estado do formulario.
        await asyncio.sleep(0.15)
        valor_atual = await locator.input_value()
        if valor_atual == valor_esperado:
            return

        await locator.evaluate(
            """(el, value) => {
                const proto = el.tagName === 'TEXTAREA'
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(el, value);
                el.dispatchEvent(new InputEvent('input', {
                    bubbles: true, inputType: 'insertText', data: value
                }));
                el.dispatchEvent(new Event('change', {bubbles: true}));
            }""",
            valor_esperado,
        )
        await locator.evaluate("el => el.blur()")
        await asyncio.sleep(0.2)

        valor_atual = await locator.input_value()
        if valor_atual == valor_esperado:
            return

        # Fallback para versões do componente que bloqueiam o setter nativo.
        await locator.fill(valor_esperado)
        await locator.press("Tab")
        await asyncio.sleep(0.2)
        if await locator.input_value() == valor_esperado:
            return

    valor_atual = await locator.input_value()
    raise RuntimeError(
        f"Campo não confirmou o valor do template após 3 tentativas "
        f"(esperado: {valor_esperado!r}, atual: {valor_atual!r})"
    )


async def ajustar_checkbox(locator, estado_desejado):
    await locator.scroll_into_view_if_needed()
    if await locator.is_checked() != bool(estado_desejado):
        await locator.click(force=True)


async def _abrir_editor(page, nome_tributo, tipo):
    """Abre a linha pelo texto, sem depender das classes dinâmicas do portal."""
    # O mesmo tributo aparece nas duas colunas. Partir do cabeçalho VIEW/TMP
    # impede que uma mudança de ordem ou um formulário aberto desloque o índice.
    cabecalho = page.get_by_text(tipo, exact=True).last
    await cabecalho.wait_for(state="visible", timeout=10_000)
    rotulo = cabecalho.locator(
        f"xpath=following::label[normalize-space()='{nome_tributo}'][1]"
    )
    await rotulo.wait_for(state="visible", timeout=10_000)

    texto_editor = "Nome da tabela TMP" if tipo == "TMP" else "Nome da tabela"
    editor_aberto = page.locator(
        f"label:visible:text-is('{texto_editor}')"
    )

    # No DOM atual o lápis é um <span> imediatamente anterior ao rótulo.
    # Tentativas adicionais preservam compatibilidade com versões que o
    # renderizam como avatar, botão ou SVG.
    candidatos = (
        rotulo.locator("xpath=preceding::span[1]"),
        rotulo.locator("xpath=preceding::div[contains(@class,'avatar')][1]"),
        rotulo.locator("xpath=preceding::button[1]"),
        rotulo.locator("xpath=preceding::*[name()='svg'][1]"),
        rotulo,
    )
    for candidato in candidatos:
        try:
            if await candidato.count() and await candidato.first.is_visible():
                await candidato.first.scroll_into_view_if_needed()
                await candidato.first.click(force=True, timeout=2_000)
                try:
                    await editor_aberto.first.wait_for(state="visible", timeout=1_500)
                    return
                except Exception:
                    pass
        except Exception:
            continue
    raise RuntimeError(f"Não foi possível expandir o card {tipo} - {nome_tributo}")


async def _editor_visivel(page, tipo):
    texto = "Nome da tabela TMP" if tipo == "tmp" else "Nome da tabela"
    # Correspondência exata é obrigatória: "Nome da tabela" também é parte de
    # "Nome da tabela TMP" e, com os dois cards abertos, o locator genérico
    # podia trocar da VIEW para a TMP após o React renderizar novamente.
    label = page.locator(f"label:visible:text-is('{texto}')").first
    await label.wait_for(state="visible", timeout=10_000)
    # Menor ancestral que contém o botão Salvar: isola o formulário aberto.
    editor = label.locator(
        "xpath=ancestor::*[.//button[normalize-space()='Salvar']][1]"
    )
    if await editor.count() == 0:
        raise RuntimeError(f"Editor {tipo.upper()} abriu, mas o formulário não foi localizado")
    return editor


async def _campo_apos_label(editor, texto_label, seletor, obrigatorio=True):
    label = editor.locator("label", has_text=texto_label).first
    if await label.count() == 0:
        if obrigatorio:
            raise RuntimeError(f"Campo '{texto_label}' não encontrado no portal")
        return None
    campo = label.locator(f"xpath=following::{seletor}[1]")
    if await campo.count() == 0 and obrigatorio:
        raise RuntimeError(f"Controle de '{texto_label}' não encontrado no portal")
    return campo if await campo.count() else None


async def _salvar_editor(
    page, editor, recolher_editor=True, evento_salvamento_iniciado=None
):
    botao = editor.locator("button", has_text="Salvar").first
    await botao.scroll_into_view_if_needed()
    await botao.click()
    if evento_salvamento_iniciado is not None:
        evento_salvamento_iniciado.set()

    # Durante o salvamento o texto do botão vira um spinner. Aguarda o portal
    # terminar a requisição antes de passar ao card seguinte.
    # Consulta o término com frequência, mas mantém uma margem ampla para dias
    # em que o servidor estiver lento. Assim normalmente avança quase imediato.
    for _ in range(80):
        await page.wait_for_timeout(250)
        if not await editor.is_visible():
            return
        salvar_pronto = editor.locator("button", has_text="Salvar").first
        if await salvar_pronto.count() and await salvar_pronto.is_visible() and await salvar_pronto.is_enabled():
            break

    alertas = editor.locator(".alert-danger:visible, .text-danger:visible, [role='alert']:visible")
    mensagens = []
    for i in range(min(await alertas.count(), 3)):
        texto = (await alertas.nth(i).inner_text()).strip()
        if texto:
            mensagens.append(texto)
    if mensagens:
        raise RuntimeError("Portal recusou o salvamento: " + " | ".join(mensagens))

    # Nos sete primeiros formulários, recolher evita que o próximo
    # preenchimento reutilize controles anteriores. O último fica aberto para
    # preservar a tela de detalhes que contém o link "Configuração".
    if not recolher_editor:
        return

    cancelar = editor.locator("button", has_text="Cancelar").first
    if await cancelar.count() and await cancelar.is_visible():
        await cancelar.click()
        try:
            await editor.wait_for(state="hidden", timeout=5_000)
        except Exception:
            # O clique em Salvar já foi confirmado acima. Uma re-renderização
            # lenta ao recolher o card não transforma o salvamento em falha.
            pass


async def _preencher_view(
    page, dados, chave, nome, log_callback, recolher_editor=True,
    evento_salvamento_iniciado=None, codigos_herdados=None,
    filtros_descritivo_herdados=None,
    sql_original_referencia="",
):
    info = dados.get(chave, {})
    if not isinstance(info, dict):
        raise RuntimeError(f"Dados inválidos no template para {nome}")

    log_callback(f"⚙️ Preenchendo VIEW - {nome}...")
    await _abrir_editor(page, nome, "VIEW")
    editor = await _editor_visivel(page, "view")
    campos = editor.locator("input[type='text']:visible")
    areas = editor.locator("textarea:visible")
    if await campos.count() < 1 or await areas.count() < 1:
        raise RuntimeError("Campos de Nome/SQL da VIEW não foram encontrados")
    # Le o SQL salvo na Mix Fiscal antes de sobrescrever o textarea. Os codigos
    # exclusivos do cliente podem existir somente nessa configuracao antiga.
    sql_atual_web = await _ler_sql_atual_estavel(areas.first, page)
    log_callback(
        f"[DEBUG] SQL original lido do portal ({nome}):\n{sql_atual_web}"
    )
    sql_final, codigos_web, filtros_descritivo = (
        _montar_sql_view_preservando_excecoes(
            info.get("view_sql", ""),
            sql_atual_web,
            codigos_herdados,
            filtros_descritivo_herdados,
            sql_original_referencia,
        )
    )
    log_callback(
        f"[DEBUG] Codigos extraidos da VIEW atual na web ({nome}): "
        f"{codigos_web}"
    )
    log_callback(
        f"[DEBUG] Filtros de descricao preservados ({nome}): "
        f"{filtros_descritivo}"
    )
    await preencher_campo_texto(campos.first, info.get("view_nome", ""))
    log_callback(f"[DEBUG] SQL enviado ao Playwright:\n{sql_final}")
    await preencher_campo_texto(areas.first, sql_final)
    # Alguns renders do editor restauram o nome ao atualizar o SQL. Confirma o
    # nome novamente imediatamente antes do salvamento (inclusive para apagá-lo).
    await preencher_campo_texto(campos.first, info.get("view_nome", ""))
    await _salvar_editor(
        page, editor, recolher_editor, evento_salvamento_iniciado
    )
    log_callback(f"✅ VIEW - {nome} salva.")
    return (
        _extrair_codigos_not_in(sql_final),
        _extrair_filtros_descritivo_not_like(sql_final),
    )


async def _raspar_sql_pis_cofins_antes_do_preenchimento(page, log_callback, cnpj=""):
    """Captura o PIS/COFINS original e fecha o card sem salvar alteracoes."""
    log_callback("🔎 Raspando SQL original da VIEW PIS/COFINS antes de preencher...")
    # O portal frequentemente entrega o primeiro card VIEW ja expandido. Como
    # esta rotina roda antes de qualquer outro card, esse editor visivel e o
    # PIS/COFINS; clicar novamente o fecharia.
    label_view_aberta = page.locator("label:visible:text-is('Nome da tabela')")
    if await label_view_aberta.count():
        editor = await _editor_visivel(page, "view")
    else:
        await _abrir_editor(page, "PIS E COFINS", "VIEW")
        editor = await _editor_visivel(page, "view")
    areas = editor.locator("textarea:visible")
    if await areas.count() < 1:
        raise RuntimeError("Textarea SQL do PIS/COFINS não foi encontrado na raspagem inicial")
    sql_original = await _ler_sql_atual_estavel(areas.first, page)
    codigos_memoria, filtros_memoria = _carregar_preservacao_cnpj(cnpj)
    codigos_raspados = _extrair_codigos_not_in(sql_original)
    filtros_raspados = _extrair_filtros_descritivo_not_like(sql_original)
    codigos_preservados = sorted(set(codigos_memoria) | set(codigos_raspados))
    filtros_preservados = list(filtros_memoria)
    vistos = {str(item).casefold() for item in filtros_preservados}
    for filtro in filtros_raspados:
        if filtro.casefold() not in vistos:
            vistos.add(filtro.casefold())
            filtros_preservados.append(filtro)
    _salvar_preservacao_cnpj(cnpj, codigos_preservados, filtros_preservados)
    sql_memoria = ""
    if codigos_preservados:
        sql_memoria += " codigo_produto NOT IN (" + ", ".join(
            str(codigo) for codigo in codigos_preservados
        ) + ")"
    if filtros_preservados:
        sql_memoria += " " + " ".join(filtros_preservados)
    log_callback(f"[DEBUG] SQL PIS/COFINS raspado antes do preenchimento:\n{sql_original}")
    log_callback(
        "[DEBUG] Códigos preservados na raspagem inicial: "
        f"{_extrair_codigos_not_in(sql_original)}"
    )
    log_callback(
        "[DEBUG] Condições de descrição preservadas na raspagem inicial: "
        f"{_extrair_filtros_descritivo_not_like(sql_original)}"
    )
    cancelar = editor.locator("button", has_text="Cancelar").first
    if await cancelar.count() and await cancelar.is_visible():
        await cancelar.click()
        try:
            await editor.wait_for(state="hidden", timeout=5_000)
        except Exception:
            pass
    return sql_original + "\n" + sql_memoria


async def _preencher_tmp(page, dados, chave, nome, log_callback, recolher_editor=True):
    info = dados.get(chave, {})
    if not isinstance(info, dict):
        raise RuntimeError(f"Dados inválidos no template para {nome}")

    log_callback(f"⚙️ Preenchendo TMP - {nome}...")
    await _abrir_editor(page, nome, "TMP")
    editor = await _editor_visivel(page, "tmp")

    nome_campo = await _campo_apos_label(editor, "Nome da tabela TMP", "input")
    await preencher_campo_texto(nome_campo, info.get("tmp_nome", ""))

    # O portal novo removeu o campo Delete e exibe apenas um checkbox. Estes
    # blocos continuam compatíveis com a versão antiga quando os controles existem.
    delete_campo = await _campo_apos_label(editor, "SELECT Delete", "input", False)
    if delete_campo is not None:
        await preencher_campo_texto(delete_campo, info.get("tmp_delete", ""))

    checkboxes = editor.locator("input[type='checkbox']:visible")
    quantidade = await checkboxes.count()
    if quantidade == 1:
        await ajustar_checkbox(checkboxes.first, info.get("flag2", False))
    elif quantidade:
        flags = (info.get("flag1", True), info.get("flag2", False), info.get("flag3", False))
        for indice, estado in enumerate(flags[:quantidade]):
            await ajustar_checkbox(checkboxes.nth(indice), estado)

    areas = editor.locator("textarea:visible")
    # O Delete é um input separado; os textareas são sempre Insert, Values e Where.
    inicio = 0
    if await areas.count() < 3:
        raise RuntimeError("Os três campos SQL da TMP não foram encontrados")
    valores = (
        info.get("tmp_insert", ""),
        info.get("tmp_values", ""),
        info.get("tmp_selectwhere", ""),
    )
    for indice, valor in enumerate(valores, inicio):
        await preencher_campo_texto(areas.nth(indice), valor)

    await preencher_campo_texto(nome_campo, info.get("tmp_nome", ""))

    await _salvar_editor(page, editor, recolher_editor)
    log_callback(f"✅ TMP - {nome} salva.")


async def preencher_tabelas_mix(page, template_dados, log_callback,
                                progress_callback=None, pause_callback=None, cnpj=""):
    """Preenche as quatro VIEWs e quatro TMPs conforme o template selecionado."""
    tabelas = TABELAS_MAPEADAS
    resultados = {}
    passo = 0
    chaves_ausentes = [chave for chave, _ in tabelas if chave not in template_dados]
    if chaves_ausentes:
        log_callback(
            "❌ Template recebido sem as seções mapeadas: " + ", ".join(chaves_ausentes)
        )
        return False

    log_callback(f"🗺️ Mapeamento carregado de: {MAPEAMENTO_FILE.name}")
    log_callback("🗂️ Seções recebidas: " + ", ".join(sorted(template_dados)))
    log_callback("🚀 Iniciando preenchimento das 8 tabelas conforme o template...")
    # Esta leitura ocorre antes de qualquer fill() ou salvamento. Ela e mantida
    # separadamente porque o React pode reidratar o editor na segunda abertura.
    sql_original_pis_cofins = await _raspar_sql_pis_cofins_antes_do_preenchimento(
        page, log_callback, cnpj
    )
    # O NOT IN de PIS/COFINS e a referencia do cliente. Seus codigos tambem
    # seguem para as demais VIEWs que possuam SQL no template.
    codigos_pis_cofins = []
    filtros_descritivo_pis_cofins = []

    for chave, nome in tabelas:
        if pause_callback:
            await pause_callback()

        inicio_salvamento_view = asyncio.Event()
        ultima_tmp = chave == tabelas[-1][0]

        async def executar_view():
            try:
                codigos_resultantes, filtros_resultantes = await _preencher_view(
                    page,
                    template_dados,
                    chave,
                    nome,
                    log_callback,
                    recolher_editor=True,
                    evento_salvamento_iniciado=inicio_salvamento_view,
                    codigos_herdados=(
                        codigos_pis_cofins if chave != "pis_cofins" else None
                    ),
                    filtros_descritivo_herdados=(
                        filtros_descritivo_pis_cofins
                        if chave != "pis_cofins" else None
                    ),
                    sql_original_referencia=(
                        sql_original_pis_cofins if chave == "pis_cofins" else ""
                    ),
                )
                if chave == "pis_cofins":
                    codigos_pis_cofins[:] = codigos_resultantes
                    filtros_descritivo_pis_cofins[:] = filtros_resultantes
                return True
            except Exception as erro:
                log_callback(f"❌ Erro em VIEW {nome}: {erro}")
                await _screenshot(page, f"erro_view_{chave}")
                return False
            finally:
                # Se a VIEW falhar antes do clique em Salvar, não deixa a TMP
                # aguardando indefinidamente; ela ainda pode ser processada.
                inicio_salvamento_view.set()

        async def executar_tmp():
            await inicio_salvamento_view.wait()
            if pause_callback:
                await pause_callback()
            try:
                log_callback(
                    f"⚡ Salvamento da VIEW {nome} em andamento; iniciando TMP em paralelo."
                )
                await _preencher_tmp(
                    page,
                    template_dados,
                    chave,
                    nome,
                    log_callback,
                    recolher_editor=not ultima_tmp,
                )
                return True
            except Exception as erro:
                log_callback(f"❌ Erro em TMP {nome}: {erro}")
                await _screenshot(page, f"erro_tmp_{chave}")
                return False

        # Os dois editores compartilham o estado React do modal. Aguarda a VIEW
        # terminar completamente antes de abrir/preencher a TMP.
        sucesso_view = await executar_view()
        sucesso_tmp = await executar_tmp()

        # Recuperação segura do pipeline: uma atualização do React durante os
        # dois salvamentos pode impedir um dos cards de expandir. Nesse caso,
        # repete somente o card que falhou, agora de forma sequencial.
        if not sucesso_view:
            log_callback(
                f"🔄 Repetindo somente VIEW {nome} em modo seguro..."
            )
            try:
                await page.wait_for_timeout(500)
                codigos_resultantes, filtros_resultantes = await _preencher_view(
                    page,
                    template_dados,
                    chave,
                    nome,
                    log_callback,
                    recolher_editor=True,
                    codigos_herdados=(
                        codigos_pis_cofins if chave != "pis_cofins" else None
                    ),
                    filtros_descritivo_herdados=(
                        filtros_descritivo_pis_cofins
                        if chave != "pis_cofins" else None
                    ),
                    sql_original_referencia=(
                        sql_original_pis_cofins if chave == "pis_cofins" else ""
                    ),
                )
                if chave == "pis_cofins":
                    codigos_pis_cofins[:] = codigos_resultantes
                    filtros_descritivo_pis_cofins[:] = filtros_resultantes
                sucesso_view = True
            except Exception as erro:
                log_callback(f"❌ Falha definitiva em VIEW {nome}: {erro}")
                await _screenshot(page, f"erro_final_view_{chave}")

        if not sucesso_tmp:
            log_callback(
                f"🔄 Repetindo somente TMP {nome} em modo seguro..."
            )
            try:
                await page.wait_for_timeout(500)
                await _preencher_tmp(
                    page,
                    template_dados,
                    chave,
                    nome,
                    log_callback,
                    recolher_editor=not ultima_tmp,
                )
                sucesso_tmp = True
            except Exception as erro:
                log_callback(f"❌ Falha definitiva em TMP {nome}: {erro}")
                await _screenshot(page, f"erro_final_tmp_{chave}")

        resultados[f"VIEW {nome}"] = sucesso_view
        resultados[f"TMP {nome}"] = sucesso_tmp

        if ultima_tmp and sucesso_tmp:
            log_callback(
                "📌 Última TMP salva; tela mantida para acessar Configuração."
            )

        passo += 2
        if progress_callback:
            progress_callback(passo)

    total_ok = sum(resultados.values())
    log_callback(f"📊 Resumo: {total_ok}/8 tabelas preenchidas com sucesso.")
    return total_ok == 8
