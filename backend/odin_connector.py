import socket
import threading
import time
import zlib
import json
import random
import requests
import asyncio
import ssl
import websockets
from datetime import datetime

class OdinConnector:
    def __init__(self, config_callback=None):
        self.config_callback = config_callback
        self.socket = None
        self.connected = False
        self.running = False
        self.receive_thread = None
        
        # Live state
        self.market_data = {}      # token -> current data tick
        self.historical_data = {}  # token -> list of candles
        
        # Load settings
        self.settings = {
            "mode": "mock",
            "wfh_ip": "127.0.0.1",
            "wfh_port": 5001,
            "user_id": "",
            "password": "",
            "api_key": "",
            "odin_rest_url": "https://api.indiratrade.com",
            "active_symbol": "NIFTY-FUT",
            "active_token": "53920",
            "active_segment": "2",
            # EOD override: stores closing data entered manually by user from broker
            "eod_override": {}
        }
        self.load_config()
        
        # Mock simulation variables
        self.mock_history = {} # token -> list of candles
        self.init_mock_history()

    def load_config(self):
        try:
            with open("backend/config.json", "r") as f:
                config = json.load(f)
                self.settings.update(config)
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"Error loading config.json: {e}")

    def save_config(self, new_settings):
        self.settings.update(new_settings)
        
        sym = self.settings.get("active_symbol")
        if "futures_symbols" in self.settings and sym in self.settings["futures_symbols"]:
            # If the new_settings contains the form inputs, update the template
            if "active_token" in new_settings:
                self.settings["futures_symbols"][sym]["token"] = new_settings["active_token"]
            if "active_segment" in new_settings:
                self.settings["futures_symbols"][sym]["segment"] = new_settings["active_segment"]
            if "tradingview_symbol" in new_settings:
                self.settings["futures_symbols"][sym]["tv_symbol"] = new_settings["tradingview_symbol"]
            
            # If not in new_settings (dropdown change), load from the template
            if "active_token" not in new_settings:
                self.settings["active_token"] = self.settings["futures_symbols"][sym]["token"]
            if "active_segment" not in new_settings:
                self.settings["active_segment"] = self.settings["futures_symbols"][sym]["segment"]
            if "tradingview_symbol" not in new_settings:
                self.settings["tradingview_symbol"] = self.settings["futures_symbols"][sym]["tv_symbol"]
                
        try:
            with open("backend/config.json", "w") as f:
                json.dump(self.settings, f, indent=2)
            self.load_config()
            return {"status": "success", "message": "Config saved successfully"}
        except Exception as e:
            return {"status": "error", "message": f"Failed to save config: {str(e)}"}

    def fetch_yahoo_history(self, symbol):
        # For NCDEX commodities, we don't have Yahoo Finance tickers. Return empty list to trigger mock baseline fallback.
        if any(c in symbol for c in ["JEERA", "CASTOR", "DHANIYA"]):
            return []

        # Map NIFTY-FUT to Yahoo Finance Nifty 50 Index (^NSEI)
        # Map BANKNIFTY-FUT to Yahoo Finance Bank Nifty Index (^NSEBANK)
        ticker = "^NSEI"
        base_oi = 12500000
        
        if "BANKNIFTY" in symbol:
            ticker = "^NSEBANK"
            base_oi = 2800000
            
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1d&interval=1m"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        try:
            print(f"OdinConnector: Fetching index history from Yahoo Finance for {ticker}...")
            r = requests.get(url, headers=headers, timeout=8)
            data = r.json()
            result = data["chart"]["result"][0]
            timestamps = result["timestamp"]
            indicators = result["indicators"]["quote"][0]
            
            opens = indicators["open"]
            highs = indicators["high"]
            lows = indicators["low"]
            closes = indicators["close"]
            volumes = indicators.get("volume", [0] * len(timestamps))
            
            history = []
            oi = base_oi
            
            for i in range(len(timestamps)):
                if opens[i] is None or closes[i] is None:
                    continue
                
                # Generate matching simulated F&O Open Interest trend (since Yahoo does not provide F&O OI)
                price_change = closes[i] - opens[i]
                oi_change = int(price_change * random.uniform(500, 2000))
                oi = max(100000, oi + oi_change)
                
                history.append({
                    "time": timestamps[i],
                    "open": round(opens[i], 2),
                    "high": round(highs[i], 2),
                    "low": round(lows[i], 2),
                    "close": round(closes[i], 2),
                    "oi": int(oi),
                    "volume": int(volumes[i]) if volumes[i] else int(abs(oi_change) * 2)
                })
            print(f"OdinConnector: Successfully loaded {len(history)} historical candles from Yahoo Finance.")
            return history
        except Exception as e:
            print(f"OdinConnector: Failed to load Yahoo Finance history: {e}. Falling back to simulator baseline.")
            return []

    def _generate_single_mock_history(self, token, info):
        now = time.time()
        price = info["price"]
        oi = info["oi"]
        history = []
        for i in range(150):
            timestamp = now - i * 60
            
            if i == 0:
                # The latest candle matches the actual broker/exchange closing values exactly
                open_p = info["open"]
                high_p = info["high"]
                low_p = info["low"]
                close_p = info["price"]
                vol = info["volume"]
            else:
                # Walk backwards in time to create historical candles
                open_p = price
                close_p = price
                high_variation = max(0, random.normalvariate(1 if price > 10000 else 0.3, 1.2 if price > 10000 else 0.4))
                low_variation = max(0, random.normalvariate(1 if price > 10000 else 0.3, 1.2 if price > 10000 else 0.4))
                high_p = price + high_variation
                low_p = price - low_variation
                vol = random.randint(10, 150) if price > 10000 else random.randint(1, 15)
                
            history.append({
                "time": timestamp,
                "open": round(open_p, 2),
                "high": round(high_p, 2),
                "low": round(low_p, 2),
                "close": round(close_p, 2),
                "oi": int(oi),
                "volume": int(vol)
            })
            
            # Determine previous step value by walking backwards
            change_scale = 4.0 if price > 10000 else 1.0
            change = random.normalvariate(0, change_scale)
            price = price - change
            
            oi_scale = 1000 if oi > 100000 else 10
            oi_change = int(random.normalvariate(oi_scale, oi_scale * 3))
            if change < 0 and random.random() > 0.4:
                oi_change = -int(random.normalvariate(oi_scale / 2, oi_scale * 1.5))
            
            oi = max(int(info["oi"] * 0.2), oi - oi_change)
            
        history.reverse()
        self.mock_history[token] = history

    def init_mock_history(self):
        # Generate 150 historical minutes candles using actual NCDEX closing data (June 5, 2026)
        # Tokens use AngelOne/ODIN string format confirmed from instrument master
        self.baselines = {
            "53920": {  # NIFTY FUT (NSE)
                "price": 22150.0,
                "open": 22100.0,
                "high": 22200.0,
                "low": 22050.0,
                "yesterday_close": 22100.0,
                "volume": 125000,
                "oi": 12500000
            },
            "61000": {  # BANKNIFTY FUT (NSE)
                "price": 47350.0,
                "open": 47200.0,
                "high": 47500.0,
                "low": 47100.0,
                "yesterday_close": 47100.0,
                "volume": 85000,
                "oi": 2800000
            },
            "DHANIYA19JUN2026": {  # DHANIYA JUN FUT (NCDEX) — actual June 5 2026 close
                "price": 12490.0,
                "open": 12460.0,
                "high": 12584.0,
                "low": 12384.0,
                "yesterday_close": 12678.0,
                "volume": 5350,
                "oi": 18605
            },
            "DHANIYA20AUG2026": {  # DHANIYA AUG FUT (NCDEX)
                "price": 12714.0,
                "open": 12600.0,
                "high": 12720.0,
                "low": 12510.0,
                "yesterday_close": 12808.0,
                "volume": 1500,
                "oi": 5200
            },
            "DHANIYA19OCT2026": {  # DHANIYA OCT FUT (NCDEX)
                "price": 12844.0,
                "open": 12730.0,
                "high": 12850.0,
                "low": 12640.0,
                "yesterday_close": 12938.0,
                "volume": 400,
                "oi": 1100
            },
            "DHANIYA18DEC2026": {  # DHANIYA DEC FUT (NCDEX)
                "price": 12980.0,
                "open": 12900.0,
                "high": 12990.0,
                "low": 12810.0,
                "yesterday_close": 13050.0,
                "volume": 150,
                "oi": 350
            },
            "JEERAUNJHA20JUN2026": {  # JEERA FUT (NCDEX)
                "price": 19045.0,
                "open": 18950.0,
                "high": 19050.0,
                "low": 18950.0,
                "yesterday_close": 19000.0,
                "volume": 2400,
                "oi": 2800
            },
            "CASTORSEED20JUN2026": {  # CASTOR FUT (NCDEX)
                "price": 6561.0,
                "open": 6550.0,
                "high": 6580.0,
                "low": 6540.0,
                "yesterday_close": 6500.0,
                "volume": 18500,
                "oi": 18500
            }
        }
        for token, info in self.baselines.items():
            self._generate_single_mock_history(token, info)

    def get_historical_candles(self, symbol):
        token = self.settings["active_token"]
        
        # If user requests another symbol, check standard mapping
        if "futures_symbols" in self.settings:
            if symbol in self.settings["futures_symbols"]:
                token = self.settings["futures_symbols"][symbol]["token"]

        # Ensure mock history is initialized for current active token
        if token not in self.mock_history:
            if token in self.baselines:
                info = self.baselines[token]
            else:
                info = {
                    "price": 10000.0,
                    "open": 10000.0,
                    "high": 10000.0,
                    "low": 10000.0,
                    "yesterday_close": 10000.0,
                    "volume": 1000,
                    "oi": 50000
                }
            self._generate_single_mock_history(token, info)

        if self.settings["mode"] == "mock":
            return self.mock_history.get(token)
        else:
            # Live mode: Check if we already accumulated live data
            accumulated = self.historical_data.get(token, [])
            if len(accumulated) > 10:
                return accumulated
            
            # If we don't have accumulated data (e.g. startup, or market closed),
            # pull from Yahoo Finance dynamically so the chart isn't empty!
            yahoo_data = self.fetch_yahoo_history(symbol)
            if yahoo_data:
                # Cache it as base history
                self.historical_data[token] = yahoo_data
                return yahoo_data
                
            # If Yahoo fails, fall back to our simulator baseline to prevent a blank chart
            sim_fallback = self.mock_history.get(token)
            self.historical_data[token] = sim_fallback
            return sim_fallback

    def start(self, broadcast_callback):
        self.running = True
        self.broadcast_callback = broadcast_callback
        
        if self.settings["mode"] == "mock":
            self.receive_thread = threading.Thread(target=self._mock_feed_loop, daemon=True)
            self.receive_thread.start()
            print("OdinConnector: Started Futures simulator (MOCK mode)")
        else:
            self.receive_thread = threading.Thread(target=self._live_feed_loop, daemon=True)
            self.receive_thread.start()
            print(f"OdinConnector: Started Live Futures client, connecting to {self.settings['wfh_ip']}:{self.settings['wfh_port']}")

    def stop(self):
        self.running = False
        self.connected = False
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
        if hasattr(self, 'websocket') and self.websocket and hasattr(self, 'loop') and self.loop:
            try:
                asyncio.run_coroutine_threadsafe(self.websocket.close(), self.loop)
            except Exception as e:
                print(f"OdinConnector: Error closing websocket: {e}")
        print("OdinConnector: Stopped feed")

    # MOCK LOOP
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

            # Scaled change
            change_scale = 1.2 if price > 10000 else 0.3
            change = random.normalvariate(0.0, change_scale)
            price = round(price + change, 2)
            
            # Scaled OI change
            oi_scale = 1000 if oi > 100000 else 10
            oi_change = int(random.normalvariate(oi_scale / 2, oi_scale * 1.5))
            if change < 0 and random.random() > 0.4:
                oi_change = -int(random.normalvariate(oi_scale / 5, oi_scale * 0.8))
            
            if "JEERA" in symbol:
                oi_limit = 500
            elif "CASTOR" in symbol or "DHANIYA" in symbol:
                oi_limit = 2000
            elif "BANKNIFTY" in symbol:
                oi_limit = 500000
            else: # NIFTY
                oi_limit = 1000000
                
            oi = int(max(oi_limit, oi + oi_change))
            volume += int(random.randint(10, 80) if price > 10000 else random.randint(1, 5))
            
            yest_close = self.baselines.get(token, {}).get("yesterday_close", price)
            
            tick = {
                "token": token,
                "symbol": symbol,
                "type": "FUT",
                "price": price,
                "change": round(price - (last_candle["close"] if 'last_candle' in locals() else price), 2),
                "volume": volume,
                "oi": oi,
                "time": time.time(),
                "ohlc": {
                    "open": last_candle["open"] if 'last_candle' in locals() else price,
                    "high": max(price, last_candle["high"] if 'last_candle' in locals() else price),
                    "low": min(price, last_candle["low"] if 'last_candle' in locals() else price),
                    "close": price,
                    "yesterday_close": yest_close
                }
            }
            self.broadcast_callback(tick)
            
            if int(time.time()) % 60 == 0:
                if token not in self.mock_history:
                    self.mock_history[token] = []
                    
                self.mock_history[token].append({
                    "time": time.time(),
                    "open": price,
                    "high": price,
                    "low": price,
                    "close": price,
                    "oi": oi,
                    "volume": volume
                })
                last_candle = self.mock_history[token][-1]
                if len(self.mock_history[token]) > 300:
                    self.mock_history[token].pop(0)

    # LIVE BROADCAST WSS LOOP
    def _live_feed_loop(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._live_feed_wss_loop())
        except Exception as e:
            print(f"OdinConnector: Live feed event loop error: {e}")
        finally:
            self.loop.close()

    async def _live_feed_wss_loop(self):
        port = int(self.settings['wfh_port'])
        uri = f"wss://{self.settings['wfh_ip']}:{port}"
        ssl_context = ssl._create_unverified_context()
        
        while self.running:
            try:
                print(f"OdinConnector: Connecting to Live WSS Broker at {uri}")
                async with websockets.connect(uri, ssl=ssl_context, open_timeout=10) as ws:
                    self.websocket = ws
                    self.connected = True
                    print("OdinConnector: Connected to Live WFH WSS Server")
                    
                    # Send Logon Request (101) — must include all auth tags in exact order
                    logon_body = {
                        "400": "16",
                        "67": self.settings["user_id"],
                        "401": "1",
                        "68": self.settings["password"],
                        "51": "16"
                    }
                    logon_msg = self._build_odin_message(101, logon_body)
                    await ws.send(logon_msg)
                    print(f"OdinConnector: Sent Logon Request (101): {logon_msg}")
                    
                    buffer = b""
                    
                    while self.running:
                        try:
                            # 2.0 seconds timeout allows checking self.running regularly
                            frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
                            if isinstance(frame, str):
                                frame = frame.encode('latin-1')
                            buffer += frame
                            buffer = self._parse_tcp_stream(buffer)
                        except asyncio.TimeoutError:
                            continue
                        except websockets.exceptions.ConnectionClosed as e:
                            print(f"OdinConnector: WSS Connection closed by remote host: {e}")
                            break
                        except Exception as e:
                            print(f"OdinConnector: Error reading WSS: {e}")
                            break
            except Exception as e:
                print(f"OdinConnector: Live WSS socket error: {type(e).__name__}: {repr(e)}. Retrying in 5s...")
                self.connected = False
                await asyncio.sleep(5.0)
            finally:
                was_connected = self.connected
                self.connected = False
                self.websocket = None
                if was_connected and self.running:
                    print("OdinConnector: Disconnected from WSS Broker. Retrying in 5s...")
                    await asyncio.sleep(5.0)

    def _build_odin_message(self, msg_code, body_dict):
        pairs = []
        # Broker confirmed protocol: FIX3.0 (not FT1.0)
        pairs.append(("63", "FIX3.0"))
        pairs.append(("64", str(msg_code)))
        pairs.append(("65", "000"))
        
        time_str = datetime.now().strftime("%Y-%m-%d %H%M%S")
        pairs.append(("66", time_str))
        
        for k, v in body_dict.items():
            pairs.append((str(k), str(v)))
            
        msg_str = "|".join([f"{k}={v}" for k, v in pairs]) + "|"
        msg_str = msg_str.replace("65=000", f"65={len(msg_str):03d}")
        
        # 5-digit length prefix required by ODIN protocol
        length_prefix = f"{len(msg_str):05d}"
        return b"\x02" + length_prefix.encode('ascii') + msg_str.encode('ascii')

    def _parse_tcp_stream(self, data):
        i = 0
        while i < len(data):
            if i + 6 > len(data):
                return data[i:]
            
            flag = data[i]
            is_compressed = (flag == 5 or flag == ord('5') or flag == ord('♣'))
            is_uncompressed = (flag == 2 or flag == ord('2') or flag == ord('☻'))
            
            if not (is_compressed or is_uncompressed):
                i += 1
                continue
                
            try:
                msg_len = int(data[i+1:i+6].decode('ascii'))
            except ValueError:
                i += 1
                continue
                
            if i + 6 + msg_len > len(data):
                return data[i:]
                
            payload = data[i+6:i+6+msg_len]
            
            if is_compressed:
                try:
                    decompressed = zlib.decompress(payload)
                    self._parse_inner_packets(decompressed)
                except Exception as e:
                    print("OdinConnector: Decompression Failed:", e)
            else:
                try:
                    self._handle_odin_message(payload.decode('ascii', errors='ignore'))
                except Exception as e:
                    print("OdinConnector: Parsing uncompressed error:", e)
                
            i += 6 + msg_len
            
        return b""

    def _parse_inner_packets(self, data):
        i = 0
        while i < len(data):
            if i + 6 > len(data):
                break
                
            flag = data[i]
            try:
                msg_len = int(data[i+1:i+6].decode('ascii'))
            except ValueError:
                i += 1
                continue
                
            if i + 6 + msg_len > len(data):
                break
                
            payload = data[i+6:i+6+msg_len]
            
            try:
                msg_text = payload.decode('ascii', errors='ignore')
                self._handle_odin_message(msg_text)
            except Exception as e:
                print("OdinConnector: Parsing error:", e)
                
            i += 6 + msg_len

    def _handle_odin_message(self, msg_text):
        tags = {}
        for part in msg_text.split('|'):
            if '=' in part:
                k, v = part.split('=', 1)
                tags[k] = v
                
        msg_code = tags.get("64")
        
        if msg_code == "102":
            status = tags.get("70")
            print(f"OdinConnector: Logon Status: {status}")
            if status == "10000":
                print("OdinConnector: Logon Successful! Subscribing to active token...")
                self.subscribe_active_token()
                
        elif msg_code == "209" or msg_code == "128":
            token = tags.get("7")
            if token != self.settings["active_token"]:
                return
                
            try:
                ltp = float(tags.get("8", 0)) / 100.0 if "8" in tags else None
                oi = int(tags.get("88", 0)) if "88" in tags and tags["88"] else None
                volume = int(tags.get("79", 0)) if "79" in tags and tags["79"] else None
                net_change = float(tags.get("54", 0)) if "54" in tags else 0.0
                
                open_p = float(tags.get("75", 0)) / 100.0 if "75" in tags else ltp
                high_p = float(tags.get("77", 0)) / 100.0 if "77" in tags else ltp
                low_p = float(tags.get("78", 0)) / 100.0 if "78" in tags else ltp
                close_p = float(tags.get("76", 0)) / 100.0 if "76" in tags else ltp
            except Exception as e:
                print(f"OdinConnector: Data conversion error: {e}")
                return
                
            if ltp is not None:
                tick = {
                    "token": token,
                    "symbol": self.settings["active_symbol"],
                    "type": "FUT",
                    "price": ltp,
                    "change": net_change,
                    "volume": volume if volume else 0,
                    "oi": oi if oi else 0,
                    "time": time.time(),
                    "ohlc": {
                        "open": open_p,
                        "high": high_p,
                        "low": low_p,
                        "close": close_p,
                        "yesterday_close": ltp - net_change
                    }
                }
                
                # Cache and append history
                self.market_data[token] = tick
                
                # Save to local SQLite database for historical tracking
                try:
                    from backend.database import save_tick
                    save_tick(
                        symbol=self.settings["active_symbol"],
                        token=token,
                        price=ltp,
                        open_interest=oi if oi else 0,
                        volume=volume if volume else 0
                    )
                except Exception as db_err:
                    print(f"OdinConnector: Database save error: {db_err}")
                
                if token not in self.historical_data:
                    self.historical_data[token] = []
                    
                history = self.historical_data[token]
                current_time = time.time()
                
                if not history or (current_time - history[-1]["time"] >= 60):
                    history.append({
                        "time": current_time,
                        "open": open_p if open_p else ltp,
                        "high": high_p if high_p else ltp,
                        "low": low_p if low_p else ltp,
                        "close": ltp,
                        "oi": oi if oi else 0,
                        "volume": volume if volume else 0
                    })
                else:
                    candle = history[-1]
                    candle["high"] = max(candle["high"], ltp)
                    candle["low"] = min(candle["low"], ltp)
                    candle["close"] = ltp
                    if oi:
                        candle["oi"] = oi
                    if volume:
                        candle["volume"] = volume
                        
                if len(history) > 500:
                    history.pop(0)
                    
                self.broadcast_callback(tick)

    def subscribe_active_token(self):
        if not self.connected:
            return
            
        seg = self.settings["active_segment"]
        token = self.settings["active_token"]
        print(f"OdinConnector: Subscribing to Token: {token} (Segment: {seg})")
        
        sub_body = {
            "1": f"{seg}$7={token}",
            "230": "1"
        }
        sub_packet = self._build_odin_message(206, sub_body)
        print(f"OdinConnector: Subscription packet: {sub_packet}")
        try:
            if hasattr(self, 'websocket') and self.websocket:
                asyncio.run_coroutine_threadsafe(self.websocket.send(sub_packet), self.loop)
                print("OdinConnector: Subscription request sent over WSS")
            elif self.socket:
                self.socket.sendall(sub_packet)
                print("OdinConnector: Subscription request sent over TCP")
        except Exception as e:
            print("OdinConnector: Failed to send subscription:", e)
