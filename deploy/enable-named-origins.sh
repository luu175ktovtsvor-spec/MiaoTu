#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${ALLOW_LEGACY_NAMED_ORIGINS:-0} != 1 ]]; then
  echo '此脚本仅适用于旧 Docker 命名域名入口；现行妙图大陆原生部署不使用它。请改用 deploy/native 流程；如确需维护旧环境，请显式设置 ALLOW_LEGACY_NAMED_ORIGINS=1。' >&2
  exit 2
fi

# 启用 canvas.miaoimg.cn / admin.miaoimg.cn（并在验收后用 REMOVE_LEGACY=1 撤掉旧域名）。
#
# 为什么要有这一步：网页版按 hostname 决定渲染哪一层（miaoimg.cn 落地页、canvas. 画布、
# admin. 管理端），所以这两个子域必须同时在 DNS、nginx 和证书三处存在才生效。
# DNS 在阿里云（NS 是 dns3/dns4.hichina.com），只有账号本人能加记录，
# 所以这个脚本只做服务器侧，并且先从公网确认解析真的指到本机才动手。
#
# 用法：
#   bash deploy/enable-named-origins.sh                 # 加进 nginx + 扩证书 + 公证验证
#   确认三个域名都正常后：REMOVE_LEGACY=1 bash deploy/enable-named-origins.sh
#
# 详细背景见 docs/部署与域名.md 与 AGENTS.md。

# Mainland production is native. Require an explicit target so this legacy
# helper can never silently mutate the retired US host.
REMOTE_HOST=${REMOTE_HOST:?请显式指定大陆 SSH 目标（例如 miaoimg-cn）}
REMOTE_IP=${REMOTE_IP:-114.215.210.134}
LEGACY=prompts.zzyppz.cn
SUBDOMAINS=(canvas.miaoimg.cn admin.miaoimg.cn)
SITE=/etc/nginx/sites-available/miaoimg.conf
CERT_NAME=miaoimg.cn
ALL_NAMES=(miaoimg.cn www.miaoimg.cn "${SUBDOMAINS[@]}")

die() { echo "$*" >&2; exit 1; }

# ① DNS 必须先就位，否则签不出证书（HTTP-01 要求域名能解析回本机）。
# 从服务器侧解析：本机域名查询可能被代理的 fake-IP 接管，拿到的不是真实地址。
apex_ip=$(ssh "$REMOTE_HOST" "dig +short miaoimg.cn A | tail -1")
[ -n "$apex_ip" ] || die "在 $REMOTE_HOST 上解析不出 miaoimg.cn，先修好服务器 DNS 再跑。"
for host in "${SUBDOMAINS[@]}"; do
  ip=$(ssh "$REMOTE_HOST" "dig +short $host A | tail -1")
  [ "$ip" = "$apex_ip" ] || die "拒绝继续：$host 解析到 '${ip:-（没有 A 记录）}'，而 miaoimg.cn 是 ${apex_ip}。
请先在阿里云云解析给 $host 加一条 A 记录指向 ${apex_ip}，等生效后重跑本脚本。"
  echo "DNS OK  $host -> $ip"
done

# ② 服务器侧：把子域并进 miaoimg.cn 的 server 块，必要时撤掉旧域名。
ssh "$REMOTE_HOST" bash -s <<REMOTE
set -Eeuo pipefail
site='$SITE'
legacy='$LEGACY'
remove_legacy='${REMOVE_LEGACY:-0}'
names='miaoimg.cn www.miaoimg.cn canvas.miaoimg.cn admin.miaoimg.cn'

cp -a "\$site" "\$site.bak-\$(date +%Y%m%d-%H%M%S)"

python3 - "\$site" "\$names" "\$legacy" "\$remove_legacy" <<'PY'
import re, sys
path, names, legacy, remove_legacy = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
text = open(path, encoding='utf-8').read()

# 只改 miaoimg.cn 那两个 server 块；prompts 的块单独处理。
text = re.sub(r'(^\s*server_name\s+)miaoimg\.cn www\.miaoimg\.cn;', lambda m: m.group(1) + names + ';', text, flags=re.M)

if remove_legacy:
    # 旧域名的 80/443 两个 server 块整段删掉（从 listen 行到匹配的右花括号）。
    out, i, removed = [], 0, 0
    lines = text.split('\n')
    while i < len(lines):
        line = lines[i]
        if re.match(r'^\s*server\s*\{', line):
            depth, block, j = 0, [], i
            while j < len(lines):
                block.append(lines[j])
                depth += lines[j].count('{') - lines[j].count('}')
                j += 1
                if depth == 0:
                    break
            if f'server_name {legacy};' in '\n'.join(block):
                removed += 1
                i = j
                continue
        out.append(line); i += 1
    text = '\n'.join(out)
    print(f'removed {removed} legacy server block(s)')

open(path, 'w', encoding='utf-8').write(text)
PY

nginx -t
systemctl reload nginx
echo "nginx 已重载，子域已并入 miaoimg.cn server 块"
REMOTE

# ③ 扩证书 SAN（certbot 的 --expand 会保留原证书名与到期轮换配置）。
ssh "$REMOTE_HOST" "certbot --nginx -n --agree-tos --expand --cert-name $CERT_NAME $(printf -- '-d %s ' "${ALL_NAMES[@]}")" \
  | tail -6

# ④ 公网回读：三个域名各自返回 200，且证书里带上了子域。
for host in "${ALL_NAMES[@]}"; do
  printf '%-22s ' "$host"
  curl -sS -o /dev/null --max-time 20 -w '%{http_code}\n' "https://$host/" || echo 'FAILED'
done
echo
echo "证书 SAN："
ssh "$REMOTE_HOST" "openssl x509 -in /etc/letsencrypt/live/$CERT_NAME/cert.pem -noout -text | grep -A1 'Subject Alternative Name'"

cat <<'NEXT'

下一步（代码侧，DNS/nginx/证书都通过后再做）：
  1. web/src/siteOrigins.ts 的 canvasEntry() 返回 `${CANVAS_ORIGIN}${path}`、landingEntry() 返回 `${LANDING_ORIGIN}${path}`；
  2. 提交、发布网页版；
  3. 真开一次浏览器确认落地页「打开画布」跳到 canvas.miaoimg.cn、/manage 跳到 admin.miaoimg.cn。
NEXT
