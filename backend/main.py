import sys
import os
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

def broadcast_tick(tick_data):
    global main_loop
    if active_websockets and main_loop:
        message = json.dumps(tick_data)
        for ws in list(active_websockets):
            try:
                main_loop.call_soon_threadsafe(
                    lambda w=ws, m=message: asyncio.create_task(w.send_text(m))
                )
            except Exception as e:
                print(f"Error broadcasting to socket: {e}")

@app.on_event("startup")
def startup_event():
    global connector, main_loop
    main_loop = asyncio.get_event_loop()
    from backend.database import init_db
    try:
        init_db()
    except Exception as e:
        print(f"FastAPI: Database initialization failed: {e}")
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
    return connector.settings

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

@app.get("/api/futures-data")
def get_futures_data():
    global connector
    token = connector.settings["active_token"]

    # If in mock mode, get current tick from simulated loop
    if connector.settings["mode"] == "mock":
        hist = connector.mock_history.get(token, [])
        if hist:
            last = hist[-1]
            yest_close = connector.baselines.get(token, {}).get("yesterday_close", last["close"])
            return {
                "symbol": connector.settings["active_symbol"],
                "token": token,
                "price": last["close"],
                "oi": last["oi"],
                "volume": last["volume"],
                "ohlc": {
                    "open": last["open"],
                    "high": last["high"],
                    "low": last["low"],
                    "close": last["close"],
                    "yesterday_close": yest_close
                }
            }

    # LIVE MODE —————————————————————————————————————————

    # 1. Priority: EOD override (real data entered from broker by user)
    eod = connector.settings.get("eod_override", {}).get(token)
    if eod:
        return eod

    # 2. Live ticks received during market hours
    m_data = connector.market_data.get(token)
    if m_data:
        return m_data

    # 3. Fallback: baseline data so dashboard never shows zeroes
    hist = connector.mock_history.get(token, [])
    if not hist:
        connector.get_historical_candles(connector.settings["active_symbol"])
        hist = connector.mock_history.get(token, [])

    if hist:
        last = hist[-1]
        yest_close = connector.baselines.get(token, {}).get("yesterday_close", last["close"])
        return {
            "symbol": connector.settings["active_symbol"],
            "token": token,
            "price": last["close"],
            "oi": last["oi"],
            "volume": last["volume"],
            "ohlc": {
                "open": last["open"],
                "high": last["high"],
                "low": last["low"],
                "close": last["close"],
                "yesterday_close": yest_close
            }
        }

    return {
        "symbol": connector.settings["active_symbol"],
        "token": token,
        "price": 0.0, "oi": 0, "volume": 0,
        "ohlc": {"open": 0.0, "high": 0.0, "low": 0.0, "close": 0.0, "yesterday_close": 0.0}
    }

@app.get("/api/historical-candles")
def get_historical_candles(symbol: str):
    global connector
    try:
        return connector.get_historical_candles(symbol)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/historical-oi")
def get_historical_oi(symbol: str):
    from backend.database import get_history
    try:
        return get_history(symbol)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/angel-history")
def get_angel_history(symbol: str):
    global connector
    client_id = connector.settings.get("angel_client_id")
    password = connector.settings.get("angel_password")
    totp_secret = connector.settings.get("angel_totp_secret")
    api_key = connector.settings.get("angel_api_key")
    
    if not all([client_id, password, totp_secret, api_key]):
        return {"status": "error", "message": "Angel One credentials not fully configured in settings."}
        
    from backend.angel_connector import resolve_angel_token
    from datetime import datetime, timedelta
    
    token = resolve_angel_token(symbol)
    if not token:
        return {"status": "error", "message": f"Could not resolve Angel One token for {symbol}"}
        
    # Fetch data for the last 5 days
    to_date = datetime.now().strftime("%Y-%m-%d %H:%M")
    from_date = (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d 09:15")
    
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
    # NCDEX: Mon-Fri, 09:00 - 17:00 IST
    is_weekday = now.weekday() < 5
    market_open_time  = now.replace(hour=9,  minute=0,  second=0, microsecond=0)
    market_close_time = now.replace(hour=17, minute=0,  second=0, microsecond=0)
    is_open = is_weekday and market_open_time <= now <= market_close_time
    return {
        "market_open": is_open,
        "current_time_ist": now.strftime("%H:%M:%S"),
        "exchange": "NCDEX",
        "session": "09:00 - 17:00 IST"
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
    tick["time"] = __import__("time").time()
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
                    old_token = connector.settings.get("active_token")
                    connector.save_config({"active_symbol": symbol})
                    new_token = connector.settings.get("active_token")
                    
                    if old_token != new_token and connector.settings.get("mode") == "live":
                        print("FastAPI: WS changed symbol, restarting connector...")
                        connector.stop()
                        connector.start(broadcast_tick)
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
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=False)
