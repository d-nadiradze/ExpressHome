#!/bin/bash
set -euo pipefail

# ============================================================
#  AWS EC2 User Data — Docker + Docker Compose + Swap
#  Ubuntu 22.04+ AMI, t3.small or larger
# ============================================================

LOG="/var/log/user-data.log"
exec > >(tee -a "$LOG") 2>&1
echo "=== Setup started at $(date) ==="

apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release git

# Install Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu

# Add 2GB swap
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "=== Done at $(date). Docker $(docker --version) ==="
