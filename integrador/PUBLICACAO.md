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
- descompacta todas as entradas do instalador e compara o Integrador e o Node do Playwright
  com os arquivos de origem; um pacote corrompido é removido e o build tenta novamente, no
  máximo três vezes;
- copia o instalador para `web/public/downloads/Instalador-Mix-Fiscal.exe`.

Não edite o manifesto ou copie esses arquivos manualmente.

## 3. Validar antes do commit

```powershell
python -m py_compile integrador\instalador_core.py integrador\diagnostico_instalador.py integrador\automacao_primeiro_acesso.py integrador\instalador_gui.py
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

Antes do push, execute também:

```powershell
git status --short -- web
```

Todo push em `main` recompila o site completo. Se houver páginas ou rotas locais que já foram
publicadas manualmente, mas ainda não estão no GitHub, um push somente do Integrador fará a
Vercel voltar ao código antigo. Revise e versione primeiro a versão correta de `web`.

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

O monitor instalado verifica o manifesto a cada cinco minutos. A partir da versão `1.0.1`, ele
atualiza automaticamente `desktop-integrador.exe`, `Painel_Mix.bat`, `monitor_mix.ps1`,
`run_silent.vbs` e o próprio `atualizador_mix.ps1`. Cada componente é validado por origem HTTPS,
tamanho e SHA-256. A troca usa backup e restaura os arquivos se uma etapa falhar.

Máquinas que receberam uma versão anterior a `1.0.1` precisam executar o instalador novo uma
vez para receber o atualizador completo. Depois dessa transição, novas versões desses cinco
componentes chegam automaticamente. Mudanças na automação de instalação ou no próprio
`Instalador-Mix-Fiscal.exe` continuam exigindo o novo instalador, pois ele não permanece na pasta
instalada.

A partir da versão `1.1.0`, o manifesto também contém tamanho e SHA-256 do próprio instalador.
Ao abrir, o setup consulta esse manifesto e, quando há uma versão superior, baixa, valida e abre
o novo setup preservando a pasta original como destino. Uma versão anterior a `1.1.0` precisa
ser substituída manualmente uma última vez para receber esse mecanismo.
