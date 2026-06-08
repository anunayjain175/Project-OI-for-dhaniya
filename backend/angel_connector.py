import requests
import json
import time
import hmac
import hashlib
import struct
import base64
import os
import threading
import asyncio
import ssl
import websockets
import random
from datetime import datetime

INSTRUMENT_MASTER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "angel_instruments.json")
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oi_history.db")

def get_totp_token(secret):
    secret = secret.replace(" ", "")
    missing_padding = len(secret) % 8
    if missing_padding:
        secret += "=" * (8 - missing_padding)
    
    key = base64.b32decode(secret, casefold=True)
    counter = struct.pack(">Q", int(time.time() / 30))
    mac = hmac.new(key, counter, hashlib.sha1).digest()
    offset = mac[-1] & 0x0f
    binary = struct.unpack(">I", mac[offset:offset+4])[0] & 0x7fffffff
    token = binary % 1000000
    return f"{token:06d}"

def parse_smart_stream_binary(data):
    if len(data) < 147:
        return None
        
    try:
        sub_mode = struct.unpack("<B", data[0:1])[0]
        exch_type = struct.unpack("<B", data[1:2])[0]
        token = data[2:27].decode('ascii', errors='ignore').strip('\x00').strip()
        
        if sub_mode == 3:  # SNAP_QUOTE
            seq = struct.unpack("<q", data[27:35])[0]
            timestamp = struct.unpack("<q", data[35:43])[0]
            ltp = struct.unpack("<q", data[43:51])[0] / 100.0
            ltq = struct.unpack("<q", data[51:59])[0]
            avg_price = struct.unpack("<q", data[59:67])[0] / 100.0
            volume = struct.unpack("<q", data[67:75])[0]
            total_buy = struct.unpack("<d", data[75:83])[0]
            total_sell = struct.unpack("<d", data[83:91])[0]
            opn = struct.unpack("<q", data[91:99])[0] / 100.0
            high = struct.unpack("<q", data[99:107])[0] / 100.0
            low = struct.unpack("<q", data[107:115])[0] / 100.0
            close = struct.unpack("<q", data[115:123])[0] / 100.0
            
            last_trade_time = struct.unpack("<q", data[123:131])[0]
            oi = struct.unpack("<q", data[131:139])[0]
            oi_change_pct = struct.unpack("<q", data[139:147])[0] / 100.0
            
            return {
                "token": token,
                "ltp": ltp,
                "volume": volume,
                "open": opn,
                "high": high,
                "low": low,
                "close": close,
                "oi": oi,
                "oi_change_pct": oi_change_pct,
                "timestamp": timestamp
            }
    except Exception as e:
        print(f"AngelConnector: Binary parse error: {e}")
    return None

class AngelConnector:
    def __init__(self, config_callback=None):
        self.config_callback = config_callback
        self.connected = False
        self.running = False
        self.receive_thread = None
        self.websocket = None
        self.loop = None
        
        # Live state
        self.market_data = {}
        self.historical_data = {}
        
        self.settings = {
            "mode": "mock",
            "active_symbol": "DHANIYA JUN 26",
            "active_token": "DHANIYA19JUN2026",
            "active_segment": "7",
            "eod_override": {},
            "angel_client_id": "",
            "angel_password": "",
            "angel_totp_secret": "",
            "angel_api_key": ""
        }
        self.load_config()

        # Mock baseline
        self.baselines = {
            "DHANIYA19JUN2026": {
                "price": 12490.0,
                "open": 12460.0,
                "high": 12584.0,
                "low": 12384.0,
                "yesterday_close": 12678.0,
                "volume": 5350,
                "oi": 18605
            },
            "DHANIYA20AUG2026": {
                "price": 12714.0,
                "open": 12600.0,
                "high": 12720.0,
                "low": 12510.0,
                "yesterday_close": 12808.0,
                "volume": 1500,
                "oi": 5200
            },
            "DHANIYA19OCT2026": {
                "price": 12844.0,
                "open": 12730.0,
                "high": 12850.0,
                "low": 12640.0,
                "yesterday_close": 12938.0,
                "volume": 400,
                "oi": 1100
            },
            "DHANIYA18DEC2026": {
                "price": 12980.0,
                "open": 12900.0,
                "high": 12990.0,
                "low": 12810.0,
                "yesterday_close": 13050.0,
                "volume": 150,
                "oi": 350
            },
            "TMCFGRNZM19JUN2026": {
                "price": 17500.0,
                "open": 17420.0,
                "high": 17650.0,
                "low": 17380.0,
                "yesterday_close": 17390.0,
                "volume": 3200,
                "oi": 12500
            },
            "GUARGUM519JUN2026": {
                "price": 10800.0,
                "open": 10750.0,
                "high": 10920.0,
                "low": 10680.0,
                "yesterday_close": 10720.0,
                "volume": 8500,
                "oi": 45000
            },
            "GUARSEED1019JUN2026": {
                "price": 5350.0,
                "open": 5320.0,
                "high": 5410.0,
                "low": 5290.0,
                "yesterday_close": 5310.0,
                "volume": 12000,
                "oi": 68000
            }
        }
        self.mock_history = {}
        self.init_mock_history()

    def get_setting(self, key):
        env_map = {
            "angel_client_id": "ANGEL_CLIENT_ID",
            "angel_password": "ANGEL_PASSWORD",
            "angel_totp_secret": "ANGEL_TOTP_SECRET",
            "angel_api_key": "ANGEL_API_KEY",
            "mode": "MODE"
        }
        env_var = env_map.get(key)
        if env_var and env_var in os.environ:
            return os.environ[env_var]
        return self.settings.get(key)

    def load_config(self):
        try:
            with open("backend/config.json", "r") as f:
                self.settings.update(json.load(f))
        except Exception as e:
            print(f"AngelConnector: Error loading config.json: {e}")

    def save_config(self, new_settings):
        self.settings.update(new_settings)
        sym = self.settings.get("active_symbol")
        if "futures_symbols" in self.settings and sym in self.settings["futures_symbols"]:
            self.settings["active_token"] = self.settings["futures_symbols"][sym]["token"]
            self.settings["active_segment"] = self.settings["futures_symbols"][sym]["segment"]
            
        try:
            with open("backend/config.json", "w") as f:
                json.dump(self.settings, f, indent=2)
            self.load_config()
            return {"status": "success", "message": "Config saved successfully"}
        except Exception as e:
            return {"status": "error", "message": f"Failed to save config: {str(e)}"}

    def init_mock_history(self):
        for token, info in self.baselines.items():
            self._generate_single_mock_history(token, info)

    def _generate_single_mock_history(self, token, info):
        now = time.time()
        price = info["price"]
        oi = info["oi"]
        history = []
        for i in range(150):
            timestamp = now - i * 60
            if i == 0:
                open_p = info["open"]
                high_p = info["high"]
                low_p = info["low"]
                close_p = info["price"]
                vol = info["volume"]
            else:
                open_p = price
                close_p = price
                high_p = price + max(0, random.normalvariate(0.3, 0.4))
                low_p = price - max(0, random.normalvariate(0.3, 0.4))
                vol = random.randint(1, 15)
                
            history.append({
                "time": timestamp,
                "open": round(open_p, 2),
                "high": round(high_p, 2),
                "low": round(low_p, 2),
                "close": round(close_p, 2),
                "oi": int(oi),
                "volume": int(vol)
            })
            price = price - random.normalvariate(0, 1.0)
            oi = max(int(info["oi"] * 0.2), oi - int(random.normalvariate(10, 30)))
            
        history.reverse()
        self.mock_history[token] = history

    def get_historical_candles(self, symbol):
        token = self.settings["active_token"]
        if "futures_symbols" in self.settings and symbol in self.settings["futures_symbols"]:
            token = self.settings["futures_symbols"][symbol]["token"]
            
        if token not in self.mock_history:
            if token in self.baselines:
                info = self.baselines[token]
            else:
                info = {"price": 12000.0, "open": 12000.0, "high": 12000.0, "low": 12000.0, "yesterday_close": 12000.0, "volume": 100, "oi": 1000}
            self._generate_single_mock_history(token, info)
            
        return self.mock_history.get(token, [])

    def login(self):
        client_id = self.get_setting("angel_client_id")
        password = self.get_setting("angel_password")
        totp_secret = self.get_setting("angel_totp_secret")
        api_key = self.get_setting("angel_api_key")
        
        if not all([client_id, password, totp_secret, api_key]):
            raise Exception("Angel One credentials not fully configured in settings.")
            
        login_url = "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword"
        totp = get_totp_token(totp_secret)
        headers = {
            "Content-Type": "application/json",
            "X-ClientLocalIP": "127.0.0.1",
            "X-ClientPublicIP": "127.0.0.1",
            "X-MACAddress": "00:00:00:00:00:00",
            "Accept": "application/json",
            "X-PrivateKey": api_key,
            "X-UserType": "USER",
            "X-SourceID": "WEB"
        }
        
        print("AngelConnector: Logging on to SmartAPI (REST)...")
        r = requests.post(login_url, json={"clientcode": client_id, "password": password, "totp": totp}, headers=headers, timeout=10)
        res = r.json()
        if res.get("status") is not True or "data" not in res:
            raise Exception(f"Login failed: {res.get('message')}")
            
        self.jwt_token = res["data"]["jwtToken"]
        self.feed_token = res["data"].get("feedToken", "")
        if not self.feed_token:
            print("AngelConnector: Querying feed token...")
            r_feed = requests.get("https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getfeedToken", headers={**headers, "Authorization": f"Bearer {self.jwt_token}"}, timeout=8)
            feed_res = r_feed.json()
            self.feed_token = feed_res.get("data", {}).get("feedToken", "")
            
        print("AngelConnector: SmartAPI login successful! JWT Token generated.")
        return self.jwt_token

    def fetch_historical_candles(self, exchange, symbol_token, interval, from_date, to_date):
        """
        Fetches historical candles from Angel One REST API.
        from_date and to_date format: 'YYYY-MM-DD HH:MM'
        """
        if not hasattr(self, "jwt_token") or not self.jwt_token:
            self.login()
            
        client_id = self.get_setting("angel_client_id")
        api_key = self.get_setting("angel_api_key")
        
        url = "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData"
        headers = {
            "Content-Type": "application/json",
            "X-ClientLocalIP": "127.0.0.1",
            "X-ClientPublicIP": "127.0.0.1",
            "X-MACAddress": "00:00:00:00:00:00",
            "Accept": "application/json",
            "X-PrivateKey": api_key,
            "X-UserType": "USER",
            "X-SourceID": "WEB",
            "Authorization": f"Bearer {self.jwt_token}"
        }
        
        payload = {
            "exchange": exchange,
            "symboltoken": symbol_token,
            "interval": interval,
            "fromdate": f"{from_date}:00",
            "todate": f"{to_date}:00"
        }
        
        print(f"AngelConnector: Fetching historical candles from {from_date} to {to_date} for token {symbol_token}...")
        r = requests.post(url, json=payload, headers=headers, timeout=15)
        res = r.json()
        
        if res.get("status") is not True or "data" not in res:
            raise Exception(f"Failed to fetch historical candles: {res.get('message')}")
            
        return res

    def resolve_all_angel_tokens(self):
        """
        Resolves tokens for all symbols configured in self.settings['futures_symbols'].
        Stores the mapping in self.symbol_token_map.
        """
        if not fetch_and_cache_scrip_master():
            return {}
            
        print("AngelConnector: Resolving all NCDEX contract tokens...")
        
        # Build lookup criteria
        # For each symbol, we split it into commodity name, month, and year
        targets = {}
        for sym_name in self.settings.get("futures_symbols", {}):
            parts = sym_name.split()
            if len(parts) >= 2:
                commodity = parts[0]
                month = parts[1][:3].upper()
                year = parts[2][-2:]
                targets[sym_name] = {
                    "commodity": commodity,
                    "suffix1": f"{month}{year}",
                    "suffix2": f"{month}20{year}"
                }
                
        symbol_token_map = {}
        
        try:
            with open(INSTRUMENT_MASTER_PATH, "r") as f:
                scrip_master = json.load(f)
                
            # Scan scrip master in a single pass
            for item in scrip_master:
                if item.get("exch_seg") == "NCDEX" and item.get("instrumenttype") == "FUTCOM":
                    name = item.get("name")
                    sym = item.get("symbol", "")
                    for sym_name, criteria in targets.items():
                        if name == criteria["commodity"]:
                            s1 = criteria["suffix1"]
                            s2 = criteria["suffix2"]
                            if sym.endswith(s1) or s1 in sym or sym.endswith(s2) or s2 in sym:
                                symbol_token_map[sym_name] = item.get("token")
                                
            print(f"AngelConnector: Successfully resolved {len(symbol_token_map)} NCDEX tokens.")
        except Exception as e:
            print(f"AngelConnector: Error resolving all tokens: {e}")
            
        self.symbol_token_map = symbol_token_map
        return symbol_token_map

    def start(self, broadcast_callback):
        self.running = True
        self.broadcast_callback = broadcast_callback
        
        # Check credentials to decide mode
        client_id = self.get_setting("angel_client_id")
        password = self.get_setting("angel_password")
        totp_secret = self.get_setting("angel_totp_secret")
        api_key = self.get_setting("angel_api_key")
        mode = self.get_setting("mode")
        
        if mode == "live" and all([client_id, password, totp_secret, api_key]):
            self.receive_thread = threading.Thread(target=self._live_feed_loop, daemon=True)
            self.receive_thread.start()
            print("AngelConnector: Started LIVE SmartAPI WebSocket client")
        else:
            self.receive_thread = threading.Thread(target=self._mock_feed_loop, daemon=True)
            self.receive_thread.start()
            print("AngelConnector: Started Futures simulator (MOCK mode)")

    def stop(self):
        self.running = False
        self.connected = False
        if self.websocket and self.loop:
            try:
                asyncio.run_coroutine_threadsafe(self.websocket.close(), self.loop)
            except:
                pass
        print("AngelConnector: Stopped feed")

    def _mock_feed_loop(self):
        token = self.settings["active_token"]
        symbol = self.settings["active_symbol"]
        self.get_historical_candles(symbol)
        
        last_candle = self.mock_history[token][-1]
        price = last_candle["close"]
        oi = last_candle["oi"]
        volume = last_candle["volume"]
        
        while self.running:
            time.sleep(1.0)
            if self.settings["active_token"] != token:
                token = self.settings["active_token"]
                symbol = self.settings["active_symbol"]
                self.get_historical_candles(symbol)
                last_candle = self.mock_history[token][-1]
                price = last_candle["close"]
                oi = last_candle["oi"]
                volume = last_candle["volume"]
                
            change = random.normalvariate(0, 0.3)
            price = round(price + change, 2)
            oi = int(max(100, oi + random.normalvariate(5, 15)))
            volume += random.randint(1, 5)
            
            yest_close = self.baselines.get(token, {}).get("yesterday_close", price)
            tick = {
                "token": token,
                "symbol": symbol,
                "type": "FUT",
                "price": price,
                "change": round(price - yest_close, 2),
                "volume": volume,
                "oi": oi,
                "time": time.time(),
                "ohlc": {
                    "open": last_candle["open"],
                    "high": max(price, last_candle["high"]),
                    "low": min(price, last_candle["low"]),
                    "close": price,
                    "yesterday_close": yest_close
                }
            }
            self.broadcast_callback(tick)

    def _live_feed_loop(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._live_feed_wss_loop())
        except Exception as e:
            print(f"AngelConnector: Live feed loop error: {e}")
        finally:
            self.loop.close()

    async def _live_feed_wss_loop(self):
        while self.running:
            try:
                # 1. Login to generate fresh session tokens on every connection attempt
                print("AngelConnector: Logging in to refresh SmartAPI session...")
                jwt_token = self.login()
                feed_token = self.feed_token
                client_id = self.get_setting("angel_client_id")
                api_key = self.get_setting("angel_api_key")
                
                wss_url = "wss://smartapisocket.angelone.in/smart-stream"
                wss_headers = {
                    "Authorization": f"Bearer {jwt_token}",
                    "x-api-key": api_key,
                    "x-client-code": client_id,
                    "x-feed-token": feed_token
                }
                
                print(f"AngelConnector: Connecting to SmartStream WebSocket...")
                async with websockets.connect(wss_url, extra_headers=wss_headers) as ws:
                    self.websocket = ws
                    self.connected = True
                    print("AngelConnector: SmartStream WSS Connected!")
                    
                    # Resolve all configured NCDEX tokens
                    token_map = self.resolve_all_angel_tokens()
                    all_tokens = list(token_map.values())
                    
                    if not all_tokens:
                        # Fallback to active token
                        from backend.angel_connector import resolve_angel_token
                        active_resolved = resolve_angel_token(self.settings["active_symbol"])
                        all_tokens = [active_resolved] if active_resolved else [self.settings["active_token"]]
                    
                    # Subscribe to all tokens in SNAP_QUOTE (mode=3)
                    sub_payload = {
                        "correlationID": "sub-all-oi-1",
                        "action": 1,
                        "params": {
                            "mode": 3,
                            "tokenList": [
                                {
                                    "exchangeType": 7, # NCDEX
                                    "tokens": all_tokens
                                }
                            ]
                        }
                    }
                    await ws.send(json.dumps(sub_payload))
                    print(f"AngelConnector: Subscribed to {len(all_tokens)} NCDEX tokens in SNAP_QUOTE mode")
                    
                    # Spawn heartbeat ping task
                    ping_task = asyncio.create_task(self._heartbeat(ws))
                    
                    while self.running:
                        try:
                            frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
                            if frame == "pong":
                                continue
                                
                            if isinstance(frame, bytes):
                                tick = parse_smart_stream_binary(frame)
                                if tick:
                                    tick_token = tick["token"]
                                    
                                    # Find matching symbol name from our token_map
                                    match_symbol = None
                                    for sym_name, tok in token_map.items():
                                        if tok == tick_token:
                                            match_symbol = sym_name
                                            break
                                            
                                    if match_symbol:
                                        # Forward to database
                                        try:
                                            from backend.database import save_tick
                                            save_tick(match_symbol, tick_token, tick["ltp"], tick["oi"], tick["volume"])
                                        except Exception as db_err:
                                            print(f"AngelConnector: DB write error: {db_err}")
                                            
                                        # If this tick matches the active contract, update UI panels
                                        target_symbol = self.settings["active_symbol"]
                                        if match_symbol == target_symbol:
                                            yest_close = tick["close"] - (tick["ltp"] * (tick["oi_change_pct"] / 100.0) if tick["oi_change_pct"] else 0.0)
                                            dash_tick = {
                                                "token": tick_token,
                                                "symbol": target_symbol,
                                                "type": "FUT",
                                                "price": tick["ltp"],
                                                "change": round(tick["ltp"] - tick["close"], 2),
                                                "volume": tick["volume"],
                                                "oi": tick["oi"],
                                                "time": time.time(),
                                                "ohlc": {
                                                    "open": tick["open"],
                                                    "high": tick["high"],
                                                    "low": tick["low"],
                                                    "close": tick["ltp"],
                                                    "yesterday_close": tick["close"]
                                                }
                                            }
                                            self.market_data[tick_token] = dash_tick
                                            self.market_data[self.settings["active_token"]] = dash_tick
                                            self.broadcast_callback(dash_tick)
                        except asyncio.TimeoutError:
                            continue
                        except websockets.exceptions.ConnectionClosed:
                            print("AngelConnector: SmartStream WSS disconnected")
                            break
                    
                    ping_task.cancel()
                    
            except Exception as e:
                print(f"AngelConnector: SmartStream error: {e}. Reconnecting in 10s...")
                await asyncio.sleep(10.0)

    async def _heartbeat(self, ws):
        while self.running:
            try:
                await asyncio.sleep(30.0)
                await ws.send("ping")
            except:
                break

def fetch_and_cache_scrip_master():
    url = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
    try:
        if os.path.exists(INSTRUMENT_MASTER_PATH):
            mtime = os.path.getmtime(INSTRUMENT_MASTER_PATH)
            if time.time() - mtime < 86400:
                return True
                
        print("AngelConnector: Downloading fresh scrip master from margincalculator...")
        r = requests.get(url, timeout=25)
        if r.status_code == 200:
            with open(INSTRUMENT_MASTER_PATH, "w") as f:
                f.write(r.text)
            return True
    except Exception as e:
        print(f"AngelConnector: Failed to update scrip master: {e}")
    return os.path.exists(INSTRUMENT_MASTER_PATH)

def resolve_angel_token(symbol_name):
    if not fetch_and_cache_scrip_master():
        return None
        
    parts = symbol_name.split()
    if len(parts) < 2:
        return None
        
    commodity = parts[0]
    month = parts[1][:3].upper() # JUN
    year_two_digits = parts[2][-2:] # 26
    
    target_match_suffix1 = f"{month}{year_two_digits}"
    target_match_suffix2 = f"{month}20{year_two_digits}"
    
    try:
        with open(INSTRUMENT_MASTER_PATH, "r") as f:
            scrip_master = json.load(f)
            
        for item in scrip_master:
            if item.get("exch_seg") == "NCDEX" and item.get("name") == commodity and item.get("instrumenttype") == "FUTCOM":
                sym = item.get("symbol", "")
                if sym.endswith(target_match_suffix1) or target_match_suffix1 in sym or sym.endswith(target_match_suffix2) or target_match_suffix2 in sym:
                    print(f"AngelConnector: Resolved {symbol_name} -> token {item.get('token')} ({sym})")
                    return item.get("token")
    except Exception as e:
        print(f"AngelConnector: Token resolution error: {e}")
    return None
