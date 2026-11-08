# Voz da IA (v1.23.0) — ouvir e responder com áudio no WhatsApp

Etapa 1: notas de voz no WhatsApp (Cloud API e QR/Baileys). Ligações telefônicas ficam para depois.

## O que faz
- **Ouvir:** áudio do cliente → download (Cloud API pelo token do canal; QR pelo Baileys) → transcrição → grava em `Message.transcript` → segue o pipeline normal como se fosse texto (opt-out, SDR, qualificação, fluxos, produtos, base de conhecimento, IA). Limites: 10 MB e 2 min. Falha/inaudível/limite atingido → nota interna no Inbox e, se a IA responde naquele canal, texto educado pedindo para o cliente escrever (nunca responde "[audio]" às cegas). Contato salvo na agenda do celular (QR, sem resposta automática) não é transcrito. Conversa em atendimento humano: transcreve para o Inbox, a IA não responde.
- **Falar:** `sendAiReply` (server/ai/voice/send.ts) decide texto ou nota de voz: `espelhar` (padrão; áudio responde áudio), `sempre_audio`, `nunca_audio`. Antes da voz: links/e-mails e listas com preço saem para uma mensagem de texto enviada logo depois; o texto é reescrito em estilo falado pela IA da organização (12 s; se perder um número/valor, pedir transferência ou falhar, fica o texto limpo original) e limpo de markdown/emojis/marcadores. Passou de `voiceMaxSeconds` (padrão 45 s) → vai por texto. Qualquer falha na voz → texto. QR mostra "gravando áudio..." (sendPresenceUpdate).
- **Envio:** Cloud API: upload `audio/ogg` em /media e `{"type":"audio","audio":{"id":...,"voice":true}}`. QR: `{ audio, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds, waveform }` (com duração e forma de onda prontas o Baileys não precisa de ffmpeg).

## Áudio ou texto por conversa (automático e humanizado — migração 0053_conversa_pref_voz)
- Corrige a IA dizendo "só converso por texto" depois de já ter mandado áudios. O prompt agora diz o que ela realmente consegue: voz ligada → "Você pode responder por áudio (nota de voz)… Nunca diga que só conversa por texto"; voz desligada → "No momento as respostas são por texto", sem negar áudios já enviados. Ela não fala que é robô/IA/assistente virtual, a não ser que o cliente pergunte diretamente (aí responde com honestidade e simpatia).
- Histórico enviado à IA marca `[enviado como áudio]` (nota de voz da IA: `Message` OUT, `sender: ai`, `type: audio`, texto falado em `transcript`) e `[áudio do cliente, transcrito]`. Se a IA copiar o marcador, ele sai antes de enviar.
- Pedido explícito do cliente (detector por palavras, sem chamada extra de IA, `server/ai/voice/preference.ts`): "pode ser por áudio", "manda áudio", "me explica em áudio", "estou dirigindo"… → `Conversation.voicePreference = 'audio'`; "prefiro texto", "não consigo ouvir", "estou no trabalho, escreve", "não precisa de áudio"… → `'texto'`. Sem tela nem botão: sempre ligado. Com a voz ligada, a preferência vale acima do modo da empresa (inclusive `nunca_audio`: o cliente pediu, recebe áudio); a resposta ao próprio pedido já sai em áudio. Voz desligada: responde por texto com naturalidade e guarda a preferência.
- Inbox: nota de voz da IA aparece com a etiqueta "🔊 enviado em áudio" e o texto falado; no topo da conversa, "🔊 Prefere áudio" / "✍️ Prefere texto".

## Motores (por organização, Inteligência artificial › Configuração › Voz)
| | Falar (`voiceProvider`) | Ouvir (`transcribeProvider`, padrão `auto` = igual à IA de texto) |
|---|---|---|
| Google Gemini (padrão, grátis) | TTS do Gemini, modelo escolhido entre os que a chave vê (padrão `gemini-3.8-flash-lite-tts`; os 2.5/3.1 preview saem do ar em 17/11/2026). Formato 3.8: `speech_metadata.style` + `voiceConfig.voice`; anteriores: `prebuiltVoiceConfig`. Volta WAV/PCM 24 kHz. | `generateContent` com o modelo de texto e o áudio inline |
| OpenAI | `/audio/speech`, `gpt-4o-mini-tts` (compatíveis: `tts-1`), `instructions` = jeito de falar, `response_format: opus`. Vozes coral, nova, shimmer, sage, marin, alloy, ash, echo, onyx, ballad, verse, cedar. Groq não tem voz em português. | `/audio/transcriptions` (OpenAI `gpt-4o-mini-transcribe`, Groq `whisper-large-v3-turbo`, outros `whisper-1`) |
| ElevenLabs (mais humana) | chave própria do cliente (`voiceApiKeyEnc`, AES-GCM, nunca volta ao navegador: só `hasVoiceApiKey`). `/v1/text-to-speech/{voice_id}?output_format=pcm_24000` (formato liberado no plano grátis deles), modelos `eleven_multilingual_v2` (padrão) ou `eleven_flash_v2_5`; vozes da conta por `GET /v1/voices`. O "jeito de falar" não se aplica (vem da voz). | `/v1/speech-to-text`, `scribe_v2` (o scribe_v1 foi descontinuado), `language_code=por` |
| MCK IA | Gemini da plataforma (`MCK_IA_GEMINI_KEY`) — conta na cota diária da MCK IA | Gemini da plataforma; reserva Groq (`MCK_IA_GROQ_KEY`) |

Gemini como voz exige que a IA de texto seja Gemini ou MCK IA (usa a mesma chave); OpenAI como voz exige a IA de texto OpenAI. Sem a chave, a resposta vai por texto e a prévia mostra o motivo.

## PCM → OGG/Opus sem ffmpeg
O Render (runtime Node nativo) não tem ffmpeg e o `ffmpeg-static` baixa ~70 MB no build. Usamos `opusscript` (libopus em WebAssembly, MIT, ~1 MB, sem compilação nativa) e montamos o Ogg em TypeScript (`server/ai/voice/ogg.ts`: OpusHead/OpusTags, páginas com CRC, granule com pre-skip 312, mono 24 kbps, quadros de 20 ms). Conferido com ffprobe/ffmpeg (opus, mono, duração exata). Única dependência nova: `opusscript`.

## Uso e limites
Cada transcrição e cada áudio gerado é um registro em `AiUsage` (modelo `transcricao:...` / `voz:...`) e conta no limite diário de respostas e no limite mensal de tokens; com chaves da plataforma, também na cota diária da MCK IA. A prévia ("Ouvir prévia", `POST /api/ai/voice/preview`, devolve `audio/ogg`) também conta. Assinatura do MCKBOT inativa: nada é transcrito nem respondido.

## Configuração (AiSettings, migração 0049_voz_ia, só aditiva)
`voiceEnabled` (false), `voiceReplyMode` ('espelhar'), `voiceProvider` ('gemini'), `voiceName` ('Kore'), `voiceModel` (''), `voiceApiKeyEnc` (null), `voiceStyle`, `voiceMaxSeconds` (45), `transcribeAudio` (true — a IA ativada passa a ouvir áudios), `transcribeProvider` ('auto'); `Message.transcript` (null).

## Variáveis de ambiente
Nenhuma obrigatória. Opcionais: `GEMINI_TTS_MODEL` (força o modelo de voz do Gemini), `AI_VOICE_TIMEOUT_MS` (padrão 40000).

## Falta / próximos passos
- Testar com chaves reais (Gemini, OpenAI, ElevenLabs) depois do deploy e ouvir no celular (QR e Cloud API).
- O áudio em si não fica guardado (só a transcrição/texto falado), para não pesar o banco grátis; o Inbox não toca o áudio.
- Safari antigo pode não tocar a prévia em OGG/Opus.
- Ligações telefônicas (etapa 2).
