"""SQLite storage: watchlist + latest quote snapshot per symbol.

Connection-per-call pattern (thread-safe), WAL mode.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "finance.db"


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db() -> None:
    with conn() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS watchlist (
                symbol   TEXT PRIMARY KEY,
                name     TEXT,
                pos      INTEGER,
                added_at TEXT DEFAULT (datetime('now'))
            )"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS quotes (
                symbol         TEXT PRIMARY KEY,
                ts             INTEGER,
                price          REAL,
                prev_close     REAL,
                change_pct     REAL,
                day_high       REAL,
                day_low        REAL,
                volume         INTEGER,
                market_state   TEXT,
                currency       TEXT,
                dividend_yield REAL,
                fifty_two_high REAL,
                fifty_two_low  REAL,
                earnings_ts    INTEGER,
                target_mean    REAL
            )"""
        )
        # Lightweight migration for databases created before these columns existed.
        wcols = {r[1] for r in c.execute("PRAGMA table_info(watchlist)")}
        if "pos" not in wcols:
            c.execute("ALTER TABLE watchlist ADD COLUMN pos INTEGER")
            c.execute("UPDATE watchlist SET pos = rowid")  # keep current insertion order
        cols = {r[1] for r in c.execute("PRAGMA table_info(quotes)")}
        if "fifty_two_high" not in cols:
            c.execute("ALTER TABLE quotes ADD COLUMN fifty_two_high REAL")
            c.execute("ALTER TABLE quotes ADD COLUMN fifty_two_low REAL")
        if "earnings_ts" not in cols:
            c.execute("ALTER TABLE quotes ADD COLUMN earnings_ts INTEGER")
            c.execute("ALTER TABLE quotes ADD COLUMN target_mean REAL")


def seed_watchlist(symbols: list[str]) -> None:
    with conn() as c:
        for s in symbols:
            sym = s.upper()
            c.execute(
                "INSERT OR IGNORE INTO watchlist (symbol, name) VALUES (?, ?)",
                (sym, sym),
            )
            c.execute(
                "UPDATE watchlist SET pos = (SELECT COALESCE(MAX(pos), 0) + 1 FROM watchlist) "
                "WHERE symbol = ? AND pos IS NULL",
                (sym,),
            )


def get_watchlist() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT symbol, name FROM watchlist ORDER BY COALESCE(pos, 999999), added_at"
        ).fetchall()
    return [dict(r) for r in rows]


def add_watch(symbol: str, name: str | None = None) -> None:
    with conn() as c:
        c.execute(
            "INSERT OR IGNORE INTO watchlist (symbol, name) VALUES (?, ?)",
            (symbol.upper(), name or symbol.upper()),
        )
        c.execute(
            "UPDATE watchlist SET pos = (SELECT COALESCE(MAX(pos), 0) + 1 FROM watchlist) "
            "WHERE symbol = ? AND pos IS NULL",
            (symbol.upper(),),
        )


def reorder_watch(symbols: list[str]) -> None:
    """Persist a custom card order (positions 0..N-1)."""
    with conn() as c:
        for i, sym in enumerate(symbols):
            c.execute("UPDATE watchlist SET pos = ? WHERE symbol = ?", (i, sym.upper()))


def set_watch_name(symbol: str, name: str) -> None:
    with conn() as c:
        c.execute("UPDATE watchlist SET name = ? WHERE symbol = ?", (name, symbol.upper()))


def remove_watch(symbol: str) -> None:
    with conn() as c:
        c.execute("DELETE FROM watchlist WHERE symbol = ?", (symbol.upper(),))
        c.execute("DELETE FROM quotes WHERE symbol = ?", (symbol.upper(),))


def upsert_quote(q: dict) -> None:
    with conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO quotes
              (symbol, ts, price, prev_close, change_pct, day_high, day_low,
               volume, market_state, currency, dividend_yield,
               fifty_two_high, fifty_two_low, earnings_ts, target_mean)
              VALUES (:symbol, :ts, :price, :prev_close, :change_pct, :day_high,
                      :day_low, :volume, :market_state, :currency, :dividend_yield,
                      :fifty_two_high, :fifty_two_low, :earnings_ts, :target_mean)""",
            q,
        )


def get_quotes() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            """SELECT q.*, w.name FROM quotes q
              JOIN watchlist w ON w.symbol = q.symbol
              ORDER BY COALESCE(w.pos, 999999), w.added_at"""
        ).fetchall()
    return [dict(r) for r in rows]
