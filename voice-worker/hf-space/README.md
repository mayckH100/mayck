---
title: MCK Voz
emoji: 🎙️
colorFrom: indigo
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# MCK Voz (servidor de voz clonada do MCKBOT)

Space **privado** da MCK Desenvolvimento. Troca o timbre de uma voz-base pela voz clonada (OpenVoice v2, MIT), em CPU.
Toda rota `/v1/*` exige assinatura HMAC (segredo `VOICE_WORKER_SECRET`); por ser privado, o Hugging Face também exige
`Authorization: Bearer <token HF>`. Código: github.com/mayckH100/mayck › voice-worker/.
