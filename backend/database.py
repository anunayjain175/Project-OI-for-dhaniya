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
    
    if is_postgres():
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ticks (
                id SERIAL PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                symbol VARCHAR(100) NOT NULL,
                token VARCHAR(100) NOT NULL,
                price REAL NOT NULL,
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
                price REAL NOT NULL,
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

def save_tick(symbol: str, token: str, price: float, open_interest: int, volume: int):
    init_db()  # Ensure table exists
    conn = get_db_connection()
    cursor = get_cursor(conn)
    
    now = int(time.time())
    
    # Check if we already have a tick for this token in the current minute to avoid bloat
    current_minute = now - (now % 60)
    p = get_placeholder()
    
    query = f"""
        SELECT id, price, open_interest, volume FROM ticks 
        WHERE token = {p} AND timestamp >= {p} AND timestamp < {p}
        ORDER BY timestamp DESC LIMIT 1
    """
    cursor.execute(query, (token, current_minute, current_minute + 60))
    row = cursor.fetchone()
    
    if row:
        # Update existing tick for the current minute with latest values
        update_query = f"""
            UPDATE ticks SET 
                timestamp = {p},
                price = {p},
                open_interest = {p},
                volume = {p}
            WHERE id = {p}
        """
        cursor.execute(update_query, (now, price, open_interest, volume, row["id"]))
    else:
        # Insert new tick for this minute
        insert_query = f"""
            INSERT INTO ticks (timestamp, symbol, token, price, open_interest, volume)
            VALUES ({p}, {p}, {p}, {p}, {p}, {p})
        """
        cursor.execute(insert_query, (now, symbol, token, price, open_interest, volume))
        
    conn.commit()
    cursor.close()
    conn.close()

def get_history(symbol: str, interval_minutes: int = 1):
    init_db()
    conn = get_db_connection()
    cursor = get_cursor(conn)
    
    interval_seconds = interval_minutes * 60
    p = get_placeholder()
    
    query = f"""
        SELECT 
            (timestamp / {p}) * {p} AS interval_time,
            price,
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
        
    # Aggregate into OHLC candles and OI values
    candles = {}
    for row in rows:
        t = row["interval_time"]
        p_val = row["price"]
        oi = row["open_interest"]
        vol = row["volume"]
        
        if t not in candles:
            candles[t] = {
                "time": t,
                "open": p_val,
                "high": p_val,
                "low": p_val,
                "close": p_val,
                "oi": oi,
                "volume": vol
            }
        else:
            candle = candles[t]
            candle["high"] = max(candle["high"], p_val)
            candle["low"] = min(candle["low"], p_val)
            candle["close"] = p_val
            candle["oi"] = oi
            candle["volume"] = max(candle["volume"], vol)  # volume is cumulative
            
    # Sort chronologically
    return sorted(candles.values(), key=lambda x: x["time"])
