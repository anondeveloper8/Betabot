//+------------------------------------------------------------------+
//|                                              ForexBotEA.mq5      |
//|                                                                  |
//| THIN EXECUTION CLIENT -- NOT the strategy.                       |
//|                                                                  |
//| This EA deliberately contains no trading logic of its own. It    |
//| gathers recent M15/H4 candles, POSTs them to the /api/decide     |
//| endpoint (the same, already-audited JS engine used for every     |
//| backtest in this project), and if told TRADE_ALLOWED, places the |
//| exact order it was given -- same direction, stop, target, size.  |
//| Every strategy rule lives in ONE place (the JS), not two. This   |
//| file should never need to encode a trading decision, only carry  |
//| one out.                                                         |
//|                                                                  |
//| DEMO ACCOUNT ONLY until there is real forward evidence to        |
//| justify otherwise. That is a decision for you to make later,     |
//| deliberately -- this EA does not gate that; your account choice  |
//| in MT5 does.                                                     |
//|                                                                  |
//| BEFORE FIRST USE:                                                |
//|   1. Compile in MetaEditor (F7) and fix any compiler errors --   |
//|      this file has not been compiled or run; only the JS side    |
//|      of this project has been directly verified.                |
//|   2. Tools > Options > Expert Advisors > "Allow WebRequest for   |
//|      listed URL" -- add BOTH your Vercel endpoint's domain and   |
//|      your Supabase project's domain. WebRequest silently fails   |
//|      without this.                                               |
//|   3. Attach to an EURUSD chart (any timeframe -- the EA uses its |
//|      own timer, not the chart's period) on a DEMO account, with  |
//|      AutoTrading enabled.                                        |
//|   4. Watch the Experts/Journal tab for the first several signals |
//|      before trusting it unattended.                              |
//+------------------------------------------------------------------+
#property copyright "Deterministic Trading Engine"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

//--- Inputs -----------------------------------------------------------
input string   InpApiUrl            = "https://YOUR-VERCEL-APP.vercel.app/api/decide"; // Decision endpoint
input string   InpSupabaseUrl       = "https://YOUR-PROJECT.supabase.co";              // Supabase project URL
input string   InpSupabaseApiKey    = "YOUR-SUPABASE-ANON-OR-SERVICE-KEY";             // Supabase API key
input string   InpSymbol            = "EURUSD";
input ulong    InpMagicNumber       = 20260907;
input int      InpLookbackDays      = 60;     // History sent to the decision endpoint each call. See note in ProcessNewBar() before increasing this.
input int      InpTimerSeconds      = 15;     // How often to check for a new closed M15 bar
input int      InpHttpTimeoutMs     = 25000;  // Generous on purpose -- building JSON for thousands of candles plus the network round-trip both eat into this

//--- Globals ------------------------------------------------------------
CTrade trade;
datetime g_lastProcessedM15Bar = 0;
bool     g_wasPaused = false;      // for logging a state-change message once, not every 15s
ulong    g_lastKnownTicket = 0;    // open position we're watching for a close
string   g_lastKnownSetupId = "";
double   g_lastKnownEntryPrice = 0;
double   g_lastKnownStopPrice = 0;
string   g_lastKnownDirection = "";

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   g_lastProcessedM15Bar = 0;
   EventSetTimer(InpTimerSeconds);
   Print("ForexBotEA initialized. Decision endpoint: ", InpApiUrl);
   Print("REMINDER: this EA has not been compiled/tested by the person who wrote it (an AI assistant with no MT5 runtime). Verify carefully on demo before trusting it.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
}

//+------------------------------------------------------------------+
// Fires every InpTimerSeconds. Cheap check; only does real work when a
// new M15 bar has actually closed.
//+------------------------------------------------------------------+
void OnTimer()
{
   // Close-detection runs every tick regardless of bar timing, so a closed
   // trade gets reported promptly rather than waiting for the next M15 bar.
   CheckForClosedPosition();

   datetime m15Times[];
   if(CopyTime(InpSymbol, PERIOD_M15, 0, 2, m15Times) < 2) return;

   datetime latestClosedBarTime = m15Times[1]; // index 0 is the still-forming bar; index 1 is the last CLOSED bar
   if(latestClosedBarTime == g_lastProcessedM15Bar) return; // nothing new yet
   g_lastProcessedM15Bar = latestClosedBarTime;

   bool paused = IsBotPaused();
   if(paused != g_wasPaused)
   {
      Print(paused ? "Bot is PAUSED (per dashboard) -- new bars will be skipped until resumed." : "Bot RESUMED (per dashboard).");
      g_wasPaused = paused;
   }
   if(paused) return; // still track closes above; just don't open anything new

   Print("New M15 bar closed at ", TimeToString(latestClosedBarTime), " -- evaluating.");
   ProcessNewBar();
}

//+------------------------------------------------------------------+
bool IsBotPaused()
{
   string url = InpSupabaseUrl + "/rest/v1/bot_config?id=eq.1&select=paused";
   string headers = "apikey: " + InpSupabaseApiKey + "\r\nAuthorization: Bearer " + InpSupabaseApiKey + "\r\n";
   char postData[];
   char result[];
   string resultHeaders;
   ResetLastError();
   int status = WebRequest("GET", url, headers, InpHttpTimeoutMs, postData, result, resultHeaders);
   if(status != 200)
   {
      Print("Could not read bot_config (status ", status, ", err ", GetLastError(), ") -- defaulting to PAUSED for safety.");
      return true; // fail safe: if we can't confirm we're allowed to trade, don't
   }
   string body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return (StringFind(body, "\"paused\":true") >= 0);
}

//+------------------------------------------------------------------+
void ProcessNewBar()
{
   // PERFORMANCE NOTE, flagged honestly rather than left for you to
   // discover: RatesToJson() below builds its output with plain string
   // concatenation in a loop. At 60 days * ~96 M15 bars/day (~5,760
   // iterations) this is a few hundred KB of JSON and should complete in a
   // reasonable time, but MQL5 string += in a loop is not guaranteed O(1)
   // per append -- if you raise InpLookbackDays a lot, or notice this
   // timing out, that loop is the first place to optimize (e.g. building
   // into a pre-sized array of parts and joining once, rather than
   // repeated +=).
   MqlRates m15[];
   MqlRates h4[];
   int m15Count = InpLookbackDays * 96;  // ~96 M15 bars/day
   int h4Count  = InpLookbackDays * 6 + 10;

   int copiedM15 = CopyRates(InpSymbol, PERIOD_M15, 0, m15Count, m15);
   int copiedH4  = CopyRates(InpSymbol, PERIOD_H4, 0, h4Count, h4);
   if(copiedM15 <= 0 || copiedH4 <= 0)
   {
      Print("CopyRates failed. M15=", copiedM15, " H4=", copiedH4, " err=", GetLastError());
      return;
   }

   // CopyRates returns oldest-first already for these calls (index 0 = oldest
   // of the requested range) -- confirm ascending order defensively.
   if(m15Count >= 2 && m15[0].time > m15[ArraySize(m15)-1].time) ArrayReverse(m15);
   if(h4Count  >= 2 && h4[0].time  > h4[ArraySize(h4)-1].time)  ArrayReverse(h4);

   // The very last M15 bar in the array may still be the forming (open) bar
   // if CopyRates included it -- drop it, decide.js expects only CLOSED bars,
   // and g_lastProcessedM15Bar already identifies the true last closed one.
   int m15Last = ArraySize(m15) - 1;
   while(m15Last >= 0 && m15[m15Last].time > g_lastProcessedM15Bar) m15Last--;

   string m15Json = RatesToJson(m15, m15Last + 1, PeriodSeconds(PERIOD_M15));
   string h4Json  = RatesToJson(h4, ArraySize(h4), PeriodSeconds(PERIOD_H4));

   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   bool positionExists = PositionSelect(InpSymbol) && PositionGetInteger(POSITION_MAGIC) == (long)InpMagicNumber;

   string body = StringFormat(
      "{\"m15\":%s,\"h4\":%s,\"equity\":%s,\"currentBid\":%s,\"currentAsk\":%s,\"positionExists\":%s,\"executedSetupIds\":[]}",
      m15Json, h4Json,
      DoubleToString(equity, 2),
      DoubleToString(bid, 5),
      DoubleToString(ask, 5),
      positionExists ? "true" : "false"
   );

   string response;
   if(!PostJson(InpApiUrl, body, response))
   {
      Print("decide.js request failed.");
      return;
   }

   LogSignalToSupabase(response, equity);
   HandleDecisionResponse(response);
}

//+------------------------------------------------------------------+
// Minimal, purpose-built JSON builder for the specific candle shape
// decide.js expects. Not a general-purpose serializer.
//+------------------------------------------------------------------+
string RatesToJson(MqlRates &rates[], int count, int periodSeconds)
{
   string parts = "[";
   for(int i = 0; i < count; i++)
   {
      long openMs  = (long)rates[i].time * 1000;
      long closeMs = openMs + (long)periodSeconds * 1000;
      if(i > 0) parts += ",";
      parts += StringFormat(
         "{\"timestampOpen\":%I64d,\"timestampClose\":%I64d,\"open\":\"%s\",\"high\":\"%s\",\"low\":\"%s\",\"close\":\"%s\",\"isComplete\":true}",
         openMs, closeMs,
         DoubleToString(rates[i].open, 5),
         DoubleToString(rates[i].high, 5),
         DoubleToString(rates[i].low, 5),
         DoubleToString(rates[i].close, 5)
      );
   }
   parts += "]";
   return parts;
}

//+------------------------------------------------------------------+
bool PostJson(string url, string &body, string &responseOut)
{
   char postData[];
   int len = StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   ArrayResize(postData, len);

   string headers = "Content-Type: application/json\r\n";
   char result[];
   string resultHeaders;

   ResetLastError();
   int status = WebRequest("POST", url, headers, InpHttpTimeoutMs, postData, result, resultHeaders);
   if(status == -1)
   {
      int err = GetLastError();
      Print("WebRequest failed, error ", err, ". Did you whitelist ", url, " in Tools > Options > Expert Advisors?");
      return false;
   }
   responseOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status != 200)
   {
      Print("decide.js returned HTTP ", status, ": ", responseOut);
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
// Minimal JSON field extraction for the KNOWN, fixed response shape of
// decide.js. Not a general JSON parser -- do not reuse for arbitrary JSON.
//+------------------------------------------------------------------+
string JsonGetString(string json, string key, int fromPos = 0)
{
   string needle = "\"" + key + "\":\"";
   int p = StringFind(json, needle, fromPos);
   if(p < 0) return "";
   p += StringLen(needle);
   int end = StringFind(json, "\"", p);
   if(end < 0) return "";
   return StringSubstr(json, p, end - p);
}

double JsonGetNumber(string json, string key, int fromPos = 0)
{
   string needle = "\"" + key + "\":";
   int p = StringFind(json, needle, fromPos);
   if(p < 0) return 0.0;
   p += StringLen(needle);
   int end = p;
   while(end < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, end);
      if(ch == ',' || ch == '}' || ch == ']') break;
      end++;
   }
   string numStr = StringSubstr(json, p, end - p);
   if(numStr == "null") return 0.0;
   return StringToDouble(numStr);
}

//+------------------------------------------------------------------+
void HandleDecisionResponse(string response)
{
   // Walk each object inside the "decisions" array looking for one with
   // decision == "TRADE_ALLOWED". freshCandidateCount is almost always 0
   // or 1 given the funnel seen in backtesting, but this scans generically.
   int arrStart = StringFind(response, "\"decisions\":[");
   if(arrStart < 0) { Print("No decisions array in response."); return; }

   int cursor = arrStart;
   while(true)
   {
      int objStart = StringFind(response, "{", cursor);
      if(objStart < 0) break;
      int objEnd = StringFind(response, "}", objStart);
      if(objEnd < 0) break;

      string decision = JsonGetString(response, "decision", objStart);
      if(decision == "TRADE_ALLOWED")
      {
         string setupId    = JsonGetString(response, "setupId", objStart);
         string direction  = JsonGetString(response, "direction", objStart);
         double stopPrice  = JsonGetNumber(response, "stopPrice", objStart);
         double targetPrice= JsonGetNumber(response, "targetPrice", objStart);
         double lotSize    = JsonGetNumber(response, "positionSize", objStart);
         double entryPrice = JsonGetNumber(response, "entryPrice", objStart);
         double rr         = JsonGetNumber(response, "rr", objStart);
         ExecuteTrade(direction, stopPrice, targetPrice, lotSize, setupId, entryPrice, rr);
         break; // one position at a time, matching the backtested model
      }
      cursor = objEnd + 1;
   }
}

//+------------------------------------------------------------------+
void ExecuteTrade(string direction, double stopPrice, double targetPrice, double lotSize, string setupId, double entryPrice, double rr)
{
   if(lotSize <= 0)
   {
      Print("Refusing to execute setup ", setupId, ": lot size from decide.js was ", lotSize);
      return;
   }

   bool ok;
   if(direction == "BUY")
      ok = trade.Buy(lotSize, InpSymbol, 0.0, stopPrice, targetPrice, setupId);
   else if(direction == "SELL")
      ok = trade.Sell(lotSize, InpSymbol, 0.0, stopPrice, targetPrice, setupId);
   else
   {
      Print("Unknown direction from decide.js: ", direction);
      return;
   }

   if(ok)
   {
      Print("Executed ", direction, " ", lotSize, " lots, setup=", setupId, " SL=", stopPrice, " TP=", targetPrice);
      g_lastKnownTicket = trade.ResultOrder();
      g_lastKnownSetupId = setupId;
      g_lastKnownEntryPrice = entryPrice;
      g_lastKnownStopPrice = stopPrice;
      g_lastKnownDirection = direction;
   }
   else
      Print("Order failed for setup ", setupId, ": ", trade.ResultRetcodeDescription());

   LogExecutionToSupabase(setupId, direction, lotSize, entryPrice, stopPrice, targetPrice, rr, ok, ok ? trade.ResultOrder() : 0);
}

//+------------------------------------------------------------------+
// Runs every timer tick. If we placed a trade (g_lastKnownTicket set) and
// it's no longer an open position, it closed -- find the closing deal and
// report the outcome back to Supabase so the dashboard can show it.
//+------------------------------------------------------------------+
void CheckForClosedPosition()
{
   if(g_lastKnownTicket == 0) return;
   if(PositionSelectByTicket(g_lastKnownTicket)) return; // still open, nothing to do

   // Position is gone -- find the closing deal in history for this ticket's
   // position id (MT5 tracks deals by POSITION_IDENTIFIER, not order ticket).
   if(!HistorySelectByPosition((long)g_lastKnownTicket))
   {
      // Fallback: select a recent window of history and search it.
      HistorySelect(TimeCurrent() - 60 * 60 * 24 * 3, TimeCurrent());
   }

   int total = HistoryDealsTotal();
   double closePrice = 0, profit = 0;
   datetime closeTime = 0;
   bool found = false;
   for(int i = total - 1; i >= 0; i--)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;
      if(HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID) != (long)g_lastKnownTicket) continue;
      if(HistoryDealGetInteger(dealTicket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      closePrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
      profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT) + HistoryDealGetDouble(dealTicket, DEAL_SWAP) + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
      closeTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
      found = true;
      break;
   }

   if(!found)
   {
      Print("Position ", g_lastKnownTicket, " (setup ", g_lastKnownSetupId, ") is gone but no closing deal found -- will retry.");
      return; // try again next tick rather than lose the report
   }

   double riskDistance = MathAbs(g_lastKnownEntryPrice - g_lastKnownStopPrice);
   double realizedR = 0;
   if(riskDistance > 0)
   {
      double moveInFavor = (g_lastKnownDirection == "BUY") ? (closePrice - g_lastKnownEntryPrice) : (g_lastKnownEntryPrice - closePrice);
      realizedR = moveInFavor / riskDistance;
   }

   Print("Position ", g_lastKnownTicket, " (setup ", g_lastKnownSetupId, ") closed at ", closePrice, ", P/L ", profit, ", R=", realizedR);
   LogCloseToSupabase(g_lastKnownSetupId, closePrice, profit, realizedR, closeTime);
   g_lastKnownTicket = 0;
   g_lastKnownSetupId = "";
   g_lastKnownEntryPrice = 0;
   g_lastKnownStopPrice = 0;
   g_lastKnownDirection = "";
}

//+------------------------------------------------------------------+
void LogCloseToSupabase(string setupId, double closePrice, double realizedMoney, double realizedR, datetime closeTime)
{
   string url = InpSupabaseUrl + "/rest/v1/bot_trades?setup_id=eq." + setupId + "&status=eq.OPEN";
   string body = StringFormat(
      "{\"status\":\"CLOSED\",\"close_price\":%s,\"realized_money\":%s,\"realized_r\":%s,\"closed_at\":\"%s\"}",
      DoubleToString(closePrice, 5), DoubleToString(realizedMoney, 2), DoubleToString(realizedR, 4),
      TimeToString(closeTime, TIME_DATE | TIME_SECONDS)
   );
   string headers = "Content-Type: application/json\r\n"
                     "apikey: " + InpSupabaseApiKey + "\r\n"
                     "Authorization: Bearer " + InpSupabaseApiKey + "\r\n"
                     "Prefer: return=minimal\r\n";
   char postData[];
   int len = StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   ArrayResize(postData, len);
   char result[];
   string resultHeaders;
   ResetLastError();
   int status = WebRequest("PATCH", url, headers, InpHttpTimeoutMs, postData, result, resultHeaders);
   if(status == -1 || status >= 300)
      Print("Failed to log close to Supabase (status ", status, ", err ", GetLastError(), "): ", CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
}

//+------------------------------------------------------------------+
void LogSignalToSupabase(string decideResponse, double equity)
{
   string url = InpSupabaseUrl + "/rest/v1/bot_signals";
   string body = StringFormat(
      "{\"raw_response\":%s,\"account\":%I64d,\"symbol\":\"%s\",\"equity\":%s}",
      decideResponse, AccountInfoInteger(ACCOUNT_LOGIN), InpSymbol, DoubleToString(equity, 2)
   );
   string response;
   PostToSupabase(url, body, response);
}

//+------------------------------------------------------------------+
void LogExecutionToSupabase(string setupId, string direction, double lotSize, double entryPrice, double stopPrice, double targetPrice, double rr, bool success, ulong orderTicket)
{
   string url = InpSupabaseUrl + "/rest/v1/bot_trades";
   string body = StringFormat(
      "{\"setup_id\":\"%s\",\"direction\":\"%s\",\"lot_size\":%s,\"entry_price\":%s,\"stop_price\":%s,\"target_price\":%s,\"rr\":%s,\"success\":%s,\"order_ticket\":%I64u,\"account\":%I64d,\"symbol\":\"%s\"}",
      setupId, direction, DoubleToString(lotSize, 2), DoubleToString(entryPrice, 5), DoubleToString(stopPrice, 5), DoubleToString(targetPrice, 5),
      DoubleToString(rr, 4), success ? "true" : "false", orderTicket, AccountInfoInteger(ACCOUNT_LOGIN), InpSymbol
   );
   string response;
   PostToSupabase(url, body, response);
}

//+------------------------------------------------------------------+
bool PostToSupabase(string url, string &body, string &responseOut)
{
   char postData[];
   int len = StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   ArrayResize(postData, len);

   string headers = "Content-Type: application/json\r\n"
                     "apikey: " + InpSupabaseApiKey + "\r\n"
                     "Authorization: Bearer " + InpSupabaseApiKey + "\r\n"
                     "Prefer: return=minimal\r\n";
   char result[];
   string resultHeaders;

   ResetLastError();
   int status = WebRequest("POST", url, headers, InpHttpTimeoutMs, postData, result, resultHeaders);
   if(status == -1)
   {
      Print("Supabase WebRequest failed, error ", GetLastError(), ". Is ", url, " whitelisted?");
      return false;
   }
   responseOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status >= 300)
   {
      Print("Supabase logging returned HTTP ", status, ": ", responseOut);
      return false;
   }
   return true;
}
//+------------------------------------------------------------------+
