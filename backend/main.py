import sys
import os
import collections
from datetime import datetime

shared_log_buffer = collections.deque(maxlen=300)

class DualLogger:
    def __init__(self, stream, prefix=""):
        self.stream = stream
        self.prefix = prefix

    def write(self, message):
        self.stream.write(message)
        if message.strip():
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            shared_log_buffer.append(f"[{timestamp}] {self.prefix}{message.strip()}")

    def flush(self):
        self.stream.flush()

    def __getattr__(self, attr):
        return getattr(self.stream, attr)

sys.stdout = DualLogger(sys.stdout)
sys.stderr = DualLogger(sys.stderr, prefix="[ERROR] ")

# Add parent directory to sys.path to resolve 'backend' imports correctly
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import json
import asyncio
from typing import Set

from backend.angel_connector import AngelConnector

app = FastAPI(title="Futures Real-Time OI Charting Terminal")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active WebSocket connections
active_websockets: Set[WebSocket] = set()

# Initialize Connector
connector = None
main_loop = None

market_open_oi_cache = {}

# In-memory result cache for get_unified_history: {symbol: (timestamp, data)}
# TTL = 60 seconds (one candle period). Invalidated on each new live tick.
_unified_history_cache: dict = {}
_UNIFIED_HISTORY_TTL = 60  # seconds

def invalidate_history_cache(symbol: str | None = None):
    """Call this whenever a new tick arrives to flush the cache for that symbol."""
    if symbol:
        _unified_history_cache.pop(symbol, None)
    else:
        _unified_history_cache.clear()

def broadcast_tick(tick_data):
    global main_loop
    if active_websockets and main_loop:
        # Inject market_open_oi to live ticks so the UI always has the correct baseline
        symbol = tick_data.get("symbol")
        if symbol:
            try:
                tick_data["market_open_oi"] = get_market_open_oi(symbol, connector)
            except Exception as e:
                print(f"Error injecting market_open_oi to tick: {e}")
            # Invalidate cached history so next HTTP poll gets the new tick appended
            invalidate_history_cache(symbol)
                
        message = json.dumps(tick_data)
        for ws in list(active_websockets):
            try:
                main_loop.call_soon_threadsafe(
                    lambda w=ws, m=message: asyncio.create_task(w.send_text(m))
                )
            except Exception as e:
                print(f"Error broadcasting to socket: {e}")


async def periodic_prune_task():
    from backend.database import prune_ticks
    import asyncio
    while True:
        try:
            prune_ticks(days_to_keep=35)
        except Exception as e:
            print(f"Error in periodic database prune task: {e}")
        # Run every 12 hours
        await asyncio.sleep(12 * 3600)

@app.on_event("startup")
def startup_event():
    global connector, main_loop
    main_loop = asyncio.get_event_loop()
    from backend.database import init_db
    try:
        init_db()
    except Exception as e:
        print(f"FastAPI: Database initialization failed: {e}")
    
    # Start the background database pruning task
    main_loop.create_task(periodic_prune_task())
    
    connector = AngelConnector(config_callback=broadcast_tick)
    connector.start(broadcast_tick)
    print("FastAPI: Started AngelConnector listener")

@app.on_event("shutdown")
def shutdown_event():
    global connector
    if connector:
        connector.stop()
        print("FastAPI: Stopped OdinConnector listener")

# Endpoints
@app.api_route("/health", methods=["GET", "HEAD", "POST"])
def health_check():
    return {"status": "healthy"}

@app.get("/api/config")
def get_config():
    global connector
    res = connector.settings.copy()
    res["broker_connected"] = connector.connected if connector else False
    return res

COMMODITY_NAMES = {
    "BAJRA": "Bajra",
    "BARLEYJPR": "Barley",
    "CASTOR": "Castor Seed",
    "COCUDAKL": "Cotton Seed Oil Cake (Cocud)",
    "COTTON": "Cotton",
    "COTWASOIL": "Cotton Seed Oil",
    "DHANIYA": "Coriander (Dhaniya)",
    "GROUNDNUT": "Groundnut",
    "GUARGUM5": "Guar Gum",
    "GUARSEED10": "Guar Seed",
    "ISABGOL": "Isabgol",
    "JEERAMINI": "Jeera Mini",
    "JEERAUNJHA": "Jeera (Cumin Seed)",
    "KAPAS": "Kapas",
    "MAIZE": "Maize",
    "SESAMESEED": "Sesame Seed",
    "STEEL": "Steel",
    "SUNOIL": "Sunflower Oil",
    "TMCFGRNZM": "Turmeric (Haldi)",
    "YELLOWP": "Yellow Peas"
}

@app.get("/api/ncdex-contracts")
def get_ncdex_contracts():
    """Returns all NCDEX contracts grouped by commodity for the frontend dropdown."""
    futures = connector.settings.get("futures_symbols", {})
    groups = {}
    for display_name, info in futures.items():
        parts = display_name.split()
        code = parts[0]
        commodity = COMMODITY_NAMES.get(code, code)
        if commodity not in groups:
            groups[commodity] = []
        groups[commodity].append({
            "label": display_name,
            "token": info.get("token", ""),
            "segment": info.get("segment", "7"),
            "tv_symbol": info.get("tv_symbol", "")
        })
    # Sort contracts within each group by label
    for g in groups:
        groups[g].sort(key=lambda x: x["label"])
    return {"groups": groups, "active_symbol": connector.settings.get("active_symbol", "")}

@app.post("/api/config")
async def post_config(new_config: dict):
    global connector
    old_token = connector.settings.get("active_token")
    old_mode = connector.settings.get("mode")
    
    res = connector.save_config(new_config)
    
    new_token = connector.settings.get("active_token")
    new_mode = connector.settings.get("mode")
    
    # Restart listener if connector mode or target token has changed
    if res.get("status") == "success" and (old_token != new_token or old_mode != new_mode or new_mode == "live"):
        print("FastAPI: Settings changed, restarting connector...")
        connector.stop()
        connector.start(broadcast_tick)
        
    return res

def generate_illiquid_prefill(start_price, target_price, high_price, low_price, start_oi, target_oi, total_volume, steps, rng):
    if steps <= 0:
        return []
        
    # 1. Determine active steps dynamically based on total volume
    # Highly active contracts should show dense candles; illiquid ones should show gaps.
    active_ratio = 0.50
    if total_volume > 2000:
        active_ratio = 0.80
    elif total_volume > 500:
        active_ratio = 0.65
    elif total_volume < 50:
        active_ratio = 0.20
        
    num_active = max(1, int(steps * active_ratio))
    if num_active > steps:
        num_active = steps
        
    active_indices = sorted(rng.sample(range(steps), num_active))
    
    # 2. Distribute total volume among active steps
    vol_steps = [0] * steps
    if total_volume > 0 and num_active > 0:
        cuts = sorted([rng.randint(0, total_volume) for _ in range(num_active - 1)])
        cuts = [0] + cuts + [total_volume]
        for idx, active_idx in enumerate(active_indices):
            vol_steps[active_idx] = cuts[idx+1] - cuts[idx]
            
    # 3. Generate price path for the steps
    active_prices = [start_price] * num_active
    if num_active > 1:
        if target_price > (high_price + low_price) / 2:
            p1 = int(num_active * 0.3)
            p2 = int(num_active * 0.7)
            milestones = [(0, start_price), (p1, low_price), (p2, high_price), (num_active - 1, target_price)]
        else:
            p1 = int(num_active * 0.3)
            p2 = int(num_active * 0.7)
            milestones = [(0, start_price), (p1, high_price), (p2, low_price), (num_active - 1, target_price)]
            
        for idx in range(len(milestones) - 1):
            s_step, s_val = milestones[idx]
            e_step, e_val = milestones[idx+1]
            span = e_step - s_step
            if span > 0:
                drift = (e_val - s_val) / span
                for s in range(s_step + 1, e_step + 1):
                    active_prices[s] = active_prices[s-1] + drift + rng.normalvariate(0, (high_price - low_price) * 0.05)
                    
        active_prices[0] = start_price
        active_prices[-1] = target_price
        for i in range(num_active):
            active_prices[i] = max(low_price, min(high_price, active_prices[i]))
            
        curr_max = max(active_prices)
        curr_min = min(active_prices)
        active_prices[active_prices.index(curr_max)] = high_price
        active_prices[active_prices.index(curr_min)] = low_price
        
    # 4. Generate OI path for active steps
    oi_steps = [start_oi] * steps
    if num_active > 0:
        oi_drift = (target_oi - start_oi) / num_active
        curr_oi = start_oi
        for idx, active_idx in enumerate(active_indices):
            curr_oi += oi_drift + rng.normalvariate(0, max(5, (target_oi - start_oi) * 0.02))
            oi_steps[active_idx] = int(max(100, curr_oi))
            
    candles = []
    current_price = start_price
    current_cumulative_vol = 0
    current_oi = start_oi
    
    active_ptr = 0
    for s in range(steps):
        is_active = (s in active_indices)
        
        if is_active and num_active > 0:
            price_open = current_price
            price_close = active_prices[active_ptr]
            active_ptr += 1
            
            candle_high = max(price_open, price_close) + abs(rng.normalvariate(0, (high_price - low_price) * 0.03))
            candle_low = min(price_open, price_close) - abs(rng.normalvariate(0, (high_price - low_price) * 0.03))
            
            candle_high = min(high_price, max(candle_high, price_open, price_close))
            candle_low = max(low_price, min(candle_low, price_open, price_close))
            
            current_price = price_close
            current_cumulative_vol += vol_steps[s]
            current_oi = oi_steps[s]
        else:
            price_open = current_price
            price_close = current_price
            candle_high = current_price
            candle_low = current_price
            
        candles.append({
            "open": round(price_open, 2),
            "high": round(candle_high, 2),
            "low": round(candle_low, 2),
            "close": round(price_close, 2),
            "volume": int(current_cumulative_vol),
            "oi": int(current_oi)
        })
        
    return candles

def get_unified_history(symbol: str, connector):
    import time
    # --- Result cache (60-second TTL, invalidated on new live tick) ---
    cached = _unified_history_cache.get(symbol)
    if cached:
        cache_ts, cache_data = cached
        if time.time() - cache_ts < _UNIFIED_HISTORY_TTL:
            return cache_data

    from backend.database import get_history
    import random
    from datetime import datetime, timezone, timedelta
    
    # 1. Get market open timestamp in IST
    # NCDEX session is Monday to Friday, starts at 10:00 AM IST.
    # If the current time is before 10:00 AM IST, the current session is the previous trading day.
    IST = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(IST)
    
    if now_ist.weekday() == 5: # Saturday
        target_date = now_ist - timedelta(days=1)
    elif now_ist.weekday() == 6: # Sunday
        target_date = now_ist - timedelta(days=2)
    elif now_ist.hour < 10:
        # Market not open yet today. Use previous trading day (Friday if Monday)
        if now_ist.weekday() == 0: # Monday
            target_date = now_ist - timedelta(days=3)
        else:
            target_date = now_ist - timedelta(days=1)
    else:
        target_date = now_ist
        
    market_open = target_date.replace(hour=10, minute=0, second=0, microsecond=0)
    market_open_epoch = int(market_open.timestamp())
    
    # Keep only the last 30 days of ticks
    thirty_days_ago = market_open_epoch - 30 * 24 * 3600
    
    # 2. Fetch real history from DB (filtered to 30 days)
    real_ticks = get_history(symbol, start_timestamp=thirty_days_ago) # sorted by time ASC
    
    # Filter real ticks into today's session and past sessions
    session_ticks = [t for t in real_ticks if t["time"] >= market_open_epoch]
    past_ticks = [t for t in real_ticks if t["time"] < market_open_epoch]
    
    # 3. Retrieve baseline information
    token = None
    if connector and "futures_symbols" in connector.settings and symbol in connector.settings["futures_symbols"]:
        token = connector.settings["futures_symbols"][symbol]["token"]
        
    # Only fetch a REST quote when WSS is disconnected (WSS keeps market_data fresh in real-time)
    if token and connector and hasattr(connector, "update_market_data_from_quote"):
        if not connector.connected:
            try:
                connector.update_market_data_from_quote(symbol, token)
            except Exception as e:
                print(f"Error fetching fresh quote for baseline: {e}")
            
    baseline = None
    if token and connector:
        # Default fallback baseline from baselines or mock_history
        baseline = connector.baselines.get(token)
        
        # Check if we have real active data (LTP / Volume / OI) from the market / WS / EOD override
        m_data = connector.market_data.get(token) or connector.settings.get("eod_override", {}).get(token)
        if m_data:
            baseline = {
                "price": m_data.get("price", 0.0),
                "open": m_data.get("ohlc", {}).get("open", 0.0) or m_data.get("price", 0.0),
                "high": m_data.get("ohlc", {}).get("high", 0.0) or m_data.get("price", 0.0),
                "low": m_data.get("ohlc", {}).get("low", 0.0) or m_data.get("price", 0.0),
                "yesterday_close": m_data.get("ohlc", {}).get("yesterday_close", 0.0),
                "volume": m_data.get("volume", 0),
                "oi": m_data.get("oi", 0)
            }
            
    if not baseline:
        # fallback based on symbol name parsing
        fallback_price = 12000.0
        fallback_oi = 10000
        fallback_vol = 100
        if "JEERA" in symbol:
            fallback_price = 28000.0
            fallback_oi = 3000
        elif "TMC" in symbol or "TURMERIC" in symbol or "HALDI" in symbol:
            fallback_price = 17500.0
            fallback_oi = 12000
        elif "GUM" in symbol:
            fallback_price = 10800.0
            fallback_oi = 45000
        elif "SEED" in symbol:
            fallback_price = 5350.0
            fallback_oi = 68000
            
        baseline = {
            "price": fallback_price,
            "open": fallback_price,
            "high": fallback_price,
            "low": fallback_price,
            "yesterday_close": fallback_price,
            "volume": fallback_vol,
            "oi": fallback_oi
        }
        
    start_price = baseline.get("open") or baseline.get("price") or 12000.0
    start_oi = baseline.get("oi") or 10000
    
    user_open_oi = None
    if connector and "futures_symbols" in connector.settings and symbol in connector.settings["futures_symbols"]:
        user_open_oi = connector.settings["futures_symbols"][symbol].get("open_oi")

    if session_ticks:
        target_price = session_ticks[0]["open"]
        target_oi = session_ticks[0]["oi"]
        target_vol = session_ticks[0]["volume"]
        
        # Try to get yesterday's closing OI to use as the starting baseline for today's prefill
        yest_oi = None
        try:
            from backend.database import get_db_connection, get_cursor, get_placeholder
            conn = get_db_connection()
            cursor = get_cursor(conn)
            p = get_placeholder()
            query = f"""
                SELECT open_interest FROM ticks
                WHERE symbol = {p} AND timestamp < {p}
                ORDER BY timestamp DESC LIMIT 1
            """
            cursor.execute(query, (symbol, market_open_epoch))
            row = cursor.fetchone()
            cursor.close()
            conn.close()
            if row:
                yest_oi = row["open_interest"]
        except Exception as e:
            print(f"Error getting yesterday closing OI for prefill: {e}")
            
        start_oi = int(user_open_oi) if user_open_oi is not None else (yest_oi if yest_oi is not None else target_oi)
    else:
        target_price = baseline.get("price") or start_price
        target_oi = baseline.get("oi") or start_oi
        target_vol = baseline.get("volume") or 100
        start_oi = int(user_open_oi) if user_open_oi is not None else target_oi
        
    # 4. Generate pre-fill ticks
    # We want to fill from market_open_epoch up to the first session tick, or the current time/market close if no ticks exist.
    current_epoch = int(time.time())
    end_prefill = session_ticks[0]["time"] if session_ticks else current_epoch
    
    # Limit prefill to the market close of target date or current epoch
    market_close = target_date.replace(hour=17, minute=0, second=0, microsecond=0)
    market_close_epoch = int(market_close.timestamp())
    end_prefill = min(end_prefill, market_close_epoch, current_epoch)
    
    duration_seconds = end_prefill - market_open_epoch
    steps = max(0, duration_seconds // 60)
    
    prefill_candles = []
    
    rng = random.Random()
    rng.seed(hash(symbol) + market_open_epoch)
    
    try:
        high_price = baseline.get("high") or max(start_price, target_price)
        low_price = baseline.get("low") or min(start_price, target_price)
        # Avoid extreme high/low logic errors
        if high_price < max(start_price, target_price):
            high_price = max(start_price, target_price)
        if low_price > min(start_price, target_price):
            low_price = min(start_price, target_price)
            
        simulated = generate_illiquid_prefill(
            start_price=start_price,
            target_price=target_price,
            high_price=high_price,
            low_price=low_price,
            start_oi=start_oi,
            target_oi=target_oi,
            total_volume=target_vol,
            steps=steps,
            rng=rng
        )
        for i, sc in enumerate(simulated):
            prefill_candles.append({
                "time": market_open_epoch + i * 60,
                "open": sc["open"],
                "high": sc["high"],
                "low": sc["low"],
                "close": sc["close"],
                "oi": sc["oi"],
                "volume": sc["volume"]
            })
    except Exception as sim_err:
        print(f"Error running illiquid prefill simulation: {sim_err}")
        # fallback simple drift
        safe_target_price = target_price if target_price is not None else 12000.0
        safe_start_price = start_price if start_price is not None else 12000.0
        safe_target_oi = target_oi if target_oi is not None else 10000
        safe_start_oi = start_oi if start_oi is not None else 10000
        safe_target_vol = target_vol if target_vol is not None else 100

        t = market_open_epoch
        price = safe_start_price
        oi = safe_start_oi
        vol = 0
        price_drift = (safe_target_price - safe_start_price) / steps if steps > 0 else 0
        oi_drift = (safe_target_oi - safe_start_oi) / steps if steps > 0 else 0
        vol_drift = safe_target_vol / steps if steps > 0 else 0
        
        for i in range(steps):
            price_change = price_drift + rng.normalvariate(0, price * 0.0001)
            price_next = price + price_change
            oi_change = oi_drift + rng.normalvariate(0, max(1, oi * 0.0002))
            oi_next = max(100, oi + oi_change)
            vol_change = vol_drift + rng.randint(0, 3)
            vol_next = vol + vol_change
            
            prefill_candles.append({
                "time": t,
                "open": round(price, 2),
                "high": round(max(price, price_next) + abs(rng.normalvariate(0, price * 0.0001)), 2),
                "low": round(min(price, price_next) - abs(rng.normalvariate(0, price * 0.0001)), 2),
                "close": round(price_next, 2),
                "oi": int(oi_next),
                "volume": int(vol_next)
            })
            price = price_next
            oi = oi_next
            vol = vol_next
            t += 60
        
    unified = past_ticks + prefill_candles + session_ticks
    import time as _t_cache
    _unified_history_cache[symbol] = (_t_cache.time(), unified)
    return unified

def get_market_open_oi(symbol: str, connector):
    # 1. Priority: User-configured opening OI baseline from settings
    if connector and "futures_symbols" in connector.settings and symbol in connector.settings["futures_symbols"]:
        open_oi = connector.settings["futures_symbols"][symbol].get("open_oi")
        if open_oi:
            try:
                return int(open_oi)
            except:
                pass

    # Cache market open OI daily per symbol to avoid heavy DB/pre-fill queries on every live tick
    from datetime import datetime, timezone, timedelta
    IST = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(IST)
    
    if now_ist.weekday() == 5: # Saturday
        target_date = now_ist - timedelta(days=1)
    elif now_ist.weekday() == 6: # Sunday
        target_date = now_ist - timedelta(days=2)
    elif now_ist.hour < 10:
        if now_ist.weekday() == 0: # Monday
            target_date = now_ist - timedelta(days=3)
        else:
            target_date = now_ist - timedelta(days=1)
    else:
        target_date = now_ist
        
    market_open = target_date.replace(hour=10, minute=0, second=0, microsecond=0)
    market_open_epoch = int(market_open.timestamp())
    today_str = target_date.strftime("%Y-%m-%d")
    cache_key = f"{symbol}_{today_str}"
    
    global market_open_oi_cache
    if cache_key in market_open_oi_cache:
        return market_open_oi_cache[cache_key]
        
    try:
        # 1. Try to get the last tick from yesterday's session to find yesterday's closing OI
        from backend.database import get_db_connection, get_cursor, get_placeholder
        conn = get_db_connection()
        cursor = get_cursor(conn)
        p = get_placeholder()
        query = f"""
            SELECT open_interest FROM ticks
            WHERE symbol = {p} AND timestamp < {p}
            ORDER BY timestamp DESC LIMIT 1
        """
        cursor.execute(query, (symbol, market_open_epoch))
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        
        if row:
            val = row["open_interest"]
            print(f"get_market_open_oi: Found yesterday's closing OI from database: {val}")
            market_open_oi_cache[cache_key] = val
            return val
    except Exception as db_err:
        print(f"Error querying yesterday's close OI: {db_err}")
        
    # 2. Fallback: Find the first tick of today from get_unified_history
    try:
        history = get_unified_history(symbol, connector)
        if history:
            val = None
            for c in history:
                if c["time"] >= market_open_epoch:
                    val = c["oi"]
                    break
            if val is None:
                val = history[0]["oi"]
            market_open_oi_cache[cache_key] = val
            return val
    except Exception as e:
        print(f"Error getting market open OI fallback: {e}")
    return 0

def make_nocache_response(content):
    response = JSONResponse(content=content)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.get("/api/futures-data")
def get_futures_data(symbol: str = None):
    global connector
    if symbol:
        token = connector.settings.get("futures_symbols", {}).get(symbol, {}).get("token")
        if not token:
            token = connector.settings["active_token"]
    else:
        symbol = connector.settings["active_symbol"]
        token = connector.settings["active_token"]
    market_open_oi = get_market_open_oi(symbol, connector)

    res_data = None
    if connector.settings["mode"] == "mock":
        hist = connector.mock_history.get(token, [])
        if hist:
            last = hist[-1]
            yest_close = connector.baselines.get(token, {}).get("yesterday_close", last["close"])
            res_data = {
                "symbol": symbol,
                "token": token,
                "price": last["close"],
                "oi": last["oi"],
                "volume": last["volume"],
                "market_open_oi": market_open_oi,
                "ohlc": {
                    "open": last["open"],
                    "high": last["high"],
                    "low": last["low"],
                    "close": last["close"],
                    "yesterday_close": yest_close
                }
            }

    if not res_data:
        eod = connector.settings.get("eod_override", {}).get(token)
        if eod:
            res_data = eod.copy()
            res_data["market_open_oi"] = market_open_oi
        else:
            # Try to query a live REST quote to populate the connector's memory cache
            m_data = connector.market_data.get(token)
            if not m_data and hasattr(connector, "update_market_data_from_quote"):
                try:
                    m_data = connector.update_market_data_from_quote(symbol, token)
                except Exception as e:
                    print(f"Error querying REST quote in endpoint: {e}")
                    
            if m_data:
                res_data = m_data.copy()
                res_data["market_open_oi"] = market_open_oi
            else:
                hist = connector.mock_history.get(token, [])
                if not hist:
                    connector.get_historical_candles(symbol)
                    hist = connector.mock_history.get(token, [])
                if hist:
                    last = hist[-1]
                    yest_close = connector.baselines.get(token, {}).get("yesterday_close", last["close"])
                    res_data = {
                        "symbol": symbol,
                        "token": token,
                        "price": last["close"],
                        "oi": last["oi"],
                        "volume": last["volume"],
                        "market_open_oi": market_open_oi,
                        "ohlc": {
                            "open": last["open"],
                            "high": last["high"],
                            "low": last["low"],
                            "close": last["close"],
                            "yesterday_close": yest_close
                        }
                    }
                else:
                    res_data = {
                        "symbol": symbol,
                        "token": token,
                        "price": 0.0, "oi": 0, "volume": 0,
                        "market_open_oi": market_open_oi,
                        "ohlc": {"open": 0.0, "high": 0.0, "low": 0.0, "close": 0.0, "yesterday_close": 0.0}
                    }
    if res_data:
        res_data["broker_connected"] = connector.connected if connector else False
    return make_nocache_response(res_data)

@app.get("/api/historical-candles")
def get_historical_candles(symbol: str):
    global connector
    try:
        data = connector.get_historical_candles(symbol)
        return make_nocache_response(data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/historical-oi")
def get_historical_oi(symbol: str):
    global connector
    try:
        data = get_unified_history(symbol, connector)
        return make_nocache_response(data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/logs")
def get_logs():
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse("\n".join(list(shared_log_buffer)))

@app.get("/api/angel-history")
def get_angel_history(symbol: str):
    global connector
    client_id = connector.get_setting("angel_client_id")
    password = connector.get_setting("angel_password")
    totp_secret = connector.get_setting("angel_totp_secret")
    api_key = connector.get_setting("angel_api_key")
    
    if not all([client_id, password, totp_secret, api_key]):
        return {"status": "error", "message": "Angel One credentials not fully configured in settings."}
        
    from datetime import datetime, timedelta
    
    # Try getting from the connector's pre-resolved token map first (which is instant)
    token = None
    if connector and hasattr(connector, "symbol_token_map") and connector.symbol_token_map:
        token = connector.symbol_token_map.get(symbol)
        
    if not token:
        from backend.angel_connector import resolve_angel_token
        token = resolve_angel_token(symbol)
        
    if not token:
        return {"status": "error", "message": f"Could not resolve Angel One token for {symbol}"}
        
    # Fetch data for the last 5 days
    to_date = datetime.now().strftime("%Y-%m-%d %H:%M")
    from_date = (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d 10:00")
    
    try:
        res = connector.fetch_historical_candles("NCDEX", token, "ONE_MINUTE", from_date, to_date)
        return res
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/market-status")
def get_market_status():
    """Returns whether the NCDEX market is currently open."""
    from datetime import datetime, timezone, timedelta
    IST = timezone(timedelta(hours=5, minutes=30))
    now = datetime.now(IST)
    # NCDEX: Mon-Fri, 10:00 - 17:00 IST
    is_weekday = now.weekday() < 5
    market_open_time  = now.replace(hour=10, minute=0,  second=0, microsecond=0)
    market_close_time = now.replace(hour=17, minute=0,  second=0, microsecond=0)
    is_open = is_weekday and market_open_time <= now <= market_close_time
    return {
        "market_open": is_open,
        "current_time_ist": now.strftime("%H:%M:%S"),
        "exchange": "NCDEX",
        "session": "10:00 - 17:00 IST"
    }

@app.post("/api/set-closing-data")
async def set_closing_data(data: dict):
    """
    Accepts real EOD closing data from the user (manually entered from broker platform).
    Stores it and serves it via /api/futures-data when market is closed.
    Expected payload:
      { "open": 12460, "high": 12584, "low": 12384, "close": 12490,
        "volume": 5350, "oi": 18605, "yesterday_close": 12678 }
    """
    global connector
    token = connector.settings["active_token"]
    symbol = connector.settings["active_symbol"]

    close  = float(data.get("close",  0))
    open_p = float(data.get("open",   close))
    high   = float(data.get("high",   close))
    low    = float(data.get("low",    close))
    volume = int(data.get("volume",   0))
    oi     = int(data.get("oi",       0))
    yclose = float(data.get("yesterday_close", close))

    # 1. Store in EOD override so /api/futures-data picks it up
    connector.settings["eod_override"][token] = {
        "symbol": symbol, "token": token,
        "price": close, "change": round(close - yclose, 2),
        "volume": volume, "oi": oi,
        "ohlc": {"open": open_p, "high": high, "low": low,
                 "close": close, "yesterday_close": yclose}
    }

    # 2. Also update the baseline so the mock history tail matches
    if token in connector.baselines:
        connector.baselines[token].update({
            "price": close, "open": open_p, "high": high,
            "low": low, "volume": volume, "oi": oi,
            "yesterday_close": yclose
        })

    # 3. Rebuild mock history from updated baseline
    connector._generate_single_mock_history(token, connector.baselines[token])

    # 4. Broadcast to all connected WebSocket clients
    tick = connector.settings["eod_override"][token].copy()
    tick["type"] = "FUT"
    tick["time"] = int(__import__("time").time())
    broadcast_tick(tick)

    return {"status": "success", "message": f"EOD data set for {symbol}",
            "data": connector.settings["eod_override"][token]}

# WebSocket Route
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_websockets.add(websocket)
    print(f"WS: Client connected. Total connections: {len(active_websockets)}")
    
    try:
        while True:
            data = await websocket.receive_text()
            try:
                cmd = json.loads(data)
                if cmd.get("action") == "change_symbol":
                    symbol = cmd.get("symbol")
                    connector.save_config({"active_symbol": symbol})
                    print(f"WS: Changed active symbol to {symbol}")
            except:
                pass
    except WebSocketDisconnect:
        active_websockets.remove(websocket)
        print(f"WS: Client disconnected. Total connections: {len(active_websockets)}")
    except Exception as e:
        print(f"WS: Error: {e}")
        if websocket in active_websockets:
            active_websockets.remove(websocket)

# Serve Frontend static assets
os.makedirs("frontend", exist_ok=True)
app.mount("/static", StaticFiles(directory="frontend"), name="static")

@app.get("/")
def get_index():
    response = FileResponse("frontend/index.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 8000))
    # On Render, bind to 0.0.0.0 so the reverse proxy can reach us.
    # Locally, use 127.0.0.1 to avoid Windows IPv6 fallback latency.
    host = "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1"
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
