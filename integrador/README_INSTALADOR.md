# Instalador automatizado do Integrador

O arquivo pronto para levar ao cliente fica em `entrega\Instalador-Mix-Fiscal.exe`.
Ao clicar em **Instalar**, ele solicita permissão de administrador e executa o fluxo completo:

1. copia o Integrador para a mesma pasta onde o instalador foi colocado;
2. abre o WebView2 e faz login com os dados informados;
3. aproveita o Machine ID que o próprio Integrador já criou;
4. grava esse ID imediatamente para que uma nova tentativa use a mesma identidade;
5. preserva outros IDs do mesmo CNPJ, pois XML e robô podem usar identidades diferentes;
6. abre **Configurações** pelo menu e confirma novamente o login;
7. preenche o CNPJ, adiciona o serviço `mixfiscal` somente se ele ainda não estiver selecionado, rola até o final e salva;
8. clica em **Instalar** na tela do Integrador e ativa a inicialização nativa;
9. chama `Painel_Mix.bat --install-monitor`, instala a tarefa invisível por VBS e a consulta;
10. consulta a mesma listagem da API usada pelo App Mix até confirmar o ID online;
11. remove a depuração temporária e deixa o Integrador aberto.

Na geração `1.1`, o setup também confirma o WebView2 antes de abrir o Integrador, valida cada
componente por SHA-256 e marca `desktop-integrador.exe` para sempre executar como administrador.
Os dados de banco continuam sendo enviados e gerenciados pelo site; o setup configura CNPJ,
arquivos locais, serviço Mix Fiscal e Machine ID.

O instalador nunca limpa os arquivos de identidade. Se `config\machine_id.json` e
`%APPDATA%\mixfiscal-integrador\local_settings.json` tiverem IDs diferentes, ele para e
preserva os dois para revisão. A tela segue o visual do App Mix, ajusta-se à área útil do
Windows, oferece rolagem em escala ampliada, formata o CNPJ e possui um botão de olho para
mostrar ou ocultar a senha. A senha digitada não é salva.

A idempotência é por máquina: uma nova tentativa reutiliza o mesmo ID local do robô. A
existência de um ID diferente para XML ou para outra instalação do CNPJ não bloqueia o fluxo.

## Monitor e manutenção

Antes de executar, crie a pasta desejada, por exemplo `C:\Mix Fiscal\integrador`, e coloque o
`Instalador-Mix-Fiscal.exe` dentro dela. O instalador copia `Painel_Mix.bat` e os demais
componentes para essa mesma pasta. Abra esse painel quando
precisar fazer manutenção; ele solicita automaticamente a permissão de administrador:

- **2 - Instalar / Ativar monitoramento**: instala ou reativa o monitor invisível e as tarefas nativas;
- **5 - Desinstalar / Desativar monitoramento**: remove a tarefa do monitor e desativa `BootStart`, `Startup` e
  `Watchdog` do Integrador;
- **4 - Parar Integrador**: encerra o processo depois que o monitoramento foi parado.

Terminada a manutenção, use novamente a opção 2 e depois a opção 3 para iniciar.
O painel, o script PowerShell e o log ficam junto do executável. O monitor detecta primeiro
`desktop-integrador.exe`, aceita um arquivo renomeado que contenha `integrador` no nome e,
quando houver somente um EXE de aplicação na pasta, aceita qualquer outro nome.

## Atualização automática

O instalador também copia `atualizador_mix.ps1` e `integrador_version.json` para a pasta do
Integrador. A cada execução de cinco minutos, o monitor consulta o manifesto público do App
Mix. Quando encontra uma versão superior, ele:

1. baixa os componentes alterados por HTTPS;
2. confere o tamanho e o SHA-256 de cada arquivo, além do cabeçalho dos executáveis;
3. encerra somente o processo que corresponde ao executável daquela pasta;
4. cria backups, substitui os arquivos e grava a versão local;
5. abre o Integrador novamente; se a troca falhar, restaura o backup.

Desde a versão `1.0.1`, o ciclo cobre `desktop-integrador.exe`, `Painel_Mix.bat`,
`monitor_mix.ps1`, `run_silent.vbs` e o próprio `atualizador_mix.ps1`. O Painel Mix e a janela
do instalador mostram a versão instalada.

A tela da geração `1.1` mostra as versões do setup, Integrador, Painel BAT e WebView2, além do
estado do monitor e da execução administrativa. O botão **Verificar ambiente e atualizações**
repete a consulta. Quando o WebView2 está ausente, o setup baixa o bootstrapper oficial da
Microsoft, confirma a assinatura digital, instala silenciosamente, aguarda e verifica novamente.

Os componentes são copiados de forma atômica e conferidos por SHA-256. O atualizador também
verifica os arquivos quando a versão remota é igual à local, permitindo reparar um componente
ausente ou alterado. Os relatórios ficam em `logs\instalacao.log` e `logs\diagnostico.json`, com
cópia de emergência em `%ProgramData%\MixFiscal\Logs`. Se a proteção remover novamente o mesmo
arquivo, o setup informa o diagnóstico para a TI; ele não desativa antivírus, EDR ou políticas.

O pacote `1.1` usa Inno Setup e instala a aplicação auxiliar em `.mix-installer`. Essa aplicação
fica em formato de pasta e não precisa descompactar Python a cada abertura. A automação conversa
diretamente com o protocolo local do WebView2 por WebSocket; Playwright e o `node.exe` de cerca
de 92 MB não fazem mais parte do instalador. O build falha se detectar novamente qualquer um
desses componentes.

O log fica em `atualizador_log.txt`, ao lado do Integrador. A opção **5 - Desinstalar / Desativar
monitoramento** do Painel Mix também interrompe as verificações de atualização durante uma
manutenção. As máquinas que já receberam uma versão antiga do instalador precisam executar
o novo pacote uma vez; a partir daí, as versões seguintes são automáticas.

Para preparar uma nova versão do Integrador e do instalador:

```powershell
powershell -ExecutionPolicy Bypass -File integrador\PUBLICAR_ATUALIZACAO.ps1 `
  -Versao 1.0.1 `
  -Executavel C:\caminho\desktop-integrador.exe
```

O roteiro completo de versão, validação, commit, deploy da Vercel e teste remoto está em
[`PUBLICACAO.md`](PUBLICACAO.md). Consulte esse arquivo antes de qualquer atualização.

O comando cria `web/public/integrador-updates/version.json`, copia o executável que será
baixado e publica o instalador completo em `web/public/downloads/Instalador-Mix-Fiscal.exe`.
Revise e envie esses arquivos no mesmo commit. Nunca reutilize um número de versão.

## Arquivos do projeto

- `instalador_gui.py`: tela com CNPJ, usuário e senha;
- `automacao_primeiro_acesso.py`: automação WebView2/Wails, identidade e monitor;
- `instalador_core.py`: validação, API e escrita JSON segura;
- `cdp_browser.py`: comunicação direta com a porta local do WebView2, sem Playwright;
- `diagnostico_instalador.py`: versões, WebView2, permissões, integridade e relatório para a TI;
- `Painel_Mix.bat`: controle manual do monitor;
- `atualizador_mix.ps1`: atualização validada e restauração em caso de falha;
- `PUBLICAR_ATUALIZACAO.ps1`: gera manifesto, binário público e instalador;
- `verificar_pacote.py`: descompacta e valida integralmente o pacote antes da publicação;
- `test_instalador.py`: testes locais sem alterar a API;
- `GERAR_INSTALADOR.ps1`: recompila o EXE com UAC.
- `Instalador-Mix-Fiscal.iss`: definição do pacote convencional do Inno Setup.

## Validação e compilação

```powershell
python -m py_compile integrador\instalador_core.py integrador\cdp_browser.py integrador\diagnostico_instalador.py integrador\automacao_primeiro_acesso.py integrador\instalador_gui.py
python -m unittest discover -s integrador -p test_instalador.py
powershell -ExecutionPolicy Bypass -File integrador\GERAR_INSTALADOR.ps1
```

Antes da distribuição ampla, execute o pacote em uma máquina Windows limpa com o WebView2
Runtime instalado e em outra sem o Runtime, validando a instalação oficial automática. Um
certificado de assinatura de código da Mix Fiscal continua recomendado para reduzir alertas de
reputação em antivírus corporativos e no SmartScreen.
