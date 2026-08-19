# Manual do Emanuel — rodar jobs do App Mix

## Resposta rápida

Sim: atualmente você cria o job pelo DBeaver.

O funcionamento é:

```text
1. Emanuel executa um INSERT no DBeaver
2. Emanuel confirma o COMMIT
3. A linha fica pendente em public.fila_execucao
4. worker_mix.py encontra a linha automaticamente
5. O worker executa tabelas e Configuração no portal
6. O worker grava concluido ou erro no banco
```

O DBeaver não executa o navegador. Ele apenas adiciona o pedido à fila. O terminal com o worker precisa permanecer aberto.

## Antes do primeiro job

Na primeira vez na máquina, execute `INSTALAR_LIMPO.bat`, faça o login pela interface e depois feche completamente a interface.

Não deixe a interface e o worker abertos ao mesmo tempo.

## Passo 1 — iniciar o worker

Abra o PowerShell dentro da pasta do App Mix:

```powershell
powershell -ExecutionPolicy Bypass -File .\primeira_execucao.ps1 -Modo worker
```

Depois que a instalação já estiver pronta, também pode usar:

```powershell
.\.venv\Scripts\python.exe .\worker_mix.py
```

Deixe esse terminal aberto. Quando aparecer:

```text
Worker App Mix iniciado 24/7
```

ele estará esperando jobs pendentes.

## Passo 2 — abrir o DBeaver

Abra a conexão PostgreSQL usada pelo App Mix e crie um editor SQL.

Primeiro confira os templates disponíveis:

```sql
SELECT id, nome, atualizado_em
FROM public.templates
ORDER BY nome;
```

O ID pode mudar de um banco para outro. Por isso, prefira inserir pelo nome do template.

## Passo 3 — adicionar um job

Exemplo: executar o CNPJ `52703958000142` com o template `VR`:

```sql
INSERT INTO public.fila_execucao (cnpj, template_id)
SELECT '52703958000142', id
FROM public.templates
WHERE LOWER(nome) = LOWER('VR');
```

Execute a instrução no DBeaver.

Se o auto-commit estiver desligado, clique no botão **Commit**. Sem o commit, o worker não consegue enxergar o job.

Essa forma é melhor do que escrever o ID `60`, pois procura o ID atual do template VR automaticamente.

## Passo 4 — confirmar que entrou na fila

Execute:

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
ORDER BY fila.id DESC
LIMIT 20;
```

O novo job deverá passar por:

```text
pendente → processando → concluido
```

Se aparecer `erro`, consulte `mensagem_erro` e o terminal do worker.

Durante a extração, o terminal também mostra `Empresa:`. Esse valor corresponde à variável `{nome_empresa}` do template e já aparece em minúsculas, sem acentos e separado por `_`.

## Inserção usando o ID

Use apenas depois de conferir o ID:

```sql
SELECT id, nome
FROM public.templates
WHERE LOWER(nome) = LOWER('VR');
```

Se o resultado realmente for `60`:

```sql
INSERT INTO public.fila_execucao (cnpj, template_id)
VALUES ('52703958000142', 60);
```

Depois execute o commit, se necessário.

## Inserir vários CNPJs no VR

Troque os exemplos pelos CNPJs reais:

```sql
INSERT INTO public.fila_execucao (cnpj, template_id)
SELECT cliente.cnpj, template.id
FROM (
    VALUES
        ('52703958000142'),
        ('00000000000000'),
        ('11111111111111')
) AS cliente(cnpj)
CROSS JOIN public.templates AS template
WHERE LOWER(template.nome) = LOWER('VR');
```

Confira a quantidade de linhas inseridas antes de confirmar o commit.

## Se o INSERT inserir zero linhas

O nome do template provavelmente não existe. Verifique:

```sql
SELECT id, nome
FROM public.templates
ORDER BY nome;
```

Copie o nome exatamente como aparece e substitua `VR` no INSERT.

## Se o job ficar pendente

Confira:

1. o terminal do worker está aberto;
2. não existe interface PyQt6 usando o mesmo navegador;
3. o INSERT recebeu commit no DBeaver;
4. `config_mix.json` aponta para o mesmo banco aberto no DBeaver;
5. o terminal não mostra erro de conexão.

## Se o job ficar em erro

Consulte:

```sql
SELECT id, cnpj, template_id, status, tentativas, mensagem_erro
FROM public.fila_execucao
WHERE status = 'erro'
ORDER BY id DESC;
```

Não reenvie imediatamente sem conferir se alguma parte já foi salva no portal.

Depois de corrigir o problema, para reenviar um job específico, troque `123` pelo `job_id` correto:

```sql
UPDATE public.fila_execucao
SET
    status = 'pendente',
    mensagem_erro = NULL,
    processado_em = NULL
WHERE id = 123
  AND status = 'erro';
```

Confirme o commit quando necessário.

## Acompanhar somente jobs ativos

```sql
SELECT id, cnpj, template_id, status, tentativas, criado_em, processado_em
FROM public.fila_execucao
WHERE status IN ('pendente', 'processando')
ORDER BY criado_em;
```

## Parar o worker

No terminal do worker, pressione:

```text
Ctrl + C
```

Não feche o terminal durante um job em `processando`, salvo em caso de emergência.

## Rotina diária resumida

1. Inicie o worker e deixe o terminal aberto.
2. Abra o DBeaver.
3. Confira o template pelo nome.
4. Execute o INSERT pelo nome do template.
5. Faça commit se necessário.
6. Consulte a fila.
7. Acompanhe o terminal.
8. Confirme o status `concluido`.
