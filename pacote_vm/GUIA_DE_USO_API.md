# Guia fácil e completo — APP-MIX API

Este guia explica como instalar o pacote na VM, iniciar os serviços e integrar qualquer sistema com o APP-MIX.

## 1. O que cada executável faz

- `APP-MIX-API.exe`: recebe requisições HTTP e coloca os CNPJs na fila.
- `APP-MIX-WORKER.exe`: lê a fila e aplica o template no cliente pela API da Mix Fiscal.
- `APP-MIX.exe`: interface gráfica para uso humano e administração dos templates.

O fluxo é:

`Sistema externo -> APP-MIX-API -> fila no PostgreSQL -> APP-MIX-WORKER -> Mix Fiscal`

A API e o Worker precisam ficar abertos. A interface `APP-MIX.exe` só precisa ser aberta quando alguém quiser utilizá-la.

## 2. Preparação da VM

1. Copie a pasta `pacote_vm` inteira para um local fixo, por exemplo `C:\APP-MIX`.
2. Não execute os arquivos diretamente dentro de ZIP nem mova somente um executável.
3. Coloque o `config_mix.json` fornecido pela equipe na mesma pasta dos três executáveis.
4. Confirme que a VM consegue acessar:
   - o PostgreSQL usado pelo APP-MIX;
   - a internet HTTPS para a API da Mix Fiscal;
   - a porta TCP da API, normalmente `8080`, a partir dos sistemas autorizados.
5. Python, pip, Playwright e Chromium não são necessários. As bibliotecas já estão dentro dos executáveis.

O `config_mix.json` contém credenciais. Ele não está no GitHub de propósito e deve ser entregue ao TI por um canal seguro.

## 3. Primeira inicialização

Siga esta ordem:

1. Execute `APP-MIX-API.exe`.
2. Na primeira abertura, será criado `config_api.json` ao lado do executável.
3. Abra `config_api.json` e guarde com segurança o valor de `api_key`.
4. Feche e abra novamente a API somente se tiver alterado o arquivo.
5. Execute `APP-MIX-WORKER.exe` e deixe a janela aberta.

Exemplo da estrutura do `config_api.json`:

```json
{
  "api_key": "COLOQUE-AQUI-UMA-CHAVE-SECRETA-COM-24-OU-MAIS-CARACTERES",
  "host": "0.0.0.0",
  "port": 8080,
  "cors_origins": []
}
```

Significado dos campos:

- `api_key`: senha usada pelos sistemas para chamar a API; deve ter pelo menos 24 caracteres.
- `host`: use `0.0.0.0` para aceitar conexões da rede da empresa ou `127.0.0.1` para aceitar somente a própria VM.
- `port`: porta da API, por padrão `8080`.
- `cors_origins`: endereços de sites autorizados a chamar a API pelo navegador. Integrações de servidor não precisam desse campo.

Exemplo de CORS para um painel web interno:

```json
{
  "api_key": "SUA-CHAVE-SECRETA-COM-24-OU-MAIS-CARACTERES",
  "host": "0.0.0.0",
  "port": 8080,
  "cors_origins": [
    "https://painel.empresa.local"
  ]
}
```

Depois de alterar `config_api.json`, reinicie `APP-MIX-API.exe`.

## 4. Como descobrir o endereço da API

Na própria VM:

```text
http://127.0.0.1:8080
```

Em outra máquina da rede:

```text
http://IP-DA-VM:8080
```

Se a VM tiver o IP `192.168.10.50`, por exemplo:

```text
http://192.168.10.50:8080
```

Para uso definitivo, o ideal é o TI criar um DNS interno e HTTPS, por exemplo `https://appmix-api.empresa.local`.

## 5. Teste rápido de funcionamento

Abra no navegador:

```text
http://IP-DA-VM:8080/health
```

Quando a API e o banco estiverem funcionando, a resposta será semelhante a:

```json
{
  "status": "ok",
  "database": "ok",
  "version": "1.0.0"
}
```

Esse endereço não exige chave e pode ser usado pelo monitoramento do TI. Se retornar HTTP `503`, a API abriu, mas não conseguiu acessar o banco.

A documentação interativa fica em:

```text
http://IP-DA-VM:8080/docs
```

## 6. Autenticação

Todas as rotas iniciadas por `/v1` exigem o cabeçalho:

```http
X-API-Key: SUA_CHAVE_DO_CONFIG_API
```

Não envie a chave na URL. Não grave a chave em código público, GitHub, prints ou logs.

## 7. Primeiro teste no PowerShell

Substitua o endereço e a chave. Não compartilhe o arquivo depois de preenchê-lo.

```powershell
$urlApi = "http://IP-DA-VM:8080"
$chaveApi = "SUA_CHAVE_DO_CONFIG_API"
$cabecalhos = @{ "X-API-Key" = $chaveApi }

Invoke-RestMethod `
    -Uri "$urlApi/v1/templates" `
    -Method Get `
    -Headers $cabecalhos
```

Se estiver correto, será retornada a lista dos templates cadastrados no APP-MIX.

## 8. Enviar CNPJs para processamento

Use `POST /v1/lotes`. É possível enviar de 1 até 1.000 CNPJs por requisição.

Exemplo usando o nome do template:

```json
{
  "template_nome": "ECOCENTAURO",
  "cnpjs": [
    "52703958000142"
  ],
  "origem": "ERP",
  "solicitado_por": "usuario@empresa.com"
}
```

Exemplo PowerShell:

```powershell
$urlApi = "http://IP-DA-VM:8080"
$chaveApi = "SUA_CHAVE_DO_CONFIG_API"
$cabecalhos = @{ "X-API-Key" = $chaveApi }

$pedido = @{
    template_nome = "ECOCENTAURO"
    cnpjs = @(
        "52703958000142"
    )
    origem = "ERP"
    solicitado_por = "usuario@empresa.com"
} | ConvertTo-Json

$lote = Invoke-RestMethod `
    -Uri "$urlApi/v1/lotes" `
    -Method Post `
    -Headers $cabecalhos `
    -ContentType "application/json" `
    -Body $pedido

$lote
$lote.lote_id
```

Também é possível informar `template_id` no lugar de `template_nome`:

```json
{
  "template_id": 94,
  "cnpjs": ["52703958000142"],
  "origem": "ERP"
}
```

Informe exatamente um dos dois campos: `template_id` ou `template_nome`.

A API:

- remove pontuação do CNPJ;
- valida os dígitos verificadores;
- remove CNPJs repetidos dentro da mesma requisição;
- cria um job para cada CNPJ;
- reaproveita um job idêntico ainda pendente ou em processamento.

Para criar outro job mesmo que já exista um igual em andamento, envie:

```json
{
  "template_nome": "ECOCENTAURO",
  "cnpjs": ["52703958000142"],
  "permitir_duplicados": true
}
```

Use `permitir_duplicados` com cuidado para não aplicar o mesmo template duas vezes sem necessidade.

## 9. Consultar a barra de progresso no outro sistema

Ao criar o lote, a API devolve um `lote_id`. Guarde esse identificador e consulte:

```http
GET /v1/lotes/{lote_id}
```

PowerShell:

```powershell
$loteId = "COLE-AQUI-O-LOTE-ID-RECEBIDO"

$progresso = Invoke-RestMethod `
    -Uri "$urlApi/v1/lotes/$loteId" `
    -Method Get `
    -Headers $cabecalhos

$progresso.percentual
$progresso.totais
$progresso.jobs
```

O sistema integrador pode consultar essa rota, por exemplo, a cada 2 ou 5 segundos e usar o campo `percentual` para desenhar sua barra de progresso.

Estados possíveis:

- `pendente`: aguardando o Worker;
- `processando`: o Worker está trabalhando no CNPJ;
- `concluido`: processamento finalizado com sucesso;
- `erro`: falhou; consulte `mensagem_erro`;
- `cancelado`: foi cancelado antes de iniciar.

O lote termina quando `percentual` chegar a `100`. Isso pode incluir jobs concluídos, com erro ou cancelados. O sistema deve olhar também o objeto `totais` para saber o resultado real.

## 10. Exemplo em Python

```python
import time
import requests

URL_API = "http://IP-DA-VM:8080"
CHAVE_API = "SUA_CHAVE_DO_CONFIG_API"
HEADERS = {"X-API-Key": CHAVE_API}

pedido = {
    "template_nome": "ECOCENTAURO",
    "cnpjs": ["52703958000142"],
    "origem": "Sistema interno",
    "solicitado_por": "integracao",
}

resposta = requests.post(
    f"{URL_API}/v1/lotes",
    headers=HEADERS,
    json=pedido,
    timeout=30,
)
resposta.raise_for_status()
lote_id = resposta.json()["lote_id"]

while True:
    resposta = requests.get(
        f"{URL_API}/v1/lotes/{lote_id}",
        headers=HEADERS,
        timeout=30,
    )
    resposta.raise_for_status()
    lote = resposta.json()
    print(f"Progresso: {lote['percentual']}% - {lote['totais']}")

    if lote["percentual"] >= 100:
        break

    time.sleep(3)
```

Em produção, mantenha a chave em um cofre de segredos ou variável de ambiente do sistema integrador, e não diretamente no código.

## 11. Exemplo com cURL

Listar templates:

```bash
curl -H "X-API-Key: SUA_CHAVE" \
  http://IP-DA-VM:8080/v1/templates
```

Criar lote:

```bash
curl -X POST \
  -H "X-API-Key: SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{"template_nome":"ECOCENTAURO","cnpjs":["52703958000142"],"origem":"ERP"}' \
  http://IP-DA-VM:8080/v1/lotes
```

## 12. Consultar jobs

Listar os 100 jobs mais recentes:

```http
GET /v1/jobs
```

Filtrar por status:

```http
GET /v1/jobs?status=erro
```

Filtrar por CNPJ:

```http
GET /v1/jobs?cnpj=52703958000142
```

Paginação:

```http
GET /v1/jobs?limite=100&offset=100
```

Consultar um job específico:

```http
GET /v1/jobs/123
```

## 13. Cancelamento

Cancelar um job ainda pendente:

```http
POST /v1/jobs/123/cancelar
Content-Type: application/json
X-API-Key: SUA_CHAVE

{
  "motivo": "Solicitação cancelada pelo usuário"
}
```

Cancelar todos os jobs pendentes de um lote:

```http
POST /v1/lotes/{lote_id}/cancelar
Content-Type: application/json
X-API-Key: SUA_CHAVE

{
  "motivo": "Lote enviado por engano"
}
```

Por segurança, somente jobs `pendente` são cancelados. Um job que já esteja `processando` não é interrompido no meio da gravação.

## 14. Resumo das rotas

| Método | Rota | Uso | Exige chave |
|---|---|---|---|
| `GET` | `/health` | Testar API e banco | Não |
| `GET` | `/docs` | Documentação interativa | Não |
| `GET` | `/v1/info` | Informações da API | Sim |
| `GET` | `/v1/templates` | Listar templates | Sim |
| `POST` | `/v1/lotes` | Criar lote de CNPJs | Sim |
| `GET` | `/v1/lotes/{lote_id}` | Consultar progresso | Sim |
| `POST` | `/v1/lotes/{lote_id}/cancelar` | Cancelar pendentes do lote | Sim |
| `GET` | `/v1/jobs` | Listar e filtrar jobs | Sim |
| `GET` | `/v1/jobs/{job_id}` | Consultar um job | Sim |
| `POST` | `/v1/jobs/{job_id}/cancelar` | Cancelar job pendente | Sim |

## 15. Códigos HTTP mais comuns

| Código | Significado | O que verificar |
|---|---|---|
| `200` | Operação concluída | Resposta normal |
| `201` | Lote criado | Guarde o `lote_id` |
| `401` | Chave inválida ou ausente | Cabeçalho `X-API-Key` |
| `404` | Recurso não encontrado | Template, lote ou job informado |
| `409` | Conflito de estado | Job já saiu de `pendente` e não pode ser cancelado |
| `422` | Dados inválidos | CNPJ, campos obrigatórios ou formato do JSON |
| `503` | Banco indisponível | Rede, PostgreSQL e `config_mix.json` |
| `500` | Erro interno | Logs da API e do Worker |

## 16. Solução de problemas

### A API não abre

- confirme que `config_mix.json` está na mesma pasta do executável;
- verifique se a porta configurada já está sendo usada por outro programa;
- execute pela linha de comando para enxergar a mensagem de erro;
- confirme o acesso da VM ao PostgreSQL.

### `/health` retorna 503

- confira host, porta, banco, usuário e senha em `config_mix.json`;
- teste a comunicação da VM com a porta do PostgreSQL;
- verifique se o usuário do banco possui as permissões necessárias.

### O lote fica sempre pendente

- confirme que `APP-MIX-WORKER.exe` está aberto;
- consulte `worker_mix.log`, criado ao lado do Worker;
- verifique o acesso à API HTTPS da Mix Fiscal;
- confirme que `config_mix.json` também está ao lado do Worker.

### Outro computador não acessa a porta 8080

- confirme que o `host` é `0.0.0.0`;
- libere a porta apenas na rede corporativa no Firewall do Windows;
- confira regras da rede, VLAN, VPN e firewall entre as máquinas;
- teste primeiro `/health` na própria VM e depois de outra máquina.

### Recebe 401

- use exatamente o valor de `api_key` do `config_api.json`;
- envie pelo cabeçalho `X-API-Key`;
- remova espaços extras;
- se a chave foi alterada, reinicie a API.

### Recebe 422 ao criar lote

- confira se cada CNPJ é válido e possui 14 dígitos;
- informe somente `template_id` ou somente `template_nome`;
- envie o cabeçalho `Content-Type: application/json`;
- limite cada chamada a no máximo 1.000 CNPJs.

## 17. Execução automática no servidor

Para produção, o TI pode configurar a API e o Worker para iniciarem automaticamente após o Windows. O método escolhido deve:

- usar a pasta fixa onde estão os executáveis e configurações;
- executar com um usuário que tenha acesso ao PostgreSQL e à internet necessária;
- reiniciar o processo em caso de falha;
- manter os logs acessíveis ao suporte;
- iniciar `APP-MIX-API.exe` e `APP-MIX-WORKER.exe` como processos separados.

Antes de automatizar, teste os dois manualmente na mesma conta que será usada pelo serviço.

## 18. Segurança recomendada

- disponibilize a API somente na rede interna ou VPN;
- para acesso por outras redes, use proxy reverso com HTTPS;
- permita a porta somente para IPs/sistemas que realmente precisam dela;
- restrinja a leitura de `config_mix.json` e `config_api.json`;
- nunca envie esses dois arquivos ao GitHub;
- mantenha uma chave diferente para produção e homologação;
- troque a chave se houver suspeita de vazamento;
- preencha `origem` e `solicitado_por` para facilitar auditoria;
- faça backup do PostgreSQL e dos templates antes de mudanças maiores.

## 19. Checklist final do TI

- [ ] Pasta copiada para um local fixo na VM.
- [ ] `config_mix.json` entregue por canal seguro e colocado ao lado dos executáveis.
- [ ] VM acessa o PostgreSQL.
- [ ] VM acessa a API HTTPS da Mix Fiscal.
- [ ] `APP-MIX-API.exe` está em execução.
- [ ] `config_api.json` foi criado e protegido.
- [ ] `APP-MIX-WORKER.exe` está em execução.
- [ ] `/health` responde com `status: ok`.
- [ ] `/v1/templates` responde quando recebe a chave.
- [ ] Um lote de homologação foi criado e chegou a 100%.
- [ ] O resultado final foi conferido na Mix Fiscal.
- [ ] Firewall permite acesso somente pela rede autorizada.
- [ ] API e Worker foram configurados para iniciar com o Windows.

