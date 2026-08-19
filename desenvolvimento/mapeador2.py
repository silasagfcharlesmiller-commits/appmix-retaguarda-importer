import asyncio
import re
import sys
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

# Configurações de Acesso
URL_APPMIX = "https://app.mixfiscal.com.br"
CNPJ_TESTE = "52703958000142"

# Script JS injetado de forma nativa e persistente no navegador
JS_INJECT_KEY_HOOKS = """
(() => {
    if (window.__hooksInjected) return;
    window.__hooksInjected = true;

    let hoveredElement = null;
    let mouseX = 0;
    let mouseY = 0;

    // Monitora a posição e o elemento atual
    document.addEventListener('mouseover', (e) => {
        hoveredElement = e.target;
    }, true);

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }, true);

    function getXPath(element) {
        if (!element) return '';
        if (element.id && element.id !== '') {
            return '//*[@id="' + element.id + '"]';
        }
        if (element === document.body) {
            return '/html/body';
        }
        var ix = 0;
        var siblings = element.parentNode ? element.parentNode.childNodes : [];
        for (var i = 0; i < siblings.length; i++) {
            var sibling = siblings[i];
            if (sibling === element) {
                return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
            }
            if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
                ix++;
            }
        }
    }

    // Intercepta as teclas no nível mais alto do DOM (Fase de Captura)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'F8') {
            e.preventDefault();
            e.stopPropagation();

            let target = hoveredElement || document.elementFromPoint(mouseX, mouseY);

            if (target) {
                const path = getXPath(target);
                const tag = target.tagName.toLowerCase();
                const id = target.id ? `#${target.id}` : '';
                const name = target.getAttribute('name') ? `[name="${target.getAttribute('name')}"]` : '';
                const text = target.innerText ? target.innerText.trim().substring(0, 30).replace(/\s+/g, ' ') : '';
                const cls = target.className && typeof target.className === 'string' ? `.${target.className.trim().split(/\s+/).join('.')}` : '';

                console.log(`[MAPPER_ELEMENT] Tag: <${tag}> | Class: "${cls}" | ID: "${id}" | Name: "${name}" | Text: "${text}"`);
                console.log(`[MAPPER_ELEMENT] XPath: ${path}`);
            } else {
                console.log('[MAPPER_ELEMENT] Posicione o mouse sobre o elemento na modal e pressione F8 novamente.');
            }
        }

        if (e.key === 'F9') {
            e.preventDefault();
            e.stopPropagation();
            console.log('[TRIGGER_BS4] Solicitando captura e análise da tela/modal...');
        }
    }, true);
})();
"""


def analisar_com_beautifulsoup(html_content):
    """Mapeia os elementos e botões presentes na tela/modal atual."""
    soup = BeautifulSoup(html_content, "html.parser")

    print("\n" + "=" * 70)
    print("🔍 [BEAUTIFULSOUP] MAPEAMENTO DE ELEMENTOS E BOTÕES (F9)")
    print("=" * 70)

    # Busca por botões e checkboxes (muito comum nessa modal do Mix Fiscal)
    elementos = soup.find_all(
        ["button", "input", "label", "a", "span", "div"]
    )
    mapeados = []

    for el in elementos:
        # Pega elementos que possuem classe, ID ou texto visível
        texto = el.get_text(strip=True)
        tag = el.name
        el_id = el.get("id", "")
        el_type = el.get("type", "")
        el_class = (
            " ".join(el.get("class", []))
            if isinstance(el.get("class"), list)
            else el.get("class", "")
        )

        # Filtra elementos úteis
        if (
            tag in ["button", "input"]
            or "btn" in el_class.lower()
            or el_id
            or (texto and len(texto) < 35)
        ):
            if texto or el_id or el_type:
                mapeados.append(
                    f"<{tag} type='{el_type}'> | Text: '{texto}' | ID: '{el_id}' | Class: '{el_class}'"
                )

    print(f"\n📌 Botões / Campos Encontrados ({len(mapeados)}):")
    if mapeados:
        # Remove duplicados mantendo a ordem
        vistos = set()
        for item in mapeados:
            if item not in vistos:
                vistos.add(item)
                print(f"   ➔ {item}")
    else:
        print("   ⚠️ Nenhum elemento mapeável encontrado no HTML atual.")

    print("\n" + "=" * 70 + "\n")


async def run_mapper():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False, args=["--start-maximized"]
        )
        context = await browser.new_context(no_viewport=True)

        # Injeta o listener persistente antes de abrir qualquer página
        await context.add_init_script(JS_INJECT_KEY_HOOKS)

        page = await context.new_page()

        # Ouve os logs disparados pelo JS injetado
        async def handle_console(msg):
            text = msg.text
            if "[MAPPER_ELEMENT]" in text:
                print(text)
            elif "[TRIGGER_BS4]" in text:
                print("\n⚙️ Extraindo HTML da página/modal para análise...")
                html = await page.content()
                analisar_com_beautifulsoup(html)

        page.on("console", lambda msg: asyncio.create_task(handle_console(msg)))

        print("🚀 Iniciando Mapeador de Elementos...")
        await page.goto(URL_APPMIX)

        print("\n" + "─" * 60)
        print("🎮 CONTROLES ATIVOS NA JANELA DO NAVEGADOR:")
        print(
            "   👉 [F8] ➔ Mapeia Tag, Class, ID e XPath do elemento sob o cursor do mouse."
        )
        print(
            "   👉 [F9] ➔ Varre o HTML da tela/modal e lista os botões e seletores no terminal."
        )
        print("─" * 60 + "\n")

        # Mantém a sessão aberta aguardando comandos do teclado sem travar a CPU
        try:
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            print("\n🛑 Mapeador encerrado pelo usuário.")
            await browser.close()


if __name__ == "__main__":
    try:
        asyncio.run(run_mapper())
    except KeyboardInterrupt:
        sys.exit(0)