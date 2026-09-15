# Multi-Symbol MT5 Level Alert — Архитектура и работа с любыми инструментами

## 1. Введение

Изначально система была ориентирована исключительно на инструмент `XAUUSD` с фиксированным шагом цен и отдельными фоновыми графиками для каждого таймфрейма одного символа.

В версии **2.00** система полностью переработана в **Multi-Symbol Level Alert**:
- EA больше не привязан к конкретному символу.
- Вы можете открыть график **любого инструмента** (XAUUSD, USDCHF, EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, NZDUSD, EURJPY, GBPJPY, US30, NAS100, SPX500, BTCUSD или любого экзотического символа вашего брокера).
- EA обнаруживает любые горизонтальные линии (`OBJ_HLINE`) на любом открытом графике, автоматически считывает имя символа через `ChartSymbol(chartId)` и регистрирует уровень на сервере с привязкой к конкретному символу.
- **Мониторинг цен не зависит от открытых графиков**: цены для всех символов с активными уровнями проверяются каждую секунду через `SymbolInfoDouble(symbol, SYMBOL_BID)`.

---

## 2. Ключевые компоненты Multi-Symbol

### 2.1. Динамическое обнаружение символов
EA запускается **на одном любом графике** терминала (например, на XAUUSD или EURUSD).
При вызове `ScanAllCharts()` он циклически обходит все открытые в терминале графики (`ChartFirst()` → `ChartNext()`):
```mql5
long cid = ChartFirst();
while(cid >= 0)
{
   string symbol = ChartSymbol(cid);
   // Поиск линий OBJ_HLINE на этом графике
   cid = ChartNext(cid);
}
```
Каждая нарисованная пользователем линия получает уникальный UUID: `LVL_<uuid>`.
Этот UUID и символ отправляются на сервер в `POST /api/levels/sync`:
```json
{
  "pc_id": "PC1",
  "symbol": "USDCHF",
  "levels": [
    {
      "level_id": "11111111-2222-3333-4444-555555555555",
      "timeframe": "H1",
      "price": 0.87500,
      "object_name": "LVL_11111111-2222-3333-4444-555555555555",
      "action": "upsert"
    }
  ]
}
```

### 2.2. Проверка цен в OnTimer() каждую секунду (не OnTick!)
В MT5 событие `OnTick()` вызывается **только** при поступлении нового тика по инструменту того графика, на котором физически запущен советник. Если рынок по этому инструменту спит или вы запустили EA на XAUUSD, а уровень стоит на USDCHF — тики XAUUSD не гарантируют своевременную проверку USDCHF.

Поэтому в Multi-Symbol EA реализован двухконтурный механизм:
1. **Основной контур (каждую секунду в `OnTimer()`):**
   ```mql5
   void OnTimer()
   {
      CheckAllPrices(); // 1 раз в секунду опрашивает SymbolInfoDouble для всех активных символов
      
      if(++g_timerCounter >= HeartbeatIntervalSec)
      {
         g_timerCounter = 0;
         ScanAllCharts();
         SyncChangesToBackend();
         DoHeartbeat();
      }
   }
   ```
2. **Ускоренный контур (`OnTick()`):**
   Немедленно проверяет уровни текущего символа графика при приходе тика (субсекундная реакция для базового графика).

### 2.3. Добавление символов в Market Watch (`SymbolSelect`)
Для того чтобы `SymbolInfoDouble(symbol, SYMBOL_BID)` возвращал актуальные рыночные котировки, символ должен находиться в окне «Обзор рынка» (Market Watch).
Советник автоматически проверяет флаг `SYMBOL_SELECT` и при необходимости вызывает `SymbolSelect(symbol, true)`:
```mql5
bool EnsureSymbolSelected(string symbol)
{
   if(SymbolInfoInteger(symbol, SYMBOL_SELECT)) return true;
   if(SymbolSelect(symbol, true))
   {
      LogInfo("Added " + symbol + " to Market Watch for live monitoring");
      return true;
   }
   LogWarn("Symbol " + symbol + " is not available from this broker");
   return false;
}
```
Если брокер не предоставляет символ или инструмент временно отключен, советник не падает и не зависает, а корректно логирует предупреждение и продолжает работу с остальными символами.

---

## 3. Масштабирование порогов: Points vs Symbol Overrides

У разных классов инструментов совершенно разные величины пунктов и цен:
- EURUSD / USDCHF: 5 знаков, 1 пункт = `0.00001`
- USDJPY: 3 знака, 1 пункт = `0.001`
- XAUUSD (золото): 2 знака, 1 пункт = `0.01`
- US30 / Dow Jones: целые единицы, 1 пункт = `1.0`
- BTCUSD: 1 пункт = `1.0` или `0.1`

В MultiSymbol EA реализована гибкая двухступенчатая система определения расстояния:

### Способ 1: Универсальные пункты (Points) по умолчанию
Если для инструмента не задан специальный override, расстояние рассчитывается автоматически через значение `_Point` инструмента:
$$\text{AlertDistance} = \text{AlertDistancePoints} \times \text{SymbolPoint(symbol)}$$
$$\text{TouchEpsilon} = \text{TouchEpsilonPoints} \times \text{SymbolPoint(symbol)}$$
$$\text{ResetDistance} = \text{ResetDistancePoints} \times \text{SymbolPoint(symbol)}$$

При стандартных настройках (`AlertDistancePoints = 30`):
- Для EURUSD (point = 0.00001): 30 pts = 0.00030 (3 пипса)
- Для XAUUSD (point = 0.01): 30 pts = 0.30 $
- Для USDJPY (point = 0.001): 30 pts = 0.030 ¥
- Для US30 (point = 1.0): 30 pts = 30 пунктов индекса

### Способ 2: Индивидуальные параметры (Symbol Threshold Overrides)
Через параметр `SymbolThresholdOverrides` можно задать индивидуальные абсолютные дистанции для конкретных инструментов в формате:
```text
SYMBOL:DISTANCE;SYMBOL:DISTANCE
```
Пример:
```text
XAUUSD:0.30;USDCHF:0.00010;EURUSD:0.00010;USDJPY:0.010;US30:10;BTCUSD:50
```
Если советник находит символ в этом списке, он использует точное значение расстояния, а для остальных символов автоматически применяет глобальные настройки в пунктах.

---

## 4. Сценарий работы на нескольких ПК (Multi-PC Failover)

```text
┌──────────────────────────────────────────────────────────┐
│                          BACKEND                         │
│  (Leader Election, SQLite, CAS Leases, Deduplication)   │
└──────────────┬───────────────────────────▲───────────────┘
               │                           │
      Heartbeat (role=ACTIVE)      Heartbeat (role=BACKUP)
               │                           │
      ┌────────▼────────┐         ┌────────┴────────┐
      │   PC1 (MT5)     │         │   PC2 (MT5)     │
      │   Priority 1    │         │   Priority 2    │
      └─────────────────┘         └─────────────────┘
```

1. **Создание уровня:**
   Вы открываете график `USDCHF` на PC1 и ставите горизонтальную линию на `0.87500`.
   EA на PC1 регистрирует уровень на сервере с `symbol="USDCHF"`.
2. **Автоматическое зеркалирование:**
   При очередном heartbeat PC2 получает этот уровень в списке уровней. Если на PC2 открыт график USDCHF H1, линия автоматически отрисовывается на графике PC2.
3. **Мониторинг котировок:**
   Даже если на PC2 **нет открытого графика USDCHF**, EA на PC2 всё равно опрашивает котировку через `SymbolInfoDouble("USDCHF", SYMBOL_BID)`.
4. **Защита от дублирования алертов:**
   - Если PC1 активен (`role="ACTIVE"`), именно он отправляет запрос в `/api/notify/trigger`.
   - Если оба ПК попытаются отправить алерт одновременно (например, в момент смены роли), сервер пропустит только первый запрос благодаря атомарному захвату `cycle_id` в SQLite. Второй запрос получит статус `duplicate` и Telegram не получит дубль.
   - Повторный алерт блокируется до тех пор, пока цена не выйдет из зоны (`ResetDistance`), после чего уровень снова переходит в состояние вооружения (`RESET`).

---

## 5. Формат уведомлений в Telegram

В зависимости от инструмента бот отображает актуальную разрядность цены:

**Валютная пара (EURUSD / USDCHF):**
```text
🔔 LEVEL HIT

📌 Symbol: USDCHF
📍 Level:  0.87500
💰 Price:  0.87512
📏 Distance: 0.00012
📊 Timeframe: H1
📈 Direction: UP ▲

🖥 Active: PC1
⏰ 2026-09-15 10:32:15 UTC
```

**Золото (XAUUSD):**
```text
🔔 LEVEL HIT

📌 Symbol: XAUUSD
📍 Level:  4500.00
💰 Price:  4500.22
📏 Distance: 0.22
📊 Timeframe: M5
📈 Direction: UP ▲

🖥 Active: PC1
⏰ 2026-09-15 10:32:18 UTC
```

**Индексы / Криптовалюты (US30, BTCUSD):**
```text
🔔 LEVEL HIT

📌 Symbol: US30
📍 Level:  45000
💰 Price:  45005
📏 Distance: 5
📊 Timeframe: H4
📈 Direction: UP ▲

🖥 Active: PC1
⏰ 2026-09-15 10:32:20 UTC
```
