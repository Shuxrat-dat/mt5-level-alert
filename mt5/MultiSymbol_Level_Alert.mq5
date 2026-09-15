//+------------------------------------------------------------------+
//|                                    MultiSymbol_Level_Alert.mq5   |
//|  Multi-Symbol, Multi-PC failover level-alert EA for MetaTrader 5. |
//|                                                                   |
//|  ARCHITECTURE SUMMARY (see docs/MULTISYMBOL.md for full detail)  |
//|  - ONE EA instance on ANY chart monitors ALL symbols that have    |
//|    horizontal lines (OBJ_HLINE) on ANY open chart in MT5.        |
//|  - OnTimer() runs every 1 second:                                |
//|      1. Every 1 sec: evaluates live Bid prices for all active     |
//|         symbols with SymbolInfoDouble() — no open chart needed.  |
//|      2. Every HeartbeatIntervalSec (default 5s):                 |
//|         - Scans open charts for new/moved/deleted OBJ_HLINEs;    |
//|         - Syncs changes to backend (/api/levels/sync);           |
//|         - Sends heartbeat (/api/heartbeat) with all symbols;     |
//|         - Mirrors levels from other PCs (multi-PC sync).         |
//|  - Per-Symbol Threshold Overrides (Section 8) or Points (Sec 7). |
//|  - Dynamic Symbol Detection & SymbolSelect() (Sec 18, 19).        |
//|  - Multi-PC failover: only ACTIVE PC sends Telegram alerts.       |
//+------------------------------------------------------------------+
#property copyright "MultiSymbol MT5 Level Alert"
#property link      "https://github.com"
#property version   "2.00"
#property strict

//====================================================================
// INPUTS
//====================================================================
input group "=== Backend Connection ==="
input string   BackendURL               = "https://your-domain.example.com"; // Backend base URL (no trailing slash)
input string   PC_ID                    = "PC1";                             // Registered PC_ID (PC1, PC2, etc.)
input string   DeviceToken              = "";                                 // Secret token from `npm run register-device`
input int      HttpTimeoutMs            = 5000;                               // WebRequest timeout (ms)

input group "=== Cluster & Timer Timing ==="
input int      TimerIntervalSec         = 1;                                  // Price-check frequency in seconds (default: 1s)
input int      HeartbeatIntervalSec     = 5;                                  // Backend sync & heartbeat frequency (seconds)

input group "=== Global Alert Thresholds (in Points) ==="
input bool     AlertOnApproach          = true;                               // Alert when price enters approach zone
input bool     AlertOnTouch             = true;                               // Alert when price touches level
input bool     AlertOnCross             = true;                               // Alert when price crosses level
input int      AlertDistancePoints      = 30;                                 // Approach distance in points (default: 30)
input int      TouchEpsilonPoints       = 5;                                  // Touch distance in points (default: 5)
input int      ResetDistancePoints      = 50;                                 // Re-arm distance in points (must be > AlertDistance)

input group "=== Symbol Threshold Overrides (Optional Price Units) ==="
// Format: SYMBOL:DISTANCE;SYMBOL:DISTANCE (e.g. XAUUSD:0.30;USDCHF:0.00010;EURUSD:0.00010;USDJPY:0.010;US30:10;BTCUSD:50)
// If a symbol is omitted from this list, it automatically uses the global Points setting above.
input string   SymbolThresholdOverrides = "XAUUSD:0.30;USDCHF:0.00010;EURUSD:0.00010;USDJPY:0.010;US30:10;BTCUSD:50";

input group "=== Diagnostics ==="
input bool     DebugMode                = false;                              // Verbose debug logging

//====================================================================
// GLOBAL STATE
//====================================================================

// Per-level record (one entry per unique UUID across all open charts).
struct LevelRecord
{
   string   level_id;       // UUID — stable identifier
   string   object_name;    // "LVL_<uuid>" as it appears on its chart
   string   symbol;         // USDCHF / XAUUSD / EURUSD / US30 / etc.
   string   timeframe;      // M5, H1, D1, etc.
   long     chart_id;       // which chart this line lives on (-1 if mirrored headless)
   double   price;
   bool     seen_this_scan;
};
LevelRecord g_levels[];
int         g_levelCount = 0;

// Per-level notification state machine.
#define STATE_NONE        0
#define STATE_APPROACHING 1
#define STATE_TOUCHED     2
#define STATE_CROSSED     3

struct NotifyState
{
   string level_id;
   int    state;
   int    side_before;        // 0 = unknown, 1 = above level, -1 = below level
   string last_notified;      // "", "APPROACH", "TOUCH", "CROSS"
};
NotifyState g_notify[];
int         g_notifyCount = 0;

// Cluster / role state.
string   g_role              = "BACKUP";
string   g_activePcId        = "";
string   g_leaseId           = "";
long     g_leaseExpiresAtMs  = 0;
int      g_serverHbIntervalMs = 5000;
datetime g_lastHeartbeatOk   = 0;
bool     g_backendReachable  = true;
int      g_timerCounter      = 0;

// Timeframe helper.
string TfName(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_M30: return "M30";
      case PERIOD_H1:  return "H1";
      case PERIOD_H4:  return "H4";
      case PERIOD_D1:  return "D1";
      case PERIOD_W1:  return "W1";
      case PERIOD_MN1: return "MN1";
      default:         return "H1";
   }
}

//====================================================================
// LOGGING
//====================================================================
void LogInfo(string msg)  { Print("[INFO] ", msg); }
void LogWarn(string msg)  { Print("[WARN] ", msg); }
void LogError(string msg) { Print("[ERROR] ", msg); }
void LogDebug(string msg) { if(DebugMode) Print("[DEBUG] ", msg); }
void LogAlert(string msg) { Print("[ALERT] ", msg); }

//====================================================================
// MINIMAL JSON HELPERS (No external dependencies)
//====================================================================
string JsonEscape(string s)
{
   string r = "";
   int len = StringLen(s);
   for(int i = 0; i < len; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c == '"' || c == '\\') { r += "\\"; r += StringSubstr(s, i, 1); }
      else if(c == '\n') r += "\\n";
      else if(c == '\r') r += "\\r";
      else if(c == '\t') r += "\\t";
      else r += StringSubstr(s, i, 1);
   }
   return r;
}

string JsonGetStringValue(string json, string key)
{
   string pattern = "\"" + key + "\"";
   int keyPos = StringFind(json, pattern);
   if(keyPos < 0) return "";
   int colonPos = StringFind(json, ":", keyPos);
   if(colonPos < 0) return "";
   int i = colonPos + 1;
   int len = StringLen(json);
   while(i < len) { ushort c = StringGetCharacter(json, i); if(c == ' ' || c == '\n' || c == '\t' || c == '\r') { i++; continue; } break; }
   if(i >= len || StringGetCharacter(json, i) != '"') return "";
   i++;
   string result = "";
   while(i < len)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == '\\' && i + 1 < len) { ushort nc = StringGetCharacter(json, i + 1); if(nc == 'n') result += "\n"; else if(nc == 'r') result += "\r"; else if(nc == 't') result += "\t"; else result += StringSubstr(json, i + 1, 1); i += 2; continue; }
      if(c == '"') break;
      result += StringSubstr(json, i, 1);
      i++;
   }
   return result;
}

double JsonGetNumberValue(string json, string key, double defaultVal, bool &found)
{
   found = false;
   string pattern = "\"" + key + "\"";
   int keyPos = StringFind(json, pattern);
   if(keyPos < 0) return defaultVal;
   int colonPos = StringFind(json, ":", keyPos);
   if(colonPos < 0) return defaultVal;
   int i = colonPos + 1;
   int len = StringLen(json);
   while(i < len) { ushort c = StringGetCharacter(json, i); if(c == ' ' || c == '\n' || c == '\t' || c == '\r') { i++; continue; } break; }
   if(i + 4 <= len && StringSubstr(json, i, 4) == "null") return defaultVal;
   int startI = i;
   while(i < len) { ushort c = StringGetCharacter(json, i); if(c == ',' || c == '}' || c == ']') break; i++; }
   string numStr = StringSubstr(json, startI, i - startI);
   StringTrimLeft(numStr); StringTrimRight(numStr);
   if(StringLen(numStr) == 0) return defaultVal;
   found = true;
   return StringToDouble(numStr);
}

int JsonGetObjectArray(string json, string key, string &outObjects[])
{
   ArrayResize(outObjects, 0);
   string pattern = "\"" + key + "\"";
   int keyPos = StringFind(json, pattern);
   if(keyPos < 0) return 0;
   int bracketPos = StringFind(json, "[", keyPos);
   if(bracketPos < 0) return 0;
   int len = StringLen(json);
   int i = bracketPos + 1, arrDepth = 1, braceDepth = 0, objStart = -1, count = 0;
   while(i < len && arrDepth > 0)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == '[') arrDepth++;
      else if(c == ']') { arrDepth--; if(arrDepth == 0) break; }
      else if(c == '{') { if(braceDepth == 0) objStart = i; braceDepth++; }
      else if(c == '}') { braceDepth--; if(braceDepth == 0 && objStart >= 0) { count++; ArrayResize(outObjects, count); outObjects[count - 1] = StringSubstr(json, objStart, i - objStart + 1); objStart = -1; } }
      i++;
   }
   return count;
}

//====================================================================
// UUID v4 GENERATOR
//====================================================================
string GenerateUUIDv4()
{
   int b[16];
   for(int i = 0; i < 16; i++) b[i] = MathRand() % 256;
   b[6] = (b[6] & 0x0F) | 0x40; // RFC 4122 v4
   b[8] = (b[8] & 0x3F) | 0x80;
   string hex = "";
   for(int i = 0; i < 16; i++) { hex += StringFormat("%02x", b[i]); if(i == 3 || i == 5 || i == 7 || i == 9) hex += "-"; }
   return hex;
}

//====================================================================
// HTTP HELPER (POST)
//====================================================================
int HttpPost(string url, string body, string &responseBody)
{
   char postData[];
   // StringToCharArray returns the number of bytes written INCLUDING the trailing
   // null terminator.  We must strip that null before sending — otherwise the
   // JSON body contains a \0 byte that confuses every HTTP server's JSON parser.
   int n = StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 1) ArrayResize(postData, n - 1);   // strip null terminator
   char result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + DeviceToken + "\r\n";
   ResetLastError();
   int status = WebRequest("POST", url, headers, HttpTimeoutMs, postData, result, resultHeaders);
   if(status == -1)
   {
      int err = GetLastError();
      LogError(StringFormat("WebRequest failed (err=%d). Make sure '%s' is in Tools -> Options -> Expert Advisors -> 'Allow WebRequest for listed URL'.", err, BackendURL));
      responseBody = "";
      return -1;
   }
   responseBody = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   return status;
}

//====================================================================
// LEVEL CACHE MANAGEMENT
//====================================================================
int AddLevelRecord(string levelId, string objectName, string symbol, string tf, long chartId, double price)
{
   g_levelCount++;
   ArrayResize(g_levels, g_levelCount);
   g_levels[g_levelCount - 1].level_id       = levelId;
   g_levels[g_levelCount - 1].object_name    = objectName;
   g_levels[g_levelCount - 1].symbol         = symbol;
   g_levels[g_levelCount - 1].timeframe      = tf;
   g_levels[g_levelCount - 1].chart_id       = chartId;
   g_levels[g_levelCount - 1].price          = price;
   g_levels[g_levelCount - 1].seen_this_scan = true;
   return g_levelCount - 1;
}

int FindLevelById(string levelId)
{
   for(int i = 0; i < g_levelCount; i++) if(g_levels[i].level_id == levelId) return i;
   return -1;
}

void RemoveLevelRecord(int idx)
{
   for(int i = idx; i < g_levelCount - 1; i++) g_levels[i] = g_levels[i + 1];
   g_levelCount--;
   ArrayResize(g_levels, g_levelCount);
}

bool StringArrayContains(string &arr[], int n, string val)
{
   for(int i = 0; i < n; i++) if(arr[i] == val) return true;
   return false;
}

//====================================================================
// NOTIFICATION STATE MACHINE
//====================================================================
int FindNotifyState(string levelId)
{
   for(int i = 0; i < g_notifyCount; i++) if(g_notify[i].level_id == levelId) return i;
   return -1;
}

int AddNotifyState(string levelId)
{
   g_notifyCount++;
   ArrayResize(g_notify, g_notifyCount);
   g_notify[g_notifyCount - 1].level_id      = levelId;
   g_notify[g_notifyCount - 1].state         = STATE_NONE;
   g_notify[g_notifyCount - 1].side_before   = 0;
   g_notify[g_notifyCount - 1].last_notified = "";
   return g_notifyCount - 1;
}

void RemoveNotifyStateById(string levelId)
{
   int idx = FindNotifyState(levelId);
   if(idx < 0) return;
   for(int i = idx; i < g_notifyCount - 1; i++) g_notify[i] = g_notify[i + 1];
   g_notifyCount--;
   ArrayResize(g_notify, g_notifyCount);
}

//====================================================================
// SYMBOL UTILITIES (DYNAMIC MARKET WATCH & DIGITS/POINT)
//====================================================================

// Ensure symbol is in Market Watch so live quotes are updated by terminal.
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

double SymbolPoint(string symbol)
{
   double pt = SymbolInfoDouble(symbol, SYMBOL_POINT);
   return (pt > 0) ? pt : 0.00001;
}

int SymbolDigits(string symbol)
{
   int d = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   return (d > 0) ? d : 5;
}

string FormatPrice(string symbol, double price)
{
   return DoubleToString(price, SymbolDigits(symbol));
}

//====================================================================
// THRESHOLD CALCULATION (PER-SYMBOL OVERRIDES OR GLOBAL POINTS)
//====================================================================
bool GetSymbolOverride(string symbol, double &outAlertDist, double &outTouchEps, double &outResetDist)
{
   if(StringLen(SymbolThresholdOverrides) == 0) return false;
   string pairs[];
   int total = StringSplit(SymbolThresholdOverrides, ';', pairs);
   for(int i = 0; i < total; i++)
   {
      string kv[];
      if(StringSplit(pairs[i], ':', kv) == 2)
      {
         StringTrimLeft(kv[0]); StringTrimRight(kv[0]);
         StringTrimLeft(kv[1]); StringTrimRight(kv[1]);
         if(StringCompare(kv[0], symbol, false) == 0)
         {
            double d = StringToDouble(kv[1]);
            if(d > 0)
            {
               outAlertDist = d;
               outTouchEps  = d * 0.1666; // proportional touch tolerance
               outResetDist = d * 1.6666; // re-arm when outside 1.6x zone
               return true;
            }
         }
      }
   }
   return false;
}

void GetLevelThresholds(string symbol, double &alertDist, double &touchEps, double &resetDist)
{
   // 1. Check for specific symbol override
   if(GetSymbolOverride(symbol, alertDist, touchEps, resetDist)) return;

   // 2. Fall back to universal points-based calculation
   double pt = SymbolPoint(symbol);
   alertDist = AlertDistancePoints * pt;
   touchEps  = TouchEpsilonPoints  * pt;
   resetDist = ResetDistancePoints * pt;
}

//====================================================================
// CHART SCANNING (ALL OPEN CHARTS)
//====================================================================
struct SyncAction { string id; string tf; string symbol; double price; string name; string action; };
SyncAction g_syncActions[];
int        g_syncCount = 0;

void ResetSyncActions()
{
   g_syncCount = 0;
   ArrayResize(g_syncActions, 0);
}

void AppendSyncAction(string id, string tf, string symbol, double price, string name, string action)
{
   g_syncCount++;
   ArrayResize(g_syncActions, g_syncCount);
   g_syncActions[g_syncCount - 1].id     = id;
   g_syncActions[g_syncCount - 1].tf     = tf;
   g_syncActions[g_syncCount - 1].symbol = symbol;
   g_syncActions[g_syncCount - 1].price  = price;
   g_syncActions[g_syncCount - 1].name   = name;
   g_syncActions[g_syncCount - 1].action = action;
}

void MarkAllNotSeen()
{
   for(int i = 0; i < g_levelCount; i++) g_levels[i].seen_this_scan = false;
}

void ScanChart(long chartId)
{
   if(chartId <= 0) return;
   string symbol = ChartSymbol(chartId);
   string tfName = TfName((ENUM_TIMEFRAMES)ChartPeriod(chartId));
   if(StringLen(symbol) == 0) return;

   int total = ObjectsTotal(chartId, -1, OBJ_HLINE);
   for(int idx = 0; idx < total; idx++)
   {
      string name = ObjectName(chartId, idx, -1, OBJ_HLINE);
      if(name == "") continue;
      double price = ObjectGetDouble(chartId, name, OBJPROP_PRICE);

      if(StringFind(name, "LVL_") == 0)
      {
         string levelId = StringSubstr(name, 4);
         int li = FindLevelById(levelId);
         if(li < 0)
         {
            li = AddLevelRecord(levelId, name, symbol, tfName, chartId, price);
            LogDebug("Adopted existing level " + name + " [" + symbol + "]");
         }
         g_levels[li].seen_this_scan = true;
         double pt = SymbolPoint(symbol);
         if(MathAbs(g_levels[li].price - price) > pt)
         {
            g_levels[li].price = price;
            AppendSyncAction(levelId, tfName, symbol, price, name, "upsert");
            LogInfo(StringFormat("Level moved: [%s] %s -> %s", symbol, name, FormatPrice(symbol, price)));
         }
      }
      else
      {
         // New line drawn by user: assign UUID
         string newId   = GenerateUUIDv4();
         string newName = "LVL_" + newId;
         if(ObjectSetString(chartId, name, OBJPROP_NAME, newName))
         {
            int li = AddLevelRecord(newId, newName, symbol, tfName, chartId, price);
            g_levels[li].seen_this_scan = true;
            AppendSyncAction(newId, tfName, symbol, price, newName, "upsert");
            LogInfo(StringFormat("New level created: [%s] %s @ %s", symbol, tfName, FormatPrice(symbol, price)));
         }
         else
         {
            LogWarn("Could not name level object on " + symbol + ", err=" + IntegerToString(GetLastError()));
         }
      }
   }
}

void ScanAllCharts()
{
   MarkAllNotSeen();
   ResetSyncActions();

   long cid = ChartFirst();
   while(cid >= 0)
   {
      ScanChart(cid);
      cid = ChartNext(cid);
   }

   // Detect lines deleted locally by the user
   for(int i = g_levelCount - 1; i >= 0; i--)
   {
      if(!g_levels[i].seen_this_scan && g_levels[i].chart_id > 0)
      {
         string delId = g_levels[i].level_id;
         double delPrice = g_levels[i].price;
         AppendSyncAction(delId, g_levels[i].timeframe, g_levels[i].symbol, delPrice, g_levels[i].object_name, "delete");
         LogInfo("Level deleted locally: " + g_levels[i].object_name + " [" + g_levels[i].symbol + "]");
         RemoveNotifyStateById(delId);
         RemoveLevelRecord(i);
      }
   }
}

//====================================================================
// SYNC CHANGES TO BACKEND
//====================================================================
void SyncChangesToBackend()
{
   if(g_syncCount == 0) return;

   string symbols[];
   int symCount = 0;
   for(int i = 0; i < g_syncCount; i++)
   {
      if(!StringArrayContains(symbols, symCount, g_syncActions[i].symbol))
      {
         symCount++;
         ArrayResize(symbols, symCount);
         symbols[symCount - 1] = g_syncActions[i].symbol;
      }
   }

   for(int s = 0; s < symCount; s++)
   {
      string sym = symbols[s];
      string body = "{";
      body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
      body += "\"symbol\":\"" + JsonEscape(sym) + "\",";
      body += "\"levels\":[";
      bool first = true;
      for(int i = 0; i < g_syncCount; i++)
      {
         if(g_syncActions[i].symbol != sym) continue;
         if(!first) body += ",";
         body += "{";
         body += "\"level_id\":\"" + g_syncActions[i].id + "\",";
         body += "\"timeframe\":\"" + g_syncActions[i].tf + "\",";
         body += "\"price\":" + DoubleToString(g_syncActions[i].price, SymbolDigits(sym)) + ",";
         body += "\"object_name\":\"" + JsonEscape(g_syncActions[i].name) + "\",";
         body += "\"action\":\"" + g_syncActions[i].action + "\"";
         body += "}";
         first = false;
      }
      body += "]}";

      string resp;
      int status = HttpPost(BackendURL + "/api/levels/sync", body, resp);
      if(status == 200)
      {
         g_backendReachable = true;
         LogDebug("Levels synced OK for " + sym);
      }
      else
      {
         g_backendReachable = false;
         LogError(StringFormat("Backend request failed (/api/levels/sync for %s): status=%d", sym, status));
      }
   }
}

//====================================================================
// APPLY SERVER LEVELS (MIRRORING FROM OTHER PCS)
//====================================================================
void ApplyServerLevels(string &objs[], int n)
{
   string serverIds[];
   ArrayResize(serverIds, n);

   for(int k = 0; k < n; k++)
   {
      string obj      = objs[k];
      string levelId  = JsonGetStringValue(obj, "level_id");
      string symbol   = JsonGetStringValue(obj, "symbol");
      string tf       = JsonGetStringValue(obj, "timeframe");
      bool   foundP;
      double price     = JsonGetNumberValue(obj, "price", 0, foundP);
      string lastEvent = JsonGetStringValue(obj, "last_event_type");
      serverIds[k] = levelId;

      long cid = -1;
      long c = ChartFirst();
      while(c >= 0) { if(ChartSymbol(c) == symbol && TfName((ENUM_TIMEFRAMES)ChartPeriod(c)) == tf) { cid = c; break; } c = ChartNext(c); }

      int li = FindLevelById(levelId);
      if(li < 0)
      {
         if(cid > 0)
         {
            string objName = "LVL_" + levelId;
            if(ObjectFind(cid, objName) < 0)
            {
               ObjectCreate(cid, objName, OBJ_HLINE, 0, 0, price);
               ObjectSetInteger(cid, objName, OBJPROP_COLOR, clrDodgerBlue);
               ObjectSetInteger(cid, objName, OBJPROP_STYLE, STYLE_DASH);
               ObjectSetInteger(cid, objName, OBJPROP_SELECTABLE, true);
            }
            li = AddLevelRecord(levelId, objName, symbol, tf, cid, price);
         }
         else
         {
            li = AddLevelRecord(levelId, "LVL_" + levelId, symbol, tf, -1, price);
         }
         LogInfo(StringFormat("Mirrored level from other PC: [%s] %s @ %s", symbol, tf, FormatPrice(symbol, price)));
      }
      else if(MathAbs(g_levels[li].price - price) > SymbolPoint(symbol))
      {
         if(cid > 0) ObjectSetDouble(cid, g_levels[li].object_name, OBJPROP_PRICE, price);
         g_levels[li].price = price;
         LogDebug(StringFormat("Level %s updated from server -> %s [%s]", levelId, FormatPrice(symbol, price), symbol));
      }

      int ni = FindNotifyState(levelId);
      if(ni < 0) ni = AddNotifyState(levelId);
      if(g_notify[ni].last_notified == "" && lastEvent != "")
      {
         g_notify[ni].last_notified = lastEvent;
         if(lastEvent == "CROSS")         g_notify[ni].state = STATE_CROSSED;
         else if(lastEvent == "TOUCH")    g_notify[ni].state = STATE_TOUCHED;
         else if(lastEvent == "APPROACH") g_notify[ni].state = STATE_APPROACHING;
      }
   }

   for(int i = g_levelCount - 1; i >= 0; i--)
   {
      if(!StringArrayContains(serverIds, n, g_levels[i].level_id))
      {
         if(g_levels[i].chart_id > 0) ObjectDelete(g_levels[i].chart_id, g_levels[i].object_name);
         LogInfo("Level removed (deleted elsewhere): " + g_levels[i].object_name + " [" + g_levels[i].symbol + "]");
         RemoveNotifyStateById(g_levels[i].level_id);
         RemoveLevelRecord(i);
      }
   }
}

//====================================================================
// HEARTBEAT
//====================================================================
void DoHeartbeat()
{
   string symbols[];
   int symCount = 0;

   // 1. Include symbols from all active levels
   for(int i = 0; i < g_levelCount; i++)
   {
      if(!StringArrayContains(symbols, symCount, g_levels[i].symbol))
      {
         symCount++;
         ArrayResize(symbols, symCount);
         symbols[symCount - 1] = g_levels[i].symbol;
      }
   }

   // 2. Include symbols from all currently open charts (so levels can be mirrored onto them)
   long cid = ChartFirst();
   while(cid >= 0)
   {
      string sym = ChartSymbol(cid);
      if(StringLen(sym) > 0 && !StringArrayContains(symbols, symCount, sym))
      {
         symCount++;
         ArrayResize(symbols, symCount);
         symbols[symCount - 1] = sym;
      }
      cid = ChartNext(cid);
   }

   string body = "{";
   body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
   body += "\"symbols\":[";
   for(int i = 0; i < symCount; i++)
   {
      if(i > 0) body += ",";
      body += "\"" + JsonEscape(symbols[i]) + "\"";
   }
   body += "],";
   body += "\"mt5_connected\":" + (TerminalInfoInteger(TERMINAL_CONNECTED) != 0 ? "true" : "false") + ",";
   body += "\"version\":\"2.00\"";
   body += "}";

   string resp;
   int status = HttpPost(BackendURL + "/api/heartbeat", body, resp);
   if(status != 200)
   {
      g_backendReachable = false;
      LogError(StringFormat("Backend request failed (/api/heartbeat status=%d)", status));
      return;
   }

   g_backendReachable = true;
   g_lastHeartbeatOk  = TimeLocal();

   string newRole   = JsonGetStringValue(resp, "role");
   string newActive = JsonGetStringValue(resp, "active_pc_id");
   string newLease  = JsonGetStringValue(resp, "lease_id");
   bool found;
   double hbMs = JsonGetNumberValue(resp, "heartbeat_interval_ms", 5000, found);

   if(newRole == "ACTIVE" && g_role != "ACTIVE") LogInfo("*** Promoted to ACTIVE ***");
   else if(newRole != "ACTIVE" && g_role == "ACTIVE") LogInfo("Demoted to BACKUP (Active PC is " + newActive + ")");

   g_role               = newRole;
   g_activePcId         = newActive;
   g_leaseId            = newLease;
   g_serverHbIntervalMs = (int)hbMs;

   string levelObjs[];
   int n = JsonGetObjectArray(resp, "levels", levelObjs);
   ApplyServerLevels(levelObjs, n);

   LogDebug(StringFormat("Heartbeat OK. role=%s active=%s symbols=%d levels=%d", g_role, g_activePcId, symCount, n));
}

//====================================================================
// NOTIFICATION DISPATCH (ACTIVE PC ONLY)
//====================================================================
bool FireNotification(int levelIdx, double currentPrice, string eventType)
{
   LevelRecord lvl = g_levels[levelIdx];

   if(g_role != "ACTIVE")
   {
      LogDebug(StringFormat("%s on [%s] %s (%s) — BACKUP PC silent", eventType, lvl.symbol, lvl.object_name, FormatPrice(lvl.symbol, currentPrice)));
      return true;
   }

   string body = "{";
   body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
   body += "\"lease_id\":\"" + g_leaseId + "\",";
   body += "\"level_id\":\"" + lvl.level_id + "\",";
   body += "\"event_type\":\"" + eventType + "\",";
   body += "\"price\":" + DoubleToString(currentPrice, SymbolDigits(lvl.symbol));
   body += "}";

   string resp;
   int status = HttpPost(BackendURL + "/api/notify/trigger", body, resp);

   if(status == 200)
   {
      string respStatus = JsonGetStringValue(resp, "status");
      if(respStatus == "sent")
      {
         LogAlert(StringFormat("%s reached level %s (%s)", lvl.symbol, FormatPrice(lvl.symbol, lvl.price), eventType));
         LogInfo("Telegram notification sent");
      }
      else if(respStatus == "duplicate")
      {
         LogDebug(StringFormat("%s on [%s] already sent (duplicate suppressed)", eventType, lvl.symbol));
      }
      else if(respStatus == "queued_for_retry")
      {
         LogWarn(StringFormat("Telegram notification queued for retry: %s [%s]", eventType, lvl.symbol));
      }
      return true;
   }
   if(status == 409)
   {
      LogWarn("Lost ACTIVE lease mid-flight — handover in progress");
      return true;
   }

   LogError(StringFormat("Telegram notification failed (/api/notify/trigger status=%d)", status));
   return false;
}

void SendResetEvent(string levelId, string symbol, double price)
{
   if(g_role != "ACTIVE") return;
   string body = "{";
   body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
   body += "\"lease_id\":\"" + g_leaseId + "\",";
   body += "\"level_id\":\"" + levelId + "\",";
   body += "\"event_type\":\"RESET\",";
   body += "\"price\":" + DoubleToString(price, SymbolDigits(symbol));
   body += "}";
   string resp;
   HttpPost(BackendURL + "/api/notify/trigger", body, resp);
}

//====================================================================
// PRICE EVALUATION ENGINE
//====================================================================
void EvaluateLevel(int levelIdx, double currentPrice)
{
   string levelId    = g_levels[levelIdx].level_id;
   double levelPrice = g_levels[levelIdx].price;
   string symbol     = g_levels[levelIdx].symbol;

   double alertDist, touchEps, resetDist;
   GetLevelThresholds(symbol, alertDist, touchEps, resetDist);

   int ni = FindNotifyState(levelId);
   if(ni < 0) ni = AddNotifyState(levelId);

   double dist = MathAbs(currentPrice - levelPrice);
   int side = (currentPrice > levelPrice) ? 1 : -1;

   if(g_notify[ni].side_before == 0)
   {
      g_notify[ni].side_before = side;
      return;
   }

   // 1. Level Crossing
   if(side != g_notify[ni].side_before)
   {
      if(AlertOnCross && g_notify[ni].state != STATE_CROSSED)
      {
         if(FireNotification(levelIdx, currentPrice, "CROSS"))
         {
            g_notify[ni].state = STATE_CROSSED;
            g_notify[ni].last_notified = "CROSS";
         }
      }
      else
      {
         g_notify[ni].state = STATE_CROSSED;
      }
      g_notify[ni].side_before = side;
      return;
   }

   // 2. Touch Alert
   if(dist <= touchEps)
   {
      if(AlertOnTouch && (g_notify[ni].state == STATE_NONE || g_notify[ni].state == STATE_APPROACHING))
      {
         if(FireNotification(levelIdx, currentPrice, "TOUCH"))
         {
            g_notify[ni].state = STATE_TOUCHED;
            g_notify[ni].last_notified = "TOUCH";
         }
      }
   }
   // 3. Approach Alert
   else if(dist <= alertDist)
   {
      if(AlertOnApproach && g_notify[ni].state == STATE_NONE)
      {
         if(FireNotification(levelIdx, currentPrice, "APPROACH"))
         {
            g_notify[ni].state = STATE_APPROACHING;
            g_notify[ni].last_notified = "APPROACH";
         }
      }
   }
   // 4. Reset & Re-arm when price leaves the zone
   else if(dist > resetDist)
   {
      if(g_notify[ni].state != STATE_NONE)
      {
         LogDebug(StringFormat("Level [%s] %s re-armed (distance %s)", symbol, g_levels[levelIdx].object_name, FormatPrice(symbol, dist)));
         SendResetEvent(levelId, symbol, currentPrice);
      }
      g_notify[ni].state = STATE_NONE;
      g_notify[ni].last_notified = "";
   }
}

//====================================================================
// PRICE CHECK FOR ALL ACTIVE SYMBOLS (CALLED EVERY 1s ONTIMER)
//====================================================================
void CheckAllPrices()
{
   string symbols[];
   int symCount = 0;
   for(int i = 0; i < g_levelCount; i++)
   {
      if(!StringArrayContains(symbols, symCount, g_levels[i].symbol))
      {
         symCount++;
         ArrayResize(symbols, symCount);
         symbols[symCount - 1] = g_levels[i].symbol;
      }
   }

   for(int s = 0; s < symCount; s++)
   {
      string sym = symbols[s];
      if(!EnsureSymbolSelected(sym)) continue;

      double bid = SymbolInfoDouble(sym, SYMBOL_BID);
      if(bid <= 0)
      {
         LogError("Failed to get price for " + sym);
         continue;
      }

      for(int i = 0; i < g_levelCount; i++)
      {
         if(g_levels[i].symbol == sym)
            EvaluateLevel(i, bid);
      }
   }
}

void LogActiveSymbols()
{
   string symbols[];
   int symCount = 0;
   for(int i = 0; i < g_levelCount; i++)
   {
      if(!StringArrayContains(symbols, symCount, g_levels[i].symbol))
      {
         symCount++;
         ArrayResize(symbols, symCount);
         symbols[symCount - 1] = g_levels[i].symbol;
      }
   }

   LogInfo(StringFormat("Active symbols: %d", symCount));
   for(int i = 0; i < symCount; i++)
   {
      int cnt = 0;
      for(int j = 0; j < g_levelCount; j++) if(g_levels[j].symbol == symbols[i]) cnt++;
      LogInfo(StringFormat("Monitoring %s (%d level(s))", symbols[i], cnt));
   }
}

//====================================================================
// EXPERT ADVISOR ENTRY POINTS
//====================================================================
int OnInit()
{
   if(StringLen(DeviceToken) == 0)
   {
      LogError("DeviceToken is empty. Run `npm run register-device` on the backend and paste the printed token into the EA inputs.");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(ResetDistancePoints <= AlertDistancePoints)
   {
      LogError("ResetDistancePoints must be greater than AlertDistancePoints.");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(TouchEpsilonPoints > AlertDistancePoints)
   {
      LogError("TouchEpsilonPoints must be <= AlertDistancePoints.");
      return(INIT_PARAMETERS_INCORRECT);
   }

   MathSrand((int)GetTickCount() ^ (int)TimeLocal());

   LogInfo("Multi-symbol monitor started");
   LogInfo("PC_ID: " + PC_ID);
   LogInfo("Backend: " + BackendURL);

   // Run 1-second high-resolution timer for multi-symbol price tracking
   int timerSec = (TimerIntervalSec > 0) ? TimerIntervalSec : 1;
   EventSetTimer(timerSec);

   // Initial cycle
   ScanAllCharts();
   SyncChangesToBackend();
   DoHeartbeat();
   CheckAllPrices();
   LogActiveSymbols();

   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   LogInfo("EA stopped, reason=" + IntegerToString(reason));
}

void OnTimer()
{
   // 1. High-frequency price check: runs every second
   CheckAllPrices();

   // 2. Low-frequency cluster heartbeat & chart sync: runs every HeartbeatIntervalSec
   g_timerCounter++;
   if(g_timerCounter >= HeartbeatIntervalSec)
   {
      g_timerCounter = 0;
      ScanAllCharts();
      SyncChangesToBackend();
      DoHeartbeat();
   }
}

void OnTick()
{
   // Fast path for the symbol of the chart the EA is physically attached to
   string sym = Symbol();
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   if(bid <= 0) return;

   for(int i = 0; i < g_levelCount; i++)
   {
      if(g_levels[i].symbol == sym)
         EvaluateLevel(i, bid);
   }
}
//+------------------------------------------------------------------+
