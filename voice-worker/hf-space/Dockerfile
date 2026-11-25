# MCK Voz no Hugging Face Space PRIVADO (Docker, CPU básico grátis: 2 vCPU / 16 GB). Sem GPU, sem API paga.
# HTTPS vem do próprio Hugging Face (sem Caddy). Porta 7860. Segredos: Settings › Variables and secrets do Space
# (VOICE_WORKER_SECRET e VOICE_DATA_KEY) — nunca no repositório.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf VOICE_DATA_DIR=/data/voices VOICE_QUALITY=0 VOICE_THREADS=2 VOICE_MAX_QUEUE=40
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git && rm -rf /var/lib/apt/lists/*
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.6.0 torchaudio==2.6.0
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt && pip install --no-deps "git+https://github.com/myshell-ai/OpenVoice.git@74a1d147b17a8c3092dd5430504bd83ef6c7eb23"
COPY app.py lowmem.py /app/
# O Hugging Face roda o contêiner como o usuário 1000.
RUN useradd -m -u 1000 user && mkdir -p /data && chown -R user /data
USER user
WORKDIR /app
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1", "--no-server-header"]
