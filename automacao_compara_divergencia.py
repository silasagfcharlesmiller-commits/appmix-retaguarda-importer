import json
import re
import unicodedata
from pathlib import Path

from playwright.async_api import Page


MAPA_CONFIGURACOES = Path(__file__).with_name("mapeamento_configuracoes.json")


def _normalizar(texto: str) -> str:
    texto = unicodedata.normalize("NFKD", str(texto or ""))
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    return re.sub(r"[^a-zA-Z0-9]", "", texto).lower()


def _valor_booleano(valor) -> bool:
    if isinstance(valor, str):
        return valor.strip().lower() in {"1", "true", "yes", "sim", "on"}
    return bool(valor)


def _carregar_mapa() -> dict:
    with MAPA_CONFIGURACOES.open("r", encoding="utf-8") as arquivo:
        return json.load(arquivo)


def _montar_campos(config: dict, mapa: dict) -> list[dict]:
    resultado = []
    secoes = mapa.get("secoes", {})
    for secao_key, dados_template in (config or {}).items():
        if not isinstance(dados_template, dict) or secao_key not in secoes:
            continue
        secao = secoes[secao_key]
        campos = secao.get("campos")
        if not campos and secao.get("herda_campos_de"):
            campos = secoes[secao["herda_campos_de"]].get("campos", {})

        if campos:
            for campo_key, estado in dados_template.items():
                if campo_key in campos and not isinstance(estado, dict):
                    resultado.append({
                        "caminho": f"{secao_key}.{campo_key}",
                        "secao": secao.get("rotulo", ""), "grupo": "",
                        "campo": campos[campo_key], "estado": _valor_booleano(estado),
                    })
            continue

        for grupo_key, dados_grupo in dados_template.items():
            grupo = secao.get("grupos", {}).get(grupo_key, {})
            if not isinstance(dados_grupo, dict):
                continue
            for campo_key, estado in dados_grupo.items():
                rotulo = grupo.get("campos", {}).get(campo_key)
                if rotulo:
                    resultado.append({
                        "caminho": f"{secao_key}.{grupo_key}.{campo_key}",
                        "secao": secao.get("rotulo", ""), "grupo": grupo.get("rotulo", ""),
                        "campo": rotulo, "estado": _valor_booleano(estado),
                    })
    return resultado


async def _pausar_se_preciso(callback):
    if callback:
        retorno = callback()
        if hasattr(retorno, "__await__"):
            await retorno


async def configurar_divergencias(page: Page, config: dict, log_callback, wait_if_paused=None):
    """Aplica ao cliente todos os checkboxes definidos no template da interface."""
    log_callback("⚙️ Iniciando configuração dos checkboxes de 'Comparar Divergência'...")
    try:
        await _pausar_se_preciso(wait_if_paused)
        mapa = _carregar_mapa()
        itens = _montar_campos(config, mapa)
        if not itens:
            log_callback("⚠️ Template de 'Comparar Divergência' vazio; etapa ignorada.")
            return True

        seletor_container = mapa["pagina"]["container"]
        container = None
        for seletor in (parte.strip() for parte in seletor_container.split(",")):
            candidato = page.locator(seletor).first
            if await candidato.count() and await candidato.is_visible():
                container = candidato
                break
        if container is None:
            raise RuntimeError("container da tela de Configurações não encontrado")
        checkboxes = container.locator("input[type='checkbox']")
        total = await checkboxes.count()
        if total == 0:
            raise RuntimeError("nenhum checkbox foi encontrado na tela de Configurações")

        inventario = []
        for indice in range(total):
            caixa = checkboxes.nth(indice)
            dados = await caixa.evaluate("""el => {
                const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
                    || el.closest('label') || el.parentElement;
                const ancestrais = [];
                let atual = label || el;
                for (let i = 0; atual && i < 7; i++, atual = atual.parentElement) {
                    ancestrais.push((atual.innerText || '').trim());
                }
                return { rotulo: ((label && label.innerText) || el.getAttribute('aria-label') || el.title || '').trim(), ancestrais };
            }""")
            inventario.append((caixa, dados))

        ajustados = 0
        nao_encontrados = []
        for item in itens:
            await _pausar_se_preciso(wait_if_paused)
            alvo = None
            melhor_pontuacao = -1
            campo_norm = _normalizar(item["campo"])
            secao_norm = _normalizar(item["secao"])
            grupo_norm = _normalizar(item["grupo"])
            for caixa, dados in inventario:
                if _normalizar(dados.get("rotulo")) != campo_norm:
                    continue
                textos = [_normalizar(t) for t in dados.get("ancestrais", [])]
                pontuacao = 10
                indices_secao = [i for i, texto in enumerate(textos) if secao_norm and secao_norm in texto]
                indices_grupo = [i for i, texto in enumerate(textos) if grupo_norm and grupo_norm in texto]
                if indices_secao:
                    pontuacao += max(1, 7 - min(indices_secao))
                if indices_grupo:
                    # O grupo mais próximo do checkbox desempata rótulos
                    # repetidos (por exemplo CST em EI, ED, ES, SAC...).
                    pontuacao += max(1, 14 - (2 * min(indices_grupo)))
                if pontuacao > melhor_pontuacao:
                    alvo, melhor_pontuacao = caixa, pontuacao

            minimo = 11 + (1 if grupo_norm else 0)
            if alvo is None or melhor_pontuacao < minimo:
                nao_encontrados.append(item["caminho"])
                continue
            if await alvo.is_checked() != item["estado"]:
                await alvo.set_checked(item["estado"], force=True)
                ajustados += 1
                await page.wait_for_timeout(100)

        if nao_encontrados:
            raise RuntimeError("campos não encontrados: " + ", ".join(nao_encontrados))

        padrao_salvar = re.compile(mapa["pagina"]["botao_salvar"], re.IGNORECASE)
        salvar = container.get_by_role("button", name=padrao_salvar).last
        if not await salvar.count() or not await salvar.is_visible():
            raise RuntimeError("botão Salvar não encontrado na tela de Configurações")
        await salvar.click()
        await page.wait_for_timeout(2_000)
        log_callback(f"✅ Configurações salvas: {len(itens)} campos conferidos, {ajustados} alterados.")
        return True
    except Exception as erro:
        log_callback(f"❌ Erro ao configurar divergências: {erro}")
        return False
