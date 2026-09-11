# Arquitetura do Instalador do Integrador Mix Fiscal

Referência técnica atualizada em **2026-09-11** para a branch
`integrador-v1.2-go-wails`, candidata `1.2.6`. Antes de gerar ou publicar, leia também
[`PUBLICACAO.md`](PUBLICACAO.md) e confirme o branch e o `git status`.

## Decisão de tecnologia

O instalador interno usa **Go 1.26 + Wails 2 + HTML/CSS/JavaScript puro**. Essa escolha acompanha
o próprio `desktop-integrador.exe`, que também foi identificado estaticamente como Go/Wails, mantém
a interface WebView2 e permite portar a automação CDP sem Playwright.

O pacote entregue ao cliente não contém Python, PyQt, PyInstaller, Node, Playwright ou .NET. O
frontend é incorporado aos executáveis Go durante o build. Os arquivos Python da geração anterior
permanecem no repositório como referência e testes de regressão, mas não são empacotados na versão
`1.2`.

```text
Instalador-Mix-Fiscal.exe (Inno Setup, elevado)
  -> copia componentes para a pasta do próprio setup
  -> MixFiscal-Bootstrap.exe (Go puro, sem WebView)
       -> detecta/instala/confirma WebView2
  -> Instalador-Mix-Fiscal-App.exe (Go + Wails)
       -> interface HTML/CSS/JavaScript
       -> diagnóstico Windows e atualização do setup
       -> API Mix + automação CDP/WebSocket
  -> desktop-integrador.exe (Integrador oficial Mix)
  -> Painel_Mix.bat + monitor_mix.ps1 + run_silent.vbs
```

O bootstrap existe porque a janela Wails depende do WebView2 para abrir. Ele prepara o Runtime
antes de o Inno iniciar a interface.

## Compatibilidade de sistema

O pacote é `windows/amd64`, `GOAMD64=v1`. O Inno declara `MinVersion=10.0.14393` e arquitetura x64.

| Sistema | Situação |
| --- | --- |
| Windows 10 x64, build 14393 ou superior | Aceito pelo setup; validar preferencialmente em 22H2 |
| Windows 11 x64 | Compatível |
| Windows Server 2016/2019/2022/2025 x64 | Mesmo patamar técnico do Integrador oficial; exige sessão interativa |
| Windows 7/8/8.1 e Server 2012 R2 ou anterior | Bloqueado/não suportado |
| Windows 32 bits ou ARM | Não suportado pelo pacote atual |

O Integrador oficial analisado é AMD64, Go `1.26.4`, Wails `2.14.0`, versão interna `v0.0.120` e
usa WebView2. O requisito prático vem do Go moderno: Windows 10 ou Server 2016 em diante. A
compatibilidade funcional final sempre depende também do executável que a Mix fornecer.

## Pasta de destino

O usuário cria a pasta definitiva, por exemplo:

```text
C:\Mix Fiscal\integrador
```

e coloca `Instalador-Mix-Fiscal.exe` nela. O Inno usa `{src}` como destino. Ele não cria outra pasta
`Mix Fiscal` e não depende do nome exato da pasta. A atualização do próprio setup preserva esse
destino por `--install-dir`/`/DIR=`.

Arquivos instalados:

```text
desktop-integrador.exe
Painel_Mix.bat
atualizador_mix.ps1
monitor_mix.ps1
run_silent.vbs
integrador_version.json
.mix-installer\Instalador-Mix-Fiscal-App.exe
.mix-installer\MixFiscal-Bootstrap.exe
.mix-installer\payload_manifest.json
config\machine_id.json
logs\instalacao.log
logs\diagnostico.json
```

## Privilégios, conta e perfil

O Inno solicita administrador por `PrivilegesRequired=admin`. O diagnóstico Go só libera a
automação quando:

1. o processo está elevado;
2. a conta elevada é a mesma conta da sessão RDP/console;
3. a conta consegue criar, ler, gravar, renomear e remover arquivos na pasta final, `%TEMP%`,
   `%APPDATA%\mixfiscal-integrador`, `%APPDATA%\desktop-integrador.exe\EBWebView` e
   `%LOCALAPPDATA%\MixFiscal\Installer`;
4. o serviço `Schedule` está ativo;
5. uma tarefa temporária `/IT /RL HIGHEST` pode ser criada e removida sem `/RU` ou `/RP`.

Se o técnico digitar no UAC a senha de outra conta administrativa, o fluxo para antes do login no
Integrador. Isso evita criar o WebView2 e o Machine ID no perfil errado. O instalador não contorna
UAC, política de domínio ou proteção corporativa.

Depois de validar os componentes, grava `RUNASADMIN` para o caminho exato do
`desktop-integrador.exe` em:

```text
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers
```

O atualizador reaplica essa marca quando troca o executável.

## Senhas

- A senha do Windows/UAC é tratada somente pelo Windows.
- Usuário e senha Mix são digitados na interface, usados em memória para API e para os formulários
  do WebView2 e não são gravados em JSON ou log.
- O campo de senha começa mascarado, possui botão de olho e é limpo ao terminar ou falhar.
- A mesma credencial Mix atende o login inicial e a confirmação em Configurações, quando exigida.

## WebView2

O bootstrap consulta a versão `pv` do Runtime nas chaves HKLM/HKCU de 32 e 64 bits. Se não houver
Runtime:

1. baixa o Evergreen Bootstrapper pelo endereço oficial Microsoft;
2. exige HTTP bem-sucedido, tamanho mínimo e cabeçalho PE;
3. valida Authenticode e exige signatário Microsoft;
4. executa `/silent /install` sem janela;
5. aguarda até dez minutos e aceita sucesso ou reinicialização necessária (`3010`);
6. consulta o Registro novamente e só retorna sucesso com uma versão encontrada.

Falhas de proxy, firewall, assinatura ou instalação interrompem o Inno antes da tela Wails.

## Fluxo da automação

```text
abrir setup e elevar
  -> copiar arquivos e manifesto
  -> preparar WebView2 no bootstrap
  -> abrir interface Wails e consultar atualização do setup
  -> validar conta, perfil e Agendador
  -> validar CNPJ e credencial Mix
  -> autenticar na API Mix
  -> ler Machine ID local existente
  -> conferir todos os componentes por tamanho e SHA-256
  -> marcar o Integrador como RUNASADMIN
  -> habilitar CDP local temporariamente na porta 19327
  -> abrir desktop-integrador.exe
  -> fazer login inicial quando a tela pedir
  -> reutilizar o Machine ID do Integrador
  -> gerar uma vez somente quando nenhum ID existir
  -> persistir o ID imediatamente
  -> buscar/configurar o ID legado quando essa tela aparecer
  -> abrir Configurações e confirmar o login quando solicitado
  -> preencher CNPJ
  -> adicionar o serviço mixfiscal se estiver ausente
  -> clicar Salvar Configurações e confirmar o localStorage
  -> clicar Instalar; se estiver parado, clicar Iniciar
  -> remover a configuração temporária de CDP
  -> chamar Painel_Mix.bat --install-monitor e consultar a tarefa
  -> confirmar CNPJ, serviço e Machine ID exato pela API
  -> conferir o mesmo ID nos dois arquivos locais
  -> esperar o ID exato ficar online
  -> localizar pelo WebView2 a janela que já está aberta e aproveitá-la
  -> abrir uma janela nova somente quando nenhuma interface estiver disponível
  -> autenticar novamente, abrir Configurações e confirmar o segundo login quando solicitado
  -> manter o Integrador aberto em Configurações para conferência
```

A automação usa Chrome DevTools Protocol diretamente por WebSocket em
`go-installer/internal/installer/cdp.go`. A porta é ligada no Registro apenas durante o fluxo e o
valor anterior é restaurado no `defer`, inclusive em falha. Ele permanece configurado até a
conferência final, permitindo aproveitar inclusive uma instância substituída pelas tarefas nativas.
A porta WebView2 comprova a interface em máquinas que bloqueiam consultas de processo via CIM. A
etapa repete os logins necessários e só conclui depois de confirmar **Configurações** aberta.

## Machine ID e idempotência

Fontes locais:

```text
<pasta>\config\machine_id.json
%APPDATA%\mixfiscal-integrador\local_settings.json
```

Um ID existente é reutilizado. Quando não existe ID, a automação clica uma vez em **Iniciar nova
configuração** e lê o valor criado pela interface; ela não chama o gerador uma segunda vez. O ID é
gravado antes dos demais cliques para uma nova tentativa retomar a mesma identidade.

Se os dois arquivos tiverem IDs diferentes, ambos são preservados e a instalação para. Outros IDs
do mesmo CNPJ são aceitos porque XML e robô podem usar identidades distintas. A confirmação final
acompanha apenas o ID usado nesta instalação.

## Monitor e manutenção

O Go chama `Painel_Mix.bat --install-monitor` e depois consulta a tarefa
`Mix Fiscal - Monitorar Integrador`. O BAT usa `wscript.exe`/`run_silent.vbs`, sem janela piscando.

No painel manual:

- opção 2 instala ou reativa o monitor e as tarefas nativas;
- opção 3 inicia o Integrador;
- opção 4 para o Integrador;
- opção 5 encerra e exclui as tarefas criadas pelo monitor, remove `run_silent.vbs`, verifica a
  limpeza e desativa `BootStart`, `Startup` e `Watchdog`. As tarefas nativas são preservadas para
  que a opção 2 possa reativá-las; o VBS é recriado automaticamente.

O monitor roda a cada cinco minutos, mantém o Integrador ativo e chama o atualizador.

## Atualizações

`atualizador_mix.ps1` baixa e repara `desktop-integrador.exe`, `Painel_Mix.bat`,
`monitor_mix.ps1`, `run_silent.vbs` e ele próprio. Cada arquivo exige HTTPS no host autorizado,
tamanho e SHA-256. A troca usa backup e restauração.

A interface Go também consulta a seção `installer` do manifesto. Se houver versão superior, baixa
o novo setup, valida host, tamanho, SHA-256 e cabeçalho PE, abre-o com a mesma pasta de destino e
encerra a interface anterior. Setups anteriores a `1.1.0` precisam ser trocados manualmente uma
última vez.

## Logs e antivírus

```text
<pasta>\logs\instalacao.log
<pasta>\logs\diagnostico.json
%ProgramData%\MixFiscal\Logs
<pasta>\atualizador_log.txt
<pasta>\painel_install_log.txt
```

Os diagnósticos não registram credenciais. Em erro, consultam ocorrências relacionadas do Microsoft
Defender para informar a TI. O runtime Go/Wails evita a extração temporária e os padrões do
PyInstaller que causaram bloqueio anterior. O pacote ainda precisa de certificado de assinatura de
código da Mix para ganhar reputação consistente no SmartScreen e em antivírus corporativos.

## Código e build

| Caminho | Responsabilidade |
| --- | --- |
| `go-installer/cmd/bootstrap` | verificação/instalação prévia do WebView2 |
| `go-installer/cmd/ui` | janela Wails |
| `go-installer/frontend/dist` | HTML, CSS, JavaScript e SVG incorporados |
| `go-installer/internal/installer/app.go` | métodos ligados à interface |
| `automation.go` | sequência de instalação, ID, Configurações e monitor |
| `cdp.go` | cliente WebSocket/CDP |
| `core.go` | CNPJ, API, JSON, SHA-256 e versões |
| `windows.go` | WTS, UAC, Registro, WebView2, Agendador e processos |
| `diagnostics.go` / `report.go` | logs, pré-diagnóstico e versões |
| `update.go` | atualização do próprio setup |
| `Instalador-Mix-Fiscal.iss` | elevação, destino, cópia, bootstrap e abertura |
| `GERAR_INSTALADOR.ps1` | testes Go, dois builds nativos, Inno e auditoria |
| `PUBLICAR_ATUALIZACAO.ps1` | versão, manifestos e artefatos públicos |

O build usa o Go instalado ou o pacote portátil em
`integrador\.tools\go1.26.4\go\bin\go.exe`. `.tools` e caches são locais e ignorados pelo Git.
O frontend não exige `npm`.

Validação mínima:

```powershell
$go = '.\integrador\.tools\go1.26.4\go\bin\go.exe'
Push-Location .\integrador\go-installer
& $go test ./...
& $go vet ./...
node --check .\frontend\dist\app.js
Pop-Location

.\.venv\Scripts\python.exe -m unittest discover -s integrador -p test_instalador.py
powershell -NoProfile -ExecutionPolicy Bypass -File .\integrador\GERAR_INSTALADOR.ps1 -SkipDependencies
```

## Limites de validação

Os testes locais confirmam compilação, seletores, CNPJ, idempotência, conflito de IDs, escrita
atômica, integridade do payload e estrutura do pacote. Eles não substituem o teste de ponta a ponta
em uma máquina cliente autorizada. Antes de promover `1.2.0`, validar em Windows 10/11 e Server
2016/2019/2022, com e sem WebView2, em RDP com a mesma conta elevada e com uma conta diferente para
confirmar o bloqueio preventivo.

Não execute o Integrador real, login, API do portal ou alteração de Machine ID em uma nova conversa
sem autorização pontual para o ambiente e CNPJ exatos.
