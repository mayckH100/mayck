# MCK Voz — servidor de voz clonada (grátis, nosso, sem API paga)

Worker que gera os áudios na voz clonada do vendedor/responsável para a IA do MCKBOT (v1.47.0).

- **Modelo:** Chatterbox Multilingual (Resemble AI), licença **MIT** (uso comercial permitido), idioma `pt`.
  Opcional: `VOICE_T3_REPO=ResembleAI/Chatterbox-Multilingual-pt-br` (ajuste fino do português do Brasil, MIT).
  O projeto foi arquivado pela Resemble em ago/2026 (sem novas versões), mas o código e os pesos seguem públicos sob MIT; fixamos a versão `chatterbox-tts==0.1.7`.
  Não usar XTTS‑v2 (licença CPML, não comercial) nem F5‑TTS (pesos CC‑BY‑NC). OpenVoice v2 (MIT) não fala português no motor base (MeloTTS).
- **Marca d'água:** todo áudio gerado sai com a marca d'água inaudível Perth (identifica conteúdo sintético).
- **Onde roda:** VM ARM do Oracle Cloud *Always Free* (Ampere A1: até 2 OCPU e 12 GB no Always Free, 200 GB de disco), ou qualquer VM Linux com Docker e ≥ 6 GB de RAM. O Render Free (512 MB) não aguenta o modelo (~3,5 GB).

## Segurança
- Só a porta **443** aberta (Caddy, HTTPS automático Let's Encrypt via TLS‑ALPN, domínio grátis `<ip>.sslip.io`). O worker fica na rede interna do Docker.
- Toda rota `/v1/*` exige assinatura **HMAC‑SHA256** (`VOICE_WORKER_SECRET`, mesmo valor no Render) sobre `"<ts>.<nonce>.<MÉTODO>.<caminho>.<sha256(corpo)>"`, relógio com no máximo 5 min de diferença e cada assinatura aceita uma vez (anti‑replay).
- A amostra **não é guardada** no worker: ele guarda só os vetores da voz, cifrados (AES‑256‑GCM, `VOICE_DATA_KEY`, que só existe na VM). Excluir no app apaga o arquivo aqui.
- Áudio gerado fica só na memória até o app buscar (expira em 10 min). Contêiner sem privilégios, só leitura, `no-new-privileges`.
- No app, a amostra fica cifrada no banco (AES‑256‑GCM com a MASTER_KEY + contexto org/voz) e o aceite LGPD (texto, data, IP, usuário) fica registrado.

## Onde roda hoje (v1.51.3): Hugging Face Space PRIVADO, grátis, sem cartão
A Oracle Cloud no Brasil pede CNPJ ativo, então o worker roda num **Space Docker privado** da conta da MCK no Hugging Face
(CPU básico grátis: 2 vCPU / 16 GB), só no **modo rápido** (OpenVoice v2, `VOICE_QUALITY=0`). Arquivos em `hf-space/`
(Dockerfile na porta 7860, sem Caddy: o HTTPS vem do Hugging Face; HMAC igual).
1. `bash voice-worker/hf-space/montar.sh /tmp/mck-voz-space` e subir os 5 arquivos no Space (Files › Upload files).
2. Space › Settings › *Variables and secrets*: secrets `VOICE_WORKER_SECRET` (`openssl rand -hex 32`) e `VOICE_DATA_KEY` (`openssl rand -base64 32`).
3. Render: `VOICE_WORKER_URL=https://<dono>-<space>.hf.space`, `VOICE_WORKER_SECRET` (o mesmo) e `VOICE_WORKER_HF_TOKEN`
   (token **Read** do Hugging Face; o Space privado só responde com `Authorization: Bearer`).
- Limites do grátis: o Space **dorme após 48 h sem uso** e acorda na próxima chamada (alguns minutos; nesse meio tempo a IA
  responde por texto e a fila tenta de novo sozinha). O disco é **efêmero**: num reinício as vozes somem do worker e o app
  reensina pela amostra cifrada. Áudio em CPU leva alguns segundos por frase.

## Instalar numa VM própria (alternativa: Oracle/qualquer Linux com Docker)
1. Criar a conta Oracle Cloud (Always Free; pede cartão só para verificação — **o Mayck faz e aprova**), região São Paulo.
2. Criar VCN com assistente; na *Security List* liberar **só TCP 443** de 0.0.0.0/0 (o SSH 22 já vem; de preferência restrinja ao seu IP).
3. Criar instância **VM.Standard.A1.Flex**, Ubuntu 24.04, 2 OCPU / 12 GB, disco 100 GB, com a sua chave SSH.
4. Na VM:
   ```bash
   git clone https://github.com/mayckH100/mayck && cd mayck/voice-worker && bash instalar-oracle.sh
   ```
   O script instala Docker, fecha a senha do SSH, libera a 443, gera os segredos no `.env` (fora do Git) e sobe tudo.
   O primeiro início baixa o modelo (~3 GB) e leva alguns minutos.
5. No Render (serviço mckbot › Environment): `VOICE_WORKER_URL=https://<ip>.sslip.io` e `VOICE_WORKER_SECRET=<o mesmo do .env>`. Salvar (reinicia o app).
6. Conferir: `curl https://<ip>.sslip.io/healthz` → `{"ok":true,"ready":true,...}`. No app, IA › Voz › "Voz do vendedor" mostra "Servidor de voz no ar".

## Atualizar
```bash
cd mayck && git pull && cd voice-worker && sudo docker compose up -d --build
```

## Observações
- **Ocioso:** a Oracle pode recuperar instância Always Free ociosa (CPU, rede e memória < 20% por 7 dias). Com o modelo carregado, a memória fica acima de 20% de 12 GB; se mesmo assim for recuperada, o app volta a ensinar as vozes sozinho a partir das amostras cifradas quando a VM nova subir (mesmo endereço/segredo).
- Velocidade em CPU: ver docs/VOZ_CLONADA.md (medição no sandbox ARM). As respostas em voz clonada esperam até `VOICE_CLONE_TIMEOUT_MS` (padrão 90 s); passou disso, vai por texto. Frases repetidas saem do cache na hora.
