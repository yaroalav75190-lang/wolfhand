#!/usr/bin/env bash
# Backup-скрипт для SQLite-БД «Рука волка».
# Делает атомарный snapshot БД через sqlite3 .backup, чтобы избежать гонок с пишущими запросами.
# Ротация: оставляет последние 30 ежедневных + последние 14 посменных бэкапов.
#
# Установка как cron-задача:
#   1) cp backup-wolfhand.sh /usr/local/bin/backup-wolfhand.sh
#   2) chmod +x /usr/local/bin/backup-wolfhand.sh
#   3) mkdir -p /var/backups/wolfhand
#   4) crontab -e:
#        # Ежедневный бэкап в 02:00
#        0 2 * * * /usr/local/bin/backup-wolfhand.sh daily
#        # Посменный бэкап после закрытия (23:30)
#        30 23 * * * /usr/local/bin/backup-wolfhand.sh shift
#
# Восстановление:
#   systemctl stop wolfhand
#   cp /var/backups/wolfhand/wolfhand-daily-YYYY-MM-DD.sqlite /var/lib/wolfhand/wolfhand.sqlite
#   chown wolfhand:wolfhand /var/lib/wolfhand/wolfhand.sqlite
#   systemctl start wolfhand

set -euo pipefail

DB_PATH="${WOLFHAND_DB_PATH:-/var/lib/wolfhand/wolfhand.sqlite}"
BACKUP_DIR="${WOLFHAND_BACKUP_DIR:-/var/backups/wolfhand}"
MODE="${1:-daily}"   # daily | shift | manual

# Ротация: сколько дней хранить
KEEP_DAILY=30
KEEP_SHIFT=14
KEEP_MANUAL=90

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: БД не найдена по пути $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TS=$(date +%F)                          # YYYY-MM-DD
TS_FULL=$(date +%F_%H-%M-%S)            # YYYY-MM-DD_HH-MM-SS
case "$MODE" in
  daily)   BACKUP_FILE="$BACKUP_DIR/wolfhand-daily-$TS.sqlite" ;;
  shift)   BACKUP_FILE="$BACKUP_DIR/wolfhand-shift-$TS_FULL.sqlite" ;;
  manual)  BACKUP_FILE="$BACKUP_DIR/wolfhand-manual-$TS_FULL.sqlite" ;;
  *)
    echo "ERROR: Неизвестный режим: $MODE. Используй daily | shift | manual" >&2
    exit 1
    ;;
esac

echo "→ Бэкап БД: $DB_PATH → $BACKUP_FILE"

# Используем .backup команду SQLite — это атомарный snapshot,
# работает даже если БД активно используется (нет блокировок).
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Проверяем целостность бэкапа
if ! sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "ERROR: Бэкап повреждён, удаляю" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Сжимаем (gzip даёт ~3-5x для SQLite)
gzip -9 "$BACKUP_FILE"
BACKUP_FILE="$BACKUP_FILE.gz"

SIZE_KB=$(du -k "$BACKUP_FILE" | cut -f1)
echo "✓ Бэкап создан: $BACKUP_FILE ($SIZE_KB KB)"

# Ротация
case "$MODE" in
  daily)   PATTERN="wolfhand-daily-*"; KEEP=$KEEP_DAILY ;;
  shift)   PATTERN="wolfhand-shift-*"; KEEP=$KEEP_SHIFT ;;
  manual)  PATTERN="wolfhand-manual-*"; KEEP=$KEEP_MANUAL ;;
esac

REMOVED=0
# shellcheck disable=SC2010
ls -1t "$BACKUP_DIR"/$PATTERN 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f"
  REMOVED=$((REMOVED + 1))
  echo "  − удалён старый: $(basename "$f")"
done

# Для интеграции с мониторингом — пишем последнюю успешную дату в файл
echo "$TS_FULL $MODE $BACKUP_FILE" > "$BACKUP_DIR/.last-success"

echo "✓ Готово ($(date '+%F %T'))"
