# MCK Voz — worker de clonagem de voz (CPU, ARM64 ou x86_64). Sem GPU, sem API paga.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/data/hf PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git && rm -rf /var/lib/apt/lists/*
# torch 2.6 CPU (no ARM o wheel padrão do PyPI já é CPU)
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.6.0 torchaudio==2.6.0
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt && pip install --no-deps "git+https://github.com/myshell-ai/OpenVoice.git@74a1d147b17a8c3092dd5430504bd83ef6c7eb23"
COPY app.py lowmem.py /app/
RUN useradd -r -u 10001 voz && mkdir -p /data && chown voz /data
USER voz
WORKDIR /app
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-server-header"]
