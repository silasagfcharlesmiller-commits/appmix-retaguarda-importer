# Arquitetura do Instalador do Integrador Mix Fiscal

Este documento é a referência técnica central do instalador. Ele foi atualizado em
**2026-09-10** a partir da branch `integrador-v1.1-diagnostico`, versão candidata `1.1.2`.

Antes de alterar, gerar ou publicar o instalador, leia também [`PUBLICACAO.md`](PUBLICACAO.md).
Uma conversa nova deve conferir o branch, o commit e os manifestos antes de assumir que a
situação registrada aqui continua atual.

## Estado do Git nesta revisão

| Item | Valor nesta revisão |
| --- | --- |
| Branch de desenvolvimento | `integrador-v1.1-diagnostico` |
| Commit da branch | `d84d72b` |
| Versão candidata | `1.1.2` |
| Branch estável | `main` / `origin/main` |
| Versão registrada na branch estável | `1.0.3` |
| Publicação da candidata | Ainda não mesclada em `main` nesta revisão |

Não publique a candidata por cópia manual. A publicação oficial acontece com uma versão SemVer
superior, pelo script `integrador\PUBLICAR_ATUALIZACAO.ps1`, seguida de revisão e push de `main`.

## Objetivo e comportamento esperado

O setup instala o Integrador oficial da Mix Fiscal na pasta em que o próprio setup foi colocado,
configura o cliente no WebView2, preserva o Machine ID da máquina, ativa o monitor do Windows e
confirma pela API que o ID usado pelo robô ficou online.

O banco de dados e as configurações específicas de retaguarda continuam sendo enviados pelo App
Mix/site. O setup cuida de CNPJ, arquivos locais, serviço `mixfiscal`, Machine ID, Integrador e
monitor.

## Sistemas operacionais

O pacote atual é destinado a Windows de 64 bits.

| Sistema | Situação recomendada |
| --- | --- |
| Windows 10 1809 ou superior, x64 | Compatível |
| Windows 11, x64 | Compatível |
| Windows Server 2019, 2022 e 2025, x64 | Compatível e recomendado para servidores |
| Windows Server 2016 | WebView2 é suportado, mas exige teste real com o runtime PyQt6/Qt atual |
| Windows 7, 8, 8.1, Server 2008, 2012 ou 2012 R2 | Não suportado pelo projeto |
| Windows de 32 bits ou Windows ARM | Não suportado pelo pacote atual |

O limite da interface vem do PyQt6/Qt 6.11, cujo alvo Windows oficial começa no Windows 10 1809.
O WebView2 admite Windows Server 2016 ou superior, mas isso isoladamente não garante toda a
aplicação. O executável oficial `desktop-integrador.exe` também pode impor requisitos próprios.

Referências dos fornecedores:

- Qt 6.11: <https://doc.qt.io/qt-6/supported-platforms.html>
- Microsoft WebView2: <https://learn.microsoft.com/pt-br/microsoft-edge/webview2/>

O arquivo Inno Setup está configurado com `ArchitecturesAllowed=x64compatible` e instala no modo
64 bits. Ainda não há `MinVersion` no script `.iss`; portanto, o setup não bloqueia sozinho todas
as versões antigas do Windows. A tabela acima deve ser tratada como requisito operacional.

## Arquitetura por camadas

```text
Instalador-Mix-Fiscal.exe
  Inno Setup, elevado como administrador
              |
              v
.mix-installer\Instalador-Mix-Fiscal-App.exe
  Python 3.12 + PyQt6/Qt, empacotado por PyInstaller onedir
              |
              +--> diagnóstico do Windows, perfil, permissões e versões
              +--> atualização do próprio setup
              +--> instalação/validação do WebView2
              +--> autenticação na API Mix
              |
              v
desktop-integrador.exe
  Aplicação oficial Mix Fiscal com WebView2/Wails
              |
              +--> automação local por CDP/WebSocket
              +--> login, Machine ID, CNPJ, serviço, salvar e instalar
              |
              v
Painel_Mix.bat + monitor_mix.ps1 + run_silent.vbs
  tarefa agendada, monitor invisível e atualização automática
```

Não há Node.js nem Playwright no pacote `1.1`. A comunicação com a interface WebView2 usa o Chrome
DevTools Protocol por WebSocket em `cdp_browser.py`.

## Linguagens e ferramentas

| Componente | Tecnologia | Função |
| --- | --- | --- |
| Setup externo | Inno Setup (`.iss`) | Elevação, cópia convencional e abertura da aplicação interna |
| Interface interna | Python 3.12 + PyQt6/Qt 6.11 | Formulário, diagnóstico, versões e execução do fluxo |
| Automação | Python | API, Machine ID, arquivos, WebView2 e validações |
| Navegação local | Python + WebSocket/CDP | Controla a interface do Integrador sem Playwright |
| Monitor/atualizador | PowerShell | Monitora, baixa, valida, troca e restaura componentes |
| Painel manual | Batch | Instala, consulta, inicia, para e remove o monitor |
| Lançador invisível | VBScript | Executa o monitor sem janela piscando |
| Empacotamento Python | PyInstaller `onedir` | Inclui Python e PyQt6 sem exigir instalação no cliente |
| Pacote final | Inno Setup 6 | Compacta o runtime e os arquivos em um único EXE de entrega |

## Os dois executáveis do setup

### 1. `Instalador-Mix-Fiscal.exe`

É o arquivo entregue ao cliente. O Inno Setup:

1. solicita elevação administrativa por `PrivilegesRequired=admin`;
2. usa como destino a pasta em que o setup está (`DefaultDirName={src}`);
3. copia o runtime interno para `.mix-installer`;
4. copia `desktop-integrador.exe`, `Painel_Mix.bat`, `atualizador_mix.ps1`,
   `monitor_mix.ps1`, `run_silent.vbs` e `integrador_version.json`;
5. abre `.mix-installer\Instalador-Mix-Fiscal-App.exe --install-dir "<pasta>"`.

Como o diagnóstico detalhado roda na aplicação interna, o Inno pode já ter copiado os arquivos
antes de uma reprovação de perfil. Uma reprovação impede login, Machine ID e configuração do
cliente, mas pode deixar os arquivos descompactados na pasta escolhida.

### 2. `.mix-installer\Instalador-Mix-Fiscal-App.exe`

É a tela profissional com CNPJ, usuário, senha, olho para exibir a senha, versões, diagnóstico e
progresso. Ela é Python/PyQt6 compilado. Não exige Python, PyQt6, Node.js nem Playwright instalados
na máquina do cliente.

Ao iniciar, consulta o manifesto público. Se houver setup superior e o manifesto possuir a seção
`installer`, baixa por HTTPS, valida host, tamanho, SHA-256 e cabeçalho PE, abre a versão nova com o
mesmo destino e encerra a antiga. Se a consulta falhar, registra o problema e permite continuar com
o setup local.

Depois de mostrar a janela, faz automaticamente a verificação do ambiente. O botão de instalação
só é habilitado quando essa verificação termina com sucesso.

## Privilégios, conta e perfil do Windows

O setup não tenta contornar UAC, antivírus ou política da empresa. Ele verifica cedo se o ambiente
consegue executar o fluxo completo.

O pré-diagnóstico exige:

1. processo elevado como administrador;
2. identificação da conta interativa da sessão RDP/console;
3. conta elevada igual à conta interativa;
4. leitura, criação, gravação, renomeação e remoção nos diretórios necessários;
5. serviço `Schedule` do Agendador de Tarefas em execução;
6. criação e remoção de uma tarefa temporária inofensiva com token interativo e nível mais alto.

Exemplos:

| Sessão ativa | Conta elevada | Resultado |
| --- | --- | --- |
| `SERVIDOR\ROBO` | `SERVIDOR\ROBO` | Liberado |
| Administrador já conectado, UAC apenas com Sim/Não | Mesma conta | Liberado |
| `SERVIDOR\CLIENTE` | `SERVIDOR\TI-ADMIN` informado no UAC | Bloqueado |

O bloqueio por contas diferentes evita instalar os arquivos com um administrador e depois tentar
usar WebView2, AppData e monitor no perfil de outro usuário.

Os caminhos testados são:

```text
<pasta do instalador>
%TEMP%
%APPDATA%\mixfiscal-integrador
%APPDATA%\desktop-integrador.exe\EBWebView
%LOCALAPPDATA%\MixFiscal\Installer
```

Por exemplo, no perfil `Hom`, o perfil WebView2 testado é:

```text
C:\Users\Hom\AppData\Roaming\desktop-integrador.exe\EBWebView
```

Se a pasta ainda não existir, o teste tenta criá-la. Se qualquer teste falhar, a aplicação interna
mantém o botão de instalação desabilitado e não inicia autenticação, alteração de Machine ID ou
configuração do CNPJ.

Em servidor RDP, o técnico deve entrar com a conta que ficará executando o Integrador e elevar o
setup dentro dessa mesma sessão. Digitar no UAC a senha de outra conta administrativa é tratado como
perfil incorreto. Desconectar o RDP geralmente preserva a sessão; fazer logoff encerra o token
interativo usado por aplicações visíveis.

## Execução permanente como administrador

Depois de copiar e conferir `desktop-integrador.exe`, o instalador grava `RUNASADMIN` para o caminho
exato do arquivo em:

```text
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers
```

Em seguida lê novamente o valor e falha se não conseguir confirmá-lo. O atualizador repete essa
configuração quando troca o executável. Isso faz o Windows solicitar/usar elevação nas futuras
aberturas, conforme as políticas de UAC da máquina.

O Integrador visível não deve ser executado como `SYSTEM` na sessão 0. O WebView2 e os arquivos de
perfil pertencem à sessão interativa do usuário validado.

## Senhas e autenticação

Existem dois tipos diferentes de senha no ambiente:

1. **credencial do Windows/UAC:** tratada exclusivamente pelo Windows; o instalador não captura,
   transmite nem salva essa senha;
2. **usuário e senha do Integrador Mix:** digitados no formulário PyQt6 e usados em memória durante
   a instalação para validar a API e preencher a interface WebView2.

A senha do Integrador:

- aparece mascarada por padrão;
- pode ser exibida temporariamente pelo botão de olho;
- é reaproveitada quando a própria tela de Configurações pede o segundo login;
- não é escrita nos JSONs ou logs;
- é apagada do campo ao concluir ou falhar.

O painel e a tarefa do monitor não recebem `/RU` nem `/RP` e não armazenam senha do Windows. A tarefa
é criada com `/IT /RL HIGHEST`, usando o token interativo da conta que o pré-diagnóstico validou.

## Verificação e instalação do WebView2

O instalador pesquisa a versão `pv` do WebView2 Runtime nos registros de máquina e de usuário, nas
visões de 32 e 64 bits, e escolhe a maior versão encontrada.

Quando encontra o Runtime, registra e continua. Quando não encontra:

1. cria `<pasta>\.setup`;
2. baixa o bootstrapper Evergreen oficial da Microsoft;
3. exige HTTPS e aplica timeout de download;
4. confere tamanho mínimo e cabeçalho de executável;
5. valida a assinatura Authenticode e exige a Microsoft como signatária;
6. executa `MicrosoftEdgeWebview2Setup.exe /silent /install` sem janela;
7. aguarda até dez minutos;
8. aceita os códigos `0` ou `3010`;
9. consulta novamente o Registro e só continua se encontrar uma versão instalada.

Falhas de proxy, firewall, assinatura, instalação ou detecção interrompem o fluxo com mensagem e
diagnóstico. A instalação do WebView2 acontece antes do login e da cópia/configuração interna feita
pela automação Python.

## Fluxo completo da instalação

```text
Abrir setup
  -> elevar como administrador
  -> copiar runtime/componentes pelo Inno
  -> verificar atualização do próprio setup
  -> abrir interface PyQt6
  -> comparar conta interativa e elevada
  -> testar AppData, LocalAppData, TEMP e pasta final
  -> testar Agendador de Tarefas
  -> validar CNPJ e presença de usuário/senha
  -> detectar ou instalar WebView2
  -> autenticar na API Mix
  -> localizar Machine ID local existente
  -> copiar e validar componentes por SHA-256
  -> marcar desktop-integrador.exe como RUNASADMIN
  -> habilitar temporariamente a porta CDP do WebView2
  -> abrir desktop-integrador.exe
  -> fazer login quando a tela solicitar
  -> reutilizar o Machine ID nativo existente
  -> gerar uma única vez somente quando realmente não existir ID
  -> persistir o ID antes dos cliques seguintes
  -> abrir Configurações e refazer login quando solicitado
  -> preencher CNPJ
  -> adicionar o serviço mixfiscal se ainda não estiver selecionado
  -> rolar até o final
  -> clicar Salvar Configurações e conferir localStorage
  -> clicar Instalar e confirmar a instalação nativa
  -> remover a configuração temporária de CDP
  -> instalar e consultar o monitor pelo Painel Mix
  -> confirmar CNPJ, serviço e Machine ID pela API
  -> conferir o mesmo ID nos dois arquivos locais
  -> aguardar o ID exato ficar online no App Mix
  -> reabrir e validar o processo do Integrador
  -> finalizar e mostrar o Machine ID
```

## Machine ID e idempotência

As duas fontes locais são:

```text
<pasta>\config\machine_id.json
%APPDATA%\mixfiscal-integrador\local_settings.json
```

Regras:

- um ID existente é reutilizado;
- ao gerar um ID novo, a automação usa o valor criado pela própria interface do Integrador;
- o valor é persistido antes de continuar, permitindo retomar uma tentativa interrompida;
- se os dois arquivos contiverem IDs diferentes, os dois são preservados e o setup para;
- IDs adicionais vinculados ao mesmo CNPJ não são removidos, pois um pode atender XML e outro o
  robô;
- a validação final acompanha somente o Machine ID exato usado pela instalação atual.

## Pasta de instalação

O usuário deve criar a pasta definitiva, por exemplo:

```text
C:\Mix Fiscal\integrador
```

e colocar `Instalador-Mix-Fiscal.exe` nela. O setup utiliza a própria pasta como destino. Ele não
cria outra árvore `C:\Mix Fiscal\...` quando foi executado de uma pasta diferente.

Componentes finais principais:

```text
desktop-integrador.exe
Painel_Mix.bat
atualizador_mix.ps1
monitor_mix.ps1
run_silent.vbs
integrador_version.json
.mix-installer\...
config\machine_id.json
logs\instalacao.log
logs\diagnostico.json
```

## Monitor, Painel Mix e manutenção

O instalador chama:

```text
Painel_Mix.bat --install-monitor
```

O BAT cria a tarefa `Mix Fiscal - Monitorar Integrador`, executada de forma invisível por
`wscript.exe`/`run_silent.vbs`. Após a criação, o instalador consulta a tarefa e falha se ela não
existir.

No painel manual:

- opção 2 instala ou reativa o monitor e as tarefas nativas;
- opção 3 inicia o Integrador;
- opção 4 para o Integrador;
- opção 5 desinstala/desativa o monitor e desativa `BootStart`, `Startup` e `Watchdog` para
  manutenção.

O monitor procura primeiro `desktop-integrador.exe`, depois um EXE com `integrador` no nome e, se
houver apenas um EXE de aplicação na pasta, pode usar esse arquivo. Ele roda a cada cinco minutos.

## Atualização automática

Há dois ciclos diferentes.

### Componentes já instalados

O monitor executa `atualizador_mix.ps1` a cada ciclo. O atualizador consulta:

```text
https://appmix-retaguarda-importer.vercel.app/integrador-updates/version.json
```

Ele pode atualizar:

- `desktop-integrador.exe`;
- `Painel_Mix.bat`;
- `monitor_mix.ps1`;
- `run_silent.vbs`;
- `atualizador_mix.ps1`.

Cada download exige HTTPS no host autorizado, tamanho e SHA-256 compatíveis. Executáveis também
passam pela verificação de cabeçalho. A troca cria backups e restaura os arquivos se falhar. Mesmo
com a mesma versão, o atualizador pode reparar componente ausente ou alterado.

Esse ciclo não chama o pré-diagnóstico completo de conta da instalação inicial. Portanto, uma
máquina já instalada continua verificando componentes; erros ficam no log de atualização.

### Atualização do próprio instalador

Setups a partir da geração `1.1` consultam a seção `installer` do mesmo manifesto ao abrir. Se a
versão publicada for superior, baixam e validam o novo setup antes de abri-lo. Versões antigas que
não possuem esse recurso precisam receber manualmente um setup novo uma última vez.

Mudanças somente no código interno do setup exigem publicação de um novo
`Instalador-Mix-Fiscal.exe`. Atualizar apenas os cinco componentes não substitui automaticamente a
aplicação interna `.mix-installer` já copiada.

## Logs, antivírus e suporte

Os relatórios principais ficam em:

```text
<pasta>\logs\instalacao.log
<pasta>\logs\diagnostico.json
%ProgramData%\MixFiscal\Logs
<pasta>\atualizador_log.txt
<pasta>\painel_install_log.txt
```

O diagnóstico registra sistema, contas, sessão, permissões, versões, etapas e ocorrências
relacionadas encontradas no Microsoft Defender. Não registra credenciais e não desativa Defender,
antivírus, EDR, firewall, UAC ou políticas da TI.

O pacote atual ainda não possui assinatura digital própria. Mesmo sem Playwright/Node e mesmo que
uma verificação local não encontre ameaça, SmartScreen ou um antivírus corporativo pode bloquear o
EXE por reputação ou política. A solução correta para distribuição ampla é assinatura de código da
Mix Fiscal e, quando necessário, liberação pela TI do cliente.

## Arquivos-fonte centrais

| Arquivo | Responsabilidade |
| --- | --- |
| `Instalador-Mix-Fiscal.iss` | Setup Inno, elevação, destino, cópia e abertura da interface |
| `instalador_gui.py` | Janela PyQt6, senha, versões, botão e threads |
| `diagnostico_instalador.py` | Conta, perfil, WebView2, versões, atualização do setup, admin e logs |
| `automacao_primeiro_acesso.py` | Orquestra instalação, WebView2, CNPJ, Machine ID e monitor |
| `cdp_browser.py` | Cliente CDP/WebSocket para a interface WebView2 |
| `instalador_core.py` | CNPJ, JSON atômico, API e confirmação online |
| `Painel_Mix.bat` | Painel manual e criação da tarefa do monitor |
| `monitor_mix.ps1` | Mantém o processo ativo e chama o atualizador |
| `atualizador_mix.ps1` | Download, integridade, backup, troca e restauração |
| `run_silent.vbs` | Execução invisível do monitor |
| `GERAR_INSTALADOR.ps1` | PyInstaller `onedir`, Inno Setup e verificação do pacote |
| `PUBLICAR_ATUALIZACAO.ps1` | Versão, manifestos, binários públicos e setup final |
| `verificar_pacote.py` | Auditoria estrutural do pacote gerado |
| `test_instalador.py` | Testes isolados do instalador |

## Geração e publicação

O comando canônico, executado na raiz do repositório, é:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\integrador\PUBLICAR_ATUALIZACAO.ps1 `
  -Versao 1.1.3 `
  -Executavel "C:\caminho\desktop-integrador.exe"
```

O número acima é apenas exemplo: consulte os dois manifestos e sempre use uma versão maior que a
já publicada. Não copie executáveis nem edite manifestos manualmente.

Validação mínima:

```powershell
python -m py_compile integrador\instalador_core.py integrador\cdp_browser.py `
  integrador\diagnostico_instalador.py integrador\automacao_primeiro_acesso.py `
  integrador\instalador_gui.py

python -m unittest discover -s integrador -p test_instalador.py

Push-Location web
npm.cmd run build
Pop-Location
```

Antes de push em `main`, execute `git status --short -- web`, preserve alterações alheias e revise
os binários públicos. O push de `main` aciona o deploy do projeto Vercel com raiz `web`. Nunca rode
`vercel --prod` na raiz deste repositório.

## Restrições para uma nova conversa

Ao retomar este trabalho:

1. leia este arquivo, `PUBLICACAO.md` e `STATUS_IMPLEMENTACAO.md`;
2. execute `git branch --show-current` e `git status --short`;
3. compare `integrador/integrador_version.json`, o manifesto em
   `web/public/integrador-updates/version.json` e `origin/main`;
4. preserve `integrador/config`, bancos locais, logs, perfis, tokens e dados de clientes;
5. não execute o Integrador real, não autentique no portal e não altere CNPJ/Machine ID sem uma
   autorização pontual que identifique o ambiente e o cliente;
6. use apenas `PUBLICAR_ATUALIZACAO.ps1` para gerar uma publicação;
7. não misture a branch candidata com `main` sem revisar o site inteiro e os artefatos públicos.

## Limitações e validações pendentes

- A candidata `1.1.2` precisa de teste completo em uma máquina cliente limpa.
- Deve ser testada em uma máquina sem WebView2, confirmando download, assinatura, espera e segunda
  detecção.
- Windows Server 2016 requer teste específico; o requisito recomendado permanece Server 2019+.
- O pré-diagnóstico interno acontece depois da cópia inicial do Inno.
- A execução visível do WebView2 depende de uma sessão interativa conectada.
- O pacote continua sujeito à política do antivírus enquanto não receber assinatura digital.
- O código não contorna uma conta sem acesso ao AppData; ele detecta e explica o bloqueio antes de
  autenticar e configurar o cliente.
