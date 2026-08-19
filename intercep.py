import json
from playwright.sync_api import sync_playwright


def analisar_requisicao(request):
  url = request.url
  metodo = request.method

  # Captura apenas envios de formulários ou botões (POST, PATCH, PUT)
  if metodo in ["POST", "PATCH", "PUT"] and "mixfiscal.com.br" in url:
    print(f"\n==================================================")
    print(f"🎯 [AÇÃO DETECTADA] Método: {metodo}")
    print(f"🔗 URL: {url}")

    # Headers de autenticação usados
    headers = request.headers
    print(f"🔑 Auth: {headers.get('authorization', 'Não enviado')[:30]}...")
    print(f"🔑 X-Token: {headers.get('x-token-user', 'Não enviado')[:30]}...")

    # Payload/Body enviado pelo front-end
    try:
      post_data = request.post_data_json
      print("📦 Payload enviado (JSON):")
      print(json.dumps(post_data, indent=2, ensure_ascii=False))
    except Exception:
      print(f"📦 Payload enviado (Texto): {request.post_data}")

    print(f"==================================================\n")


def main():
  with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    context = browser.new_context()
    page = context.new_page()

    # Escuta as requisições de saída
    page.on("request", analisar_requisicao)

    print("🚀 Abrindo o navegador...")
    page.goto("https://app.mixfiscal.com.br")

    print("\n👉 PASSO A PASSO NO NAVEGADOR:")
    print("1. Faça o login e selecione a loja.")
    print("2. Vá na tela do Painel / Configuração de Tabela e clique em SALVAR.")
    print("3. Clique no botão verde IMPORTAR.")
    print("\n[Aguardando você clicar nos botões no navegador...]\n")

    input(
        "Pressione ENTER neste terminal APÓS ter clicado nos botões para fechar"
        "...\n"
    )
    browser.close()


if __name__ == "__main__":
  main()