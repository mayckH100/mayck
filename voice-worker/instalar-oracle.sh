#!/usr/bin/env bash
# Instala o MCK Voz numa VM Ubuntu (Oracle Cloud Always Free, Ampere A1 ARM). Rode como usuário com sudo:
#   git clone https://github.com/mayckH100/mayck && cd mayck/voice-worker && bash instalar-oracle.sh
set -euo pipefail
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 unattended-upgrades fail2ban curl openssl
sudo systemctl enable --now docker
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
# Firewall da VM: só SSH (22) e HTTPS (443). Na Oracle, libere SÓ a 443 na Security List da VCN também.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save || true
# SSH só com chave
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl reload ssh || true
if [ ! -f .env ]; then
  IP=$(curl -s https://ifconfig.me)
  cp .env.exemplo .env
  sed -i "s/^VOICE_DOMAIN=.*/VOICE_DOMAIN=${IP//./-}.sslip.io/" .env
  sed -i "s/^VOICE_WORKER_SECRET=.*/VOICE_WORKER_SECRET=$(openssl rand -hex 32)/" .env
  sed -i "s#^VOICE_DATA_KEY=.*#VOICE_DATA_KEY=$(openssl rand -base64 32)#" .env
  chmod 600 .env
fi
sudo docker compose up -d --build
. ./.env
echo
echo "Pronto. Cole no Render (Environment):"
echo "  VOICE_WORKER_URL=https://${VOICE_DOMAIN}"
echo "  VOICE_WORKER_SECRET=(o valor de VOICE_WORKER_SECRET no arquivo .env desta VM)"
echo "Teste: curl https://${VOICE_DOMAIN}/healthz  (o 1º início baixa o modelo, ~3 GB, alguns minutos)"
