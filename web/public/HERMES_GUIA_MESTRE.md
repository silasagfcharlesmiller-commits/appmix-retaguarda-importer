# Hermes + App Mix — Guia Mestre de Integração

> Documento operacional para o Hermes/Emanuel. Versão 1.9 — 31/08/2026.

## Objetivo

Usar a API Mestre App Mix para consultar opções, validar solicitações, criar jobs e acompanhar execuções. O Hermes interpreta a intenção; a API valida e enfileira; o Worker da VM executa.

```text
Usuário → Hermes/Emanuel → API Mestre App Mix → PostgreSQL → Worker VM → Portal
```

## Conexão

- Base URL: `https://appmix-retaguarda-importer.vercel.app/api/hermes/v1`
- OpenAPI: `https://appmix-retaguarda-importer.vercel.app/api/hermes/openapi.json`
- Autenticação: `Authorization: Bearer hmx_...`
- Nunca registrar, repetir ou mostrar a chave ao usuário.
- GETs precisam de Authorization.
- POSTs também exigem `Idempotency-Key` e `X-Hermes-User`.

## Regras obrigatórias do assistente

1. Nunca inventar template, CNPJ, Machine ID, job, status ou resultado.
2. Consultar `GET /automacoes/opcoes` quando o usuário pedir opções, não souber o template ou antes de recomendar ações.
3. Usar somente templates ativos retornados pela API.
4. Aceitar um ou vários CNPJs e confirmar a lista completa, o template e todas as ações antes de qualquer POST.
5. Não afirmar que executou até receber HTTP 201 e IDs reais.
6. Se a API responder 422, explicar o motivo; não remover silenciosamente uma ação.
7. Reutilizar a mesma `Idempotency-Key` ao repetir a mesma intenção após timeout. Usar nova chave somente para nova intenção confirmada.
8. Consultar os jobs depois da criação. “Job criado” não significa “automação concluída”.
9. Não enviar senha, SQL ou credenciais no prompt; esses dados permanecem cifrados no App Mix.
10. Em dúvida, consultar `/knowledge` e `/capabilities`; se ainda faltar informação, dizer que ela não foi encontrada.

## Fluxo recomendado

### 1. Descobrir capacidades

```http
GET /capabilities
Authorization: Bearer <chave>
```

### 2. Consultar conhecimento

```http
GET /knowledge?q=como+instalar+dados+de+conexao
Authorization: Bearer <chave>
```

### 3. Listar templates e compatibilidade

```http
GET /automacoes/opcoes
Authorization: Bearer <chave>
```

A resposta informa, por template:

- `cadastrar_template`
- `configuracao_xml`
- `dados_conexao`
- `scheduler`
- `acoes_disponiveis`

Nunca ofereça uma ação marcada como indisponível.

### 4. Confirmar com o usuário

Exemplo:

> Confirma executar Cadastrar template, Configuração XML, Dados de conexão e Scheduler no CNPJ 00.000.000/0001-00 usando o template VR?

Somente prossiga após confirmação inequívoca.

### 5. Executar em uma chamada

```http
POST /automacoes
Authorization: Bearer <chave>
Idempotency-Key: <uuid>
X-Hermes-User: <usuário solicitante>
Content-Type: application/json
```

```json
{
  "template_nome": "ECOCENTAURO LUCRO REAL",
  "cnpjs": ["09627008000157", "52703958000142"],
  "acoes": [
    "cadastrar_template",
    "configuracao_xml",
    "dados_conexao",
    "scheduler"
  ]
}
```

Opcionalmente:

```json
{
  "machine_ids": ["ID_EXPLICITAMENTE_AUTORIZADO"]
}
```

Ações válidas:

`importar_e_gravar` é a única ação que não exige `template_id` nem `template_nome`:

```json
{
  "cnpjs": ["09627008000157", "52703958000142"],
  "acoes": ["importar_e_gravar"]
}
```

`configuracao_xml` e `scheduler` são independentes. Selecionar XML nunca autoriza nem cria Scheduler. O Scheduler só pode ser enfileirado quando `scheduler` estiver explicitamente presente em `acoes`.

O campo `cnpjs` é sempre um array com 1 a 1.000 itens em todas as automações. Envie todos os clientes na mesma chamada; a API cria um job independente por combinação de CNPJ e ação e devolve cada ID na resposta.

### Vários templates para os respectivos CNPJs

Quando todos os CNPJs usam o mesmo template, utilize o formato simples acima. Quando cada cliente ou grupo usa um template diferente, envie `execucoes`. Cada grupo possui seu próprio template, lista de CNPJs, ações e, opcionalmente, Machine IDs:

```json
{
  "execucoes": [
    {
      "template_nome": "ECOCENTAURO LUCRO REAL",
      "cnpjs": ["09627008000157"],
      "acoes": ["cadastrar_template"]
    },
    {
      "template_nome": "VR",
      "cnpjs": ["52703958000142"],
      "acoes": ["cadastrar_template", "configuracao_xml"]
    }
  ]
}
```

São permitidos até 100 grupos e 1.000 CNPJs no total. A API valida cada grupo separadamente. Os grupos válidos são enfileirados; grupos com template ausente, arquivado ou sem XML, conexão ou Scheduler solicitado são devolvidos em `bloqueados`, com os motivos. Um grupo inválido não impede os demais.

- `status: "enfileirado"`: todos os grupos foram aceitos.
- `status: "parcial"`: grupos válidos foram enfileirados e grupos inválidos foram bloqueados.
- `status: "bloqueado"` com HTTP 422: nenhum grupo era válido e nenhum job foi criado.

| Ação | Efeito |
|---|---|
| `cadastrar_template` | Aplica o template ativo ao cliente |
| `importar_e_gravar` | Importa e grava sem exigir template |
| `configuracao_xml` | Aplica os caminhos XML cadastrados |
| `dados_conexao` | Instala banco, usuário e senha cifrada do template |
| `scheduler` | Executa o comando Scheduler cadastrado |

A API valida cada grupo antes de inserir. Se uma ação dependente não estiver cadastrada no template, somente esse grupo aparece em `bloqueados`; os demais continuam. `importar_e_gravar` não participa da validação de template.

### 6. Interpretar a resposta

Sucesso HTTP 201:

```json
{
  "execution_id": "uuid",
  "modo": "plano_multiplo",
  "quantidade_grupos": 2,
  "quantidade_jobs": 2,
  "resultados": [
    {
      "grupo": 1,
      "template": {"id": 150, "nome": "ECOCENTAURO LUCRO REAL"},
      "acao": "cadastrar_template",
      "operacao": "cadastro_template",
      "jobs": [{"id": 474, "cnpj": "09627008000157", "status": "pendente"}]
    }
  ]
}
```

Informe os IDs ao usuário e diga “jobs criados/enfileirados”, nunca “concluídos”.

### 7. Acompanhar jobs

```http
GET /jobs/474
Authorization: Bearer <chave>
```

Estados possíveis:

- `pendente`
- `pausado`
- `processando`
- `concluido`
- `erro`
- `cancelado`

Só informe sucesso final quando `status=concluido`. Em erro, apresente `etapa` e `mensagem_erro`.

## Outros endpoints

| Método | Rota | Finalidade |
|---|---|---|
| GET | `/status` | Estado do banco, API e Workers |
| GET | `/capabilities` | Catálogo legível por agentes |
| GET | `/knowledge?q=...` | Regras da Central de Conhecimento |
| GET | `/templates` | Templates ativos |
| GET | `/automacoes` | Instruções do endpoint mestre |
| GET | `/automacoes/opcoes` | Templates e ações disponíveis |
| POST | `/automacoes` | Execução múltipla recomendada |
| GET | `/jobs/{id}` | Status de um job |
| GET | `/lotes/{id}` | Status de lote legado |
| POST | `/importacoes` | Importar e Gravar |
| POST | `/lotes` | Cadastro de template legado |
| POST | `/configuracoes-xml` | XML legado |
| POST | `/conexoes` | Conexão legada |
| POST | `/schedulers` | Scheduler legado |

Prefira `POST /automacoes` para cadastro, XML, conexão e Scheduler.

## Validação de conexão

Host, porta, dialeto e tamanho máximo preenchidos automaticamente não comprovam conexão. Ela só é válida quando todos estes campos possuem conteúdo não vazio:

- Banco de dados
- Usuário do banco
- Senha do banco

Se faltar algum, a API deve bloquear `dados_conexao`.

## Múltiplos Machine IDs

XML, conexão e Scheduler devem alcançar todos os Machine IDs encontrados para o CNPJ. Use `machine_ids` explícitos somente quando autorizados, por exemplo em filial vinculada a outro CNPJ. Nunca invente IDs.

## Tratamento de erros

| HTTP | Conduta |
|---|---|
| 401 | Chave ausente, revogada ou inválida |
| 404 | Template/job/recurso não encontrado |
| 422 | Solicitação inválida ou template incompatível; não fingir sucesso |
| 429 | Aguardar e tentar novamente sem alterar a Idempotency-Key |
| 500/503 | Indisponibilidade temporária; consultar status e preservar a intenção |

## Exemplos de conversa

Usuário: “Quero fazer as quatro operações, mas não sei o template.”

1. Chamar `GET /automacoes/opcoes`.
2. Mostrar somente opções reais e ações disponíveis.
3. Solicitar CNPJ e escolha do template.
4. Repetir todas as ações para confirmação.
5. Chamar `POST /automacoes`.
6. Mostrar IDs.
7. Consultar os jobs até estado terminal.

Usuário: “Faça tudo no CNPJ X com template Y.”

1. Validar CNPJ e consultar opções.
2. Não assumir que “tudo” inclui ações indisponíveis.
3. Informar as ações compatíveis e pedir confirmação.
4. Executar somente após confirmação.

## Limites

A API operacional não autoriza o Hermes a criar, editar, arquivar ou excluir templates. Essas alterações continuam restritas ao painel administrativo. O Hermes pode consultar e aplicar templates ativos.
