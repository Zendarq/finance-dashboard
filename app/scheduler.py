"""APScheduler: periodic quote refresh for the whole watchlist."""

import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler

from . import config, db, yahoo

log = logging.getLogger("scheduler")


def refresh_quotes() -> None:
    """Fetch a fresh quote for every watchlist symbol and persist it."""
    symbols = [w["symbol"] for w in db.get_watchlist()]
    if not symbols:
        return
    ok = 0
    for sym in symbols:
        try:
            db.upsert_quote(yahoo.get_quote(sym))
            ok += 1
        except Exception as e:
            log.warning("quote failed for %s: %s", sym, e)
    log.info("quote refresh done: %d/%d symbols", ok, len(symbols))


def start() -> BackgroundScheduler:
    sched = BackgroundScheduler()
    sched.add_job(
        refresh_quotes,
        "interval",
        minutes=config.REFRESH_MINUTES,
        max_instances=1,
        coalesce=True,
        id="quotes",
    )
    # One-shot boot fetch so the dashboard isn't empty on first load.
    sched.add_job(
        refresh_quotes,
        "date",
        run_date=datetime.now() + timedelta(seconds=1),
        id="boot-fetch",
    )
    sched.start()
    log.info("scheduler started (interval=%s min)", config.REFRESH_MINUTES)
    return sched
