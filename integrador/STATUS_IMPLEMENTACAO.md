# Status da automação do Integrador

Atualizado em 2026-09-10 na branch `integrador-v1.2-go-wails`.

## Candidata atual

- versão: `1.2.1`;
- interface: Go 1.26 + Wails 2 + HTML/CSS/JavaScript;
- pacote: Inno Setup elevado;
- runtime cliente: dois executáveis Go e um manifesto;
- automação: CDP/WebSocket direto, sem Playwright;
- destino: a mesma pasta em que o setup foi colocado;
- publicação: ainda depende de revisão/merge/push em `main`.

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
- reaproveitamento idempotente do Machine ID existente;
- geração única pela interface oficial quando nenhum ID existe;
- preenchimento de CNPJ, serviço `mixfiscal`, Salvar e Instalar/Iniciar;
- monitor instalado por `Painel_Mix.bat --install-monitor` e tarefa consultada;
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
- candidata `1.2.1` gerada pelo publicador canônico: 13.835.850 bytes;
- SHA-256 do setup candidato: `7962C50F19DEF140988C1FD0241DF1493BB287F82DE01E0C632E1C43316F3985`.

## Antes de produção

1. gerar `1.2.1` somente pelo comando de [`PUBLICACAO.md`](PUBLICACAO.md);
2. executar o teste completo autorizado em máquina cliente/VM;
3. validar Windows 10/11 e Server 2016/2019/2022;
4. testar uma máquina com WebView2 e outra sem;
5. testar RDP com a mesma conta elevada e com conta diferente;
6. revisar `git status --short -- web`, build do Next.js e artefatos públicos;
7. mesclar em `main` e publicar pela Vercel somente após aprovação.

O teste local não executou o Integrador real, não autenticou no portal e não alterou nenhum CNPJ ou
Machine ID. Essas ações exigem autorização pontual para o ambiente e cliente exatos.
