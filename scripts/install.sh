#!/bin/sh
set -eu
umask 077
NOTETRAIL_SOURCE=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
if [ "${1:-}" = "--help" ]; then
  printf '%s\n' '用法：sh scripts/install.sh [--prefix /独立安装目录] [--data-dir /独立数据目录] [--from-backup /已验证的备份目录]' '支持 macOS 26.6 arm64，运行环境随安装下载并校验。'
  exit 0
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ] || [ "$(sw_vers -productVersion)" != 26.6 ]; then
  printf '%s\n' '安装未执行：当前只验证了 macOS 26.6 arm64。' >&2
  exit 1
fi
NOTETRAIL_BOOTSTRAP=$(mktemp -d /private/tmp/notetrail-bootstrap.XXXXXX)
trap 'rm -rf "$NOTETRAIL_BOOTSTRAP"' EXIT
trap 'exit 130' HUP INT TERM
NOTETRAIL_NODE_URL=$(/usr/bin/plutil -extract node.url raw -o - "$NOTETRAIL_SOURCE/scripts/runtime-lock.json")
NOTETRAIL_NODE_SHA=$(/usr/bin/plutil -extract node.sha256 raw -o - "$NOTETRAIL_SOURCE/scripts/runtime-lock.json")
printf '%s\n' '正在获取并校验启动所需的 Node…'
if ! /usr/bin/curl -q --proto '=https' --proto-redir '=https' --fail --location --silent --show-error \
    --retry 4 --retry-all-errors --retry-max-time 900 --speed-limit 1 --speed-time 60 --connect-timeout 15 --max-time 900 \
    --max-filesize 268435456 "$NOTETRAIL_NODE_URL" -o "$NOTETRAIL_BOOTSTRAP/node.archive"; then
  printf '%s\n' '下载未完成。原安装未改变，请检查网络后重新运行。' >&2
  exit 1
fi
NOTETRAIL_ACTUAL_SHA=$(/usr/bin/shasum -a 256 "$NOTETRAIL_BOOTSTRAP/node.archive" | /usr/bin/awk '{print $1}')
if [ "$NOTETRAIL_ACTUAL_SHA" != "$NOTETRAIL_NODE_SHA" ]; then
  printf '%s\n' 'Node 下载校验失败，未执行下载内容。' >&2
  exit 1
fi
mkdir "$NOTETRAIL_BOOTSTRAP/node"
/usr/bin/tar -xf "$NOTETRAIL_BOOTSTRAP/node.archive" -C "$NOTETRAIL_BOOTSTRAP/node" --strip-components 1 package/bin/node package/LICENSE
for item in bin/node LICENSE; do
  case "$item" in bin/node) key=binarySha256 ;; LICENSE) key=licenseSha256 ;; esac
  expected=$(/usr/bin/plutil -extract "node.$key" raw -o - "$NOTETRAIL_SOURCE/scripts/runtime-lock.json")
  actual=$(/usr/bin/shasum -a 256 "$NOTETRAIL_BOOTSTRAP/node/$item" | /usr/bin/awk '{print $1}')
  [ "$actual" = "$expected" ] || { echo 'Node 官方文件指纹不符。' >&2; exit 1; }
done
/usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 "$NOTETRAIL_BOOTSTRAP/node/bin/node" "$NOTETRAIL_SOURCE/scripts/install.mjs" --source "$NOTETRAIL_SOURCE" --bootstrap-archive "$NOTETRAIL_BOOTSTRAP/node.archive" "$@"
