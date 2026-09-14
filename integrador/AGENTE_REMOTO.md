# Mix Agent remoto — branch de desenvolvimento

Esta implementação está isolada na branch `feature/mix-agent-remoto`. A versão estável `1.2.8`
permanece na `main`, e nenhum arquivo desta branch deve ser copiado para
`web/public/integrador-updates/` ou `web/public/downloads/` antes da homologação.

## Resultado esperado

O instalador mantém o fluxo já validado de login, CNPJ, Machine ID, serviço Mix Fiscal, salvar,
instalar e confirmar o estado online. Depois da confirmação, ele:

1. usa o bearer Mix somente para provar que o Machine ID pertence ao CNPJ;
2. registra a máquina na API `/api/agents/enroll`;
3. recebe um segredo exclusivo, mostrado apenas nessa resposta;
4. protege o segredo com DPAPI no escopo da máquina;
5. restringe a pasta `%ProgramData%\MixFiscal\Agent` a SYSTEM e Administradores;
6. instala `MixFiscalAgentService.exe` em `%ProgramFiles%\Mix Fiscal\Agent`;
7. configura o serviço automático com início atrasado e três tentativas de recuperação;
8. cria a tarefa interativa `Mix Fiscal - Abrir Integrador` para a conta validada pelo setup;
9. remove a tarefa antiga `Mix Fiscal - Monitorar Integrador`.

O serviço não possui interface, console ou WebView2. Ele consulta a API por HTTPS a cada vinte
segundos. A máquina não abre uma porta de entrada.

## Controle pelo painel

A página local `/painel/robos` mostra Agente, Integrador, sessão do Windows, versão e último
heartbeat. Os comandos são:

- `start`: grava estado desejado `running`, habilita as tarefas nativas e aciona o lançador;
- `pause`: grava `paused`, desabilita tarefas nativas e encerra somente a árvore do Integrador;
- `restart`: encerra a árvore do Integrador e aciona o lançador na sessão interativa.

Os comandos ficam auditados em `mix_agent_commands`. Se a máquina estiver offline, o estado
desejado permanece no banco e será aplicado quando o Agente voltar. Sem uma sessão do Windows, o
serviço continua online, mas informa que aguarda login para abrir o aplicativo gráfico.

## Tabelas e autenticação

`web/lib/agent-control.ts` cria, de forma idempotente, `mix_agents` e `mix_agent_commands`. O vínculo
automático exige simultaneamente:

- bearer Mix válido;
- consulta bem-sucedida a `settings/details/{machine_id}`;
- CNPJ e Machine ID exatos na resposta;
- login Mix ativo e associado a uma única conta no App Mix.

O site armazena somente SHA-256 do segredo do dispositivo. Heartbeats usam os cabeçalhos
`X-Mix-Agent-ID` e `X-Mix-Agent-Token`. A senha Mix não é enviada a essa API nem gravada pelo
Agente.

## Arquivos principais

| Caminho | Responsabilidade |
| --- | --- |
| `go-installer/cmd/agent` | entrada do serviço Windows |
| `go-installer/internal/agent` | DPAPI, serviço, processo, vínculo e cliente HTTPS |
| `go-installer/internal/installer/automation.go` | instala o Agente depois da validação online |
| `web/lib/agent-control.ts` | persistência, autenticação e fila de comandos |
| `web/app/api/agents` | endpoints do painel e do dispositivo |
| `web/app/painel/robos` | tela de controle dos robôs |

## Build sem substituir a versão estável

Na raiz do projeto:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\integrador\GERAR_PREVIA_AGENTE.ps1
```

O resultado fica em:

```text
integrador\entrega-agente\Instalador-Mix-Fiscal-Agente-Preview.exe
```

Essa prévia depende das rotas da mesma branch. Enquanto o site não for homologado e publicado, ela
não deve ser executada em cliente.

## Validação antes da homologação

```powershell
$go = '.\integrador\.tools\go1.26.4\go\bin\go.exe'
$env:GOCACHE = (Resolve-Path '.\integrador\.tools\gocache').Path
$env:GOMODCACHE = (Resolve-Path '.\integrador\.tools\gomodcache').Path
Push-Location .\integrador\go-installer
& $go test ./...
& $go vet ./...
Pop-Location

.\.venv\Scripts\python.exe -m unittest discover -s integrador -p test_instalador.py
Push-Location .\web
npm.cmd run build
Pop-Location
```

O teste final exige uma máquina Windows descartável e uma implantação de homologação da API. Não
instale o serviço na estação de desenvolvimento nem use CNPJ de cliente para esse teste.
