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
5. restringe a pasta `<integrador>\.mixfiscal-agent` a SYSTEM e Administradores;
6. instala `MixFiscalAgentService.exe` ao lado de `desktop-integrador.exe`;
7. configura o serviço automático com início atrasado e três tentativas de recuperação;
8. cria a tarefa interativa `Mix Fiscal - Abrir Integrador` para a conta validada pelo setup;
9. remove a tarefa antiga `Mix Fiscal - Monitorar Integrador`.

O serviço não possui interface, console ou WebView2. A revisão de diagnóstico consulta a API por
HTTPS a cada cinco segundos. A máquina não abre uma porta de entrada.

## Controle pelo painel

A página local `/painel/robos` mostra Agente, Integrador, sessão do Windows, versão e último
heartbeat. Os comandos são:

- `start`: grava estado desejado `running`, habilita as tarefas nativas e aciona o lançador;
- `pause`: grava `paused`, desabilita tarefas nativas e encerra somente a árvore do Integrador;
- `restart`: encerra a árvore do Integrador e aciona o lançador na sessão interativa.
- `update`: baixa uma versão superior compatível, atualiza agente e instalador, e confirma o
  heartbeat da nova versão. Instalações completas também atualizam os componentes do Integrador.

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

As rotas do painel e da API foram publicadas no site em 14/09/2026 pelo commit `5eb959f` da
`main`. A prévia usa diretamente
`https://appmix-retaguarda-importer.vercel.app/api/agents`, mas deve continuar restrita à máquina
de homologação até o fluxo completo ser aprovado.

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

## Revisão de diagnóstico e manutenção remota (local, sem publicação)

Esta revisão precisa das rotas web da mesma branch. A publicação anterior da API não implementa
`health`, `self-test`, `status`, identificação do cliente e atualização de protocolo 2. Gerar a
prévia não publica essas rotas. Se usada com a API anterior, a interface deve mostrar o controle
remoto como pendente, nunca aprovado.

### Identificação e atualização de estado

- O título mostra o nome do cliente; a retaguarda aparece abaixo. A máquina e a conta ficam nos
  detalhes. Os campos podem ser informados no instalador ou editados em **Identificar cliente**
  no painel. O vínculo continua sendo proprietário + CNPJ + Machine ID + máquina.
- A página consulta a cada cinco segundos, evita consultas sobrepostas, usa timeout e retoma a
  consulta quando a janela recebe foco. Uma falha preserva a última leitura com indicação de
  consulta indisponível.
- Até 90 segundos de heartbeat há contato recente; de 90 a 180 segundos o contato está atrasado;
  depois disso aparece **Sem contato recente**. Ausência de heartbeat não comprova máquina desligada.
- **Processo aberto** significa processo local observado, não conexão comprovada com a retaguarda.
  Consulta de processo bloqueada aparece como **Processo sem confirmação**. A sessão é consultada
  pela API WTS para a conta configurada, inclusive em Server/RDP sem `explorer.exe`.
- Início e reinício só são confirmados depois de observar o processo por três segundos. Resultado
  pendente de envio é persistido e reenviado sem repetir um reinício já confirmado localmente.

### Sete testes e relatório para a TI

1. Elevação de administrador.
2. Conta da sessão e conta elevada; diferença comprovada bloqueia para preservar o perfil.
3. Leitura, escrita, renomeação e remoção nas pastas necessárias; ida e volta de uma credencial
   aleatória com DPAPI, sem usar ou imprimir credenciais reais.
4. Criação de tarefa interativa elevada no Agendador.
5. Detecção do WebView2; consulta inconclusiva é aviso e o bootstrap trata o Runtime.
6. Execução do binário do agente em modo `probe` e consulta de ocorrências do Defender. Esse modo
   não instala serviço, não lê a configuração do agente e não contata a API.
7. HTTPS inicialmente; após a instalação, fila real de início/reinício, executada pelo serviço
   na conta SYSTEM e confirmada pela API de resultados.

Todos os testes independentes são coletados mesmo quando algum reprova. A interface distingue
aprovado, bloqueio confirmado e pendência. O relatório JSON contém os eventos, os sete resultados
e as orientações; o botão de relatório apresenta o texto para encaminhamento à TI.

O teste 7 usa um identificador aleatório idempotente e espera até 150 segundos. Comandos de teste
que ainda não foram entregues expiram; não devem reiniciar uma máquina horas depois. O endpoint
de status não retira comandos da fila. Falha de HTTPS, histórico do antivírus ou indisponibilidade
de consulta não são, isoladamente, reprovação da instalação. Se o Integrador já foi configurado e
o agente falhar, o resultado diferencia **Integrador configurado / controle pendente**. O estado
online da API Mix também pode ficar pendente sem impedir a instalação do agente.

O teste final realmente reinicia o Integrador selecionado. A interface informa isso antes da
instalação. Executá-lo em cliente continua exigindo autorização pontual para máquina/CNPJ.

### Instalar somente o agente

O Inno extrai os componentes oficiais em `.mix-installer/payload`, sem substituir o Integrador
antes da escolha. **Instalar somente Agente** pede o `desktop-integrador.exe` já existente,
repete o diagnóstico no destino, reutiliza o Machine ID e valida o CNPJ pela API. Não cria ID,
não faz login na interface, não salva configurações nem copia o payload sobre o Integrador.
Instala somente serviço/lançador e executa o mesmo teste remoto.

### Preparação opcional do Windows

**Preparar e testar novamente** prepara as pastas e a marca de execução elevada do Integrador.
A exceção do Defender exige marcar a opção explícita e se limita à pasta exclusiva mostrada na
tela. Raízes, pastas gerais do usuário e pastas do Windows são recusadas. Resultado recusado por
política corporativa é registrado como aviso para a TI. Não desativa antivírus/firewall, não
altera nível de segurança da Internet, não ignora TLS e não armazena senha do Windows.

### Atualização do agente e do instalador

- A publicação canônica passa a marcar `agent_protocol: 2` no manifesto. O painel oferece o
  comando somente a agentes que anunciam protocolo 2. Pré-agentes precisam receber a nova prévia
  localmente uma vez; nenhum servidor consegue adicionar esse recurso a um binário antigo sozinho.
- O helper fica em Program Files, consulta somente HTTPS no host autorizado, exige versão
  superior e confere tamanho, SHA-256 e cabeçalho PE. Redirecionamento para outro host é recusado.
- `/AGENTUPDATE=1 /VERYSILENT` extrai o setup em staging protegido sem WebView2/interface nem
  instalação de serviço interativo. O helper para o serviço, guarda backup, troca o binário,
  preserva a credencial/identidade e espera heartbeat da versão nova; em falha tenta restaurar e
  iniciar o agente anterior. Erros de recuperação ficam explícitos no resultado.
- Atualiza o setup original (inclusive se renomeado), uma cópia em Program Files, a interface,
  o bootstrap e o payload. Arquivo em uso ou bloqueado é informado como falha, sem anunciar
  atualização completa. O instalador aberto deve ser fechado antes de solicitar atualização.
- Em instalação completa, a lista existente de cinco componentes do Integrador é atualizada
  com backup, mantendo o estado pausado ou em execução. O agente é parado durante essa troca
  para não reabrir o executável antes da cópia terminar. Em modo somente agente, o Integrador
  existente permanece sob a política de atualização que já tinha.
- A fila reserva até 15 minutos para uma atualização em andamento. Não aceita comandos
  conflitantes enquanto outro está pendente. Solicitar atualização quando já está na versão
  publicada é uma conclusão sem troca de arquivos.

As alterações de banco ficam restritas às duas tabelas existentes do agente: campos de nome,
retaguarda, protocolo e observação do processo, mais a ação `update` na restrição da fila.
O ajuste idempotente é serializado por advisory lock e só será aplicado quando as rotas forem
publicadas e utilizadas. Nenhuma alteração de banco foi executada durante o desenvolvimento.

### Validação e homologação

Além dos comandos Go/Python/build acima:

```powershell
node --check .\integrador\go-installer\frontend\dist\app.js
node --test .\web\tests\agent-control.test.cjs
```

Os testes isolados cobrem autenticação da requisição, identificação limitada ao proprietário,
comandos pendentes, resultados idempotentes, diagnóstico que agrega falhas, consultas
inconclusivas, processo que encerra logo após abrir, hash/tamanho/host do download e restauração
de componentes quando um arquivo fica bloqueado. Não instalam o serviço na estação.

Antes de publicar, homologar na máquina e CNPJ autorizados: instalação completa e somente agente,
Windows Server/RDP, processo sem permissão de consulta, proxy diferente para SYSTEM, bloqueio do
executável, queda de rede durante confirmação e atualização, recuperação do agente e preservação
de Machine ID/configurações e do estado pausado. Testes locais não comprovam compatibilidade com
todos os antivírus e políticas corporativas.
