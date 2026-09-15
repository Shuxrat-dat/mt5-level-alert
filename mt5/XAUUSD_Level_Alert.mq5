//+------------------------------------------------------------------+
//|                                        XAUUSD_Level_Alert.mq5     |
//|  Multi-PC failover level-alert EA.                                |
//|                                                                    |
//|  ARCHITECTURE SUMMARY (see docs/ARCHITECTURE.md for full detail) |
//|  - The SAME .ex5 runs unmodified on every PC. Only the inputs    |
//|    (PC_ID / DeviceToken / Priority) differ per machine.          |
//|  - Every HeartbeatIntervalSec seconds (OnTimer) the EA calls     |
//|    POST /api/heartbeat. The backend runs leader election and     |
//|    tells this PC whether it is ACTIVE or BACKUP right now.       |
//|  - Only the ACTIVE PC is allowed to actually push a Telegram      |
//|    notification (enforced both locally and, authoritatively, by  |
//|    the backend via the lease_id check).                          |
//|  - Horizontal lines (OBJ_HLINE) drawn on ANY of the 8 supported   |
//|    timeframe charts are auto-detected, assigned a stable UUID,   |
//|    and synced to the backend so they mirror onto the other PC(s) |
//|    automatically - you draw a line once, it appears everywhere.  |
//|  - XAUUSD has ONE price regardless of which timeframe chart you  |
//|    look at, so OnTick (which only needs to fire on the chart the |
//|    EA is physically attached to) evaluates ALL cached levels,    |
//|    across every timeframe, against that single live Bid price.   |
//+------------------------------------------------------------------+
#property copyright "Personal use"
#property version   "1.00"
#property strict

//====================================================================
// INPUTS
//====================================================================
input group "=== Backend connection ==="
input string   BackendURL          = "https://your-domain.example.com"; // Backend base URL (no trailing slash)
input string   PC_ID               = "PC1";        // Must match a PC_ID registered on the backend
input string   DeviceToken         = "";            // Token printed by `npm run register-device` - keep secret
input int      HttpTimeoutMs       = 5000;          // WebRequest timeout

input group "=== Cluster timing ==="
input int      HeartbeatIntervalSec = 5;            // How often to call /api/heartbeat (and sync levels)

input group "=== Symbol ==="
input string   TradeSymbol         = "XAUUSD";      // Symbol to monitor (future-proofed for others)

input group "=== Timeframes to monitor (lines drawn on these charts are tracked) ==="
input bool     EnableM5            = true;
input bool     EnableM15           = true;
input bool     EnableM30           = true;
input bool     EnableH1            = true;
input bool     EnableH4            = true;
input bool     EnableD1            = true;
input bool     EnableW1            = true;
input bool     EnableMN1           = true;

input group "=== Alert thresholds (in price units, e.g. USD for XAUUSD) ==="
input bool     AlertOnApproach     = true;
input bool     AlertOnTouch        = true;
input bool     AlertOnCross        = true;
input double   AlertDistance       = 0.30;          // Distance to trigger APPROACH
input double   TouchEpsilon        = 0.05;          // Distance to trigger TOUCH
input double   ResetDistance       = 0.50;          // Distance beyond which the level re-arms (must be > AlertDistance)

input group "=== Misc ==="
input bool     DebugMode           = false;         // Verbose logging

//====================================================================
// GLOBAL STATE
//====================================================================
#define MAX_TF 8

string   g_tfNames[MAX_TF];
ENUM_TIMEFRAMES g_tfEnums[MAX_TF];
long     g_tfChartId[MAX_TF];
int      g_tfCount = 0;

// One record per known level (across all timeframes).
struct LevelRecord
{
   string           level_id;      // UUID
   string           object_name;   // "LVL_<uuid>" as it appears on its chart
   int              tf_index;      // index into g_tfNames / g_tfChartId
   double           price;
   bool             seen_this_scan;
};
LevelRecord g_levels[];
int         g_levelCount = 0;

// Per-level notification state machine.
#define STATE_NONE       0
#define STATE_APPROACHING 1
#define STATE_TOUCHED     2
#define STATE_CROSSED     3

struct NotifyState
{
   string level_id;
   int    state;
   int    side_before;      // 0 = unknown, 1 = above level, -1 = below level
   string last_notified;    // "", "APPROACH", "TOUCH", "CROSS" - bootstrapped from server on promotion
};
NotifyState g_notify[];
int         g_notifyCount = 0;

// Cluster / role state, refreshed every heartbeat.
string   g_role            = "BACKUP";
string   g_activePcId      = "";
string   g_leaseId         = "";
long     g_leaseExpiresAtMs = 0;
int      g_serverHeartbeatIntervalMs = 5000;
datetime g_lastHeartbeatOk = 0;
bool     g_backendReachable = true;

//====================================================================
// LOGGING
//====================================================================
void LogInfo(string msg)  { Print("[INFO] ", msg); }
void LogWarn(string msg)  { Print("[WARN] ", msg); }
void LogError(string msg) { Print("[ERROR] ", msg); }
void LogDebug(string msg) { if(DebugMode) Print("[DEBUG] ", msg); }

//====================================================================
// MINIMAL JSON HELPERS
// MQL5 has no built-in JSON support. Rather than pull in a generic
// third-party parser, these functions are hand-written against the exact,
// flat, well-known shapes our own backend returns (see docs/ARCHITECTURE.md
// "Data format between EA and backend"). This keeps the EA dependency-free
// and easy to audit.
//====================================================================
string JsonEscape(string s)
{
   string r = "";
   int len = StringLen(s);
   for(int i = 0; i < len; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c == '"' || c == '\\')
      {
         r += "\\";
         r += StringSubstr(s, i, 1);
      }
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
   while(i < len)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == ' ' || c == '\n' || c == '\t' || c == '\r') { i++; continue; }
      break;
   }
   if(i >= len || StringGetCharacter(json, i) != '"') return ""; // not a string (null / missing)
   i++;
   string result = "";
   while(i < len)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == '\\' && i + 1 < len)
      {
         ushort nc = StringGetCharacter(json, i + 1);
         if(nc == 'n') result += "\n";
         else if(nc == 'r') result += "\r";
         else if(nc == 't') result += "\t";
         else result += StringSubstr(json, i + 1, 1);
         i += 2;
         continue;
      }
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
   while(i < len)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == ' ' || c == '\n' || c == '\t' || c == '\r') { i++; continue; }
      break;
   }
   if(i + 4 <= len && StringSubstr(json, i, 4) == "null") return defaultVal;
   int startI = i;
   while(i < len)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == ',' || c == '}' || c == ']') break;
      i++;
   }
   string numStr = StringSubstr(json, startI, i - startI);
   StringTrimLeft(numStr);
   StringTrimRight(numStr);
   if(StringLen(numStr) == 0) return defaultVal;
   found = true;
   return StringToDouble(numStr);
}

// Splits the top-level objects out of a named JSON array, e.g. "levels":[{...},{...}].
// Returns the raw (still-encoded) substring of each object for further
// per-field extraction with JsonGetStringValue / JsonGetNumberValue.
int JsonGetObjectArray(string json, string key, string &outObjects[])
{
   ArrayResize(outObjects, 0);
   string pattern = "\"" + key + "\"";
   int keyPos = StringFind(json, pattern);
   if(keyPos < 0) return 0;
   int bracketPos = StringFind(json, "[", keyPos);
   if(bracketPos < 0) return 0;

   int len = StringLen(json);
   int i = bracketPos + 1;
   int arrDepth = 1;
   int braceDepth = 0;
   int objStart = -1;
   int count = 0;

   while(i < len && arrDepth > 0)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == '[') arrDepth++;
      else if(c == ']')
      {
         arrDepth--;
         if(arrDepth == 0) break;
      }
      else if(c == '{')
      {
         if(braceDepth == 0) objStart = i;
         braceDepth++;
      }
      else if(c == '}')
      {
         braceDepth--;
         if(braceDepth == 0 && objStart >= 0)
         {
            count++;
            ArrayResize(outObjects, count);
            outObjects[count - 1] = StringSubstr(json, objStart, i - objStart + 1);
            objStart = -1;
         }
      }
      i++;
   }
   return count;
}

//====================================================================
// UUID v4 (random) - used to give every drawn line a stable, globally
// unique id that survives object renames and doesn't depend on MT5's own
// (sometimes reused) object-name auto-numbering.
//====================================================================
string GenerateUUIDv4()
{
   int b[16];
   for(int i = 0; i < 16; i++) b[i] = MathRand() % 256;
   b[6] = (b[6] & 0x0F) | 0x40; // version 4
   b[8] = (b[8] & 0x3F) | 0x80; // RFC 4122 variant
   string hex = "";
   for(int i = 0; i < 16; i++)
   {
      hex += StringFormat("%02x", b[i]);
      if(i == 3 || i == 5 || i == 7 || i == 9) hex += "-";
   }
   return hex;
}

//====================================================================
// HTTP (WebRequest wrapper)
//====================================================================
int HttpPost(string url, string body, string headers, string &responseBody)
{
   char postData[];
   int n = StringToCharArray(body, postData, 0, StringLen(body), CP_UTF8);
   if(ArraySize(postData) > 0) ArrayResize(postData, ArraySize(postData) - 1); // drop trailing \0

   char result[];
   string resultHeaders;
   ResetLastError();
   int status = WebRequest("POST", url, headers, HttpTimeoutMs, postData, result, resultHeaders);

   if(status == -1)
   {
      int err = GetLastError();
      LogError(StringFormat(
         "WebRequest failed (err=%d). Add %s to Tools -> Options -> Expert Advisors -> 'Allow WebRequest for listed URL'.",
         err, BackendURL));
      responseBody = "";
      return -1;
   }

   responseBody = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   return status;
}

//====================================================================
// TIMEFRAME / CHART MANAGEMENT
//
// XAUUSD has ONE price regardless of which timeframe you're looking at -
// only the drawn objects differ per chart. So instead of running 8 copies
// of this EA (one per timeframe), a single instance opens a lightweight
// background chart per enabled timeframe (if one isn't already open) and
// reads/writes OBJ_HLINE objects on each of them directly by chart_id.
//====================================================================
int g_digits = 2;
double g_point = 0.01;

long FindOpenChart(string symbol, ENUM_TIMEFRAMES tf)
{
   long cid = ChartFirst();
   while(cid >= 0)
   {
      if(ChartSymbol(cid) == symbol && ChartPeriod(cid) == tf) return cid;
      cid = ChartNext(cid);
   }
   return -1;
}

int FindTfIndex(string tfName)
{
   for(int i = 0; i < g_tfCount; i++)
      if(g_tfNames[i] == tfName) return i;
   return -1;
}

void InitTimeframes()
{
   g_tfCount = 0;
   if(EnableM5)  { g_tfNames[g_tfCount] = "M5";  g_tfEnums[g_tfCount] = PERIOD_M5;  g_tfCount++; }
   if(EnableM15) { g_tfNames[g_tfCount] = "M15"; g_tfEnums[g_tfCount] = PERIOD_M15; g_tfCount++; }
   if(EnableM30) { g_tfNames[g_tfCount] = "M30"; g_tfEnums[g_tfCount] = PERIOD_M30; g_tfCount++; }
   if(EnableH1)  { g_tfNames[g_tfCount] = "H1";  g_tfEnums[g_tfCount] = PERIOD_H1;  g_tfCount++; }
   if(EnableH4)  { g_tfNames[g_tfCount] = "H4";  g_tfEnums[g_tfCount] = PERIOD_H4;  g_tfCount++; }
   if(EnableD1)  { g_tfNames[g_tfCount] = "D1";  g_tfEnums[g_tfCount] = PERIOD_D1;  g_tfCount++; }
   if(EnableW1)  { g_tfNames[g_tfCount] = "W1";  g_tfEnums[g_tfCount] = PERIOD_W1;  g_tfCount++; }
   if(EnableMN1) { g_tfNames[g_tfCount] = "MN1"; g_tfEnums[g_tfCount] = PERIOD_MN1; g_tfCount++; }

   for(int i = 0; i < g_tfCount; i++)
   {
      long cid = FindOpenChart(TradeSymbol, g_tfEnums[i]);
      if(cid <= 0)
      {
         cid = ChartOpen(TradeSymbol, g_tfEnums[i]);
         if(cid > 0) LogInfo(StringFormat("Opened background chart for %s %s (id=%I64d)", TradeSymbol, g_tfNames[i], cid));
         else LogError(StringFormat("Could not open chart for %s %s, err=%d", TradeSymbol, g_tfNames[i], GetLastError()));
      }
      else
      {
         LogDebug(StringFormat("Using existing chart for %s %s (id=%I64d)", TradeSymbol, g_tfNames[i], cid));
      }
      g_tfChartId[i] = cid;
   }
}

// Re-verifies background charts are still open (the user could close a tab
// manually) and reopens any that are missing. Cheap, safe to call often.
void EnsureChartsOpen()
{
   for(int i = 0; i < g_tfCount; i++)
   {
      bool valid = false;
      if(g_tfChartId[i] > 0)
      {
         if(ChartSymbol(g_tfChartId[i]) == TradeSymbol && ChartPeriod(g_tfChartId[i]) == g_tfEnums[i])
            valid = true;
      }
      if(!valid)
      {
         long cid = FindOpenChart(TradeSymbol, g_tfEnums[i]);
         if(cid <= 0) cid = ChartOpen(TradeSymbol, g_tfEnums[i]);
         if(cid > 0 && cid != g_tfChartId[i])
            LogWarn(StringFormat("Background chart for %s was closed, re-opened (id=%I64d)", g_tfNames[i], cid));
         g_tfChartId[i] = cid;
      }
   }
}

//====================================================================
// LEVEL RECORD STORAGE (in-memory cache mirroring the backend)
//====================================================================
int AddLevelRecord(string levelId, string objectName, int tfIndex, double price)
{
   g_levelCount++;
   ArrayResize(g_levels, g_levelCount);
   g_levels[g_levelCount - 1].level_id       = levelId;
   g_levels[g_levelCount - 1].object_name    = objectName;
   g_levels[g_levelCount - 1].tf_index       = tfIndex;
   g_levels[g_levelCount - 1].price          = price;
   g_levels[g_levelCount - 1].seen_this_scan = true;
   return g_levelCount - 1;
}

int FindLevelById(string levelId)
{
   for(int i = 0; i < g_levelCount; i++)
      if(g_levels[i].level_id == levelId) return i;
   return -1;
}

void RemoveLevelRecord(int idx)
{
   for(int i = idx; i < g_levelCount - 1; i++) g_levels[i] = g_levels[i + 1];
   g_levelCount--;
   ArrayResize(g_levels, g_levelCount);
}

bool ContainsString(string &arr[], int n, string val)
{
   for(int i = 0; i < n; i++)
      if(arr[i] == val) return true;
   return false;
}

//====================================================================
// NOTIFICATION STATE MACHINE STORAGE
//====================================================================
int FindNotifyState(string levelId)
{
   for(int i = 0; i < g_notifyCount; i++)
      if(g_notify[i].level_id == levelId) return i;
   return -1;
}

int AddNotifyState(string levelId)
{
   g_notifyCount++;
   ArrayResize(g_notify, g_notifyCount);
   g_notify[g_notifyCount - 1].level_id     = levelId;
   g_notify[g_notifyCount - 1].state        = STATE_NONE;
   g_notify[g_notifyCount - 1].side_before  = 0;
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
// LEVEL DETECTION (local chart objects -> pending sync actions)
//====================================================================
void AppendSyncAction(string &ids[], string &tfs[], double &prices[], string &names[], string &actions[],
                       int &count, string id, string tf, double price, string name, string action)
{
   count++;
   ArrayResize(ids, count);
   ArrayResize(tfs, count);
   ArrayResize(prices, count);
   ArrayResize(names, count);
   ArrayResize(actions, count);
   ids[count - 1]     = id;
   tfs[count - 1]     = tf;
   prices[count - 1]  = price;
   names[count - 1]   = name;
   actions[count - 1] = action;
}

// Scans ONE timeframe's chart for OBJ_HLINE objects, detects new lines
// (renaming them to "LVL_<uuid>" in place so the id survives), detects
// moved lines, and detects deleted lines - appending any change to the
// shared pending-sync-action arrays (accumulated across all timeframes by
// the caller before a single batched /api/levels/sync call).
void ScanChartForLevels(int tfIndex, string &ids[], string &tfs[], double &prices[], string &names[],
                         string &actions[], int &count)
{
   long cid = g_tfChartId[tfIndex];
   if(cid <= 0) return;

   for(int i = 0; i < g_levelCount; i++)
      if(g_levels[i].tf_index == tfIndex) g_levels[i].seen_this_scan = false;

   int total = ObjectsTotal(cid, -1, OBJ_HLINE);
   for(int idx = 0; idx < total; idx++)
   {
      string name = ObjectName(cid, idx, -1, OBJ_HLINE);
      if(name == "") continue;
      double price = ObjectGetDouble(cid, name, OBJPROP_PRICE);

      if(StringFind(name, "LVL_") == 0)
      {
         string levelId = StringSubstr(name, 4);
         int li = FindLevelById(levelId);
         if(li < 0)
         {
            // Object already carries our naming convention but we don't have
            // it cached (e.g. EA restarted, or it was created by the mirror
            // logic moments ago). Adopt it rather than treat it as an error.
            li = AddLevelRecord(levelId, name, tfIndex, price);
            LogDebug("Adopted existing level object " + name);
         }
         g_levels[li].seen_this_scan = true;
         if(MathAbs(g_levels[li].price - price) > g_point)
         {
            g_levels[li].price = price;
            AppendSyncAction(ids, tfs, prices, names, actions, count, levelId, g_tfNames[tfIndex], price, name, "upsert");
            LogInfo(StringFormat("Level moved: %s %s -> %s", g_tfNames[tfIndex], name, DoubleToString(price, g_digits)));
         }
      }
      else
      {
         // Brand-new user-drawn line: claim it with a fresh UUID.
         string newId   = GenerateUUIDv4();
         string newName = "LVL_" + newId;
         if(ObjectSetString(cid, name, OBJPROP_NAME, newName))
         {
            int li = AddLevelRecord(newId, newName, tfIndex, price);
            g_levels[li].seen_this_scan = true;
            AppendSyncAction(ids, tfs, prices, names, actions, count, newId, g_tfNames[tfIndex], price, newName, "upsert");
            LogInfo(StringFormat("New level detected on %s at %s -> %s", g_tfNames[tfIndex], DoubleToString(price, g_digits), newName));
         }
         else
         {
            LogWarn("Could not claim line object '" + name + "', err=" + IntegerToString(GetLastError()));
         }
      }
   }

   // Anything for this timeframe not seen in this pass was deleted locally.
   for(int i = g_levelCount - 1; i >= 0; i--)
   {
      if(g_levels[i].tf_index == tfIndex && !g_levels[i].seen_this_scan)
      {
         string delId   = g_levels[i].level_id;
         string delName = g_levels[i].object_name;
         double delPrice = g_levels[i].price;
         AppendSyncAction(ids, tfs, prices, names, actions, count, delId, g_tfNames[tfIndex], delPrice, delName, "delete");
         LogInfo("Level deleted locally: " + delName);
         RemoveNotifyStateById(delId);
         RemoveLevelRecord(i);
      }
   }
}

void SyncLevelsToBackend(string &ids[], string &tfs[], double &prices[], string &names[], string &actions[], int count)
{
   string body = "{";
   body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
   body += "\"symbol\":\"" + JsonEscape(TradeSymbol) + "\",";
   body += "\"levels\":[";
   for(int i = 0; i < count; i++)
   {
      if(i > 0) body += ",";
      body += "{";
      body += "\"level_id\":\"" + ids[i] + "\",";
      body += "\"timeframe\":\"" + tfs[i] + "\",";
      body += "\"price\":" + DoubleToString(prices[i], g_digits) + ",";
      body += "\"object_name\":\"" + JsonEscape(names[i]) + "\",";
      body += "\"action\":\"" + actions[i] + "\"";
      body += "}";
   }
   body += "]}";

   string resp;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + DeviceToken + "\r\n";
   int status = HttpPost(BackendURL + "/api/levels/sync", body, headers, resp);

   if(status == 200)
   {
      g_backendReachable = true;
      LogDebug(StringFormat("Level sync OK (%d change(s))", count));
   }
   else
   {
      g_backendReachable = false;
      LogWarn(StringFormat("Level sync failed, status=%d resp=%s", status, resp));
   }
}

void ScanAllChartsAndSync()
{
   string ids[]; string tfs[]; string names[]; string actions[];
   double prices[];
   int count = 0;

   for(int i = 0; i < g_tfCount; i++)
      ScanChartForLevels(i, ids, tfs, prices, names, actions, count);

   if(count > 0)
      SyncLevelsToBackend(ids, tfs, prices, names, actions, count);
}

//====================================================================
// APPLY SERVER LEVELS (mirror levels created/moved/deleted on OTHER PCs)
//====================================================================
void ApplyServerLevels(string &objs[], int n)
{
   string serverIds[];
   ArrayResize(serverIds, n);

   for(int k = 0; k < n; k++)
   {
      string obj      = objs[k];
      string levelId  = JsonGetStringValue(obj, "level_id");
      string tf       = JsonGetStringValue(obj, "timeframe");
      bool   foundP;
      double price     = JsonGetNumberValue(obj, "price", 0, foundP);
      string lastEvent = JsonGetStringValue(obj, "last_event_type");
      serverIds[k] = levelId;

      int tfIndex = FindTfIndex(tf);
      if(tfIndex < 0) continue; // this timeframe isn't enabled on this PC

      int li = FindLevelById(levelId);
      if(li < 0)
      {
         long cid = g_tfChartId[tfIndex];
         if(cid <= 0) continue;
         string objName = "LVL_" + levelId;
         if(ObjectFind(cid, objName) < 0)
         {
            ObjectCreate(cid, objName, OBJ_HLINE, 0, 0, price);
            ObjectSetInteger(cid, objName, OBJPROP_COLOR, clrDodgerBlue);
            ObjectSetInteger(cid, objName, OBJPROP_STYLE, STYLE_DASH);
            ObjectSetInteger(cid, objName, OBJPROP_SELECTABLE, true);
         }
         li = AddLevelRecord(levelId, objName, tfIndex, price);
         LogInfo(StringFormat("Mirrored level from another PC: %s @ %s (%s)", tf, DoubleToString(price, g_digits), levelId));
      }
      else if(MathAbs(g_levels[li].price - price) > g_point)
      {
         long cid = g_tfChartId[tfIndex];
         if(cid > 0) ObjectSetDouble(cid, g_levels[li].object_name, OBJPROP_PRICE, price);
         g_levels[li].price = price;
         LogDebug(StringFormat("Level %s updated from server -> %s", levelId, DoubleToString(price, g_digits)));
      }

      // Bootstrap this level's notification state from the server ONLY the
      // first time we see it (empty last_notified) - e.g. right after this
      // PC gets promoted to ACTIVE, or right after the EA restarts. This is
      // what stops a freshly-promoted PC from re-sending an event another
      // PC already sent before it died. Once bootstrapped, the LOCAL price
      // state machine (EvaluateLevel) takes over exclusively.
      int ni = FindNotifyState(levelId);
      if(ni < 0) ni = AddNotifyState(levelId);
      if(g_notify[ni].last_notified == "" && lastEvent != "")
      {
         g_notify[ni].last_notified = lastEvent;
         if(lastEvent == "CROSS")        g_notify[ni].state = STATE_CROSSED;
         else if(lastEvent == "TOUCH")   g_notify[ni].state = STATE_TOUCHED;
         else if(lastEvent == "APPROACH")g_notify[ni].state = STATE_APPROACHING;
      }
   }

   // Anything we have locally that the server no longer lists was deleted
   // (by us or another PC) - remove the mirrored object.
   for(int i = g_levelCount - 1; i >= 0; i--)
   {
      if(!ContainsString(serverIds, n, g_levels[i].level_id))
      {
         long cid = g_tfChartId[g_levels[i].tf_index];
         if(cid > 0) ObjectDelete(cid, g_levels[i].object_name);
         LogInfo("Level removed (deleted elsewhere): " + g_levels[i].object_name);
         RemoveNotifyStateById(g_levels[i].level_id);
         RemoveLevelRecord(i);
      }
   }
}

//====================================================================
// HEARTBEAT (role / lease / level list in one combined call)
//====================================================================
void DoHeartbeat()
{
   string body = "{";
   body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
   body += "\"symbol\":\"" + JsonEscape(TradeSymbol) + "\",";
   body += "\"mt5_connected\":" + (TerminalInfoInteger(TERMINAL_CONNECTED) != 0 ? "true" : "false") + ",";
   body += "\"version\":\"1.00\"";
   body += "}";

   string resp;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + DeviceToken + "\r\n";
   int status = HttpPost(BackendURL + "/api/heartbeat", body, headers, resp);

   if(status != 200)
   {
      g_backendReachable = false;
      LogWarn(StringFormat("Heartbeat failed, status=%d resp=%s", status, resp));
      return; // keep last known role - never assume ACTIVE just because the backend is unreachable
   }

   g_backendReachable = true;
   g_lastHeartbeatOk = TimeLocal();

   string newRole   = JsonGetStringValue(resp, "role");
   string newActive = JsonGetStringValue(resp, "active_pc_id");
   string newLease  = JsonGetStringValue(resp, "lease_id");
   bool found;
   double hbIntervalMs = JsonGetNumberValue(resp, "heartbeat_interval_ms", 5000, found);

   if(newRole == "ACTIVE" && g_role != "ACTIVE")
      LogInfo("*** Promoted to ACTIVE ***");
   else if(newRole != "ACTIVE" && g_role == "ACTIVE")
      LogInfo("Demoted to BACKUP (active is now " + newActive + ")");

   g_role                     = newRole;
   g_activePcId               = newActive;
   g_leaseId                  = newLease;
   g_serverHeartbeatIntervalMs = (int)hbIntervalMs;

   string levelObjs[];
   int n = JsonGetObjectArray(resp, "levels", levelObjs);
   ApplyServerLevels(levelObjs, n);

   LogDebug(StringFormat("Heartbeat OK. role=%s active=%s levels=%d", g_role, g_activePcId, n));
}

//====================================================================
// NOTIFICATION TRIGGER (only ever called when role == ACTIVE)
//====================================================================
bool FireNotification(int levelIdx, double price, string eventType)
{
   LevelRecord lvl = g_levels[levelIdx];

   if(g_role != "ACTIVE")
   {
      LogDebug(StringFormat("%s on %s reached (%s) but this PC is BACKUP - not sending", eventType, lvl.object_name,
                             DoubleToString(price, g_digits)));
      return true; // handled locally; BACKUP still advances its own state machine silently
   }

   string body = "{";
   body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
   body += "\"lease_id\":\"" + g_leaseId + "\",";
   body += "\"level_id\":\"" + lvl.level_id + "\",";
   body += "\"event_type\":\"" + eventType + "\",";
   body += "\"price\":" + DoubleToString(price, g_digits);
   body += "}";

   string resp;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + DeviceToken + "\r\n";
   int status = HttpPost(BackendURL + "/api/notify/trigger", body, headers, resp);

   if(status == 200)
   {
      string respStatus = JsonGetStringValue(resp, "status");
      if(respStatus == "sent")
         LogInfo(StringFormat("Telegram notification sent: %s %s @ %s", eventType, lvl.object_name, DoubleToString(price, g_digits)));
      else if(respStatus == "duplicate")
         LogInfo(StringFormat("%s on %s was already sent (duplicate suppressed) - OK", eventType, lvl.object_name));
      else if(respStatus == "queued_for_retry")
         LogWarn(StringFormat("Backend could not reach Telegram, queued for retry: %s %s", eventType, lvl.object_name));
      return true;
   }
   if(status == 409)
   {
      LogWarn("Lost ACTIVE role mid-flight (another PC took over) - not sending, next heartbeat will sync role.");
      return true; // stale role client-side; don't retry, heartbeat will correct g_role shortly
   }

   LogError(StringFormat("notify/trigger failed status=%d resp=%s - will retry while condition persists", status, resp));
   return false;
}

void SendResetEvent(string levelId, double price)
{
   if(g_role != "ACTIVE") return;
   string body = "{";
   body += "\"pc_id\":\"" + JsonEscape(PC_ID) + "\",";
   body += "\"lease_id\":\"" + g_leaseId + "\",";
   body += "\"level_id\":\"" + levelId + "\",";
   body += "\"event_type\":\"RESET\",";
   body += "\"price\":" + DoubleToString(price, g_digits);
   body += "}";
   string resp;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + DeviceToken + "\r\n";
   HttpPost(BackendURL + "/api/notify/trigger", body, headers, resp); // best-effort
}

//====================================================================
// PRICE STATE MACHINE (runs on every tick, no network I/O except the
// rare moment a real transition fires a notification)
//====================================================================
void EvaluateLevel(int levelIdx, double price)
{
   string levelId = g_levels[levelIdx].level_id;
   double levelPrice = g_levels[levelIdx].price;

   int ni = FindNotifyState(levelId);
   if(ni < 0) ni = AddNotifyState(levelId);

   double dist = MathAbs(price - levelPrice);
   int side = (price > levelPrice) ? 1 : -1;

   if(g_notify[ni].side_before == 0)
   {
      g_notify[ni].side_before = side; // first observation - just initialize, no event
      return;
   }

   if(side != g_notify[ni].side_before)
   {
      if(AlertOnCross && g_notify[ni].state != STATE_CROSSED)
      {
         if(FireNotification(levelIdx, price, "CROSS"))
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

   if(dist <= TouchEpsilon)
   {
      if(AlertOnTouch && (g_notify[ni].state == STATE_NONE || g_notify[ni].state == STATE_APPROACHING))
      {
         if(FireNotification(levelIdx, price, "TOUCH"))
         {
            g_notify[ni].state = STATE_TOUCHED;
            g_notify[ni].last_notified = "TOUCH";
         }
      }
   }
   else if(dist <= AlertDistance)
   {
      if(AlertOnApproach && g_notify[ni].state == STATE_NONE)
      {
         if(FireNotification(levelIdx, price, "APPROACH"))
         {
            g_notify[ni].state = STATE_APPROACHING;
            g_notify[ni].last_notified = "APPROACH";
         }
      }
   }
   else if(dist > ResetDistance)
   {
      if(g_notify[ni].state != STATE_NONE)
      {
         LogDebug(StringFormat("Level %s re-armed (%s away)", g_levels[levelIdx].object_name, DoubleToString(dist, g_digits)));
         SendResetEvent(levelId, price);
      }
      g_notify[ni].state = STATE_NONE;
      g_notify[ni].last_notified = "";
   }
}

void OnTickHandler()
{
   double bid = SymbolInfoDouble(TradeSymbol, SYMBOL_BID);
   if(bid <= 0) return;

   for(int i = 0; i < g_levelCount; i++)
      EvaluateLevel(i, bid);
}

//====================================================================
// ENTRY POINTS
//====================================================================
int OnInit()
{
   if(StringLen(DeviceToken) == 0)
   {
      LogError("DeviceToken is empty. Run `npm run register-device` on the backend and paste the printed token here.");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(ResetDistance <= AlertDistance)
   {
      LogError("ResetDistance must be greater than AlertDistance (see docs/ARCHITECTURE.md).");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(TouchEpsilon > AlertDistance)
   {
      LogError("TouchEpsilon must be <= AlertDistance.");
      return(INIT_PARAMETERS_INCORRECT);
   }

   MathSrand((int)GetTickCount() ^ (int)TimeLocal());

   g_digits = (int)SymbolInfoInteger(TradeSymbol, SYMBOL_DIGITS);
   if(g_digits <= 0) g_digits = 2;
   g_point = SymbolInfoDouble(TradeSymbol, SYMBOL_POINT);
   if(g_point <= 0) g_point = 0.01;

   InitTimeframes();
   if(g_tfCount == 0)
   {
      LogError("No timeframes enabled - nothing to monitor. Enable at least one in the inputs.");
      return(INIT_PARAMETERS_INCORRECT);
   }

   LogInfo("=== XAUUSD Level Alert EA starting ===");
   LogInfo("PC_ID: " + PC_ID);
   LogInfo(StringFormat("Monitoring %s across %d timeframe(s)", TradeSymbol, g_tfCount));
   LogInfo("Connecting to backend: " + BackendURL);

   EventSetTimer(HeartbeatIntervalSec);

   // Do an immediate scan + heartbeat on startup instead of waiting a full
   // HeartbeatIntervalSec, so the EA picks up its role and existing levels
   // right away.
   ScanAllChartsAndSync();
   DoHeartbeat();

   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   LogInfo("EA stopped, reason=" + IntegerToString(reason));
}

void OnTimer()
{
   EnsureChartsOpen();
   ScanAllChartsAndSync();
   DoHeartbeat();
}

void OnTick()
{
   OnTickHandler();
}
