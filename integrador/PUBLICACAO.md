# Publicação do Integrador Mix Fiscal

Este é o roteiro canônico para atualizar o Integrador e publicar o instalador. Execute todos
os comandos a partir da raiz:

```text
C:\Users\Hom\Desktop\appmix
```

## 1. Escolher a versão

Consulte `integrador/integrador_version.json` e
`web/public/integrador-updates/version.json`. A nova versão precisa ser maior que a publicada,
seguindo `MAJOR.MINOR.PATCH`. Os clientes só baixam quando a versão remota é superior à local.
Nunca reutilize nem diminua uma versão já publicada.

Exemplos: `1.0.0` → `1.0.1` para correção, `1.0.1` → `1.1.0` para funcionalidade.

## 2. Gerar todos os artefatos

Use este comando, trocando a versão e o caminho do novo executável:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\integrador\PUBLICAR_ATUALIZACAO.ps1 `
  -Versao 1.0.1 `
  -Executavel "C:\caminho\desktop-integrador.exe"
```

O script realiza em conjunto:

- copia o novo executável para `integrador/desktop-integrador.exe`;
- publica a cópia baixada pelos clientes em
  `web/public/integrador-updates/desktop-integrador.exe`;
- gera `web/public/integrador-updates/version.json` sem BOM, com versão, tamanho e SHA-256;
- atualiza `integrador/integrador_version.json`;
- recompila `integrador/entrega/Instalador-Mix-Fiscal.exe` como administrador;
- copia o instalador para `web/public/downloads/Instalador-Mix-Fiscal.exe`.

Não edite o manifesto ou copie esses arquivos manualmente.

## 3. Validar antes do commit

```powershell
python -m py_compile integrador\instalador_core.py integrador\automacao_primeiro_acesso.py integrador\instalador_gui.py
Push-Location integrador
python -m unittest test_instalador.py
Pop-Location
Push-Location web
npm.cmd run build
Pop-Location
```

Confirme também que o SHA-256 do binário público coincide com o manifesto:

```powershell
$manifesto = Get-Content .\web\public\integrador-updates\version.json -Raw -Encoding UTF8 | ConvertFrom-Json
$binario = '.\web\public\integrador-updates\desktop-integrador.exe'
$hash = (Get-FileHash $binario -Algorithm SHA256).Hash
$tamanho = (Get-Item $binario).Length
if ($hash -ne $manifesto.executable.sha256 -or $tamanho -ne $manifesto.executable.size) {
    throw 'Manifesto e executável não correspondem.'
}
```

## 4. Revisar, criar o commit e publicar

Revise `git status` e adicione somente os arquivos da alteração. Mudanças do Integrador
normalmente incluem o código alterado e estes artefatos:

```text
integrador/desktop-integrador.exe
integrador/integrador_version.json
web/public/integrador-updates/desktop-integrador.exe
web/public/integrador-updates/version.json
web/public/downloads/Instalador-Mix-Fiscal.exe
```

Depois do commit, execute:

```powershell
git push origin main
```

O push da branch `main` dispara o deploy de produção. O projeto Vercel é
`appmix-retaguarda-importer` e a raiz da aplicação é `web`. Não execute `vercel --prod` na
raiz do repositório: o `.vercelignore` local exclui `*.exe` e pode deixar os downloads fora.

## 5. Confirmar o deploy público

Espere o deploy terminar e confira:

- manifesto: <https://appmix-retaguarda-importer.vercel.app/integrador-updates/version.json>;
- Integrador: <https://appmix-retaguarda-importer.vercel.app/integrador-updates/desktop-integrador.exe>;
- instalador: <https://appmix-retaguarda-importer.vercel.app/downloads/Instalador-Mix-Fiscal.exe>.

Baixe o Integrador publicado e compare seu tamanho e SHA-256 com o manifesto. Verifique também
se o instalador responde com HTTP `200` e o tamanho esperado.

## Alcance da atualização automática

O monitor instalado verifica o manifesto a cada cinco minutos. Ele atualiza automaticamente
somente `desktop-integrador.exe`, cria um backup e reinicia o processo. Se a mudança estiver em
`atualizador_mix.ps1`, `Painel_Mix.bat`, na automação do instalador ou no próprio instalador, as
máquinas existentes precisam executar o novo `Instalador-Mix-Fiscal.exe` uma vez.
