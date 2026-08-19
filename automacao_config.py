import asyncio
import re
import unicodedata
from playwright.async_api import Page


def _normalizar_texto(texto: str) -> str:
    """Remove acentos, caracteres especiais e espaços para comparação exata de chaves."""
    if not texto:
        return ""
    nfkd = unicodedata.normalize("NFKD", texto)
    texto_sem_acento = "".join(
        [c for c in nfkd if not unicodedata.combining(c)]
    )
    return re.sub(r"[^a-zA-Z0-9]", "", texto_sem_acento).lower()


def _flatten_config(config_dict: dict) -> dict:
    """Converte o dicionário de configuração em um mapa simples (chave: boolean)."""
    flat_config = {}
    if not isinstance(config_dict, dict):
        return flat_config

    def _extract(d):
        for k, v in d.items():
            if isinstance(v, dict):
                _extract(v)
            else:
                norm_key = _normalizar_texto(str(k))
                flat_config[norm_key] = bool(v)

    _extract(config_dict)
    return flat_config


async def configurar_divergencias(
    page: Page, config: dict, log_callback, wait_if_paused
):
    """Marca os checkboxes e clica no botão Salvar diretamente no Modal ativo usando JavaScript nativo."""
    log_callback(
        "⚙️ Iniciando configuração de 'Comparar Divergência' no Modal Ativo..."
    )
    try:
        await wait_if_paused()
        await page.wait_for_timeout(1000)

        template_plano = _flatten_config(config)
        if not template_plano:
            log_callback(
                "⚠️ Template de 'Comparar Divergência' está vazio. Nenhuma ação executada."
            )
            return True

        # ----------------------------------------------------------------------
        # 1. PROCESSA OS CHECKBOXES VIA JAVASCRIPT NO CONTAINER ATIVO
        # ----------------------------------------------------------------------
        # Localiza o modal/painel ativo
        modal_container = page.locator(
            "div.modal.show, div.tab-pane.active, div.card-body"
        ).first

        checkboxes = modal_container.locator("input[type='checkbox']")
        total = await checkboxes.count()
        log_callback(
            f"   📌 Total de caixas de seleção (checkboxes) no modal: {total}"
        )

        if total == 0:
            # Fallback caso não esteja dentro de um modal com classe .show
            checkboxes = page.locator("input[type='checkbox']")
            total = await checkboxes.count()

        ajustes_realizados = 0

        for i in range(total):
            await wait_if_paused()
            elemento = checkboxes.nth(i)

            try:
                # Extrai dados e rótulo do campo
                dados_item = await elemento.evaluate("""
                    el => {
                        let labelText = '';
                        if (el.id) {
                            let lbl = document.querySelector(`label[for="${el.id}"]`);
                            if (lbl) labelText = lbl.innerText;
                        }
                        if (!labelText) {
                            let parent = el.closest('.form-check, .custom-control, label, div, td') || el.parentElement;
                            if (parent) labelText = parent.innerText;
                        }
                        return {
                            text: (labelText || '').trim().replace(/\\n/g, ' '),
                            checked: !!el.checked
                        };
                    }
                """)

                texto_label = dados_item.get("text", "")
                esta_marcado = dados_item.get("checked", False)

                if not texto_label:
                    continue

                norm_label_tela = _normalizar_texto(texto_label)

                chave_correspondente = None
                for chave_norm in template_plano.keys():
                    if (
                        chave_norm in norm_label_tela
                        or norm_label_tela in chave_norm
                    ):
                        chave_correspondente = chave_norm
                        break

                if chave_correspondente:
                    estado_desejado = template_plano[chave_correspondente]

                    if esta_marcado != estado_desejado:
                        # Executa a troca via dispatchEvent para garantir que o estado do React/JS seja atualizado sem falhas
                        await elemento.evaluate(
                            """
                            (el, desejado) => {
                                el.checked = desejado;
                                el.dispatchEvent(new Event('click', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                        """,
                            estado_desejado,
                        )

                        ajustes_realizados += 1
                        status_str = (
                            "LIGADO [✓]"
                            if estado_desejado
                            else "DESLIGADO [ ]"
                        )
                        log_callback(
                            f"   ✏️ [{ajustes_realizados}] Ajustado '{texto_label}' ➔ {status_str}"
                        )
                        # Pequena pausa para o React processar a mudança de estado do componente
                        await page.wait_for_timeout(100)

            except Exception:
                continue

        log_callback(
            f"   ✅ Processamento concluído: {ajustes_realizados} alterações efetuadas."
        )
        await page.wait_for_timeout(1000)

        # ----------------------------------------------------------------------
        # 2. CLIQUE VIA JS NO BOTÃO SALVAR DO MODAL ATIVO
        # ----------------------------------------------------------------------
        log_callback("   💾 Disparando clique no botão Salvar via JS nativo...")

        # Tenta acionar via JS o botão do Modal/Tab Ativo primeiro e cai em fallback para o seletor completo caso necessário
        resultado_clique = await page.evaluate("""
            () => {
                // 1. Tenta achar o botão dentro da aba/modal ativo
                let btn = document.querySelector('div.tab-pane.active button.btn-success') || 
                          document.querySelector('div.modal.show button.btn-success') ||
                          document.querySelector('button.btn.btn-success');
                
                if (btn) {
                    btn.scrollIntoView();
                    btn.click();
                    return true;
                }
                return false;
            }
        """)

        if resultado_clique:
            log_callback("   ✅ Botão 'Salvar' (btn-success) acionado via JS!")
        else:
            log_callback(
                "   ⚠️ Botão de salvar não encontrado via JS, tentando clique direto Playwright..."
            )
            btn_salvar = page.locator("button.btn-success").first
            await btn_salvar.click(force=True)

        # ----------------------------------------------------------------------
        # 3. VERIFICAÇÃO DE ERRO E TEMPO DE GRAVAÇÃO
        # ----------------------------------------------------------------------
        log_callback("   ⏳ Aguardando confirmação do salvamento...")
        await page.wait_for_timeout(2500)

        # Checa se o alerta de erro do backend apareceu
        alerta_erro = page.locator(
            "div:has-text('Falha ao tentar atualizar dados'), .toast-danger"
        )
        if await alerta_erro.count() > 0 and await alerta_erro.is_visible():
            log_callback(
                "   ❌ O backend retornou erro. Verifique os dados ou permissões do usuário."
            )
            return False

        for seg in range(5, 0, -1):
            log_callback(
                f"   ⏳ Processando gravação no banco ({seg}s)..."
            )
            await asyncio.sleep(1)

        log_callback(
            "✅ Configuração de 'Comparar Divergência' finalizada com sucesso!"
        )
        return True

    except Exception as e:
        log_callback(f"❌ Erro ao configurar divergências: {e}")
        return False