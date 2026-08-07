"""Yahoo Finance data layer (free, ~15 min delayed) via yfinance.

Every call goes through a small TTL cache so the dashboard stays snappy
and we don't hammer Yahoo. Quotes are stored in SQLite by the scheduler;
chains/expirations/history are cached in memory.
"""

import logging
import threading
import time
from datetime import datetime, timezone

import yfinance as yf

from . import config, greeks

log = logging.getLogger("yahoo")

_cache: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def _cached(key: str, ttl: float, fn):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (time.time(), val)
    return val


def _num(x):
    """numpy-safe float conversion; None for NaN/None."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if f != f else f  # NaN check


def _num0(x):
    v = _num(x)
    return v if v is not None else 0.0


def _info(symbol: str) -> dict:
    """Quote-summary info for a symbol, cached briefly (yfinance also caches internally)."""

    def fetch():
        return yf.Ticker(symbol).get_info() or {}

    return _cached(f"info:{symbol}", config.QUOTE_TTL_SECONDS, fetch)


def _name(symbol: str) -> str:
    def fetch():
        try:
            info = _info(symbol)
            return info.get("shortName") or info.get("longName") or symbol
        except Exception:
            return symbol

    return _cached(f"name:{symbol}", 86400, fetch)


def get_quote(symbol: str) -> dict:
    """Latest quote snapshot for one symbol (no cache — scheduler controls freshness)."""
    sym = symbol.upper()
    t = yf.Ticker(sym)

    try:
        info = t.get_info() or {}
        price = _num(info.get("regularMarketPrice"))
        prev = (
            _num(info.get("regularMarketPreviousClose"))
            or _num(info.get("previousClose"))
            or _num(info.get("chartPreviousClose"))
        )
        change_pct = ((price / prev) - 1.0) * 100.0 if price and prev else None
        return {
            "symbol": sym,
            "ts": int(_num(info.get("regularMarketTime")) or time.time()),
            "price": price,
            "prev_close": prev,
            "change_pct": change_pct,
            "day_high": _num(info.get("regularMarketDayHigh")),
            "day_low": _num(info.get("regularMarketDayLow")),
            "volume": _num(info.get("regularMarketVolume")),
            "market_state": info.get("marketState") or "",
            "currency": info.get("currency") or "USD",
            "dividend_yield": _num(info.get("trailingAnnualDividendYield")) or 0.0,
            "fifty_two_high": _num(info.get("fiftyTwoWeekHigh")),
            "fifty_two_low": _num(info.get("fiftyTwoWeekLow")),
        }
    except Exception as e:
        log.info("get_info failed for %s (%s), falling back to fast_info", sym, e)
        fi = t.fast_info
        price = _num(fi.last_price)
        prev = _num(getattr(fi, "previous_close", None)) or _num(
            getattr(fi, "regular_market_previous_close", None)
        )
        change_pct = ((price / prev) - 1.0) * 100.0 if price and prev else None
        return {
            "symbol": sym,
            "ts": int(time.time()),
            "price": price,
            "prev_close": prev,
            "change_pct": change_pct,
            "day_high": _num(getattr(fi, "day_high", None)),
            "day_low": _num(getattr(fi, "day_low", None)),
            "volume": _num(getattr(fi, "last_volume", None)),
            "market_state": "",
            "currency": getattr(fi, "currency", None) or "USD",
            "dividend_yield": 0.0,
            "fifty_two_high": None,
            "fifty_two_low": None,
        }


def get_name(symbol: str) -> str:
    return _name(symbol.upper())


def get_expirations(symbol: str) -> list[str]:
    def fetch():
        exps = list(yf.Ticker(symbol).options or [])
        if not exps:
            raise RuntimeError(f"No options found for {symbol}")
        return exps

    try:
        return _cached(f"exp:{symbol}", config.EXP_TTL_SECONDS, fetch)
    except Exception as e:
        raise RuntimeError(f"Couldn't load expirations for {symbol}: {e}") from e


def get_history(symbol: str, period: str = "3mo") -> dict:
    def fetch():
        df = yf.Ticker(symbol).history(period=period, interval="1d", auto_adjust=False)
        if df is None or df.empty:
            return {"labels": [], "close": [], "volume": []}
        return {
            "labels": [d.strftime("%m/%d") for d in df.index],
            "close": [_num(v) for v in df["Close"]],
            "volume": [_num(v) for v in df["Volume"]],
        }

    try:
        return _cached(f"hist:{symbol}:{period}", config.HISTORY_TTL_SECONDS, fetch)
    except Exception as e:
        raise RuntimeError(f"Couldn't load history for {symbol}: {e}") from e


def get_chain(symbol: str, exp: str, force: bool = False) -> dict:
    """Full options chain for one expiry, with computed greeks."""

    def fetch():
        t = yf.Ticker(symbol)
        chain = t.option_chain(exp)

        # Underlying context for greeks: spot price + dividend yield.
        info = t.get_info() or {}
        spot = _num(info.get("regularMarketPrice"))
        div_yield = _num(info.get("trailingAnnualDividendYield")) or 0.0

        # Time to expiry (years): 4pm ET on expiry date in UTC.
        exp_dt = datetime.fromisoformat(exp).replace(tzinfo=timezone.utc)
        close_dt = exp_dt.replace(hour=20, minute=0, second=0)
        t_years = max((close_dt - datetime.now(timezone.utc)).total_seconds() / 86400.0, 1.0 / 365.0) / 365.0

        def rows(df, kind):
            out = []
            for _, row in df.iterrows():
                sigma = _num(row.get("impliedVolatility"))
                strike = _num(row.get("strike"))
                g = (
                    greeks.greeks(spot, strike, t_years, sigma, config.RISK_FREE_RATE, div_yield, kind)
                    if sigma and spot and strike
                    else None
                )
                out.append(
                    {
                        "contract": row.get("contractSymbol"),
                        "strike": strike,
                        "last": _num(row.get("lastPrice")),
                        "bid": _num(row.get("bid")),
                        "ask": _num(row.get("ask")),
                        "chg": _num(row.get("change")),
                        "chg_pct": _num(row.get("percentChange")),
                        "volume": _num(row.get("volume")),
                        "oi": _num(row.get("openInterest")),
                        "iv": sigma * 100.0 if sigma else None,
                        "itm": bool(row.get("inTheMoney")),
                        "greeks": g,
                    }
                )
            return out

        return {
            "symbol": symbol.upper(),
            "expiration": exp,
            "dte": round(t_years * 365.0),
            "spot": spot,
            "div_yield": div_yield,
            "calls": rows(chain.calls, "call"),
            "puts": rows(chain.puts, "put"),
        }

    try:
        if force:
            return fetch()
        return _cached(f"chain:{symbol}:{exp}", config.CHAIN_TTL_SECONDS, fetch)
    except Exception as e:
        raise RuntimeError(f"Couldn't load chain for {symbol} {exp}: {e}") from e
