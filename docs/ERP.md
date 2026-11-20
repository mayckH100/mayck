# MCK ERP — Arquitetura, DER, Máquina de Estados e Plano

## 1. Arquitetura

**Estilo:** monólito modular orientado a eventos, na mesma stack do MCKBOT (Node 22 + TypeScript, Express, Zod, React 18 + Vite, Prisma + PostgreSQL). Roda grátis no Render Free + Neon/Supabase. Cada módulo tem fronteira própria e só fala com outro por **eventos** ou por **serviço público**, nunca por tabela alheia. Assim, se um dia crescer, um módulo vira serviço separado sem reescrever.

```
web/src/erp/            React: Kanban (CRM, Pedidos, OP), telas, dashboards
server/erp/
  core/                 empresa, filial, centro de custo, plano de contas, numeração
  shared/
    events/             outbox + dispatcher + consumidores idempotentes
    audit/              audit_log (append-only) + trace_link (rastreio ponta a ponta)
    integrations/       hub de adaptadores + fila de retry
    statemachine/       motor genérico de estados (puro, testável)
  crm/ vendas/ estoque/ producao/ compras/ fiscal/ financeiro/ bi/
prisma/                 schema "erp" (multiSchema), separado do schema do MCKBOT
```

**Barramento de eventos sem custo (Transactional Outbox):**
1. O módulo grava a mudança **e** o evento (`domain_event`) na mesma transação. Nunca há pedido aprovado sem evento.
2. Um dispatcher lê com `FOR UPDATE SKIP LOCKED`, entrega aos consumidores e marca entregue.
3. Cada consumidor registra em `event_consumption (evento_id, consumidor)` com chave única = idempotência (reprocessar não duplica reserva nem título).
4. Falha → retentativa com backoff exponencial → após N tentativas, vai para a fila morta (DLQ) visível no painel, com botão "reprocessar".

**Fluxo-exemplo:** `PedidoAprovado` → Estoque tenta reservar → (falta) `NecessidadeGerada` → MRP explode BOM → `SugestaoOP` / `SugestaoCompra` → Financeiro grava provisão de recebimento.

**Rastreabilidade:**
- `correlation_id` nasce no lead/oportunidade e viaja por pedido → OP → NF → título → baixa.
- `trace_link (origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)` monta o grafo "do lead ao boleto pago e ao lote de matéria-prima".
- `audit_log` só de inserção: quem, quando, antes/depois (JSON), IP.
- Nada é apagado: cancelamento é estado + estorno.

**Multiempresa:** toda transação carrega `empresa_id`, `filial_id` e, onde couber, `centro_custo_id`, base dos filtros dos dashboards. Valores em `Decimal(15,2)`, quantidades em `Decimal(15,4)`.

**Integrações (adaptadores trocáveis):**
| Necessidade | Opção gratuita / observação |
|---|---|
| CNPJ (razão, endereço, CNAE, situação, Simples) | BrasilAPI / ReceitaWS: gratuito |
| Inscrição Estadual | Consulta CCC da SEFAZ exige certificado A1: fase fiscal |
| NF-e / NFS-e / DANFE | Precisa de certificado A1 + provedor (geralmente pago). Adaptador pronto, com modo homologação |
| Boleto, Pix dinâmico, link | Via banco/gateway (cobram tarifa por título). Reaproveita boletos e régua do MCK Mensagens |
| Frete e etiqueta | Melhor Envio (conta grátis, paga por etiqueta) |
| WhatsApp / e-mail | Reaproveita MCKBOT (QR/Cloud API) e Brevo |
| Conciliação | OFX grátis; Open Finance depois |

## 2. DER (núcleo de integridade)

```mermaid
erDiagram
  EMPRESA ||--o{ FILIAL : tem
  FILIAL ||--o{ DEPOSITO : tem
  PARCEIRO ||--o{ OPORTUNIDADE : gera
  LEAD ||--o| PARCEIRO : converte
  PARCEIRO ||--o{ INTERACAO : timeline
  OPORTUNIDADE ||--o{ ORCAMENTO : origina
  ORCAMENTO ||--o| PEDIDO_VENDA : converte
  PEDIDO_VENDA ||--|{ PEDIDO_VENDA_ITEM : contem
  PRODUTO ||--o{ PEDIDO_VENDA_ITEM : vendido
  PEDIDO_VENDA_ITEM ||--o{ RESERVA_ESTOQUE : reserva
  LOTE ||--o{ RESERVA_ESTOQUE : reservado
  PRODUTO ||--o{ LOTE : possui
  LOTE ||--o{ SALDO_ESTOQUE : saldo
  ENDERECO_ESTOQUE ||--o{ SALDO_ESTOQUE : guarda
  LOTE ||--o{ MOVIMENTO_ESTOQUE : movimenta
  PRODUTO ||--o{ BOM : ficha
  BOM ||--|{ BOM_ITEM : componentes
  PEDIDO_VENDA_ITEM ||--o{ ORDEM_PRODUCAO : demanda
  ORDEM_PRODUCAO ||--o{ OP_CONSUMO : consome
  LOTE ||--o{ OP_CONSUMO : insumo
  ORDEM_PRODUCAO ||--o{ OP_LOTE_PRODUZIDO : gera
  LOTE ||--o| OP_LOTE_PRODUZIDO : produto
  ORDEM_PRODUCAO ||--o{ OP_APONTAMENTO : etapas
  REQUISICAO_COMPRA ||--o{ COTACAO : cota
  COTACAO ||--o| PEDIDO_COMPRA : vence
  PEDIDO_COMPRA ||--|{ PEDIDO_COMPRA_ITEM : contem
  PEDIDO_COMPRA_ITEM ||--o{ RECEBIMENTO_ITEM : recebe
  RECEBIMENTO_ITEM ||--|| LOTE : cria
  PEDIDO_VENDA ||--o{ NOTA_FISCAL : fatura
  NOTA_FISCAL ||--|{ NOTA_FISCAL_ITEM : contem
  NOTA_FISCAL_ITEM }o--|| LOTE : sai_do
  NOTA_FISCAL ||--o{ TITULO : gera
  PEDIDO_COMPRA ||--o{ TITULO : gera
  TITULO ||--o{ RATEIO_TITULO : rateia
  CENTRO_CUSTO ||--o{ RATEIO_TITULO : recebe
  TITULO ||--o{ COBRANCA : cobra
  TITULO ||--o{ BAIXA : liquida
  BAIXA }o--o| EXTRATO_LANCAMENTO : concilia
  PEDIDO_VENDA ||--o{ EXPEDICAO : expede
  EXPEDICAO ||--o{ RASTREIO_EVENTO : status
```

**Tabelas por módulo**
- **Core:** empresa, filial, centro_custo, plano_conta (DRE), usuario (reusa auth/RBAC do MCKBOT), alcada (limites de desconto/compra/crédito por papel), sequencia_documento.
- **CRM:** parceiro (cliente e fornecedor unificados, CPF/CNPJ único por empresa, IE, regime, CNAE, situação Receita, score, limite_credito), parceiro_endereco, parceiro_contato, lead, oportunidade (etapa Kanban, valor, probabilidade, origem, custo de aquisição), interacao (tipo: whatsapp, email, ligação, chamado; vínculo com mensagem do MCKBOT), chamado.
- **Produtos e preços:** produto (NCM, CEST, origem, unidade, peso, cubagem, controla_lote, regra FEFO/FIFO, ponto_pedido, estoque_min, custo_medio, custo_padrao), tabela_preco (região/UF, volume), tabela_preco_item, condicao_pagamento (parcelas, prazos).
- **Estoque/WMS:** deposito, endereco_estoque (rua/prateleira/posição, QR), lote (nº, fabricação, validade, status: liberado/quarentena/bloqueado, origem: compra ou OP), saldo_estoque (produto+lote+endereço, físico, reservado, quarentena; disponível = físico − reservado − quarentena; CHECK ≥ 0), movimento_estoque (razão imutável: tipo, qtd, custo, documento_origem_tipo/id), reserva_estoque, inventario, inventario_contagem.
- **Vendas/OMS:** orcamento, orcamento_item, pedido_venda (status_operacional, status_financeiro, correlation_id), pedido_venda_item, aprovacao (alçada), separacao (picking sugerido por FEFO), separacao_item (lote lido no QR), expedicao (transportadora, frete cotado, etiqueta, rastreio), volume, rastreio_evento.
- **Produção/MRP:** bom (versão, vigência), bom_item (multinível via produto componente com BOM própria, perda %), roteiro, roteiro_operacao (recurso, setup, tempo padrão), recurso (máquina/centro de trabalho), mrp_execucao, mrp_sugestao (produzir/comprar, qtd, data), ordem_producao (QR), op_consumo (lote real de insumo), op_apontamento (início/fim, paradas, refugo), op_lote_produzido.
- **Compras:** requisicao_compra (origem: ponto de pedido, MRP, manual), cotacao, cotacao_fornecedor, cotacao_item (mapa comparativo), pedido_compra, pedido_compra_item, recebimento (conferência cega), recebimento_item, nfe_entrada_xml (manifesto SEFAZ).
- **Fiscal:** regra_tributaria (NCM × CFOP × UF origem/destino × regime → ICMS, ST, IPI, PIS, COFINS, ISS), nota_fiscal (entrada/saída, chave, status SEFAZ, XML, PDF), nota_fiscal_item (impostos calculados, lote), evento_fiscal (cancelamento, CC-e).
- **Financeiro:** titulo (pagar/receber, parcela, vencimento, valor, saldo, origem NF/pedido/compra), rateio_titulo (centro de custo × plano de contas), cobranca (boleto, Pix, link; nosso número, txid), regua_cobranca, baixa (total/parcial, juros, desconto, estorno), conta_bancaria, extrato_lancamento (OFX/API), conciliacao.
- **Plataforma:** domain_event, event_consumption, integration_job (retry/DLQ), audit_log, trace_link, mensagem_canal (abertura de e-mail, leitura no WhatsApp).

**Regras de integridade que o banco garante:**
- Saldo nunca negativo (CHECK) e toda mudança de saldo passa por movimento_estoque na mesma transação.
- Item de NF de saída aponta para o lote que saiu; o lote produzido aponta para a OP e a OP para os lotes consumidos (genealogia completa para recall).
- Título só nasce de documento de origem (NF, pedido de compra) ou lançamento manual auditado.
- FKs com `ON DELETE RESTRICT`; documentos fiscais e financeiros nunca são excluídos.

## 3. Máquina de Estados do Pedido de Venda

Duas regiões paralelas: **operacional** e **financeira**. O pedido só fica **CONCLUÍDO** quando está ENTREGUE **e** LIQUIDADO.

**Operacional**
| De | Evento / guarda | Para | Efeitos (eventos emitidos) |
|---|---|---|---|
| RASCUNHO | enviar | EM_APROVACAO | — |
| EM_APROVACAO | desconto acima da alçada ou crédito insuficiente | BLOQUEADO | notifica aprovador |
| BLOQUEADO | aprovado pelo gestor / crédito liberado | APROVADO | — |
| EM_APROVACAO | dentro das regras | APROVADO | `PedidoAprovado` → reserva + provisão financeira |
| APROVADO | estoque disponível | RESERVADO | `EstoqueReservado` |
| APROVADO | falta item | AGUARDANDO_SUPRIMENTO | `NecessidadeGerada` → MRP: OP e/ou compra |
| AGUARDANDO_SUPRIMENTO | OP concluída / compra recebida | RESERVADO | — |
| RESERVADO | liberar separação | EM_SEPARACAO | picking por FEFO/FIFO |
| EM_SEPARACAO | conferência QR ok | SEPARADO | — |
| SEPARADO | NF autorizada | FATURADO | `PedidoFaturado` → títulos a receber, envio DANFE/XML |
| FATURADO | etiqueta + coleta | EM_TRANSPORTE | rastreio |
| EM_TRANSPORTE | confirmação de entrega | ENTREGUE | OTIF calculado |
| EM_TRANSPORTE | entrega parcial / recusa | ENTREGA_PARCIAL / DEVOLVIDO | devolução, NF de entrada |
| qualquer antes de FATURADO | cancelar | CANCELADO | libera reservas, estorna provisão |
| FATURADO+ | cancelar NF (prazo legal) | SEPARADO | estorna títulos |

**Financeira:** SEM_TITULO → PROVISIONADO (aprovado) → EM_ABERTO (faturado) → PARCIAL → LIQUIDADO; ou EM_ABERTO → VENCIDO → INADIMPLENTE (régua de cobrança), voltando a LIQUIDADO com a baixa.

Toda transição passa pelo motor de estados (função pura `transition(estado, evento, contexto)`), grava `audit_log` e emite o evento no outbox.

## 4. Plano em 5 etapas

1. **Fundação + CRM (Módulo 1):** core multiempresa, outbox/eventos, auditoria e trace, motor de estados; cadastro 360º com CNPJ via BrasilAPI; funil Kanban; timeline com WhatsApp e e-mail reaproveitando o MCKBOT; limite de crédito e score; KPIs (ativos/inativos, CAC, ticket médio, conversão, inadimplência).
2. **Produtos, Estoque/WMS e Vendas/OMS:** produtos, tabelas de preço, alçadas; saldos físico/reservado/quarentena/disponível; lotes com FEFO/FIFO; endereçamento e etiquetas QR; orçamento → pedido com a máquina de estados; separação e conferência por QR.
3. **Compras e Produção/MRP:** ponto de pedido, requisição, mapa de cotação, pedido de compra, recebimento cego, custo médio; BOM multinível, roteiros, MRP, OP com QR, apontamento, consumo de lote, refugo, OEE.
4. **Fiscal e Financeiro:** motor tributário, NF-e/NFS-e por adaptador (homologação primeiro), títulos automáticos, rateio por centro de custo, DRE gerencial, boleto/Pix/link via gateway, régua de cobrança (reaproveita MCK Mensagens), conciliação OFX, fluxo de caixa previsto × realizado.
5. **Hub de integrações, Logística e BI:** frete e etiquetas, rastreio, monitor de engajamento, dashboard executivo com filtros por período, filial e centro de custo, rastreio visual ponta a ponta; endurecimento e desempenho.

**Testes enxutos:** só testes unitários das regras críticas (motor de estados, saldo/reserva, MRP, impostos) e a suíte existente rodada uma vez antes de cada commit, como manda a ATA. Sem e2e a cada etapa.

## Decisão 2026-11-03 (Mayck): fiscal configurado pelo cliente
- O ERP não contrata provedor fiscal. Cada empresa cliente conecta a própria SEFAZ num assistente simples "Conectar SEFAZ":
  1. Envia o certificado A1 (.pfx) e a senha (guardados cifrados, por empresa).
  2. Informa UF, CNPJ, IE, regime, série e próximo número da NF-e (CNPJ preenche o resto via BrasilAPI).
  3. Escolhe homologação ou produção; botão "Testar conexão" consulta o status do serviço da SEFAZ.
- Emissão direta nos webservices da SEFAZ com o certificado do cliente (sem custo para a MCK). NFS-e pelo padrão nacional, com adaptador para prefeituras fora dele.
- Opcional: campo para o cliente usar um provedor próprio (token), se preferir.
- O mesmo vale para boleto/Pix: o cliente informa as credenciais do banco/gateway dele.


## Etapa 1 entregue (2026-11-03): Fundação + CRM
- Backend em `server/erp/`: `shared/` (motor de estados, outbox de eventos com retry e fila morta, rastreio, auditoria), `core/` (filiais, centros de custo, monitor de eventos, rastreio), `crm/` (cadastro 360º com CNPJ via BrasilAPI, funil Kanban com máquina de estados, linha do tempo com envio real por WhatsApp/e-mail, KPIs).
- API: `/api/erp/core/*`, `/api/erp/crm/parceiros`, `/api/erp/crm/funil`, `/api/erp/crm/interacoes`, `/api/erp/crm/kpis`. Módulo de permissão `erp_crm`.
- Tela: menu "MCK ERP · CRM" (`/erp`, `/erp/funil`, `/erp/clientes`, `/erp/clientes/:id`) em `web/src/erp/`.
- Banco: migração `0038_erp_crm` só aditiva (tabelas `Erp*`).
- Testes: `tests/unit/erp-crm.test.ts` (estados, KPIs, CNPJ, backoff).

## Etapa 2 entregue (2026-11-03): Produtos, Estoque/WMS, Vendas/OMS
- `server/erp/produtos/`: produtos (NCM, CEST, origem, lote/validade, FIFO/FEFO, mínimo e ponto de pedido, custo médio), tabelas de preço regionais com faixa de volume, condições de pagamento, regras comerciais (alçada de desconto, bloqueio por crédito, validade do orçamento).
- `server/erp/estoque/`: depósitos e endereços (grade rua-prateleira-posição), lotes com quarentena, saldo físico/reservado/quarentena/disponível, razão imutável de movimentos, entrada/baixa/transferência, etiquetas QR (endereço e lote). Reserva por UPDATE atômico condicionado ao disponível; CHECK no Postgres impede saldo negativo.
- `server/erp/vendas/`: orçamento → pedido com a máquina de estados (seção 3), aprovação automática ou por gestor, reserva FEFO/FIFO, aguardando suprimento (evento `estoque.necessidade` para Compras/MRP), lista de separação por endereço, conferência por QR que só aceita o lote reservado, faturamento (NF externa até a Etapa 4) com baixa do estoque, expedição, entrega, devolução, cancelamento com liberação de reservas. Pedido aprovado fecha a oportunidade de origem como ganha e entra na linha do tempo do cliente.
- Telas: `/erp/produtos`, `/erp/estoque`, `/erp/pedidos`, `/erp/pedidos/:id`.
- Banco: migração `0039_erp_estoque_vendas` (só aditiva).
- Testes: `tests/unit/erp-estoque-vendas.test.ts` e `tests/integration/erp-estoque-vendas.test.ts` (FEFO, conferência, baixa, falta, alçada).

## Estoque completo (2026-11-03): entrada por XML, lotes, etiquetas e inventário
- **Entrada por XML de NF-e** (`server/erp/estoque/nfe-xml.ts`, `nfe.routes.ts`): lê o XML (modelo 55, layout 4.00) sem dependência externa; recusa duplicada pela chave; avisa se não há protocolo de autorização; cadastra o fornecedor pelo emitente; vincula itens por de-para do fornecedor (com fator de conversão, ex.: 1 CX = 12 UN) ou EAN; permite criar o produto a partir do item. Custo de entrada = produto + IPI + ST + frete + seguro + outras − desconto, rateado pela quantidade convertida (custo médio).
- **Lotes**: o lançamento gera lote interno no formato configurável (`{AA}{MM}{DD}-{SEQ}`, `{SKU}`…) guardando o lote do fornecedor (rastro da NF-e ou informado na conferência), o fornecedor e a nota de origem (trace nfe → lote). Opção de usar o lote do fornecedor como interno. Entrada em quarentena opcional.
- **Etiquetas** (`etiquetas.ts`, `web/src/erp/estoque/impressao.ts`): QR com o lote; ZPL II para Zebra (203/300 dpi, tamanho em mm, cópias) enviado pelo Zebra Browser Print local ou baixado como .zpl; impressora comum em folha A4 ou rolo. A CSP libera só `http://localhost:9100` para o Browser Print.
- **Inventário** (`inventario.routes.ts`): foto do saldo, contagem por leitura de endereço + lote/SKU, contagem cega, item achado fora da foto, envio para aprovação, recontagem e ajuste (contado − foto) como movimento INVENTARIO.
- Migração `0040_erp_nfe_entrada_lotes_inventario` (só aditiva).
- Fica para a Etapa 4 (precisa do certificado A1 do cliente): baixar as NF-e destinadas direto da SEFAZ (Distribuição DF-e) e manifestar o destinatário.

## Etapa 3 — Compras e Produção/MRP (2026-11-03)

**Compras** (`/api/erp/compras`, tela `/erp/compras`)
- Solicitação de compra com aprovação (só OWNER/ADMIN aprova). O MRP também cria solicitações (origem `MRP`).
- Cotação com vários fornecedores convidados; propostas lançadas por item (preço, prazo, condição). Mapa escolhe a melhor por item (menor preço; empate → menor prazo), o comprador pode trocar. Encerrar gera um pedido de compra por fornecedor vencedor e baixa o atendido da solicitação.
- Pedido de compra com máquina de estados (RASCUNHO → EM_APROVACAO → APROVADO → ENVIADO → RECEBIDO_PARCIAL/RECEBIDO; CANCELADO). Alçada (`ErpConfig.alcadaCompraCents`, padrão R$ 5.000): até ela, aprova ao enviar; acima, só OWNER/ADMIN. Impressão/PDF para o fornecedor.
- Recebimento: a NF-e de entrada se liga a um pedido aberto do mesmo fornecedor. No lançamento há confronto de quantidade (pendente) e preço (`toleranciaPrecoBp`, padrão 2%) e da conferência física. Divergência trava; só OWNER/ADMIN aceita. Recebimento cego opcional (`recebimentoCego`): o conferente não vê a quantidade da nota.

**Produção** (`/api/erp/producao`, tela `/erp/producao`)
- Estrutura (BOM) multinível com perda %, sem ciclos; roteiro com centro de trabalho, segundos por unidade, setup e custo/hora. Custo padrão = materiais (custo médio, multinível) + operações.
- Ordem de produção: PLANEJADA → LIBERADA (reserva FEFO/FIFO dos componentes; trava se faltar) → EM_PRODUCAO → ENCERRADA; CANCELADA. Reservas usam `ErpReserva` com `origemTipo = 'op'`.
- Apontamento: consumo por backflush na proporção do produzido + refugo, entrada do produto com lote interno ao custo real (materiais + operações + setup no 1º apontamento) e genealogia no trace (`lote compoe lote`, `op produziu lote`).
- MRP de período único (sem baldes de tempo): demanda dos pedidos de venda abertos + dependente das OPs + alvo (máx. de estoque mínimo e ponto de pedido) − disponível − a receber (pedidos de compra, OPs, solicitações). Processa por nível mais baixo, aplica lote mínimo, explode a estrutura. Aplicar gera OPs planejadas e uma solicitação de compra.
- Produto ganhou `leadTimeDias`, `loteMinimoMil`, `fornecedorPadraoId`.

**Migração** `0041_erp_compras_producao`: só aditiva. Não aplicada em Postgres de produção.

**Limitações conhecidas**: MRP sem baldes de tempo (datas só informativas); sem apontamento por operação nem capacidade finita; envio do pedido de compra/cotação ao fornecedor é por texto/PDF (sem e-mail automático).

## Etapa 4 — Financeiro e Fiscal (2026-11-03)

**Financeiro** (`/api/erp/financeiro`, tela `/erp/financeiro`)
- Contas (banco, caixa, cartão) com saldo inicial e chave Pix; saldo = inicial + lançamentos.
- Plano de contas gerencial por grupo da DRE (receita bruta, deduções, custos, operacionais, financeiras, impostos), criado com um padrão editável.
- Títulos a receber e a pagar com parcelas. Gerados por evento: `vendas.pedido.faturado` → a receber pela condição de pagamento; `estoque.nfe_entrada.lancada` → a pagar pelas duplicatas da nota (sem duplicata: uma parcela na emissão). Pedido cancelado/devolvido cancela os títulos sem baixa.
- Baixa total ou parcial com juros/multa e desconto (multa até 2% e juros de mora pro rata, configuráveis), estorno (só gestor), cancelamento (só gestor, sem baixa). Status financeiro do pedido acompanha (EM_ABERTO, PARCIAL, LIQUIDADO).
- Pix copia-e-cola (BR Code estático com CRC16) na chave do cliente, sem provedor.
- Transferência entre contas, lançamento avulso, importação de extrato OFX e conciliação (mesmo valor, até 3 dias; cria lançamento para tarifa).
- Painel: saldo, aging a receber e a pagar, fluxo de caixa projetado. DRE por competência ou caixa.

**Fiscal** (`/api/erp/fiscal`, tela `/erp/fiscal` e bloco "Nota fiscal" no pedido)
- Emitente, regime (Simples ou normal), ambiente (homologação padrão), série e numeração.
- Certificado A1 do próprio cliente, cifrado com `MASTER_KEY`; valida senha, validade e CNPJ.
- Regras de tributação por produto, por prefixo de NCM ou padrão: CFOP dentro/fora do estado, CSOSN/CST ICMS, IPI, PIS e COFINS.
- NF-e 4.00 a partir do pedido separado: chave com DV módulo 11, desconto e frete rateados, tributos por regra, XML assinado (XML-DSig, C14N, RSA-SHA1). Transmissão síncrona, nfeProc com protocolo, cancelamento em até 24 h (evento 110111), status do serviço, refazer após rejeição com o mesmo número, XML e DANFE com código de barras.
- Endpoints: SP e UFs da SVRS. Demais UFs com SEFAZ própria (MG, PR, RS, BA, GO, MS, MT, PE, AM, MA) ainda não.

**Migração** `0042_erp_financeiro_fiscal`: só aditiva. Não aplicada em Postgres de produção.

**Limitações conhecidas**: transmissão nunca testada contra a SEFAZ real (precisa do certificado do cliente; começar em homologação); sem ST, DIFAL, FCP, NFC-e, NFS-e, inutilização de numeração, carta de correção e download de DF-e; boleto registrado depende do banco do cliente (hoje: Pix copia-e-cola).

## Etapa 5 — BI (2026-11-03)
- `/api/erp/bi/resumo?de&ate` (tela `/erp/bi`): receita, CMV, margem bruta, ticket médio, receita por dia, maiores clientes, curva ABC com margem por produto; valor do estoque, cobertura em dias, itens abaixo do mínimo, lotes vencendo em 30 dias; compras por fornecedor; OPs encerradas, refugo e custo; inadimplência e a pagar em 7 dias; pipeline e conversão do CRM.
- Venda conta na data da baixa de estoque do faturamento; margem pelo custo médio dessa baixa. Pedidos cancelados ou devolvidos ficam fora.
- `/api/erp/bi/exportar?tipo=pedidos|produtos` em CSV (separador `;`, abre direto no Excel).
- Migração `0043_erp_bi` (coluna `encerradaEm` na OP). Não aplicada em produção.
- Limitação: cálculo na hora, sem cubo/pré-agregação; períodos até 400 dias.

## Ajustes pós-lançamento (2026-11-03, pedidos do Mayck)
- **Clientes e Fornecedores separados**: duas telas e dois formulários (`/erp/clientes`, `/erp/fornecedores`). Mesma tabela `ErpParceiro` por baixo (NF-e, pedidos e financeiro seguem ligados); cadastrar um CNPJ já existente no outro papel só acrescenta o papel.
- **Contas a pagar**: campo `natureza` no título — Fornecedor ou Conta da empresa (água, luz, internet, telefone, aluguel, imposto, outra). Filtro na aba A pagar; categoria do plano de contas preenchida pelo tipo quando vazia. NF-e de entrada = Fornecedor.
- **Alertas por WhatsApp** (`/erp/alertas`, só Proprietário/Admin): um resumo por dia, na hora escolhida, para até 5 números: contas a pagar vencidas e a vencer em N dias (fornecedores e contas da empresa separados), produtos abaixo do estoque mínimo e produtos com saldo sem saída há N dias (padrão 15). Envia por um WhatsApp conectado da organização (`sendToStaffNumber`); prévia e envio de teste na tela. Tick a cada 5 min com `ENABLE_SCHEDULER=true`; um envio por dia (reserva atômica de `alertaUltimoDia`).
- **Produto**: código de barras interno gerado no cadastro quando vazio (EAN-13 prefixo 2, uso interno GS1); campo de custo e lista "+ Adicionar custo" (embalagem, rótulo...) em `custosAdicionais`; custo total = custo + adicionais. Fornecedor padrão com seletor. "Ponto de pedido" aparece na tela como "Estimativa de compra".
- **Etiqueta do lote**: QR `MCK1;lote interno;lote do fornecedor;validade;SKU;descrição` + Code 128 do lote interno (ZPL e folha comum). A conferência aceita o QR novo e o código simples.
- Migração `0044_erp_alertas` (aditiva).
- **Venda balcão** (botão em Pedidos, `POST /api/erp/vendas/balcao`): leitor de código de barras ou busca, cliente opcional ("Consumidor final", documento 00000000000), Dinheiro/Pix/Cartão com troco. Numa transação: pedido → aprovado → reservado → separado → faturado (`BALCAO-n`) → entregue (nova transição FATURADO→ENTREGUE, retirada no local), baixa de estoque FEFO/FIFO, título a receber criado e liquidado na conta (cria "Caixa" se não houver). Sem estoque: nada é gravado.
- **Planilhas** (`/api/erp/io/:entidade/{modelo|exportar|importar}`, entidades clientes, fornecedores, produtos): modelo CSV com cabeçalho e exemplos (`;`, UTF-8 com BOM; aceita `,` e Windows-1252). Importar mostra prévia (`?simular=1`) com erro por linha antes de gravar; atualiza pela chave (CPF/CNPJ ou SKU) só as colunas preenchidas. Produtos ligam o fornecedor padrão pelo CNPJ. Botões Exportar/Importar nas telas de Clientes, Fornecedores e Produtos. Regra para as próximas etapas: todo cadastro novo ganha modelo, importação e exportação.
- **Menu lateral** em categorias recolhíveis: MCK ERP, MCKBOT, MCK Mensagens no topo; depois Gestão, Conta, Plataforma.
- **Plano Completo** (antigo Combo): ERP + MCKBOT + MCK Mensagens; preço padrão R$ 100/mês (R$ 1.000/ano). Em produção o preço vale o que está em Painel Master → Configurações (a linha já gravada não muda sozinha).
- **Custos extras entram no CMV**: saídas, consumo de produção e venda usam custo médio + custos adicionais (`custoTotal`). Valor do estoque segue no custo médio.
- **Custo vindo de NF-e (XML)**: alterar exige a senha do usuário (`senhaCusto`), fica no log (`erp.produto.custo_xml`, antes/depois/quem) e avisa o proprietário por WhatsApp (celular dele; sem ele, números de alerta) e e-mail. Planilha não altera esse custo.
- **Relatórios** (`/erp/relatorios`): relatório do dia (vendido, balcão, recebido/pago por forma, CMV, alterações sensíveis), CSV e "Enviar agora". Às 22h (fuso da empresa) vai sozinho ao proprietário (WhatsApp + e-mail com CSV), se houve movimento. Depende de `ENABLE_SCHEDULER=true`.
- **Funcionários** (`/erp/funcionarios`): convite pela Equipe com áreas do ERP: acesso (clientes/fornecedores/CRM), vendas, estoque, compras/produção, financeiro/fiscal, relatórios. Quem tinha só o acesso antigo continua vendo tudo.

## IA consulta o estoque do ERP (v1.24.0, 2026-11-08)
- `AiSettings.productSource` por empresa: `catalogo` (padrão, só Produtos), `erp` (só produtos ativos do ERP, sem INSUMO) ou `ambos` (Produtos para descrição/promoção/link + ERP para o saldo; liga pelo SKU citado no nome/detalhes do produto ou pelo nome igual). `erpShowQuantity` (padrão falso: só "disponível / poucas unidades / sem estoque / sob encomenda") e `erpDepositoId` (nulo = todos).
- Disponível = Σ (físico − reservado − quarentena) dos lotes LIBERADOS e não vencidos, reaproveitando `saldosParaSaida` + `planejarAlocacao` (mesma regra da reserva). Preço = `precoBaseCents` (o ERP não tem tabela padrão; 0 = "preço não cadastrado"). "Poucas unidades" = até 5 un. ou até o estoque mínimo. Produzido sem saldo = sob encomenda; serviço = disponível.
- Código: `server/ai/productSource.ts` (seleciona só campos públicos do ErpProduto: nunca custo, custos adicionais ou fornecedor); prompt em `server/ai/service.ts`; rotas `GET/PUT /api/ai/products/source` e `POST /api/ai/products/preview` (aceita a fonte escolhida na tela). Tela: Produtos › "De onde a IA consulta os produtos".
- Acesso: ERP só com Plano Completo ativo/teste ou empresa da MCK (`isMckOrg`); sem isso ou com erro no ERP, volta ao catálogo. Migração `0050_ia_fonte_produtos` (só aditiva).

## Caixa do PDV (abrir e fechar caixa) — 2026-11-08
- **Pedido do Mayck:** venda balcão só com caixa aberto, para saber quando abriu, com quanto dinheiro e quando fechou.
- **Regra:** `POST /api/erp/vendas/balcao` sem caixa aberto responde **409 "Abra o caixa antes de vender"** e nada é gravado. Orçamentos e pedidos normais não dependem do caixa. Vendas antigas ficam como estão (`caixaSessaoId` nulo).
- **Sessão** (`ErpCaixaSessao`): conta financeira do tipo CAIXA, quem abriu, quando, dinheiro na abertura (obrigatório, pode ser 0), observação; no fechamento: quem, quando, dinheiro contado, esperado, diferença (sobra/falta), totais por forma (JSON), sangrias, suprimentos e observação. Uma sessão aberta por conta CAIXA (coluna única `contaAberta`, nula depois de fechar). Empresa com várias contas CAIXA pode ter vários caixas abertos; aí a venda informa `caixaSessaoId` (a tela mostra "Caixa da venda"); sem ele vale a única aberta ou a aberta pelo próprio usuário.
- **Venda:** pedido e recebimento (`ErpPedidoVenda.caixaSessaoId`, `ErpBaixa.caixaSessaoId`) ficam ligados à sessão. Dinheiro vai para a conta do caixa aberto; Pix e cartão seguem a conta escolhida (como antes). A venda trava a linha da sessão na transação: fechamento e venda não se cruzam.
- **Sangria/suprimento** (`ErpCaixaMovimento`): valor, motivo obrigatório, quem e quando. Lançam na conta do caixa (`origemTipo` `caixa_sangria`/`caixa_suprimento`, fora da DRE) e, se escolhida, a contrapartida em outra conta (cofre/banco). Sangria maior que o dinheiro esperado é recusada.
- **Fechamento:** esperado em dinheiro = abertura + vendas em dinheiro + suprimentos − sangrias (estornos de baixa saem da conta); diferença = contado − esperado; diferença ≠ 0 exige observação. Depois de fechado, os valores ficam congelados e nenhuma venda balcão sai até abrir de novo. A diferença não gera lançamento automático (só informa). O dinheiro de abertura também não é lançado (é o troco que já estava na gaveta).
- **API** (`/api/erp/vendas/caixa`, área `erp_vendas`; leitura também para `erp_financeiro` e `erp_relatorios`): `GET /` (contas CAIXA, sessões abertas com resumo, sessão padrão do usuário), `POST /abrir`, `GET /sessoes?de&ate&status&contaId` (data de abertura no fuso da empresa), `GET /sessoes/:id` (relatório: resumo, sangrias/suprimentos, vendas), `POST /sessoes/:id/movimentos`, `POST /sessoes/:id/fechar`. Auditoria: `erp.caixa.abrir`, `erp.caixa.sangria`, `erp.caixa.suprimento`, `erp.caixa.fechar`.
- **Telas:** Venda balcão (PDV) mostra a faixa "Caixa aberto desde HH:MM por Fulano — R$ X na abertura" com Sangria, Suprimento e Fechar caixa; caixa fechado → o botão "Venda balcão" abre "Abrir caixa" primeiro. Aba "Caixas" com o histórico (filtro de datas e situação) e relatório imprimível em `/erp/caixa/:id`. Horários no fuso da empresa (padrão America/Sao_Paulo).
- **Código:** `server/erp/vendas/caixa.routes.ts`, `caixa.calculo.ts` (contas puras), `balcao.routes.ts`; `web/src/erp/vendas/Caixa.tsx`, `Pedidos.tsx`, `Balcao.tsx`.
- **Migração** `0052_erp_caixa` (só aditiva: 2 tabelas novas + coluna `caixaSessaoId` em ErpPedidoVenda e ErpBaixa). Aplica no deploy normal.
- **Testes:** `tests/unit/erp-caixa.test.ts`, `tests/integration/erp-caixa.test.ts`; `erp-balcao-importacao` abre o caixa antes de vender; e2e `erp-balcao.spec.ts` abre o caixa na tela.

## Alerta diário inteligente + compra aprovada pelo WhatsApp — v1.30.0 (2026-11-19)
- **Pedido do Mayck:** alerta diário do ERP por WhatsApp profissional, bem explicado e mais inteligente, com pedido de compra aprovado respondendo à mensagem.
- **Texto** (`server/erp/alertas/formato.ts`, só contas puras): cabeçalho com nome da empresa, dia da semana e data; linha "Hoje: …" com o resumo; seções numeradas na ordem 💰 Contas a pagar → 📦 Estoque baixo → ⏳ Validade → 💤 Produtos parados → 🧾 Caixa de ontem → ✏️ Alterações de ontem (só as que têm conteúdo e estão ligadas); "✅ Ações sugeridas" no fim; rodapé "ERP › Alertas". Mais de 3.500 caracteres → várias mensagens (corta entre seções; da 2ª em diante "(parte N/M)"); cada número recebe as partes em ordem e para na primeira que falhar. Máximo de 15 itens por lista ("… e mais N").
- **Dados** (`server/erp/alertas/dados.ts`): estoque baixo = saldo físico < estoque mínimo; consumo médio = saídas (SAIDA + CONSUMO) dos últimos `consumoDias` (30); **sugestão** = máx(falta para o mínimo, mínimo + consumo/dia × (`coberturaDias` + prazo do produto) − saldo), respeita o lote mínimo, arredonda para unidade inteira (`sugestaoCompra`). Fornecedor: fornecedor padrão do produto → fornecedor do último pedido de compra não cancelado → fornecedor do lote da última entrada. Custo: preço do último pedido de compra → custo da última entrada → custo médio. Parados: saldo > 0, criado antes da janela e sem SAIDA/CONSUMO há `alertaSemSaidaDias` (padrão 15; 0 = desligado, como antes), com dias parado e valor a custo médio, ordenados por valor. Validade: lotes com saldo e validade até hoje + `validadeDias` (30) — vencidos e vencendo, quantidade e valor a custo médio. Caixa: sessões abertas/fechadas no dia anterior (fuso da empresa) e as ainda abertas, com abertura, vendas por forma, sangrias/suprimentos (motivo, quem, hora), contado × esperado e diferença (quebra) + justificativa. Alterações (AuditLog do dia anterior): `erp.produto.preco` (NOVO, gravado ao mudar o preço na tela ou por planilha), `produto.custo`/`custo_xml`/`custos_adicionais`, `estoque.ajuste_saida`, `estoque.entrada`, `inventario.aprovar`, `baixa.estornar`, `pedido.cancelar`, `titulo.cancelar`, com quem e hora. Custo mudado por planilha também passa a ser registrado.
- **Opções** (`ErpConfig.alertaOpcoes`, JSON; sem valor = padrões, todas ligadas; `server/erp/alertas/opcoes.ts`): `validade`, `validadeDias`, `caixa`, `alteracoes`, `compraWhatsapp`, `consumoDias`, `coberturaDias`. `PUT /api/erp/alertas` aceita `opcoes` (parcial; sem o campo mantém o salvo) e `GET` devolve `opcoes`. Tela ERP › Alertas: cada seção liga/desliga, dias de validade, dias parado, consumo/cobertura, compra pelo WhatsApp, prévia em mensagens e "Compras aprovadas pelo WhatsApp" (`GET /api/erp/alertas/aprovacoes`).
- **Aprovação pelo WhatsApp** (`server/erp/alertas/aprovacao.ts`, tabela `ErpAprovacaoCompra`): no envio (agendado ou "Salvar e enviar agora"), com itens de estoque baixo e a opção ligada, cria um código de 4 caracteres (sem 0/O/1/I), guarda os itens sugeridos e os números autorizados (números do alerta + celular do proprietário) e marca como SUBSTITUIDA a pendente anterior. Vale 48 h. Em `server/whatsapp/inbound.ts`, ANTES de criar contato/SDR/IA/fluxos: mensagem de texto de número autorizado (conferido no envio e de novo agora) com aprovação recente → `tratarRespostaAprovacao`. Entende por palavras (com/sem acento): "aprovado", "ok aprovado", "pode comprar", "autorizado", "aprovado 1,3", "1 e 3", "2-4", código opcional; "não aprovado"/"cancelar" recusa; item fora da lista avisa. Resposta livre que palavras não resolvem ("beleza, manda só o café") → IA da empresa (MCK IA ou a dela) como apoio, só se a IA estiver ligada e a cota da MCK IA não tiver acabado (uso gravado no AiUsage); a IA responde JSON APROVAR/RECUSAR/OUTRO. Não é sobre a compra → segue o caminho normal (a mensagem não é engolida).
- **Ao aprovar:** trava atômica (status PENDENTE → PROCESSANDO com `versao`); confere se o ERP está liberado no plano; itens com fornecedor → um **pedido de compra em RASCUNHO por fornecedor** (estado inicial da `compra.machine`; preço = custo de referência; observação com código e número que aprovou; auditoria `erp.pedido_compra.criar` com origem "aprovação pelo WhatsApp"); itens sem fornecedor → pergunta um a um "Tem preferência de fornecedor para X? Responda com o nome ou NÃO": nome casa com fornecedor cadastrado (exato vence; senão todas as palavras; vários → lista numerada para escolher), "NÃO"/"sem preferência"/"tanto faz" → **solicitação de compra RASCUNHO sem fornecedor** (origem WHATSAPP, para cotar), "cancelar" para as perguntas. Confirmação no WhatsApp: número do pedido/solicitação, fornecedor, itens, quantidades, valor estimado e link `/erp/compras`. Nunca envia nada ao fornecedor nem aprova o pedido no ERP.
- **Segurança/idempotência:** só números autorizados da própria empresa (o canal que recebeu define a empresa); ids de mensagem já tratados guardados (reenvio da Meta não duplica); "aprovado" de novo responde "já foi aprovada" com os números; vencido/substituído/recusado responde e não cria nada; cada passo da conversa grava com trava otimista (`versao`); o agendador marca EXPIRADA o que passou de 48 h. Mensagem tratada aqui não cria contato nem lead do SDR.
- **Migração** `0058_erp_alerta_inteligente` (só aditiva: coluna `ErpConfig.alertaOpcoes` + tabela `ErpAprovacaoCompra`). Aplica no deploy normal.
- **Testes:** `tests/unit/erp-alerta-inteligente.test.ts` (sugestão, opções, texto, divisão, interpretação, fornecedor, confirmação) e `tests/integration/erp-alerta-inteligente.test.ts` (todas as seções com dados reais, opções da tela, aprovação completa pelo inbound, ambíguo, NÃO → solicitação, idempotência, número não autorizado, recusa, vencido, substituição, tick, IA de apoio, lista de aprovações).
- **Limites conhecidos:** no modo QR, se o WhatsApp entregar a mensagem só com o LID (sem o número), a resposta não é reconhecida como da equipe e segue o caminho normal; "pedido em rascunho" não tem preço quando o produto não tem nenhum custo de referência (o ERP pede o preço antes de enviar).

## Alerta claro, lote interno e código do produto automáticos — v1.31.0 (2026-11-20)
Pedido do Mayck olhando o alerta real: "está bem confuso, não sei quantas quantidades preciso comprar, não sei o que é valor".

- **Causa do "5 30" no alerta:** o campo Unidade do produto era texto livre (até 6 caracteres) no cadastro e na planilha; o produto foi salvo com unidade "30" e o alerta montava `qtd + ' ' + unidade` ("Saldo: 5 30 · Mínimo: 20 30"). Dois números separados por espaço o WhatsApp sublinha como telefone. Não era bug de conta.
- **Unidade (`server/erp/shared/unidade.ts`, usado pelo servidor e pela web):** só sigla que começa por letra (UN, CX, KG, M2, PÇ…); número sozinho é recusado com mensagem clara (cadastro, planilha). Na leitura, unidade numérica/vazia/estranha vira UN. `qtdUn` escreve por extenso ("15 unidades", "1 caixa", "2,5 kg"; singular de 1 até menos de 2). Cadastro com lista de unidades + "Outra sigla…"; produto com unidade ruim abre com aviso.
- **Texto do alerta (`formato.ts`):** estoque baixo uma informação por linha (📦 Tem hoje · 🎯 Estoque mínimo · 📉 Vende em média X por dia · dura uns N dias · 🛒 *Comprar* + o porquê · 💲 Preço por unidade (origem) · 💰 *Total da compra* · 🏭 Fornecedor); parados com "Dinheiro parado no estoque (preço de custo)"; validade com "Lote interno … · Lote fabricante …"; caixa e alterações sem números lado a lado ("19/11 às 08:00", "de *R$ X* para *R$ Y*"); "O que fazer hoje" no lugar de "Ações sugeridas"; data no topo por extenso. `trechosParecemTelefone()` é a heurística usada nos testes (pares de números separados por espaço/traço ou ≥ 7 dígitos fora de R$ e de códigos que começam por letra). Conversa de aprovação (`aprovacao.ts`) no mesmo estilo. A prévia em ERP › Alertas mostra negrito/itálico como no WhatsApp.
- **Lote interno automático (`server/erp/estoque/servico.ts` › `entrada`/`proximoLoteInterno`):** toda entrada sem número de lote (manual, saldo inicial, NF-e de entrada/recebimento de compra, produção) gera o lote interno pela sequência da empresa `ErpConfig.proximoLoteInterno` (UPDATE com increment dentro da transação = trava a linha no Postgres; número que já exista para o produto é pulado). Formato padrão novo `L{AA}{MM}-{SEQ4}` (ex.: L2611-0001, dia de Brasília); quem nunca mudou o formato (antigo `{AA}{MM}{DD}-{SEQ}`) passa a usar o novo; formato personalizado é mantido (token novo `{SEQ4}`). Lote do fabricante = coluna existente `ErpLote.loteFornecedor` (digitado na entrada manual como "Lote do fabricante" ou `rastro/nLote` do XML). Transferência e inventário continuam usando o lote que já existe. Lotes antigos (inclusive "UNICO" e "261101-1") não mudam. A NF-e deixou de ler/gravar o contador fora da transação (antes podia repetir número com duas notas ao mesmo tempo). Produto sem controle de lote agora também tem lotes (FIFO); a conferência por leitura aceita o SKU/código de barras em qualquer lote desse produto.
- **Validade:** obrigatória na entrada só para produto que controla validade ("perecível"); a tela de entrada mostra o campo só nesse caso. Lotes: colunas "Lote interno / fabricante" e validade ("não controla" para quem não controla); cadastro do produto perecível mostra a validade dos lotes com saldo. Etiquetas: "LOTE INT." e "LOTE FAB.".
- **Código do produto automático (`server/erp/produtos/codigo.ts`):** SKU vazio no cadastro, na planilha (coluna SKU deixou de ser obrigatória) e no "criar produto" da NF-e → próximo código no padrão mais usado pela empresa (prefixo de letras + número com zeros, ex.: MCK0001 → MCK0002); sem nenhum, P0001. Único por empresa pelo `@@unique([orgId, sku])`: colisão em cadastros simultâneos tenta o número seguinte. Edição com código vazio mantém o atual; códigos existentes nunca mudam. Tela: "Código (automático)", travado; Proprietário/Admin podem digitar/alterar.
- **Excluir produto:** `GET /api/erp/produtos/:id/uso` e `DELETE /api/erp/produtos/:id` (só Proprietário/Admin). Já usado (movimentos/saldo, lotes, vendas, compras/solicitações/cotações, NF-e de entrada, inventário, produção) → arquivado (`ativo=false`), AuditLog `erp.produto.arquivar`; nunca usado → apagado com tabela de preço, de-para de fornecedor, regra fiscal e roteiro do produto, AuditLog `erp.produto.excluir`. Tela com confirmação explicando o que vai acontecer.
- **Migração:** nenhuma (o lote do fabricante usa `loteFornecedor`, que já existia; a próxima livre continua 0059).
- **Testes:** tests/unit/erp-alerta-claro.test.ts, tests/unit/erp-codigo-lote.test.ts, tests/integration/erp-codigo-lote-produto.test.ts (+ ajustes de texto nos testes do alerta e do lote). No SQLite dos testes as entradas simultâneas rodam em sequência (o SQLite trava o arquivo); com `TEST_DB=postgres` rodam juntas.

## Compras › O que comprar e unidade de compra (embalagem) — v1.32.0 (2026-11-20)
- **Tela** `web/src/erp/compras/OQueComprar.tsx` (aba padrão de Compras): só produtos zerados ou abaixo do mínimo (zerado sem mínimo entra só se teve saída em 90 dias), zerados primeiro e depois por dias de cobertura; agrupado por fornecedor com subtotal; total geral no rodapé; quantidade editável (em embalagens quando o produto tem); celular vira cartões. "Gerar pedido de compra" → `POST /api/erp/compras/o-que-comprar/gerar` cria um `ErpPedidoCompra` RASCUNHO por fornecedor (sem fornecedor → `ErpSolicitacaoCompra` RASCUNHO), AuditLog `erp.pedido_compra.criar` / `erp.solicitacao_compra.criar`; área `erp_compras` (leitura também para estoque/financeiro).
- **Lista** `GET /api/erp/compras/o-que-comprar?cobertura=N` (`server/erp/compras/oQueComprar.ts`), a mesma usada pelo alerta diário (`alertas/dados.ts`).
- **Fórmula** (`server/erp/compras/sugestao.ts`, pura): consumo/dia = saídas (SAIDA, CONSUMO e AJUSTE negativo; não contam inventário/transferência) dos últimos 30 dias (opção "consumo" do alerta) ÷ janela; sem saída em 30, usa 90; janela nunca menor que 7 dias nem maior que a idade do histórico. Sugerida = max(consumo/dia × (cobertura 30 + prazo do fornecedor) − saldo − já pedido, mínimo − saldo − já pedido, 0) → lote mínimo → arredonda para cima (embalagem inteira; sem embalagem, unidade inteira ou 0,1 para kg/m/l). Já pedido = itens não recebidos de pedidos RASCUNHO, EM_APROVACAO, APROVADO, ENVIADO, RECEBIDO_PARCIAL. Mudança de v1.30/1.31: o mínimo deixou de ser somado à necessidade (agora é piso).
- **Custo de referência:** última entrada com custo → último pedido de compra → custo do cadastro.
- **Embalagem** (`server/erp/shared/embalagem.ts`, pura, usada também pela web): `ErpProduto.unidadeCompra` (sigla da lista; vazio = mesma do estoque) e `fatorCompraMil` (unidades base por embalagem em milésimos, padrão 1000). Estoque e pedidos continuam na unidade base (preço por unidade base; o recebimento por NF-e não mudou). Telas mostram "5 pacotes (50 peças) · R$ 20,00/pacote · R$ 2,00/peça · Total R$ 100,00"; entrada de estoque e itens de compra aceitam digitar em embalagens. Unidade de compra igual à de estoque zera a embalagem; PUT sem os campos mantém o salvo. Planilha de produtos: colunas "Unidade de compra (PCT, CX, RL...)" e "Quantidade por embalagem".
- **Migração** `0059_erp_unidade_compra` (só aditiva: `unidadeCompra` TEXT, `fatorCompraMil` INTEGER NOT NULL DEFAULT 1000).
- **Não feito:** de-para da NF-e (XML) não herda o fator do produto (continua por fornecedor); preço por embalagem quebrado (ex.: R$ 20,00 / 3) é guardado arredondado por unidade, então o total pode diferir em centavos do preço da caixa.

## Rastreabilidade de lote, etiquetas GS1-128 + QR, inventário com senha do proprietário e cadastros editáveis — v1.33.0 (2026-11-20)
Pedido do Mayck (print da tela Produtos no celular: a Canetack mostrava só "UN · lote FIFO", sem lote interno nem do fornecedor): rastreabilidade completa de lote; depois, no mesmo pedido: busca única, edição completa de cadastros, inventário por código de barras com relatório e aprovação por senha, e etiqueta do lote com código de barras + QR.

- **Base:** todo saldo (`ErpSaldo`), movimento (`ErpMovimento`) e reserva já tinham `loteId`; o rastreio é calculado do razão (só inserção), das reservas e do grafo `ErpTraceLink` (genealogia `lote compoe lote`). Nada novo precisa ser gravado para lotes antigos.
- **Saldo antigo sem lote:** o lote "UNICO" (antes da v1.31) vira `L-INICIAL` (mesmo id; saldos, movimentos, reservas e contagens continuam ligados). Migração `0060` faz o UPDATE no deploy; `normalizarLotesSemNumero()` (server/erp/estoque/rastreio.ts) cobre o que aparecer depois. Data de entrada = primeiro movimento. Inventário não cria mais "UNICO" (gera lote interno).
- **Telas:** Produtos mostra "📦 N lotes · M com saldo" → cartões por lote (`web/src/erp/estoque/lotes.tsx`); Estoque › "Saldo por lote"; **MCK ERP › Rastreio de lote** (`/erp/rastreio`, `?q=`, `?lote=`, `?pedido=`): busca única, linha do tempo, onde está, reservado para, para onde foi (cliente/OP/baixa/inventário, com os lotes gerados na produção), clientes alcançados via produto acabado (recall), de onde veio (insumos → fornecedor/NF), CSV e impressão. Pedido › "🔎 Lotes deste pedido".
- **API (`/api/erp/estoque`):** `GET /rastreio?q=` (identifica: chave de 44 dígitos, número → pedido de venda/compra/NF de entrada/NF-e de saída/nº digitado no faturamento, código de barras, texto → produto/lote/lote do fornecedor), `GET /rastreio/lote/:id`, `GET /rastreio/lote/:id/csv`, `GET /rastreio/pedido/:id`, `GET /lotes/produto/:id`, `GET /lotes-saldo`, `GET /ler?codigo=`, `GET /etiquetas/pdf?lotes=id:cópias,...&formato=rolo|a4`. Produtos: `lotes: { total, comSaldo }` na lista.
- **Saídas gravam o lote:** conferido em teste para venda (pedido e balcão), consumo da produção, baixa manual, inventário e transferência. Novos tipos de movimento: `SEPARACAO` (quantidade 0, só linha do tempo; gravado na conferência por leitura) e `DEVOLUCAO` (ação DEVOLVER com `voltarEstoque: true` devolve ao mesmo lote/endereço; `devolverAoEstoque` em servico.ts).
- **Etiqueta do lote:** GS1-128 (Code 128 com FNC1) com AIs `(11)` fabricação, `(17)` validade, `(241)` código do produto, `(10)` lote interno; QR `MCK1;lote;lote fornecedor;validade;SKU;nome;fabricação;empresa` (6 primeiros campos iguais ao formato antigo). `server/erp/estoque/codigoLote.ts` (puro: gerar e ler — GS, `]C1`, parênteses e sem separador), PDF em `etiquetaPdf.ts` (pdf-lib, nova dependência MIT; encoder Code 128 do jsbarcode, sem canvas). Etiqueta estreita (< 0,19 mm por barra) tira as datas das barras (continuam no QR e no texto). ZPL também com GS1-128. Nome da empresa: nome fantasia/razão do Fiscal, senão o nome da organização. Entradas (manual e NF-e) devolvem `etiquetas: [{ loteId, numero, sugeridas }]` (uma por embalagem quando há unidade de compra, senão por peça; granel = 1; até 999) e a tela abre "Gerar etiqueta e imprimir". Data de fabricação (opcional) na entrada manual.
- **Leitura (`server/erp/estoque/leitura.ts` › `resolverCodigo`):** GS1 do lote, QR, número do lote, código do produto e EAN/GTIN (com/sem zeros à esquerda). Usada no inventário, em Estoque › Saldos (filtra para mover/baixar/corrigir) e na conferência da separação. Câmera: `BarcodeDetector` do navegador (Chrome/Android) — `Permissions-Policy` passou a `camera=(self)`; sem suporte, leitor USB/Bluetooth ou digitação.
- **Inventário:** contagem por lote+local; modo `LEITURA` (cada leitura soma 1; produto com vários lotes no local pede o lote e as próximas leituras vão para ele) e `MANUAL` (quantidade digitada). Encerrar (`ENVIAR`) congela custo por linha, grava `resumoJson` e, havendo diferença, chama `notificarProprietario` (WhatsApp dos donos/números de alerta + e-mail) só com o resumo e marca `notificadoEm` (aviso no app: `GET /inventarios/pendentes`, mostrado no Estoque e no Painel). Relatório `GET /inventarios/:id/relatorio[?formato=csv]` (por produto/lote/local: contado, sistema, diferença qtd e R$; totais sobras/faltas/líquido; maior divergência) — `inventario-relatorio.ts` (puro). `APROVAR` exige motivo + **senha de um Proprietário** (bcrypt, reautenticação na hora; funcionário pode enviar se o dono digitar; 5 erros/15 min por empresa → 429; recusas no AuditLog `erp.inventario.senha_recusada`); sem diferença conclui sem senha. `POST /inventarios/corrigir-saldo` (prévia antes/depois/R$ com `previa: true`; aplica como inventário de 1 linha, AuditLog `erp.estoque.correcao_saldo`). Ajustes = movimentos `INVENTARIO` por lote.
- **Cadastros:** cliente/fornecedor ganham `inscricaoMunicipal`, `condicaoPagamentoId`, `tabelaPrecoId` (pedido novo usa os do cliente quando não vierem) e `prazoEntregaDias` (O que comprar usa quando o produto não tem prazo). Campos novos opcionais sem padrão (tela/planilha antiga não apaga). `GET /crm/parceiros/:id/travas`: CPF/CNPJ trava depois de NF-e (entrada ou saída); limite e status só OWNER/ADMIN (403 para os demais). Contatos: `PUT /:id/contatos/:contatoId`, e criar/editar/excluir no AuditLog. Produto: `GET /produtos/:id/travas` (código trava se saiu em NF-e; unidade trava com movimentação, exceto unidade antiga inválida; controle de lote trava com saldo); código só OWNER/ADMIN no servidor; campo descrição na tela. `diferencas()` (shared/auditoria.ts) grava antes → depois só dos campos alterados (`erp.parceiro.editar`, `erp.produto.editar`).
- **Migração `0060_erp_rastreio_inventario`** (aditiva): colunas novas em ErpInventario, ErpInventarioContagem e ErpParceiro + UPDATE UNICO → L-INICIAL. Próxima livre: 0061.
- **Testes:** tests/unit/erp-rastreio.test.ts, tests/unit/erp-codigo-lote-gs1.test.ts, tests/integration/erp-rastreio-lote.test.ts, tests/integration/erp-inventario-v133.test.ts, tests/integration/erp-editar-cadastros.test.ts (+ ajustes em erp-estoque-vendas e security-anti-ataque).
- **Não feito / limites:** sem e-mail/WhatsApp ao fornecedor; câmera depende do `BarcodeDetector` (iPhone/Safari não tem: usar leitor ou digitar); PDF da tela de rastreio é pela impressão do navegador; NF-e emitida pelo ERP não grava o lote no XML (rastro/nLote) — o vínculo é pelo pedido.

## Leitura unificada (código de barras / QR), venda balcão por leitura, localizar pedido e Zebra direta — v1.34.0 (2026-11-20)
Pedido do Mayck: "venda para o balcão / localizar pedido / tudo que tenha para localizar pedido ou vender ou fazer rastreabilidade deve ser feito também via QR code ou código de barra, o coletor ou por celular"; e, no mesmo dia, "a etiqueta zebra está fazendo download, deve imprimir diretamente pelo aplicativo ao localizar a impressora".

- **Componente único de leitura** (`web/src/erp/leitura/Leitor.tsx`: `CampoLeitura`, `LeitorCamera`, `sinal`): leitor USB/Bluetooth em modo teclado (digita + Enter), câmera (`BarcodeDetector`: EAN/UPC, Code 128/GS1-128, ITF, Code 39, QR, Data Matrix, PDF417) e digitação; bipe/vibração de acerto e bipe grave duplo de erro com a mensagem na tela. Usado em Venda balcão, Localizar pedido, Rastreio, Inventário, Estoque (filtro e entrada manual), conferência do recebimento da NF-e (cada leitura soma 1 no item, pelo EAN/código do fornecedor ou pelo produto vinculado; produto fora da nota = alerta) e separação do pedido (conferência com quantidade por leitura; item/lote errado = alerta com os lotes certos, regra já existente em `conferir`). `lotes.tsx` reexporta os dois componentes (compatível).
- **Classificação pura** (`server/erp/leitura/codigo.ts`, também usada pela web): pedido (`PV-123`, `PV123`, `MCKPV:123`), chave de 44 dígitos (código de barras do DANFE, chave com espaços, QR da NFC-e com `p=`/`chNFe=`; DV módulo 11 conferido), etiqueta do lote (GS1/QR) ou código comum.
- **Ler código de qualquer tela:** botão "📷 Ler código" fixo no início da barra do ERP + tecla F2 (`web/src/erp/leitura/LerCodigo.tsx`). `GET /api/erp/leitura?codigo=` devolve `{ tipo, titulo, destino }`: pedido → `/erp/pedidos/:id`; chave → pedido da NF-e de saída (ou nº digitado no faturamento) / rastreio da NF-e de entrada; etiqueta/lote → `/erp/rastreio?lote=`; produto → `/erp/rastreio?q=SKU`; resto → `/erp/localizar?q=`. Só informa o destino; a tela de destino continua conferindo a permissão. Área: `erp_vendas` (leitura também para estoque/compras/financeiro/relatórios).
- **Localizar pedido** (`/erp/localizar`, menu "Localizar pedido"; `GET /api/erp/vendas/localizar?q=`, `server/erp/vendas/localizar.ts`): código PV, nº do pedido, nº da NF-e emitida, nº digitado no faturamento, `BALCAO-n`, chave (DANFE/QR NFC-e), cliente (nome/fantasia/documento), lote (etiqueta, lote interno ou do fornecedor → pedidos com saída/devolução/reserva daquele lote) e produto (código de barras, código, nome). Cada resultado diz "encontrado por". Até 100 pedidos.
- **Documentos com o código do pedido** (`GET /api/erp/vendas/localizar/documento/:id`; `web/src/erp/vendas/documento.ts`): recibo (bobina 80 mm; "não é documento fiscal"), pedido (A4 com preços) e romaneio (A4 sem preços, endereço/lote/validade/conferido e assinaturas), todos com QR + Code 128 de `PV-n`. Botões no pedido (Recibo só na venda balcão), em Localizar e no fim da venda balcão.
- **Venda balcão por leitura:** `GET /api/erp/vendas/balcao/ler?codigo=` → produto (preço, saldo disponível), `lote` quando a etiqueta traz o lote (saldo do lote, vencido/bloqueado/quarentena) e `sugestao` (lote que sai pela regra FEFO/FIFO, informativo). Cada leitura +1 na linha produto+lote; quantidade e preço editáveis; digitação/nome continua. Item com `loteId` (novo, opcional, em `itemSchema` de pedidos): `montarItens` confere que o lote é do produto e da empresa; `reservarPedido` reserva só daquele lote (sem completar com outro); falta → "Sem estoque disponível: … no lote X lido". Desconto segue `descontoMaxBp`/gestor. Cliente opcional (consumidor final). Cartão com maquininha segue igual (o ensaio já passa o lote). Fim da venda: imprimir recibo, abrir a venda (NF-e) e o código PV para localizar.
- **NF-e da venda balcão:** `POST /api/erp/fiscal/nfe/pedido/:id` agora aceita pedido balcão `ENTREGUE` (antes só `SEPARADO`); a tela do pedido mostra "Emitir NF-e" com aviso (CPF/CNPJ e endereço do cliente; NFC-e não existe ainda; em homologação sem valor fiscal). Nada é emitido automaticamente.
- **Zebra direta** (`web/src/erp/estoque/zebra.ts` + `ZebraImprimir.tsx` › `BotaoZebra`/`LocalizarImpressora`): "Localizar impressora" guarda a escolha no aparelho (`localStorage mck:zebra:impressora`). Ordem: (1) Web Bluetooth — serviço Zebra Parser Data `38eb4a80-c570-11e3-9507-0002a5d5c51b`, característica de escrita `…4a82…`, filtros por serviço e nomes (XX…, ZQ, ZD, ZT, ZR, QLn, iMZ) + "mostrar todos", blocos de 180 bytes (cai para 20 se o primeiro falhar), reconexão por `getDevices()` quando existe; (2) WebUSB — fabricante 0x0A5F, interface classe 7 / endpoint bulk OUT, blocos de 16 KB; (3) Zebra Browser Print (`http://localhost:9100` e `https://localhost:9101`: `/available`, `/default`, `/write`), que também enxerga impressora de rede; (4) rede/IP direta não é possível do navegador (HTTPS não abre TCP 9100 nem `http://IP`): orientado a adicionar no Browser Print. Status na tela (procurando, conectando, imprimindo, enviado, erro + "o que fazer"); etiqueta de teste; download do .zpl só no fim ("Nenhuma forma funcionou?") explicando o motivo. Aplicado em Estoque › Etiquetas, "Gerar etiqueta e imprimir" após entrada (lotes e Produtos › lotes) e NF-e de entrada lançada. `Permissions-Policy`: `usb=(self), bluetooth=(self)`; CSP `connect-src` + `https://localhost:9101`. Não existe etiqueta só de produto (sem lote): as etiquetas do produto saem pelos lotes dele.
- **Migração `0061_erp_leitura_balcao`** (aditiva): `ErpPedidoItem.loteId` (opcional) e índice `ErpPedidoVenda(orgId, nfNumero)`. Próxima livre: 0062.
- **Testes:** tests/unit/erp-leitura.test.ts, tests/unit/erp-zebra.test.ts, tests/integration/erp-leitura-balcao.test.ts.
- **Limites:** câmera só onde há `BarcodeDetector` (Chrome Android; iPhone/Safari e Firefox não) — usar leitor ou digitar; Zebra sem teste com impressora física (BLE só em modelos Link-OS com Bluetooth LE; Bluetooth clássico não funciona no navegador; iPhone não tem Web Bluetooth/WebUSB; WebUSB no Windows costuma ser bloqueado pelo driver ZDesigner → Browser Print); recibo não é NFC-e; NF-e da venda balcão com "Consumidor final" (sem CPF) deve ser recusada pela montagem/SEFAZ.

## v1.35.0 — menu: Localizar dentro de Pedidos, Ler código dentro de Venda balcão
- Pedido do dono (20/11 17:01). `ERP_ITENS` (web/src/erp/ErpNav.tsx) ganhou `pai`: subitens aparecem numa segunda linha de abas quando o grupo está aberto e recuados (↳) no menu lateral.
- Pedidos › Localizar pedido: rota nova `/erp/pedidos/localizar` (a antiga `/erp/localizar` redireciona mantendo `?q=`; o servidor de leitura já devolve o caminho novo).
- Venda balcão (PDV) › 📷 Ler código: tela `/erp/balcao/ler` (área erp_vendas). O botão solto da barra saiu; a tecla F2 continua abrindo o leitor em qualquer tela (`AtalhoLerCodigo`). Leitura nas telas de separação, recebimento, inventário e rastreio inalterada.
- Teste: tests/unit/erp-menu-grupos.test.ts.
