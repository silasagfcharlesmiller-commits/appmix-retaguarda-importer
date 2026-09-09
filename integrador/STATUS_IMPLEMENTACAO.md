# Status da automação do Integrador

Atualizado em 2026-09-09.

## Fluxo implementado

O instalador executa como administrador, copia o Integrador e o Painel Mix para
`C:\mix fiscal\integracao`, autentica no WebView2, reutiliza a identidade nativa existente,
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

O monitor agora executa o atualizador antes de verificar o processo. A versão `1.0.0`
consulta o manifesto público do site, aceita somente download HTTPS do domínio configurado,
valida tamanho, SHA-256 e cabeçalho PE, mantém um backup e restaura o executável caso a
substituição falhe. O manifesto e os downloads ficam em `web/public` e seguem no mesmo deploy
do painel.

## Validações

- 12 testes locais passaram;
- os três arquivos Python compilam com `py_compile`;
- o pacote contém `desktop-integrador.exe`, `Painel_Mix.bat`, `atualizador_mix.ps1`,
  `integrador_version.json` e o driver Playwright;
- o manifesto do pacote solicita `requireAdministrator`;
- interface responsiva validada com rolagem vertical, sem corte horizontal e olho visível;
- artefato: `entrega\Instalador-Mix-Fiscal.exe`, 91.329.128 bytes;
- SHA-256: `1E29F2924E3B2F553FB801DFB1F0292936B36003F4844517011184D212F04BC9`;
- o pacote ainda não possui assinatura digital;
- a versão idempotente precisa de um teste completo em uma máquina cliente/VM limpa.

Os testes anteriores no computador de desenvolvimento comprovaram login, geração nativa,
salvamento, serviço Mix Fiscal, tarefas nativas, consulta da API e status online. Já existem
registros anteriores para o CNPJ usado naquele teste; esta versão permite essas identidades e
confirma somente o ID exato usado pela instalação atual.
