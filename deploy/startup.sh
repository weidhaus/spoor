#!/bin/bash
# VM startup script (runs as root on every boot, idempotent).
# Installs Docker, writes the systemd unit that fetches secrets and runs the app.
# Access: IAP TCP forwarding only (firewall allows 35.235.240.0/20 to tcp:22 and tcp:8000; no external IP).
# Never echo secret values: this output goes to the system journal.
set -euo pipefail

if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -yq ca-certificates curl gnupg python3
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io
fi
systemctl enable --now docker

# Shared helpers: metadata + Secret Manager access via the VM service account.
cat > /usr/local/lib/saas-common.sh <<'EOF'
MD=http://metadata.google.internal/computeMetadata/v1
md() { curl -fsS -H Metadata-Flavor:Google "$MD/$1"; }
attr() { curl -fsS -H Metadata-Flavor:Google "$MD/instance/attributes/$1" 2>/dev/null || echo "$2"; }
token() { md instance/service-accounts/default/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
PROJECT=$(md project/project-id)
# fetch_secret NAME DEST: writes the latest version to DEST (0600). Returns non-zero if no version exists.
fetch_secret() {
  local tmp; tmp=$(mktemp -p /run/saas)
  if ! curl -fsS -H "Authorization: Bearer $(token)" \
      "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1/versions/latest:access" -o "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  python3 -c 'import sys,json,base64;sys.stdout.buffer.write(base64.b64decode(json.load(open(sys.argv[1]))["payload"]["data"]))' "$tmp" > "$2.new"
  rm -f "$tmp"; chmod 600 "$2.new"; mv -f "$2.new" "$2"
}
EOF

# App wrapper: fetch secrets into tmpfs, pull image, (re)create container bound to 127.0.0.1 and the internal IP (reached via IAP).
cat > /usr/local/bin/saas-run <<'EOF'
#!/bin/bash
set -euo pipefail
umask 077
. /usr/local/lib/saas-common.sh
install -d -m 0700 -o root -g root /run/saas
fetch_secret saas-env /run/saas/env
fetch_secret saas-google-sa /run/saas/google-sa.json
chown 10001 /run/saas/google-sa.json; chmod 0400 /run/saas/google-sa.json

IMAGE=$(attr image "")
BASE_URL=$(attr base-url http://localhost:8000)
[ -n "$IMAGE" ] || { echo "metadata attribute 'image' missing"; exit 1; }
token | docker login -u oauth2accesstoken --password-stdin "https://${IMAGE%%/*}" >/dev/null
docker pull -q "$IMAGE"

INTERNAL_IP=$(md instance/network-interfaces/0/ip)
PORTS=(-p 127.0.0.1:8000:8000 -p "$INTERNAL_IP:8000:8000")

docker rm -f saas >/dev/null 2>&1 || true
docker run -d --name saas \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  --restart unless-stopped \
  -v saas-data:/data \
  --env-file /run/saas/env \
  -e GOOGLE_SA_FILE=/secrets/google-sa.json \
  -e BASE_URL="$BASE_URL" \
  --mount type=bind,src=/run/saas/google-sa.json,dst=/secrets/google-sa.json,readonly \
  "${PORTS[@]}" \
  "$IMAGE" >/dev/null
echo "saas started: image=$IMAGE base_url=$BASE_URL ports=${PORTS[*]}"
EOF
chmod 0755 /usr/local/bin/saas-run

cat > /etc/systemd/system/saas.service <<'EOF'
[Unit]
Description=Spoor container
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/saas-run
ExecStop=/usr/bin/docker stop saas
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable saas.service
systemctl restart saas.service
