"""Options Dashboard — FastAPI app.

Free, ~15-min-delayed market data from Yahoo Finance. Underlying watchlist
with live quotes + full options chains with computed Black-Scholes greeks.
"""

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, scheduler, yahoo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


def _refresh_all():
    try:
        scheduler.refresh_quotes()
    except Exception as e:
        log.warning("manual refresh failed: %s", e)


app = FastAPI(title="Options Dashboard")


def _enrich_names():
    """Fill in real company names for rows that still show the bare ticker."""
    for w in db.get_watchlist():
        if not w.get("name") or w["name"] == w["symbol"]:
            try:
                db.set_watch_name(w["symbol"], yahoo.get_name(w["symbol"]))
            except Exception as e:
                log.debug("name enrich failed for %s: %s", w["symbol"], e)


@app.on_event("startup")
def _startup():
    db.init_db()
    db.seed_watchlist(config.DEFAULT_SYMBOLS)
    _enrich_names()
    app.state.scheduler = scheduler.start()


@app.on_event("shutdown")
def _shutdown():
    sched = getattr(app.state, "scheduler", None)
    if sched:
        sched.shutdown(wait=False)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------------------------------------------------------------- API


@app.get("/api/snapshot")
def snapshot():
    """Latest persisted quotes for the whole watchlist."""
    quotes = db.get_quotes()
    last_ts = max((q["ts"] for q in quotes), default=None)
    return {"quotes": quotes, "last_ts": last_ts, "refresh_min": config.REFRESH_MINUTES}


@app.post("/api/refresh")
def refresh():
    _refresh_all()
    return {"ok": True}


@app.get("/api/expirations")
def expirations(symbol: str):
    try:
        return {"symbol": symbol.upper(), "dates": yahoo.get_expirations(symbol.upper())}
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.get("/api/chain")
def chain(symbol: str, exp: str, force: bool = False):
    try:
        return yahoo.get_chain(symbol.upper(), exp, force)
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.get("/api/history")
def history(symbol: str, period: str = "3mo"):
    try:
        return yahoo.get_history(symbol.upper(), period)
    except RuntimeError as e:
        raise HTTPException(502, str(e))


class AddReq(BaseModel):
    symbol: str


@app.post("/api/watchlist")
def add_watch(req: AddReq):
    sym = req.symbol.strip().upper()
    if not sym:
        raise HTTPException(400, "Symbol required")
    # Validate the symbol resolves before adding it.
    try:
        quote = yahoo.get_quote(sym)
        db.add_watch(sym, yahoo.get_name(sym))
        db.upsert_quote(quote)
    except Exception as e:
        raise HTTPException(400, f"Couldn't add {sym}: {e}")
    return {"ok": True, "symbol": sym}


@app.delete("/api/watchlist/{symbol}")
def remove_watch(symbol: str):
    db.remove_watch(symbol.upper())
    return {"ok": True}
