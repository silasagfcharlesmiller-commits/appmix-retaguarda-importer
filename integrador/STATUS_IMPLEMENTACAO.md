# Status da automação do Integrador

Atualizado em 2026-09-11 na branch `main`.

## Candidata atual

- versão: `1.2.7`;
- interface: Go 1.26 + Wails 2 + HTML/CSS/JavaScript;
- pacote: Inno Setup elevado;
- runtime cliente: dois executáveis Go e um manifesto;
- automação: CDP/WebSocket direto, sem Playwright;
- destino: a mesma pasta em que o setup foi colocado;
- publicação: download e atualização automática pelo site após o push em `main`.

## Implementado

- bootstrap Go detecta, baixa, valida e instala WebView2 antes da interface;
- tela responsiva com CNPJ, login, senha com olho, diagnóstico e versões;
- atualização do próprio instalador ao abrir;
- diagnóstico da conta interativa/elevada, AppData, TEMP e Agendador;
- detecção do serviço `Schedule` pelo estado `RUNNING` retornado pelo Windows, corrigindo o falso
  bloqueio observado na `1.2.0`;
- validação de payload por tamanho e SHA-256;
- `desktop-integrador.exe` marcado como `RUNASADMIN`;
- login inicial e segundo login em Configurações quando a tela pedir;
- espera explícita da ponte Wails e repetição das consultas idempotentes, evitando que o atraso do
  WebView2 seja mostrado como erro JavaScript após uma instalação parcial;
- reaproveitamento idempotente do Machine ID existente;
- geração única pela interface oficial quando nenhum ID existe;
- preenchimento de CNPJ, serviço `mixfiscal`, Salvar e Instalar/Iniciar;
- reaproveitamento da janela já aberta, identificada diretamente pela porta WebView2 mesmo quando
  o servidor bloqueia consultas CIM; nova abertura somente como contingência;
- login final, entrada em **Configurações**, segundo login quando solicitado e manutenção dessa
  tela aberta para conferência;
- espera da tela real de login antes de preencher as credenciais e restauração da janela do
  Integrador quando ela estiver minimizada ou oculta na bandeja;
- monitor instalado por `Painel_Mix.bat --install-monitor` e tarefa consultada;
- opção 5 do Painel Mix exclui suas tarefas agendadas, remove o VBS, desativa as tarefas nativas
  e valida a limpeza sem impedir uma reinstalação pela opção 2;
- confirmação de CNPJ, serviço e Machine ID exato na API e espera pelo status online;
- logs sem credenciais e indicação de ocorrências relacionadas do Microsoft Defender;
- atualização dos cinco componentes já instalados pelo monitor.

## Validações locais concluídas

- `go test ./...` passou;
- `go vet ./...` passou;
- JavaScript passou em `node --check`;
- 27 testes Python de regressão passaram;
- os dois executáveis Windows nativos foram compilados;
- Inno Setup 6.7.3 gerou o pacote completo;
- o verificador confirmou dois binários nativos e ausência de Python/PyQt/Playwright/Node;
- a prévia do frontend foi renderizada em Edge/WebView e não apresentou cortes em 1100 × 850;
- candidata `1.2.7` gerada pelo publicador canônico: 13.838.153 bytes;
- SHA-256 do setup candidato: `0AC479EDA92065F080FF77D6348CC92E3C033DAE8314ED00C0910A999813A362`;
- Microsoft Defender não encontrou ameaças no setup candidato;

## Antes de produção

1. executar o teste completo autorizado em máquina cliente/VM;
2. validar Windows 10/11 e Server 2016/2019/2022;
3. testar uma máquina com WebView2 e outra sem;
4. testar RDP com a mesma conta elevada e com conta diferente;
5. revisar `git status --short -- web`, build do Next.js e artefatos públicos;
6. mesclar em `main` e publicar pela Vercel somente após aprovação.

O teste local não executou o Integrador real, não autenticou no portal e não alterou nenhum CNPJ ou
Machine ID. Essas ações exigem autorização pontual para o ambiente e cliente exatos.
