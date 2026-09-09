# Instalação automatizada do integrador

Análise estática de `desktop-integrador.exe` em 2026-09-08. O executável não foi iniciado e nenhuma chamada de rede, autenticação, alteração de cadastro ou instalação foi realizada.

## Evidências no executável

- Aplicativo Go/Wails com interface web e ponte `window.go.app.App`.
- Métodos internos: `GenerateMachineId`, `EnsureMachineIDForNewClient`, `LoadSavedMachineID`, `SearchMachineID`, `SaveMachineDetails`, `UpdateMachineConfig`, `GetLocalSettings` e `SaveLocalSettings`.
- Resolução de identidade: símbolos `resolveOrCreateMachineID`, `persistMachineID`, `lookupRegisteredMachine`; pacote interno com `NewRandom`, `HostID`, `LegacyFingerprint` e `LegacyFingerprintFrom`. Isso não determina sozinho o algoritmo nem a ordem de recuperação.
- Referência explícita ao arquivo `config/machine_id.json`. A base de resolução do caminho e o esquema completo ainda precisam ser confirmados.
- Arquivo encontrado em `%APPDATA%\mixfiscal-integrador\local_settings.json`, contendo objeto vazio nesta máquina.
- Perfil WebView2 encontrado em `%APPDATA%\desktop-integrador.exe\EBWebView`. Não é um modelo de configuração para distribuir.
- A interface salva configurações por POST em `https://api.mixfiscal.com.br/integrador/api/v1/settings`, incluindo `machine_id`, `cnpj_cpf`, `mixfiscal_service_name` e `metadata.tag_service`, além de campos de conexão e agendamento. Contrato, autenticação autorizada e campos obrigatórios não foram validados no servidor.
- A interface chama `SaveLocalSettings` após salvar, com `machine_id`, `push_schedule_time`, `pull_schedule_time` e `grpc_max_message_size_mb`.
- O botão de instalação chama `InstallWindowsService`; existem também `GetWindowsServiceStatus` e `StartWindowsService`. Há referências a `schtasks`, mas o mecanismo exato de instalação não foi confirmado.
- Existe argumento `--start-minimized`; não foi encontrado `--install` nesta busca. Não presumir uma CLI de instalação.
- `/machine-id` aparece como alternativa à ponte Wails; não comprova servidor HTTP disponível no executável distribuído.

## Fluxo pretendido do instalador

1. Solicitar elevação e escolher uma pasta fixa de instalação.
2. Pedir CNPJ e credenciais, sem senha embutida no pacote.
3. Detectar instalação existente e preservar sua identidade e configuração.
4. Para instalação nova, obter a identidade pelo mecanismo compatível com esta versão.
5. Cadastrar CNPJ e serviço usando autenticação autorizada e confirmar o retorno.
6. Persistir identidade, detalhes retornados e configurações locais no esquema nativo.
7. Instalar e iniciar pelo mecanismo nativo; verificar estado e identidade carregada.
8. Em caso de falha parcial, permitir retomada sem gerar outro cadastro.

Não distribuir Machine ID, dados de cliente, credenciais ou perfil WebView2 de uma instalação existente. Não substituir o executável original nem inventar o conteúdo dos arquivos de identidade.

## Pendências para implementar um instalador funcional

- Obter o esquema real de `machine_id.json` e dos detalhes gravados por `SaveMachineDetails`, preferencialmente pelo código-fonte ou por arquivos de uma instalação de teste autorizada, examinando os valores sensíveis apenas quando necessário.
- Confirmar algoritmo, validação do Host ID e recuperação de identidade já registrada.
- Confirmar o valor interno do serviço Mix Fiscal.
- Confirmar autenticação de usuário aceita para cadastro, sem reutilizar credenciais internas extraídas do binário.
- Confirmar instalação/inicialização nativas e comportamento do AppData quando a elevação usa outro usuário administrador.
- Testar primeira instalação e reexecução em ambiente e CNPJ explicitamente autorizados.

Este documento é um mapeamento; não é um instalador implementado ou validado.

## Inspeção da instalação indicada pelo usuário

Diretório examinado somente para leitura: `C:\mix fiscal\integracao`.

- O SHA-256 do executável coincide com o de `integrador/desktop-integrador.exe` do projeto.
- Existem `config`, `jobs.db`, `jobs.db-shm` e `jobs.db-wal`. Os bancos não foram abertos ou copiados.
- `config/machine_id.json` contém um objeto com uma única chave `machine_id`, de tipo string.
- O ID desta amostra tem 66 caracteres hexadecimais. Não presumir comprimento de 64 nem concluir que esse exemplo determina o algoritmo de geração.
- Existe `config/<machine_id>.json` cujo nome corresponde exatamente ao ID salvo. Seu conteúdo é apenas `{}`. Portanto, a amostra não revela o esquema de detalhes nem comprova cadastro ou configuração completos no servidor.
- Nenhum ID real ou credencial foi incorporado neste documento.

Formato estrutural confirmado (o texto abaixo é apenas um marcador, não um ID válido):

```json
{"machine_id": "<identidade específica desta instalação>"}
```

Na primeira instalação, o instalador deverá criar a pasta `config` e persistir uma identidade válida; a existência dos arquivos, isoladamente, não comprova funcionamento. O arquivo de detalhes deverá ser preenchido com a resposta válida esperada pelo integrador, e não distribuído vazio como se fosse configuração concluída. A criação de `jobs.db` e do perfil WebView2 deve ficar a cargo do aplicativo, sem transportar dados ou sessões de outra máquina.

A análise de strings também encontrou opções de tarefas agendadas (`ONLOGON`, `ONSTART`, `HIGHEST`, `/TN`, `/TR`, `/SC`). Isso reforça a necessidade de confirmar a implementação de `InstallWindowsService` antes de assumir um serviço Windows convencional ou criar uma tarefa equivalente.
