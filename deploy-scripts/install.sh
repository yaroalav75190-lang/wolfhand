#!/usr/bin/env bash
# Первичная установка зависимостей и сервиса на VPS (Ubuntu 22.04/24.04).
# Запускать ОДИН РАЗ от root:
#   bash install.sh
#
# Что делает:
# 1. Ставит Node 20.x (через NodeSource) + build-essentials (для better-sqlite3)
# 2. Ставит nginx + certbot
# 3. Создаёт пользователя wolfhand, директории /opt/wolfhand, /var/lib/wolfhand
# 4. Копирует systemd-unit и nginx-конфиг
# 5. Открывает порты в UFW
# 6. Запрашивает домен и получает Let's Encrypt сертификат

set -euo pipefail

# ============ КОНФИГ ============
APP_USER="wolfhand"
APP_DIR="/opt/wolfhand"
DATA_DIR="/var/lib/wolfhand"
SERVICE_NAME="wolfhand"
NGINX_CONF="/etc/nginx/sites-available/wolfhand"
NGINX_LINK="/etc/nginx/sites-enabled/wolfhand"

# ============ Проверки ============
if [ "$EUID" -ne 0 ]; then echo "Запустите от root"; exit 1; fi

echo "→ [1/7] Установка системных пакетов..."
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release build-essential ufw

echo "→ [2/7] Установка Node.js 20.x..."
if ! command -v node &>/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "→ [3/7] Установка nginx + certbot..."
apt-get install -y nginx certbot python3-certbot-nginx

echo "→ [4/7] Создание пользователя $APP_USER и директорий..."
id -u $APP_USER &>/dev/null || useradd -r -s /bin/false -d $APP_DIR $APP_USER
mkdir -p $APP_DIR $DATA_DIR
chown -R $APP_USER:$APP_USER $APP_DIR $DATA_DIR
chmod 750 $DATA_DIR

echo "→ [5/7] UFW firewall (открываем 80, 443; SSH ожидаем уже открытым)..."
ufw allow 80/tcp comment 'http' || true
ufw allow 443/tcp comment 'https' || true
ufw status

# ============ systemd ============
echo "→ [6/7] systemd unit..."
cat > /etc/systemd/system/$SERVICE_NAME.service <<'EOF'
[Unit]
Description=Wolf Hand — promo campaign server
After=network.target

[Service]
Type=simple
User=wolfhand
Group=wolfhand
WorkingDirectory=/opt/wolfhand
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=KV_DRIVER=sqlite
Environment=SQLITE_PATH=/var/lib/wolfhand/wolfhand.sqlite
EnvironmentFile=-/opt/wolfhand/.env.production
ExecStart=/usr/bin/node /opt/wolfhand/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/wolfhand

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE_NAME
echo "  ✓ unit создан и enabled (запустим после деплоя кода)"

# ============ nginx ============
echo "→ [7/7] nginx config..."
if [ -z "${WOLF_DOMAIN:-}" ]; then
  read -r -p "Введите домен (например wolfhand.example.ru) или оставьте пустым для IP-доступа: " DOMAIN
  DOMAIN="${DOMAIN:-_}"
else
  DOMAIN="$WOLF_DOMAIN"
  echo "  Использую WOLF_DOMAIN=$DOMAIN"
fi

# Глобальный rate-limit zone (отдельный файл, не sites-enabled)
cat > /etc/nginx/conf.d/wolfhand-ratelimit.conf <<'EOF'
limit_req_zone $binary_remote_addr zone=api_rl:10m rate=10r/s;
EOF

mkdir -p /var/www/letsencrypt

# 1) Готовим CELEVOJ финальный конфиг в /tmp/ (он понадобится в конце)
FINAL_CONF=/tmp/wolfhand-nginx-final.conf
if [ "$DOMAIN" = "_" ]; then
  # Без домена — HTTP-only, доступ по IP
  cat > $FINAL_CONF <<'EOF_PLAIN'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    access_log /var/log/nginx/wolfhand-access.log;
    error_log  /var/log/nginx/wolfhand-error.log warn;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
    location /api/ {
        add_header Cache-Control "no-store" always;
        limit_req zone=api_rl burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
EOF_PLAIN
else
  # С доменом — HTTP→HTTPS redirect + HTTPS с Let's Encrypt
  sed "s|WOLF_DOMAIN|$DOMAIN|g" "$(dirname "$0")/nginx-wolfhand.conf" > $FINAL_CONF 2>/dev/null || \
  cat > $FINAL_CONF <<EOF_DOMAIN
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(self), microphone=(), geolocation=()" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    access_log /var/log/nginx/wolfhand-access.log;
    error_log  /var/log/nginx/wolfhand-error.log warn;
    location / {
        add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
    location /api/ {
        add_header Cache-Control "no-store" always;
        limit_req zone=api_rl burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
EOF_DOMAIN
fi

# 2) Активация: либо сразу финальный (HTTP-only), либо двухэтапная установка с certbot
if [ "$DOMAIN" = "_" ]; then
  cp $FINAL_CONF $NGINX_CONF
  ln -sf $NGINX_CONF $NGINX_LINK
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
else
  # HTTP-only stub для validation certbot
  cat > $NGINX_CONF <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 200 'wolfhand pending'; add_header Content-Type text/plain; }
}
EOF
  ln -sf $NGINX_CONF $NGINX_LINK
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx

  certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" \
    --non-interactive --agree-tos -m "admin@$DOMAIN"

  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    # Сертификат получен — ставим финальный HTTPS-конфиг
    cp $FINAL_CONF $NGINX_CONF
    nginx -t && systemctl reload nginx
    echo "  ✓ HTTPS работает на https://$DOMAIN"
  else
    echo "  ⚠ certbot не получил сертификат. Оставляем HTTP-only заглушку."
    echo "    Когда DNS будет готов, выполните:"
    echo "      certbot certonly --webroot -w /var/www/letsencrypt -d $DOMAIN"
    echo "      cp $FINAL_CONF $NGINX_CONF && nginx -t && systemctl reload nginx"
  fi
fi

echo ""
echo "✅ Установка завершена."
echo ""
echo "Дальше:"
echo "  1. Скопировать код проекта в $APP_DIR (на локальной машине: deploy.ps1)"
echo "  2. Заполнить $APP_DIR/.env.production — обязательный минимум:"
echo "       PUBLIC_ORIGIN=https://$DOMAIN"
echo "       WOLF_SESSION_SECRET=\$(openssl rand -hex 32)"
echo "       MANAGER_PASSWORD=... MARKETING_PASSWORD=..."
echo "       PARTNER_PASSWORD_HELLOAPPLE=... (по одному на каждого партнёра)"
echo "       PRIZE_BUDGET_DAILY_COGS=5000  JACKPOT_MIN_INTERVAL_DAYS=30"
echo "       DEV_MODE=0   ← обязательно, иначе можно заказать любую комбинацию"
echo "  3. cd $APP_DIR && npm install --omit=dev"
echo "  4. systemctl start $SERVICE_NAME"
echo "  5. systemctl status $SERVICE_NAME"
echo ""
echo "Проверка после запуска:"
echo "  curl -s https://$DOMAIN/api/config | head -c 200"
echo "  открыть https://$DOMAIN/admin/ → вход «Стойка клуба»"
