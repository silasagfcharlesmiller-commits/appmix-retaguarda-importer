# APP-MIX API

API para sistemas internos, ERPs, painéis e agentes de IA controlarem a fila do APP-MIX.

## Inicialização

1. Inicie `APP-MIX-WORKER.exe` e mantenha-o aberto.
2. Inicie `APP-MIX-API.exe` e mantenha-o aberto.
3. Na primeira execução, a API cria `config_api.json`.
4. Use o valor `api_key` desse arquivo no cabeçalho `X-API-Key`.

Endereço padrão na própria VM: `http://127.0.0.1:8080`.
Na rede, use o IP ou DNS da VM. Libere a porta 8080 somente na rede corporativa/VPN.

Documentação interativa: `http://IP-DA-VM:8080/docs`.

## Autenticação

Todas as rotas `/v1` exigem:

```http
X-API-Key: SUA_CHAVE
```

`GET /health` não exige chave e serve para monitoramento.

## Criar um lote

`POST /v1/lotes`

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

Também é possível usar `template_id` no lugar de `template_nome`. Cada requisição aceita até 1.000 CNPJs válidos.

## Consultar progresso

`GET /v1/lotes/{lote_id}`

A resposta contém percentual, totais por status e cada job com eventual mensagem de erro.

## Outras rotas

- `GET /v1/templates`: lista templates disponíveis;
- `GET /v1/jobs`: lista jobs, com filtros `status` e `cnpj`;
- `GET /v1/jobs/{job_id}`: consulta um job;
- `POST /v1/jobs/{job_id}/cancelar`: cancela um job pendente;
- `POST /v1/lotes/{lote_id}/cancelar`: cancela os jobs pendentes de um lote;
- `GET /v1/info`: informações e versão da API.

Jobs em processamento não são interrompidos no meio de uma gravação. O cancelamento afeta somente jobs ainda pendentes.

## Exemplo PowerShell

```powershell
$cabecalhos = @{ "X-API-Key" = "SUA_CHAVE" }
$corpo = @{
    template_nome = "ECOCENTAURO"
    cnpjs = @("52703958000142")
    origem = "Sistema interno"
} | ConvertTo-Json

Invoke-RestMethod `
    -Uri "http://IP-DA-VM:8080/v1/lotes" `
    -Method Post `
    -Headers $cabecalhos `
    -ContentType "application/json" `
    -Body $corpo
```

## Segurança

- não exponha a porta 8080 diretamente na internet;
- prefira VPN ou proxy reverso HTTPS corporativo;
- restrinja leitura de `config_api.json` e `config_mix.json`;
- troque a chave imediatamente se ela for compartilhada indevidamente;
- use `origem` e `solicitado_por` para auditoria das integrações.
