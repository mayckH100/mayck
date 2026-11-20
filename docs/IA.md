# IA da MCK (v1.35.0)

Mapa completo e auditoria: ver a seção "Fase 1" do plano registrado na ATA (2026-11-20). Resumo técnico:

## Regra fixa do dono
A IA é PROIBIDA de transferir para humano, exceto quando o cliente pede explicitamente um atendente/humano/pessoa
(`server/ai/humanRequest.ts`). Falha, resposta vazia ou "não sei" → texto de falha e segue com a IA. Continuam valendo:
bloco "Transferir para humano" dos fluxos e ações configuradas da qualificação (campanhas). SDR/campanhas: lead quente,
irritado ou dúvida fora das Instruções só **avisam a equipe** (`avisarEquipe`, server/sdr/conversaService.ts).

## Camada única (`server/ai/core.ts` → `aiChat`)
Usada por: extração do SDR (cache 10 min), follow-up, campanhas, aprovação de compra do ERP, resposta automática e
reescrita de voz. Faz: modelo reserva (Gemini: outro Flash grátis; `AI_FALLBACK_MODEL` força/desliga) em falha
passageira (timeout, rede, vazio, 429/5xx), espera `AI_RETRY_BACKOFF_MS` após 429/503, timeout por tentativa e total,
grava AiUsage com `purpose` e `promptVersion`. O atendimento principal (`server/ai/service.ts`) mantém a própria política
(3 tentativas) e grava `purpose = atendimento`. Versões dos prompts: `server/ai/prompts.ts` (subir a versão ao mudar).

## Atendimento
- Busca na base (`retrieve`): BM25 com radical; pergunta curta (< 4 termos) busca junto com as 2 anteriores do cliente
  (`searchQuery`); documentos "Correção: …" valem 1,5× (`boostCorrections`).
- Dados do contato (`server/ai/contactProfile.ts`): nome (se não for telefone), etiquetas, etapa do Kanban, próximo
  compromisso — como dados, não instruções.
- Checagem de valores (`server/ai/valueGuard.ts`): valor/percentual/prazo fora das Instruções + base + produtos + conversa
  → `AiUsage.quality = valor_fora_base`. `AiSettings.guardValues` (padrão false): 1 nova tentativa com crítica (se a cota
  permitir) → senão `TEXTO_CONFIRMAR_VALOR` + nota "Tarefa para a equipe". Não roda quando a resposta agendou/registrou
  pedido, nem na IA avançada de leads (que tem a própria checagem).

## Correções ("IA respondeu mal")
`POST /api/ai/feedback {messageId, correction}` (Proprietário/Admin; só mensagens OUT da IA da própria organização) →
KnowledgeDoc "Correção: <pergunta>" reindexado + AiFeedback + nota no Inbox. `GET /api/ai/feedback`,
`DELETE /api/ai/feedback/:id` (apaga o documento junto). `GET /api/ai/quality`: consumo por finalidade (30 dias),
valores fora da base, bloqueados e correções.

## Migração
`0062_ia_qualidade` (só aditiva): `AiSettings.guardValues`, `AiUsage.purpose/promptVersion/quality`, tabela `AiFeedback`.
