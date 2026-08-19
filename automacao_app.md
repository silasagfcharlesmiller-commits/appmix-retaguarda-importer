# Arquitetura e Funcionamento do Projeto App Mix

Este documento descreve a arquitetura técnica, o fluxo de dados e os componentes principais do projeto de automação App Mix.

## 1. Visão Geral da Arquitetura

O projeto foi desenhado com uma arquitetura modular e desacoplada, permitindo que a lógica de automação seja executada de duas formas distintas, reutilizando o mesmo núcleo de processamento.

Os principais componentes são:

- **Pontos de Entrada (Execução):**
  - `appmix.pyw`: Uma interface gráfica (GUI) construída com PyQt6 para uso interativo.
  - `worker_mix.py`: Um serviço de fundo (worker) que opera 24/7, processando jobs de uma fila de forma autônoma.

- **Núcleo de Automação (Core):**
  - `automacao_core.py`: Contém a classe `MixAutomation`, que encapsula toda a lógica de interação com o navegador (via Playwright). Este é o cérebro da automação, utilizado tanto pela GUI quanto pelo worker.
  - `automacao_tabela.py`: Módulo especializado no preenchimento das 8 tabelas (VIEWs e TMPs).
  - `automacao_compara_divergencia.py`: Módulo especializado na configuração dos 102 checkboxes de "Comparar Divergência".

- **Camada de Dados e Configuração:**
  - **PostgreSQL:** Banco de dados central que armazena os **Templates** e a fila de execução (`fila_execucao`).
  - `database.py`: Uma classe de serviço (`DatabaseService`) que abstrai toda a comunicação com o PostgreSQL, isolando o resto do código dos detalhes de conexão e SQL.
  - **Arquivos JSON de Mapeamento:** Externalizam os seletores da interface web, permitindo atualizações sem alterar o código Python.
  - `config_mix.json`: Armazena credenciais de acesso ao portal e ao banco de dados.

!Diagrama de Arquitetura <!-- Você pode gerar um diagrama e substituir o link -->

## 2. Fluxo de Execução

O sistema pode ser iniciado de duas maneiras, mas o fluxo de automação em si é o mesmo.

### 2.1. Fluxo via Worker (Modo Produção/Autônomo)

Este é o modo principal de operação, projetado para rodar em um servidor.

1.  **Início:** O script `worker_mix.py` é executado. Ele entra em um loop infinito, monitorando a tabela `fila_execucao` no PostgreSQL.
2.  **Gatilho:** Um usuário ou sistema externo insere um novo registro na tabela `fila_execucao` com um `cnpj` e um `template_id`, com o status `pendente`.
3.  **Captura do Job:** O worker detecta o job pendente, o seleciona e atualiza seu status para `processando` para evitar que outro worker o pegue.
4.  **Carregamento do Template:** O worker usa o `template_id` do job para carregar as regras completas (SQLs, configurações de divergência) do template correspondente no banco de dados, através do `database.py`.
5.  **Execução do Core:** O worker instancia a classe `MixAutomation` de `automacao_core.py`, passando o `cnpj` e os dados do template.
6.  **Automação:** A `MixAutomation` executa o passo a passo no navegador:
    - Login no portal Mix Fiscal.
    - Busca do cliente pelo CNPJ.
    - Extração de dados da página (UF, Regime Tributário).
    - Chamada do `automacao_tabela.py` para preencher as 8 tabelas.
    - Navegação para a aba "Configurações".
    - Chamada do `automacao_compara_divergencia.py` para marcar os checkboxes.
    - Salvamento final.
7.  **Finalização:** Após a conclusão, o worker atualiza o status do job na `fila_execucao` para `concluido` ou `erro` (registrando a mensagem de erro, se houver).
8.  **Repetição:** O worker volta ao passo 1, procurando pelo próximo job pendente.

### 2.2. Fluxo via Interface Gráfica (Modo Interativo)

1.  **Início:** O usuário executa `appmix.pyw`.
2.  **Configuração:** O usuário insere as credenciais, seleciona um template ativo (a lista é carregada do banco de dados) e carrega uma lista de CNPJs (importando de CSV ou colando).
3.  **Disparo:** Ao clicar em "Iniciar Automação", a interface cria uma thread separada (`AutomacaoWorker`) para não travar a tela.
4.  **Execução do Core:** A thread de automação instancia a `MixAutomation` e a executa em um loop para cada CNPJ da lista, seguindo o mesmo passo a passo de automação descrito no item 6 do fluxo do worker.
5.  **Feedback:** A `MixAutomation` envia sinais de volta para a interface para atualizar o log no console, a barra de progresso e o status de cada cliente na tabela.

## 3. Mapeamentos (Seletores da Interface Web)

Um dos pontos fortes da arquitetura é a separação entre a lógica de automação (o *quê* fazer) e os seletores da página (o *onde* clicar/preencher). Isso é feito através de dois arquivos JSON principais. Se o portal Mix Fiscal mudar seu layout, basta editar estes arquivos, sem a necessidade de alterar o código Python.

### `mapeamento_portal_mix.json`

Este arquivo contém os seletores para a primeira parte do fluxo:

- **Tela de Login:** Seletores para os campos de usuário, senha e botão de entrar.
- **Painel de Controle:** Seletores para o botão de filtro, campo de busca de CNPJ e o ícone de "detalhes" (olho).
- **Tabelas VIEW/TMP:** Mapeamento dos seletores para cada um dos 8 cards de tributos (PIS/COFINS, ICMS Saída, etc.) e os elementos internos de cada card (botão de sincronizar, campo de nome da tabela, área de texto do SQL, etc.).

### `mapeamento_configuracoes.json`

Este arquivo é dedicado exclusivamente à tela de "Configurações -> Comparar Divergência".

- **Estrutura Hierárquica:** Ele espelha a árvore de checkboxes da página, com grupos e subgrupos.
- **Mapeamento:** Cada entrada no JSON corresponde a um checkbox na tela, contendo seu seletor (ID, nome ou outro atributo) e a chave que o representa no template do banco de dados (ex: `"ignorar_ncm_nao_preenchido": true`).

Quando a função `configurar_divergencias` é executada, ela lê este arquivo JSON, percorre a árvore e, para cada item, verifica o valor correspondente (`true` ou `false`) no template carregado do banco de dados, marcando ou desmarcando o checkbox na página de acordo.

## 4. Templates no Banco de Dados

Os templates são o coração da automação, definindo as regras de negócio para cada cliente ou grupo de clientes. Eles são armazenados no PostgreSQL para permitir acesso centralizado e simultâneo.

Um template é composto por duas seções principais, armazenadas como JSONB no banco:

- **`tabelas`:** Contém um objeto para cada um dos 4 tipos de tributo. Cada objeto, por sua vez, contém os SQLs para as tabelas VIEW e TMP, nomes das tabelas e flags de configuração.
- **`comparar_divergencia`:** Um objeto simples com pares chave-valor, onde cada chave corresponde a um checkbox da tela de configurações e o valor é `true` ou `false`.

### Variáveis Dinâmicas

Os textos dentro dos templates (principalmente nos SQLs) podem conter variáveis que são substituídas em tempo de execução:

- `{cnpj}`: O CNPJ do cliente em processamento.
- `{estado}`: A UF do cliente, extraída da página do portal.
- `{lucro_real}` ou `{regime_tributario}`: O regime tributário do cliente, também extraído da página.

Isso permite que um único template sirva para múltiplos clientes de diferentes estados e regimes, tornando a manutenção muito mais simples.

## criar executavel.
abrir na pasta do projeto:
.\.venv\Scripts\python.exe -m pip install pyinstaller


gerar executável:
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --windowed --name "APP-MIX" --collect-all playwright --add-data "mapeamento_portal_mix.json;." --add-data "mapeamento_configuracoes.json;." .\appmix.pyw