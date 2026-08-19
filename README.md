# App Mix — automação do portal Mix Fiscal

## Objetivo

O App Mix automatiza, para cada CNPJ, duas etapas do portal Mix Fiscal:

1. preenchimento das quatro tabelas VIEW e quatro tabelas TMP;
2. preenchimento dos 102 checkboxes da tela Configuração → Comparar Divergência.

Os valores vêm de templates centralizados no PostgreSQL. A aplicação possui uma interface PyQt6 para cadastrar/testar templates e um worker headless que consome jobs de uma fila no banco.

## Como o sistema funciona

```text
DBeaver insere job em public.fila_execucao
                    ↓
worker_mix.py encontra status = pendente
                    ↓
automacao_core.py abre o cliente no portal
                    ↓
automacao_tabela.py aplica VIEW/TMP
                    ↓
automacao_compara_divergencia.py aplica Configuração
                    ↓
worker atualiza o job para concluido ou erro
```

`automacao_core.py` não é um programa de entrada e não deve ser executado diretamente. Ele é chamado pela interface e pelo worker.

## Modos de execução

### Interface PyQt6

Usada para:

- criar e editar templates;
- configurar tabelas VIEW/TMP;
- configurar os checkboxes de Comparar Divergência;
- testar a automação visualmente com uma lista de CNPJs;
- salvar os templates no PostgreSQL.

Entrada: `appmix.pyw` → `automacao_login.AutomacaoWorker` → `automacao_core.MixAutomation`.

### Worker PostgreSQL

Usado para operação contínua. Ele consulta `public.fila_execucao` a cada cinco segundos, reserva um job pendente e executa o template indicado por `template_id`.

Entrada: `worker_mix.py` → `automacao_core.MixAutomation`.

O worker abre em headless por padrão.

## Instalação em máquina nova

Requisitos:

- Windows 10 ou superior;
- Python 3.11 ou superior;
- internet na primeira instalação;
- acesso ao PostgreSQL;
- acesso ao portal Mix Fiscal.

Copie a pasta preparada para a máquina nova e execute:

```bat
INSTALAR_LIMPO.bat
```

Digite `INSTALAR` quando solicitado. O instalador remove somente dados gerados dentro da própria pasta, cria `.venv`, instala `requirements.txt`, baixa o Chromium e abre a interface.

Alternativa sem limpeza:

```powershell
powershell -ExecutionPolicy Bypass -File .\primeira_execucao.ps1 -Modo interface
```

Primeiro login:

1. abra a interface;
2. use o navegador visível;
3. autentique a conta destinada àquela máquina;
4. encerre a interface;
5. inicie o worker.

Não copie `playwright-profile` para uma conta diferente. O perfil guarda cookies e a sessão do usuário anterior.

## Comandos de execução

Interface:

```powershell
.\.venv\Scripts\python.exe .\appmix.pyw
```

Worker headless:

```powershell
.\.venv\Scripts\python.exe .\worker_mix.py
```

Worker com navegador visível para diagnóstico:

```powershell
$env:WORKER_HEADLESS = "false"
.\.venv\Scripts\python.exe .\worker_mix.py
```

Voltar ao padrão headless:

```powershell
Remove-Item Env:WORKER_HEADLESS -ErrorAction SilentlyContinue
```

Pare o worker com `Ctrl + C`.

## Operação da fila

Atualmente, o job do worker é criado manualmente pelo DBeaver. O DBeaver apenas grava a linha no PostgreSQL; quem executa a automação é o `worker_mix.py` aberto no terminal.

Consultar templates:

```sql
SELECT id, nome, atualizado_em
FROM public.templates
ORDER BY nome;
```

Adicionar o CNPJ ao template VR sem precisar decorar o ID:

```sql
INSERT INTO public.fila_execucao (cnpj, template_id)
SELECT '52703958000142', id
FROM public.templates
WHERE LOWER(nome) = LOWER('VR');
```

Se o DBeaver estiver com auto-commit desligado, clique em **Commit** após o INSERT. O worker somente verá o job depois do commit.

Consultar os jobs:

```sql
SELECT
    fila.id AS job_id,
    fila.cnpj,
    fila.status,
    fila.tentativas,
    fila.mensagem_erro,
    template.id AS template_id,
    template.nome AS template_nome
FROM public.fila_execucao AS fila
JOIN public.templates AS template ON template.id = fila.template_id
ORDER BY fila.id DESC;
```

Consulte `MANUAL_EMANUEL.md` para o procedimento operacional completo.

## Fluxo no portal

Para cada cliente:

1. abre `/painel-controle`;
2. filtra pelo CNPJ recebido no job;
3. abre os detalhes pelo ícone com `title="Detalhes"`;
4. extrai CNPJ, UF, regime tributário e nome da empresa do HTML;
5. substitui as variáveis do template;
6. preenche os quatro pares VIEW/TMP;
7. inicia a TMP enquanto a VIEW correspondente está salvando;
8. se um card falhar no pipeline, repete somente esse card em modo sequencial;
9. confirma `8/8` tabelas;
10. acessa a aba Configuração;
11. se o portal fechou o detalhe, reabre pelo olho sem repetir as tabelas;
12. clica em Editar;
13. aplica os 102 checkboxes do template;
14. salva e conclui o cliente.

Uma falha na etapa Configuração não reinicia as tabelas já gravadas.

## Estrutura dos templates

Cada template possui duas seções no PostgreSQL:

```json
{
  "tabelas": {
    "pis_cofins": {},
    "icms_saida": {},
    "icms_entrada": {},
    "ibs_cbs": {}
  },
  "comparar_divergencia": {}
}
```

Campos de tabela principais:

- `view_nome`, `view_sql`;
- `tmp_nome`, `tmp_delete`;
- `flag1`, `flag2`, `flag3`;
- `tmp_insert`, `tmp_values`, `tmp_selectwhere`.

Variáveis substituídas por cliente:

- `{cnpj}`: CNPJ somente com números;
- `{estado}`: UF em minúsculas, como `sp`;
- `{lucro_real}` e `{regime_tributario}`: regime normalizado extraído do portal;
- `{nome_empresa}`: nome da empresa em minúsculas, sem acentos e com palavras separadas por `_`.

Exemplo:

```text
Empresa da Empresa Variável → empresa_da_empresa_variavel
```

O nome é extraído prioritariamente da célula `#cell-3-undefined` da listagem filtrada. Como fallback, são procurados os campos `Nome Empresa`, `Razão Social` e `Nome Fantasia`. O botão **Inserir Nome Empresa** da interface adiciona `{nome_empresa}` ao campo de template selecionado.

## Mapeamentos

`mapeamento_portal_mix.json` contém os textos, seletores e regras das oito tabelas.

`mapeamento_configuracoes.json` contém a hierarquia seção → grupo → campo dos 102 checkboxes. A hierarquia é necessária porque existem rótulos repetidos, como `CST`, `ALQ` e `RBC`.

Classes CSS geradas como `sc-*` não devem ser usadas como seletor principal. Prefira texto, papel semântico, associação label/input e estrutura estável.

## Perfil, navegador e cache

- `playwright-browsers/`: Chromium local;
- `playwright-profile/`: cookies, login e cache da conta;
- `cache_modais.json`: registro local de comunicados encontrados;
- `erros_automacao/`: screenshots de falha;
- `worker_mix.log`: log do worker.

Interface e worker não podem usar o mesmo `playwright-profile` simultaneamente. Feche um antes de abrir o outro.

`cache_modais.json` pode ser levado para outra máquina. `playwright-profile` não deve ser levado para outro usuário/login.

## Banco de dados

`database.py` usa PostgreSQL e lê a conexão de `config_mix.json`.

Tabelas utilizadas:

- `public.templates`: nome e ID do template;
- `public.template_secoes`: JSON de cada seção do template;
- `public.fila_execucao`: jobs processados pelo worker.

Transições do job:

```text
pendente → processando → concluido
                     ↘ erro
```

O worker usa `FOR UPDATE SKIP LOCKED`, permitindo reserva segura do próximo job quando houver mais de um consumidor.

Jobs em `processando` há mais de 30 minutos são devolvidos para `pendente` na inicialização do worker.

## Arquivos principais

- `appmix.pyw`: interface e edição dos templates;
- `worker_mix.py`: consumidor 24/7 da fila;
- `automacao_core.py`: navegação compartilhada e orquestração;
- `automacao_login.py`: thread da interface;
- `automacao_tabela.py`: pipeline VIEW/TMP;
- `automacao_compara_divergencia.py`: automação dos checkboxes;
- `comparar_divergencia_widget.py`: editor dos 102 campos no PyQt6;
- `database.py`: acesso ao PostgreSQL;
- `mapeamento_portal_mix.json`: mapa das tabelas;
- `mapeamento_configuracoes.json`: mapa da Configuração;
- `primeira_execucao.ps1`: bootstrap idempotente;
- `INSTALAR_LIMPO.bat`: reinstalação limpa;
- `preparar_pasta_teste.ps1`: criação do pacote de distribuição;
- `MANUAL_INSTALACAO.md`: instalação detalhada;
- `MANUAL_EMANUEL.md`: operação diária.

## Preparar pacote de distribuição

Na pasta de desenvolvimento:

```powershell
powershell -ExecutionPolicy Bypass -File .\preparar_pasta_teste.ps1 -Destino pacote_novo
```

O pacote não deve incluir `.venv`, `playwright-browsers` nem `playwright-profile`. O arquivo `config_mix.json` é incluído e contém credenciais; proteja o pacote.

## Gerar o executável do APP MIX

Execute na raiz do projeto:

```powershell
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --windowed --name "APP-MIX" --collect-all playwright --add-data "mapeamento_portal_mix.json;." --add-data "mapeamento_configuracoes.json;." .\appmix.pyw
```

O executável será criado em `dist\APP-MIX.exe`. Coloque o `config_mix.json` ao lado dele antes de abrir. O arquivo fica externo ao executável para que as configurações possam ser salvas normalmente.

## Verificações técnicas

Compilar os módulos sem executar a automação:

```powershell
.\.venv\Scripts\python.exe -m py_compile .\appmix.pyw .\worker_mix.py .\automacao_core.py .\automacao_login.py .\automacao_tabela.py .\automacao_compara_divergencia.py .\comparar_divergencia_widget.py .\database.py
```

Verificar o instalador sem apagar nada:

```bat
INSTALAR_LIMPO.bat --verificar
```

## Orientações para outra IA

Antes de alterar o projeto:

1. leia este README e os dois JSONs de mapeamento;
2. confirme que interface e worker chamam o mesmo `MixAutomation`;
3. preserve `playwright-profile` e `config_mix.json`;
4. não use seletores baseados apenas em classes dinâmicas;
5. não transforme atraso ao recolher um card em falha de salvamento;
6. não repita as oito tabelas quando a etapa Configuração falhar;
7. mantenha o worker headless por padrão e a opção visível por variável de ambiente;
8. valide Python, JSON e PowerShell depois das mudanças;
9. não execute SQL de produção nem uma automação real sem autorização explícita.

Pontos sensíveis conhecidos:

- o portal permite uma VIEW e uma TMP abertas simultaneamente;
- `Nome da tabela` e `Nome da tabela TMP` exigem correspondência exata;
- o portal pode fechar o modal de detalhes ao salvar a última TMP;
- o limpador de comunicados não deve ser chamado sobre o modal de detalhes;
- checkboxes com o mesmo rótulo precisam ser diferenciados pela seção e pelo grupo.

## Segurança

Não publique:

- `config_mix.json`;
- `playwright-profile/`;
- logs e screenshots com dados de clientes;
- arquivos CSV de CNPJ.

Itens recomendados no `.gitignore`:

```text
config_mix.json
.venv/
.venv-1/
__pycache__/
playwright-browsers/
playwright-profile/
erros_automacao/
*.log
```
## Para gerar exe.

.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --windowed --name "APP-MIX" --collect-all playwright --add-data "mapeamento_portal_mix.json;." --add-data "mapeamento_configuracoes.json;." .\appmix.pyw
