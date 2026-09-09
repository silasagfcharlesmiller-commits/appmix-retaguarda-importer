# Hermes — regras fiscais automáticas por UF

O endpoint `GET /api/hermes/v1/automacoes/opcoes` informa `regimes_tributarios` e `regras_fiscais_uf` para cada template. No modo `automatico`, o worker consulta a UF real de cada CNPJ e resolve cBenef, alíquota cBenef, FECP, FECP-ST e RE 29.560. No modo `desativado`, mantém exatamente os checkboxes do template.

O Hermes não deve pedir a UF nem enviá-la no POST. O contrato de `POST /automacoes` não mudou.
