# Status da automação do Integrador

Atualizado em 2026-09-10.

## Fluxo implementado

O instalador executa como administrador, copia o Integrador e o Painel Mix para a própria pasta
onde o instalador foi colocado, autentica no WebView2, reutiliza a identidade nativa existente,
configura CNPJ e Mix Fiscal, salva, instala as tarefas nativas, instala o monitor adicional e
confirma pela API que o ID exato está online para o App Mix.

A correção de idempotência removeu a limpeza automática do estado local. A ordem atual é:

1. ler o ID dos dois arquivos locais, quando existirem;
2. abrir o Integrador e chamar `LoadSavedMachineID`;
3. quando a tela inicial precisar gerar um ID, clicar uma vez e ler diretamente o valor de
   `machine-generated-id-input`, sem chamar o gerador novamente;
4. persistir imediatamente o valor retornado;
5. abrir Configurações pelo menu e confirmar o segundo login;
6. preencher CNPJ e Mix Fiscal, rolar ao final, salvar e instalar;
7. instalar e consultar a tarefa adicional do monitor;
8. validar `settings/details` e esperar o ID exato do robô ficar online.

Outros IDs do CNPJ são permitidos e preservados, porque uma identidade pode atender XML e
outra pode atender o robô. A idempotência evita trocar o ID local do robô em uma nova tentativa.

## Monitor

A tarefa adicional se chama `Mix Fiscal - Monitorar Integrador` e verifica o processo a cada
cinco minutos. `Painel_Mix.bat` permite instalar/reativar e parar o monitor. Para manutenção,
a opção 5 também desativa as tarefas nativas `BootStart`, `Startup` e `Watchdog`; a opção 2
reativa todas elas. Scripts e logs ficam junto do executável, e o monitor aceita o nome padrão
ou outro nome que contenha `integrador`. Se houver somente um EXE de aplicação na pasta,
ele também pode ter qualquer outro nome.

O Painel Mix usa quebras de linha reais, sem BOM, e solicita elevação administrativa ao ser aberto.
Há um teste que impede publicar novamente o BAT com sequências `\n` literais.

O monitor agora executa o atualizador antes de verificar o processo. A versão `1.0.3`
consulta o manifesto público do site, aceita somente downloads HTTPS do domínio configurado e
atualiza cinco componentes: Integrador, Painel Mix, monitor, lançador silencioso e o próprio
atualizador. Cada arquivo tem tamanho e SHA-256 validados; executáveis também têm o cabeçalho
verificado. A troca mantém backups e restaura os componentes caso uma etapa falhe. O Painel Mix
e o instalador exibem a versão instalada.

O instalador chama `Painel_Mix.bat --install-monitor`. O BAT fornecido pelo operador foi usado
como base e cadastra a tarefa por `wscript.exe`, mantendo o monitor invisível. O mesmo painel
instala, consulta e desinstala o monitor sem deixar tarefas antigas duplicadas.

## Branch v1.1 — diagnóstico e recuperação

A branch `integrador-v1.1-diagnostico` acrescenta verificação automática do WebView2, cópia
atômica com SHA-256, reparo de componentes mesmo sem mudança de versão, execução permanente do
Integrador como administrador e relatórios em `logs\instalacao.log` e `logs\diagnostico.json`.
A tela mostra as versões do setup, Integrador, Painel BAT e WebView2 e permite repetir a
verificação do ambiente. O banco permanece fora do setup e continua sendo enviado pelo site.

O manifesto gerado para versões a partir da `1.1.0` inclui o próprio instalador. Setups dessa
geração conseguem baixar, validar e abrir uma versão superior mantendo a pasta de destino
original. O diagnóstico registra ocorrências relacionadas encontradas no Microsoft Defender
e gera informações para a TI sem alterar ou desativar a proteção da máquina.

Após um antivírus bloquear a extração do pacote anterior, a geração foi trocada de PyInstaller
`onefile` para aplicação interna `onedir` embalada pelo Inno Setup. A automação deixou de usar
Playwright e passou a acessar diretamente o protocolo local do WebView2 por WebSocket. Com isso,
o `node.exe` de aproximadamente 92 MB foi removido e o setup caiu de cerca de 91 MB para 36 MB.

## Validações

- 21 testes locais passaram, incluindo diagnóstico, integridade e proteção contra retorno ao `onefile`;
- os cinco arquivos Python principais compilam com `py_compile`;
- o pacote contém `desktop-integrador.exe`, `Painel_Mix.bat`, `atualizador_mix.ps1`,
  `monitor_mix.ps1`, `run_silent.vbs`, `integrador_version.json` e o driver Playwright;
- o runtime interno possui 11 entradas CArchive e nenhum arquivo do Playwright/Node;
- a instalação silenciosa de validação terminou com código `0`, criou os 156 arquivos esperados
  e respeitou o destino solicitado;
- a verificação manual do pacote final pelo Microsoft Defender retornou zero detecções;
- o cliente CDP conectou a um Edge local isolado, localizou um campo e o preencheu corretamente;
- o manifesto do pacote solicita `requireAdministrator`;
- interface responsiva validada com rolagem vertical, sem corte horizontal e olho visível;
- artefato candidato v1.1.0: `entrega\Instalador-Mix-Fiscal.exe`, 36.426.042 bytes;
- SHA-256: `02EA3E3A0977A4C0E48AD1242FC67D1DE329C8A5976490404598D6F1CD95FCE2`;
- o pacote ainda não possui assinatura digital;
- a versão idempotente precisa de um teste completo em uma máquina cliente/VM limpa.

Os testes anteriores no computador de desenvolvimento comprovaram login, geração nativa,
salvamento, serviço Mix Fiscal, tarefas nativas, consulta da API e status online. Já existem
registros anteriores para o CNPJ usado naquele teste; esta versão permite essas identidades e
confirma somente o ID exato usado pela instalação atual.
