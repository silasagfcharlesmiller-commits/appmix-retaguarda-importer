# Publicação do Integrador Mix Fiscal

Este é o roteiro canônico. Execute os comandos na raiz:

```text
C:\Users\Hom\Desktop\appmix
```

## 1. Conferir versão e branch

Leia `integrador/integrador_version.json` e
`web/public/integrador-updates/version.json`. Use sempre SemVer superior à maior versão publicada.
Não reutilize nem reduza versão.

```powershell
git branch --show-current
git status --short
Get-Content .\integrador\integrador_version.json
Get-Content .\web\public\integrador-updates\version.json
```

## 2. Pré-requisitos de build

- Inno Setup 6;
- Go 1.26.4 instalado ou extraído em
  `integrador\.tools\go1.26.4\go\bin\go.exe`;
- Python somente para o verificador/testes do repositório;
- Node não é usado pelo instalador nem por seu frontend.

Para instalar o Inno uma vez:

```powershell
winget install --id JRSoftware.InnoSetup --exact --silent --accept-package-agreements --accept-source-agreements
```

## 3. Gerar a versão

Use somente `PUBLICAR_ATUALIZACAO.ps1`, trocando a versão e o executável oficial:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\integrador\PUBLICAR_ATUALIZACAO.ps1 `
  -Versao 1.2.0 `
  -Executavel "C:\caminho\desktop-integrador.exe"
```

O script:

- copia o Integrador oficial para a origem e a pasta pública;
- atualiza `integrador_version.json` e o manifesto público sem BOM;
- registra tamanho e SHA-256 dos cinco componentes atualizáveis;
- executa testes Go;
- compila `MixFiscal-Bootstrap.exe` e `Instalador-Mix-Fiscal-App.exe` nativos;
- incorpora HTML/CSS/JavaScript na interface Wails;
- gera o setup elevado pelo Inno;
- audita payload e ausência de Python/PyQt/Playwright/Node no runtime;
- copia o setup para `web/public/downloads/Instalador-Mix-Fiscal.exe`;
- acrescenta ao manifesto o tamanho e SHA-256 do próprio setup.

Não edite manifestos nem copie artefatos manualmente.

## 4. Validar

```powershell
$go = '.\integrador\.tools\go1.26.4\go\bin\go.exe'
$env:GOCACHE = (Resolve-Path '.\integrador\.tools\gocache').Path
$env:GOMODCACHE = (Resolve-Path '.\integrador\.tools\gomodcache').Path
Push-Location .\integrador\go-installer
& $go test ./...
& $go vet ./...
node --check .\frontend\dist\app.js
Pop-Location

.\.venv\Scripts\python.exe -m unittest discover -s integrador -p test_instalador.py

Push-Location .\web
npm.cmd run build
Pop-Location
```

Confirme o binário publicado contra o manifesto:

```powershell
$manifesto = Get-Content .\web\public\integrador-updates\version.json -Raw -Encoding UTF8 | ConvertFrom-Json
$binario = '.\web\public\integrador-updates\desktop-integrador.exe'
$hash = (Get-FileHash $binario -Algorithm SHA256).Hash
$tamanho = (Get-Item $binario).Length
if ($hash -ne $manifesto.executable.sha256 -or $tamanho -ne $manifesto.executable.size) {
    throw 'Manifesto e executável não correspondem.'
}
```

## 5. Revisar e publicar

Antes de qualquer push em `main`:

```powershell
git status --short -- web
```

Todo push em `main` recompila o site completo. Inclua as alterações corretas do site e confira que
nenhuma versão local publicada anteriormente será revertida. Os artefatos esperados incluem:

```text
integrador/desktop-integrador.exe
integrador/integrador_version.json
integrador/entrega/Instalador-Mix-Fiscal.exe
web/public/integrador-updates/desktop-integrador.exe
web/public/integrador-updates/version.json
web/public/downloads/Instalador-Mix-Fiscal.exe
```

Depois de revisar e mesclar a branch candidata em `main`:

```powershell
git push origin main
```

O push de `main` faz o deploy do projeto Vercel `appmix-retaguarda-importer`, cuja raiz é `web`.
Nunca execute `vercel --prod` na raiz do repositório.

## 6. Validar os downloads públicos

- manifesto: <https://appmix-retaguarda-importer.vercel.app/integrador-updates/version.json>;
- Integrador: <https://appmix-retaguarda-importer.vercel.app/integrador-updates/desktop-integrador.exe>;
- instalador: <https://appmix-retaguarda-importer.vercel.app/downloads/Instalador-Mix-Fiscal.exe>.

Confirme HTTP `200`, tamanho e SHA-256 após a Vercel terminar.

## Alcance das atualizações

O monitor atualiza automaticamente, a cada cinco minutos:

- `desktop-integrador.exe`;
- `Painel_Mix.bat`;
- `monitor_mix.ps1`;
- `run_silent.vbs`;
- `atualizador_mix.ps1`.

A interface Wails também atualiza o próprio setup ao ser aberta quando encontra versão remota
superior. Ela baixa, valida e abre o novo `Instalador-Mix-Fiscal.exe` preservando a pasta original.
Máquinas com setup anterior a `1.1.0` precisam receber manualmente um setup moderno uma última vez.

Uma alteração somente no código do instalador Go/Wails exige nova versão do setup. O monitor não
troca sozinho os binários dentro de `.mix-installer`; essa atualização acontece quando o usuário
abre o setup e ele encontra a versão superior publicada.
