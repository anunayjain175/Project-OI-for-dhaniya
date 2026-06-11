import sqlite3
import os
import time
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
                volume INTEGER NOT NULL
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
                volume INTEGER NOT NULL
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON ticks (symbol, timestamp)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_ticks_token_time ON ticks (token, timestamp)")
        
    conn.commit()
    cursor.close()
    conn.close()
    print(f"Database initialized. Type: {'PostgreSQL' if is_postgres() else 'SQLite'}")

def is_market_hours(epoch: int) -> bool:
    """
    Returns True if the epoch timestamp (in IST) is within NCDEX market hours:
    Monday to Friday, 10:00 AM to 5:00 PM IST (inclusive of 17:00 minute, up to 17:00:59).
    """
    from datetime import datetime, timezone, timedelta, time
    IST = timezone(timedelta(hours=5, minutes=30))
    dt = datetime.fromtimestamp(epoch, tz=IST)
    
    # Monday = 0, Friday = 4, Saturday = 5, Sunday = 6
    if dt.weekday() > 4:
        return False
        
    t = dt.time()
    start_time = time(10, 0, 0)
    end_time = time(17, 1, 0) # Up to 17:00:59 IST
    
    return start_time <= t < end_time

def get_last_market_minute(epoch: int) -> int:
    """
    Returns the nearest epoch timestamp (truncated to minute) that is within market hours and <= epoch.
    """
    from datetime import datetime, timezone, timedelta
    IST = timezone(timedelta(hours=5, minutes=30))
    dt = datetime.fromtimestamp(epoch, tz=IST)
    
    # If weekend, rewind to Friday 5:00 PM IST
    if dt.weekday() == 5: # Saturday
        dt = (dt - timedelta(days=1)).replace(hour=17, minute=0, second=0, microsecond=0)
        return int(dt.timestamp())
    elif dt.weekday() == 6: # Sunday
        dt = (dt - timedelta(days=2)).replace(hour=17, minute=0, second=0, microsecond=0)
        return int(dt.timestamp())
        
    # If weekday, but before 10:00 AM:
    # if Monday: go to Friday 5:00 PM
    # else: go to yesterday 5:00 PM
    if dt.hour < 10:
        if dt.weekday() == 0: # Monday
            dt = (dt - timedelta(days=3)).replace(hour=17, minute=0, second=0, microsecond=0)
        else:
            dt = (dt - timedelta(days=1)).replace(hour=17, minute=0, second=0, microsecond=0)
        return int(dt.timestamp())
        
    # If weekday, but after 5:00 PM:
    # Set to 17:00 of today
    if dt.hour >= 17:
        if dt.hour > 17 or dt.minute > 0 or dt.second > 0:
            dt = dt.replace(hour=17, minute=0, second=0, microsecond=0)
            return int(dt.timestamp())
            
    return epoch - (epoch % 60)

def save_tick(symbol: str, token: str, price: float, open_interest: int, volume: int):
    now = int(time.time())
    if not is_market_hours(now):
        return
        
    conn = get_db_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    
    # 1. Fetch the last recorded tick overall for this token (to get baseline volume/price)
    query_prev = f"""
        SELECT open, high, low, close, open_interest, volume, timestamp FROM ticks
        WHERE token = {p}
        ORDER BY timestamp DESC LIMIT 1
    """
    cursor.execute(query_prev, (token,))
    prev_tick = cursor.fetchone()
    
    # 2. Check if we already have a tick for this token in the current minute
    current_minute = now - (now % 60)
    query_curr = f"""
        SELECT id, open, high, low, close, open_interest, volume FROM ticks 
        WHERE token = {p} AND timestamp >= {p} AND timestamp < {p}
        ORDER BY timestamp DESC LIMIT 1
    """
    cursor.execute(query_curr, (token, current_minute, current_minute + 60))
    curr_tick = cursor.fetchone()
    
    if curr_tick:
        # We are updating the current minute's tick
        if prev_tick and volume > prev_tick["volume"]:
            # This is a trade tick!
            if curr_tick["volume"] == prev_tick["volume"]:
                # This is the first trade of the minute! Overwrite the placeholder values.
                update_query = f"""
                    UPDATE ticks SET 
                        timestamp = {p},
                        open = {p},
                        high = {p},
                        low = {p},
                        close = {p},
                        open_interest = {p},
                        volume = {p}
                    WHERE id = {p}
                """
                cursor.execute(update_query, (now, price, price, price, price, open_interest, volume, curr_tick["id"]))
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
                        volume = {p}
                    WHERE id = {p}
                """
                cursor.execute(update_query, (now, new_high, new_low, price, open_interest, volume, curr_tick["id"]))
        else:
            # Standard heartbeat/no-trade update: just update close, OI, and volume
            update_query = f"""
                UPDATE ticks SET 
                    timestamp = {p},
                    close = {p},
                    open_interest = {p},
                    volume = {p}
                WHERE id = {p}
            """
            cursor.execute(update_query, (now, price, open_interest, volume, curr_tick["id"]))
    else:
        # We are inserting a new minute tick
        if prev_tick and volume <= prev_tick["volume"]:
            # Insert a placeholder candle at the previous close price (no trades occurred yet)
            prev_close = prev_tick["close"]
            insert_query = f"""
                INSERT INTO ticks (timestamp, symbol, token, open, high, low, close, open_interest, volume)
                VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p})
            """
            cursor.execute(insert_query, (now, symbol, token, prev_close, prev_close, prev_close, prev_close, open_interest, prev_tick["volume"]))
        else:
            # Insert a new trading candle
            insert_query = f"""
                INSERT INTO ticks (timestamp, symbol, token, open, high, low, close, open_interest, volume)
                VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p})
            """
            cursor.execute(insert_query, (now, symbol, token, price, price, price, price, open_interest, volume))
        
    conn.commit()
    cursor.close()
    conn.close()

def get_history(symbol: str, interval_minutes: int = 1, start_timestamp: int = None):
    conn = get_db_connection()
    cursor = get_cursor(conn)
    
    interval_seconds = interval_minutes * 60
    p = get_placeholder()
    
    if start_timestamp is not None:
        query = f"""
            SELECT 
                (timestamp / {p}) * {p} AS interval_time,
                open,
                high,
                low,
                close,
                open_interest,
                volume
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
                volume
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
        
    rows = [r for r in rows if is_market_hours(r["interval_time"])]
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
        
        if t not in candles:
            candles[t] = {
                "time": t,
                "open": op,
                "high": hi,
                "low": lo,
                "close": cl,
                "oi": oi,
                "volume": vol
            }
        else:
            candle = candles[t]
            candle["high"] = max(candle["high"], hi)
            candle["low"] = min(candle["low"], lo)
            candle["close"] = cl
            candle["oi"] = oi
            candle["volume"] = max(candle["volume"], vol)  # volume is cumulative
            
    # Sort chronologically
    return sorted(candles.values(), key=lambda x: x["time"])

def prune_ticks(days_to_keep: int = 35):
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

