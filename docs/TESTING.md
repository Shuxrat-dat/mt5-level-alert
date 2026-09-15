# Тестирование

## 1. Backend — автоматические тесты

```bash
cd backend
npm install
npm test
```

21 тест, все сценарии из ТЗ проверены реальным кодом (не моками электоральной
логики):

| Файл | Что проверяет |
|---|---|
| `tests/lease.test.ts` | Чистая функция `electLeader` (5 тестов: выбор по приоритету, anti-flapping, promotion после stability window, "никого нет" → null, детерминизм) + `applyHeartbeatAndElect` с реальной in-memory SQLite (6 тестов: сценарии 1-4 из ТЗ дословно, split-brain невозможен) |
| `tests/idempotency.test.ts` | `POST /api/notify/trigger`: отказ не-ACTIVE ПК (409), ровно одна отправка в Telegram на событие, дубль в пределах cooldown НЕ уходит в Telegram, прогрессия APPROACH→TOUCH→CROSS отправляет 3 разных сообщения |
| `tests/levels.test.ts` | `POST /api/levels/sync` + мультитаймфрейм: создание/перемещение/удаление уровня, несколько таймфреймов в одном heartbeat, отклонение неподдерживаемого таймфрейма, 401 без токена |

Перед коммитом всегда: `npm run build` (проверка типов) и `npm test`.

## 2. Ручная проверка backend без MT5

Полезно перед тем, как трогать реальные ПК — можно эмулировать EA через curl.

```bash
cd backend
cp .env.example .env   # заполните TELEGRAM_BOT_TOKEN/CHAT_ID реальными или тестовыми
npm run build
npm run register-device -- --pc-id=PC1 --priority=1
npm run register-device -- --pc-id=PC2 --priority=2
npm start &

TOKEN1="<вставьте токен PC1>"
TOKEN2="<вставьте токен PC2>"
BASE="http://localhost:8080"

# PC1 становится ACTIVE
curl -s -X POST $BASE/api/heartbeat -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN1" \
  -d '{"pc_id":"PC1","symbol":"XAUUSD"}' | python3 -m json.tool

# PC2 должен увидеть себя BACKUP
curl -s -X POST $BASE/api/heartbeat -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"pc_id":"PC2","symbol":"XAUUSD"}' | python3 -m json.tool

# Создать уровень на M5 от лица PC1
curl -s -X POST $BASE/api/levels/sync -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN1" \
  -d '{"pc_id":"PC1","symbol":"XAUUSD","levels":[{"level_id":"11111111-1111-1111-1111-111111111111","timeframe":"M5","price":4500.0,"object_name":"LVL_test","action":"upsert"}]}'

# PC2 должен увидеть этот уровень в следующем heartbeat
curl -s -X POST $BASE/api/heartbeat -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"pc_id":"PC2","symbol":"XAUUSD"}' | python3 -m json.tool
# -> levels: [{level_id: "1111...", timeframe: "M5", price: 4500, ...}]

# Общий статус кластера
curl -s $BASE/status | python3 -m json.tool
```

## 3. Проверка failover без реального отключения ПК

Не отправляйте heartbeat от PC1 в течение `FAILOVER_TIMEOUT_SEC` (15с по
умолчанию) — просто не вызывайте curl для PC1 какое-то время, а PC2 продолжайте
дёргать каждые 5 секунд. После ~15-20 секунд PC2 в ответе получит
`"role":"ACTIVE"`.

## 4. Проверка идемпотентности вручную

```bash
# Получите lease_id из ответа heartbeat выше (для ACTIVE-ПК), затем:
curl -s -X POST $BASE/api/notify/trigger -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN1" \
  -d '{"pc_id":"PC1","lease_id":"<lease_id>","level_id":"11111111-1111-1111-1111-111111111111","event_type":"TOUCH","price":4500.02}'
# -> {"status":"sent",...}  — и сообщение реально придёт в Telegram-группу

# Повторите тот же запрос немедленно:
curl -s -X POST $BASE/api/notify/trigger ... (тот же body)
# -> {"status":"duplicate",...} — ВТОРОГО сообщения в Telegram быть не должно
```

## 5. Чек-лист сценариев из ТЗ (раздел "19. ОТКЛЮЧЕНИЕ ПК")

Выполняйте на реальных PC1/PC2 после `docs/INSTALL.md`:

- [ ] **Сценарий 1**: оба ПК включены → PC1 ACTIVE, PC2 BACKUP (`/status`).
- [ ] **Сценарий 2**: выключить PC1 → через ~15-20с PC2 становится ACTIVE.
- [ ] **Сценарий 4**: снова включить PC1 → через ~10с PC1 забирает роль обратно.
- [ ] **Сценарий 5**: отключить интернет на активном ПК (не сам ПК) →
      поведение идентично сценарию 2 (backend видит то же самое — отсутствие
      heartbeat).
- [ ] **Сценарий 6**: остановить backend (`pm2 stop xauusd-backend`) →
      в логах EA должно появиться `[WARN] Heartbeat failed` на обоих ПК, роль
      НЕ меняется (последняя известная сохраняется), новых Telegram-сообщений
      не будет, пока backend не поднимется обратно. Поднимите backend — EA
      сам восстановит связь на следующем таймере, без перезапуска MT5.
- [ ] **Сценарий 7**: временно неверный `TELEGRAM_BOT_TOKEN` в `.env` (потом
      верните обратно и перезапустите backend) → в логе backend'а
      `[WARN] Telegram send failed`, событие остаётся в очереди retry-воркера
      и досылается автоматически после исправления токена и перезапуска (или
      дождитесь следующего реального события).
- [ ] **Сценарий 8**: два ПК одновременно пытаются стать ACTIVE — структурно
      невозможно благодаря CAS (раздел 3 `ARCHITECTURE.md`); проверяется
      автотестом `never has two PCs simultaneously believing they are ACTIVE`.
- [ ] **Сценарий 10/11**: подвиньте и удалите линию на одном ПК → на другом
      изменения должны отразиться в течение `HeartbeatIntervalSec`.
- [ ] **Сценарий 12**: один и тот же уровень виден на обоих терминалах после
      синхронизации — визуально сравните графики.

## 6. Проверка компиляции EA (обязательно перед первым использованием)

В контейнере разработки нет MQL5-тулчейна, поэтому файл не был скомпилирован
автоматически — код прошёл только структурную проверку (баланс скобок,
сигнатуры функций, ручной построчный ревью). **Первое, что нужно сделать** —
открыть `mt5/XAUUSD_Level_Alert.mq5` в MetaEditor и нажать `Compile` (F7),
см. `docs/INSTALL.md` шаг 11. Если компилятор покажет warning про
неиспользуемую переменную (`found` в паре мест, где значение сознательно не
проверяется) — это не ошибка, EA будет работать.
