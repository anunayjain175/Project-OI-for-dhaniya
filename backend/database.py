import sqlite3
import os
import time
import queue
import threading
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oi_history.db")
DATABASE_URL = os.environ.get("DATABASE_URL")

def is_postgres():
    return DATABASE_URL and (DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://"))

def get_db_connection():
    if is_postgres():
        import psycopg2
        # Clean up any potential connection string quirks (e.g. postgres:// vs postgresql://)
        conn_str = DATABASE_URL
        if conn_str.startswith("postgres://"):
            conn_str = conn_str.replace("postgres://", "postgresql://", 1)
        conn = psycopg2.connect(conn_str)
        return conn
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn

def get_cursor(conn):
    if is_postgres():
        from psycopg2.extras import RealDictCursor
        return conn.cursor(cursor_factory=RealDictCursor)
    else:
        return conn.cursor()

def get_placeholder():
    return "%s" if is_postgres() else "?"

def init_db():
    conn = get_db_connection()
    cursor = get_cursor(conn)
    
    # Auto-migration: check if old schema exists and needs to be dropped
    schema_needs_reset = False
    try:
        cursor.execute("SELECT open FROM ticks LIMIT 1")
    except Exception:
        # Table exists but has old schema (lacks 'open' column) or table doesn't exist
        schema_needs_reset = True
        if is_postgres():
            conn.rollback() # rollback failed query transaction
            
    if schema_needs_reset:
        print("Migrating/reinitializing database schema to support OHLC candles...")
        if is_postgres():
            cursor.execute("DROP TABLE IF EXISTS ticks CASCADE")
        else:
            cursor.execute("DROP TABLE IF EXISTS ticks")
        conn.commit()

    if is_postgres():
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ticks (
                id SERIAL PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                symbol VARCHAR(100) NOT NULL,
                token VARCHAR(100) NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                open_interest INTEGER NOT NULL,
                volume INTEGER NOT NULL,
                cvd REAL NOT NULL DEFAULT 0.0
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON ticks (symbol, timestamp)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ticks_token_time ON ticks (token, timestamp)")
    else:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ticks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                token TEXT NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                open_interest INTEGER NOT NULL,
                volume INTEGER NOT NULL,
                cvd REAL NOT NULL DEFAULT 0.0
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON ticks (symbol, timestamp)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ticks_token_time ON ticks (token, timestamp)")
        
    conn.commit()
    
    # Safe auto-migration: check if cvd column exists. If table was just created, it will have it.
    # Otherwise, we add it dynamically to avoid dropping data.
    try:
        cursor.execute("SELECT cvd FROM ticks LIMIT 1")
    except Exception:
        if is_postgres():
            conn.rollback()
        print("Database migration: adding 'cvd' column to existing 'ticks' table...")
        try:
            cursor.execute("ALTER TABLE ticks ADD COLUMN cvd REAL DEFAULT 0.0")
            conn.commit()
            print("Database migration: successfully added 'cvd' column.")
        except Exception as alter_err:
            if is_postgres():
                conn.rollback()
            print(f"Database migration: failed to alter table: {alter_err}")
            
    cursor.close()
    conn.close()
    print(f"Database initialized. Type: {'PostgreSQL' if is_postgres() else 'SQLite'}")
# NCDEX Trading Holidays 2026 (morning session closed)
# Format: (month, day) tuples for quick lookup
NCDEX_HOLIDAYS_2026 = {
    (1, 15),   # Municipal Corporation Elections
    (1, 26),   # Republic Day
    (3, 3),    # Holi
    (3, 26),   # Shri Ram Navami
    (3, 31),   # Shri Mahavir Jayanti
    (4, 3),    # Good Friday
    (4, 14),   # Dr. Baba Saheb Ambedkar Jayanti
    (5, 1),    # Maharashtra Day
    (5, 28),   # Bakri Id
    (6, 26),   # Muharram
    (9, 14),   # Ganesh Chaturthi
    (10, 2),   # Mahatma Gandhi Jayanti
    (10, 20),  # Dussehra
    (11, 10),  # Diwali-Balipratipada
    (11, 24),  # Guru Nanak Jayanti
    (12, 25),  # Christmas
}

def is_ncdex_holiday(dt_or_epoch) -> bool:
    """Check if a date falls on an NCDEX trading holiday.
    Accepts either a datetime object or an epoch timestamp."""
    from datetime import datetime, timezone, timedelta
    if isinstance(dt_or_epoch, (int, float)):
        IST = timezone(timedelta(hours=5, minutes=30))
        dt = datetime.fromtimestamp(dt_or_epoch, tz=IST)
    else:
        dt = dt_or_epoch
    return (dt.month, dt.day) in NCDEX_HOLIDAYS_2026

def is_market_hours(epoch: int, is_mcx: bool = False) -> bool:
    """
    Returns True if the epoch timestamp (in IST) is within market hours:
    NCDEX: Mon-Fri 10:00 AM to 5:00 PM IST.
    MCX: Mon-Fri 9:00 AM to 11:30 PM IST.
    """
    from datetime import datetime, timezone, timedelta, time
    IST = timezone(timedelta(hours=5, minutes=30))
    dt = datetime.fromtimestamp(epoch, tz=IST)
    
    # Monday = 0, Friday = 4, Saturday = 5, Sunday = 6
    if dt.weekday() > 4:
        return False

    # Check NCDEX holidays
    if is_ncdex_holiday(dt):
        return False
        
    t = dt.time()
    if is_mcx:
        start_time = time(9, 0, 0)
        end_time = time(23, 30, 0)
    else:
        start_time = time(10, 0, 0)
        end_time = time(17, 0, 0) # Strictly before 5:00 PM IST
    
    return start_time <= t < end_time


def get_last_market_minute(epoch: int) -> int:
    """
    Returns the nearest epoch timestamp (truncated to minute) that is within market hours and <= epoch.
    Skips weekends and NCDEX holidays.
    """
    from datetime import datetime, timezone, timedelta
    IST = timezone(timedelta(hours=5, minutes=30))
    dt = datetime.fromtimestamp(epoch, tz=IST)
    
    # Rewind to 16:59 of the most recent valid trading day
    def _rewind_to_prev_trading_day(d):
        """Move backwards from d to find the last valid trading day, return it set to 16:59."""
        candidate = d
        # If currently after market close or on a non-trading day, start from today/yesterday
        for _ in range(10):  # Max 10 days back (covers long weekends + holidays)
            if candidate.weekday() <= 4 and not is_ncdex_holiday(candidate):
                return candidate.replace(hour=16, minute=59, second=0, microsecond=0)
            candidate -= timedelta(days=1)
        # Fallback: just use the original date
        return d.replace(hour=16, minute=59, second=0, microsecond=0)

    # Weekend
    if dt.weekday() > 4:
        return int(_rewind_to_prev_trading_day(dt - timedelta(days=1)).timestamp())
    
    # Holiday
    if is_ncdex_holiday(dt):
        return int(_rewind_to_prev_trading_day(dt - timedelta(days=1)).timestamp())
    
    # Weekday before market open
    if dt.hour < 10:
        return int(_rewind_to_prev_trading_day(dt - timedelta(days=1)).timestamp())
        
    # Weekday after market close
    if dt.hour >= 17:
        dt = dt.replace(hour=16, minute=59, second=0, microsecond=0)
        return int(dt.timestamp())
            
    return epoch - (epoch % 60)


db_write_queue = queue.Queue()

def _db_writer_worker():
    conn = None
    cursor = None
    while True:
        try:
            # Block until an item is available
            item = db_write_queue.get()
            if item is None:
                db_write_queue.task_done()
                break
                
            symbol, token, price, open_interest, volume, cvd_value, now = item
            
            # Ensure database connection is active
            if conn is None or (hasattr(conn, "closed") and conn.closed):
                if conn:
                    try:
                        conn.close()
                    except:
                        pass
                print("Database Worker: Opening fresh connection...")
                conn = get_db_connection()
                cursor = get_cursor(conn)
                
            p = get_placeholder()
            
            # 1. Fetch the last recorded tick overall for this token PRIOR to the current minute (to get baseline volume/price)
            current_minute = now - (now % 60)
            query_prev = f"""
                SELECT open, high, low, close, open_interest, volume, timestamp FROM ticks
                WHERE token = {p} AND timestamp < {p}
                ORDER BY timestamp DESC LIMIT 1
            """
            cursor.execute(query_prev, (token, current_minute))
            prev_tick = cursor.fetchone()
            
            # Determine baseline volume for comparison (resets to 0 on a new calendar day in IST)
            prev_volume = 0
            if prev_tick:
                prev_timestamp = prev_tick["timestamp"]
                prev_day = (prev_timestamp + 19800) // 86400
                curr_day = (now + 19800) // 86400
                if prev_day == curr_day:
                    prev_volume = prev_tick["volume"]

            # 2. Check if we already have a tick for this token in the current minute
            query_curr = f"""
                SELECT id, open, high, low, close, open_interest, volume FROM ticks 
                WHERE token = {p} AND timestamp >= {p} AND timestamp < {p}
                ORDER BY timestamp DESC LIMIT 1
            """
            cursor.execute(query_curr, (token, current_minute, current_minute + 60))
            curr_tick = cursor.fetchone()
            
            if curr_tick:
                # We are updating the current minute's tick
                if prev_tick and volume > prev_volume:
                    # This is a trade tick!
                    if curr_tick["volume"] == prev_volume:
                        # This is the first trade of the minute! Overwrite the placeholder values.
                        update_query = f"""
                            UPDATE ticks SET 
                                timestamp = {p},
                                open = {p},
                                high = {p},
                                low = {p},
                                close = {p},
                                open_interest = {p},
                                volume = {p},
                                cvd = {p}
                            WHERE id = {p}
                        """
                        cursor.execute(update_query, (now, price, price, price, price, open_interest, volume, cvd_value, curr_tick["id"]))
                    else:
                        # Standard update within the same minute
                        new_high = max(curr_tick["high"], price)
                        new_low = min(curr_tick["low"], price)
                        update_query = f"""
                            UPDATE ticks SET 
                                timestamp = {p},
                                high = {p},
                                low = {p},
                                close = {p},
                                open_interest = {p},
                                volume = {p},
                                cvd = {p}
                            WHERE id = {p}
                        """
                        cursor.execute(update_query, (now, new_high, new_low, price, open_interest, volume, cvd_value, curr_tick["id"]))
                else:
                    # Standard heartbeat/no-trade update: update close, high, low, OI, and volume
                    new_high = max(curr_tick["high"], price)
                    new_low = min(curr_tick["low"], price)
                    update_query = f"""
                        UPDATE ticks SET 
                            timestamp = {p},
                            high = {p},
                            low = {p},
                            close = {p},
                            open_interest = {p},
                            volume = {p},
                            cvd = {p}
                        WHERE id = {p}
                    """
                    cursor.execute(update_query, (now, new_high, new_low, price, open_interest, volume, cvd_value, curr_tick["id"]))
            else:
                # We are inserting a new minute tick
                if prev_tick and volume <= prev_volume:
                    # Insert a placeholder candle at the previous close price (no trades occurred yet)
                    prev_close = prev_tick["close"]
                    insert_query = f"""
                        INSERT INTO ticks (timestamp, symbol, token, open, high, low, close, open_interest, volume, cvd)
                        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p})
                    """
                    cursor.execute(insert_query, (now, symbol, token, prev_close, prev_close, prev_close, prev_close, open_interest, prev_volume, cvd_value))
                else:
                    # Insert a new trading candle
                    insert_query = f"""
                        INSERT INTO ticks (timestamp, symbol, token, open, high, low, close, open_interest, volume, cvd)
                        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p})
                    """
                    cursor.execute(insert_query, (now, symbol, token, price, price, price, price, open_interest, volume, cvd_value))
                
            conn.commit()
            db_write_queue.task_done()
            
        except Exception as e:
            print(f"Database Worker Error: {e}")
            if conn:
                try:
                    conn.rollback()
                except:
                    pass
                try:
                    conn.close()
                except:
                    pass
                conn = None
                cursor = None
            db_write_queue.task_done()

_cvd_state = {} # maps token -> {"last_price": float, "last_volume": int, "running_cvd": float, "last_direction": int}
_cvd_lock = threading.Lock()

def get_or_calculate_cvd(token: str, price: float, volume: int, timestamp: int = None) -> float:
    global _cvd_state
    if timestamp is None:
        timestamp = int(time.time())
    with _cvd_lock:
        state = _cvd_state.get(token)
        if state is None:
            conn = get_db_connection()
            cursor = get_cursor(conn)
            p = get_placeholder()
            try:
                cursor.execute(f"SELECT close, volume, cvd, timestamp FROM ticks WHERE token = {p} ORDER BY timestamp DESC LIMIT 1", (token,))
                row = cursor.fetchone()
                if row:
                    state = {
                        "last_price": float(row["close"]),
                        "last_volume": int(row["volume"]),
                        "running_cvd": float(row["cvd"]),
                        "last_direction": 1,
                        "last_timestamp": int(row["timestamp"])
                    }
                else:
                    state = {
                        "last_price": float(price),
                        "last_volume": int(volume),
                        "running_cvd": 0.0,
                        "last_direction": 1,
                        "last_timestamp": timestamp
                    }
            except Exception as e:
                print(f"CVD Tracker: Error resuming state for {token}: {e}")
                state = {
                    "last_price": float(price),
                    "last_volume": int(volume),
                    "running_cvd": 0.0,
                    "last_direction": 1,
                    "last_timestamp": timestamp
                }
            finally:
                cursor.close()
                conn.close()
            _cvd_state[token] = state
            
        # Check if day changed (in IST) to reset CVD to 0.0
        import datetime
        tz_ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
        dt_curr = datetime.datetime.fromtimestamp(timestamp, tz_ist)
        dt_last = datetime.datetime.fromtimestamp(state["last_timestamp"], tz_ist)
        
        if dt_curr.date() != dt_last.date():
            # Reset running CVD on a new trading day
            state["running_cvd"] = 0.0
            state["last_volume"] = 0
            
        volume_diff = volume - state["last_volume"]
        if volume_diff < 0:
            # Volume decreased (exchange reset or service restart mismatch)
            # Just re-baseline the volume without generating any delta
            state["last_volume"] = volume
            volume_diff = 0
            
        if volume_diff > 0:
            if price > state["last_price"]:
                direction = 1
            elif price < state["last_price"]:
                direction = -1
            else:
                direction = state.get("last_direction", 1)
                
            # Convert volume diff to lot units based on commodity
            # NCDEX: volume is in Quintals, 5 Quintals = 1 lot
            # MCX Gold/Silver: volume is already in lots (1 unit = 1 lot)
            lot_divisor = 5.0  # Default for NCDEX commodities
            token_upper = token.upper()
            if token_upper.startswith("GOLD") or token_upper.startswith("SILVER"):
                lot_divisor = 1.0  # MCX reports volume in lots
            lot_diff = volume_diff / lot_divisor
            delta = direction * lot_diff
            state["running_cvd"] += round(delta, 2)
            state["last_direction"] = direction
            state["last_price"] = price
            state["last_volume"] = volume
            
        state["last_timestamp"] = timestamp
        
        return state["running_cvd"]

# Start background writer thread
_worker_thread = threading.Thread(target=_db_writer_worker, name="DBWriterWorker", daemon=True)
_worker_thread.start()

def save_tick(symbol: str, token: str, price: float, open_interest: int, volume: int, cvd: float = None):
    now = int(time.time())
    is_mcx = "GOLD" in symbol.upper() or "SILVER" in symbol.upper()
    if is_market_hours(now, is_mcx=is_mcx):
        if cvd is None:
            cvd = get_or_calculate_cvd(token, price, volume, now)
        db_write_queue.put((symbol, token, price, open_interest, volume, cvd, now))
    else:
        # Route after-hours ticks to the final EOD timestamp of the active session
        eod_ts = get_last_market_minute(now)
        if cvd is None:
            cvd = get_or_calculate_cvd(token, price, volume, eod_ts)
        db_write_queue.put((symbol, token, price, open_interest, volume, cvd, eod_ts))

def get_history(symbol: str, interval_minutes: int = 1, start_timestamp: int = None):
    conn = get_db_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    
    interval_seconds = interval_minutes * 60
    
    if start_timestamp is not None:
        query = f"""
            SELECT 
                (timestamp / {p}) * {p} AS interval_time,
                open,
                high,
                low,
                close,
                open_interest,
                volume,
                cvd
            FROM ticks
            WHERE symbol = {p} AND timestamp >= {p}
            ORDER BY timestamp ASC
        """
        cursor.execute(query, (interval_seconds, interval_seconds, symbol, start_timestamp))
    else:
        query = f"""
            SELECT 
                (timestamp / {p}) * {p} AS interval_time,
                open,
                high,
                low,
                close,
                open_interest,
                volume,
                cvd
            FROM ticks
            WHERE symbol = {p}
            ORDER BY timestamp ASC
        """
        cursor.execute(query, (interval_seconds, interval_seconds, symbol))

    rows = cursor.fetchall()
    
    cursor.close()
    conn.close()
    
    if not rows:
        return []
        
    is_mcx = "GOLD" in symbol.upper() or "SILVER" in symbol.upper()
    rows = [r for r in rows if is_market_hours(r["interval_time"], is_mcx=is_mcx)]

    if not rows:
        return []
        
    # Aggregate into OHLC candles and OI values
    candles = {}
    for row in rows:
        t = row["interval_time"]
        op = row["open"]
        hi = row["high"]
        lo = row["low"]
        cl = row["close"]
        oi = row["open_interest"]
        vol = row["volume"]
        cvd_val = row["cvd"] if row["cvd"] is not None else 0.0
        
        if t not in candles:
            candles[t] = {
                "time": t,
                "open": op,
                "high": hi,
                "low": lo,
                "close": cl,
                "oi": oi,
                "volume": vol,
                "cvd": cvd_val
            }
        else:
            candle = candles[t]
            candle["high"] = max(candle["high"], hi)
            candle["low"] = min(candle["low"], lo)
            candle["close"] = cl
            candle["oi"] = oi
            candle["volume"] = max(candle["volume"], vol)  # volume is cumulative
            candle["cvd"] = cvd_val  # take latest CVD value in the interval
            
    # Sort chronologically
    return sorted(candles.values(), key=lambda x: x["time"])

def prune_ticks(days_to_keep: int = 1825):
    """Deletes ticks older than the specified number of days to prevent database bloat."""
    conn = get_db_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    
    cutoff_timestamp = int(time.time()) - (days_to_keep * 24 * 3600)
    
    try:
        query = f"DELETE FROM ticks WHERE timestamp < {p}"
        cursor.execute(query, (cutoff_timestamp,))
        conn.commit()
        print(f"Database: Pruned ticks older than {days_to_keep} days (before epoch {cutoff_timestamp}).")
    except Exception as e:
        print(f"Database: Error pruning ticks: {e}")
    finally:
        cursor.close()
        conn.close()

