# Voz do vendedor (v1.47.0): áudios gravados + voz clonada

Tela: **Inteligência artificial › Voz › "🎙️ Voz do vendedor: áudios gravados e voz clonada"** (rota `/ia/voz`), só Proprietário/Admin.
API: `/api/ai/voz/*` (server/ai/voice/clone/routes.ts). Migração `0071_voz_clonada_biblioteca` (só aditiva).

## 1. Áudios gravados (biblioteca) — grátis, funciona já
- O vendedor grava pelo app (microfone; `Permissions-Policy: microphone=(self)`) ou envia arquivo. O navegador decodifica MP3/M4A/OGG/WAV e manda WAV 24 kHz; o servidor converte para OGG/Opus (nota de voz). Até 40 áudios, 2 min cada.
- Cada áudio: nome, "quando usar", o que é dito (se vazio, transcreve sozinho com o motor da IA).
- Com "A IA pode responder com estes áudios" ligado (`AiSettings.voiceLibraryEnabled`), o prompt lista os áudios ainda não enviados na conversa; a IA põe `[AUDIO:id]` na resposta. `generateAiReply` tira o marcador e valida (existe, ativo, mesma empresa) → `AiReply.clipId`. `sendAiReply(..., { clipId })` manda o áudio como PTT (QR: "gravando áudio…") e o resto por escrito. Falha no envio → texto (transcrição + resposta). Cliente que pediu texto na conversa não recebe áudio gravado. Mensagem gravada com corpo `[áudio gravado] <nome>` (é assim que não repete).

## 2. Voz clonada
### Fluxo
1. **Aceite (LGPD art. 11, I — voz é biométrica):** nome completo do dono da voz, função, e-mail opcional, voz masculina/feminina, termo (`CONSENT_VERSION = voz-v1-2026-11`), 2 caixas de aceite e **assinatura digitada igual ao nome**. Grava o texto aceito, data, IP e usuário; AuditLog `voz.clone.aceite`.
2. **Amostra de 1 a 3 min** lendo o roteiro (1ª frase = autorização falada). Guardada cifrada no banco (AES‑256‑GCM, MASTER_KEY, AAD `orgId:id`, formato `MCK1…`). AuditLog `voz.clone.amostra`.
3. **Fila:** `processProfile` manda a amostra ao servidor de voz (register), gera a **prévia** pelo mesmo caminho das respostas e fica `PRONTA`. Sem servidor/fora do ar → `NA_FILA`, a rotina de fundo (2 min, `startVoiceCloneLoop`) tenta de novo (até 30 vezes).
4. **Ativar** (só com prévia) → `AiSettings.voiceProvider = 'clone'`, `voiceCloneProfileId`, voz ligada. "Quando responder em áudio" (espelhar/sempre/nunca) continua valendo.
5. **Excluir a pedido:** apaga amostra, prévia, cache e a voz no servidor de voz (se ele estiver fora, marca `remover_no_servidor` e a rotina termina depois); a IA volta ao Gemini. O registro do aceite e da exclusão fica, sem áudio.

### Motor (`CloneVoice`, server/ai/voice/clone/service.ts)
- Cache por frase (`VoiceCloneCache`, sha256 de voz+texto, 400 por empresa).
- **Modo rápido (padrão):** voz-base grátis (Gemini TTS da empresa ou MCK IA, Puck/Kore conforme o gênero; quem usa OpenAI usa ash/coral) → servidor de voz troca o timbre (OpenVoice v2, MIT). A amostra de voz nunca sai do nosso servidor; só o texto da resposta vai ao Gemini (como já acontece com a IA de texto).
- **Modo qualidade:** Chatterbox Multilingual (MIT) fala o texto direto. Lento em CPU; desligado por padrão no worker (`VOICE_QUALITY=0`).
- `VOICE_CLONE_MODE` = auto (rápido; se falhar, qualidade) | rapido | qualidade. `VOICE_CLONE_TIMEOUT_MS` (padrão 90 s).
- Servidor de voz perdeu a voz (VM nova) → reaprende pela amostra cifrada e repete.
- Qualquer falha/demora → `synthesizeReply` devolve erro → `sendAiReply` manda **texto** (o cliente nunca fica sem resposta). Saúde do servidor em cache de 60 s (não espera quando está fora).

### Servidor de voz
`voice-worker/` (FastAPI + Docker + Caddy). Ver voice-worker/README.md. Render: `VOICE_WORKER_URL` (https) e `VOICE_WORKER_SECRET` (≥ 32). Assinatura HMAC com nonce e anti‑replay; só a 443 aberta.

## 3. Avaliação dos modelos (23/11/2026)
| Modelo | Licença | Português | Uso |
|---|---|---|---|
| Chatterbox Multilingual V2/V3 (Resemble AI) | MIT (pesos e código) | sim (`pt`; ajuste fino pt‑BR MIT) | modo qualidade |
| OpenVoice v2 (MyShell) | MIT | conversor de timbre (independe do idioma); motor base MeloTTS não tem PT | modo rápido (com voz-base Gemini) |
| XTTS‑v2 (Coqui) | CPML, não comercial | sim | **não usar** |
| F5‑TTS | pesos CC‑BY‑NC | sim | **não usar** |
Obs.: a Resemble arquivou o Chatterbox em ago/2026 (continua MIT, sem novas versões) — fixado `chatterbox-tts==0.1.7`.

### Medição em CPU (sandbox ARM64, 2 vCPU dividida com outro processo, 8 GB)
- Chatterbox (qualidade): carregar 218 s; aprender a voz 26 s; frase de 70 caracteres → 5,0 s de áudio em **147 s** (≈29× o tempo real); 82 caracteres → 6,3 s em **162 s** (≈26×). Memória 3,9 GB. Inviável para conversa em 2 núcleos.
- OpenVoice v2 (rápido): carregar 8 s; aprender a voz (amostra de 75 s) **2,6 s**; converter 6 s de áudio em **7,8–8,5 s** (≈1,3×). Memória 1,1 GB. + voz-base Gemini (~2–5 s).
- Teste ponta a ponta (worker real local + cliente do app): register, convert, assinatura errada → 401, sem assinatura → 401, excluir apaga os arquivos.
- Em 2 OCPU Ampere dedicados o esperado é igual ou melhor (sem disputa de CPU/disco).

## 4. Pendências
- Criar a conta Oracle Always Free (cartão só para verificação; aprovação e cartão do Mayck) e rodar `voice-worker/instalar-oracle.sh`; colar `VOICE_WORKER_URL`/`VOICE_WORKER_SECRET` no Render.
- Oracle Always Free hoje = 2 OCPU / 12 GB no Ampere (a doc atual diz 1.500 OCPU‑h/mês), não 4/24.
- Ouvir prévias reais com vozes de verdade e ajustar `tau` (0,3) se o timbre ficar fraco.
