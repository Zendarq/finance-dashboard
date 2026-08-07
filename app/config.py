"""Options Dashboard configuration."""

# Default underlyings seeded on first boot (all optionable, liquid names).
DEFAULT_SYMBOLS = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "META", "AMD", "AMZN"]

# How often the scheduler refreshes quotes for the whole watchlist.
REFRESH_MINUTES = 5

# Cache TTLs (seconds) for the Yahoo Finance data layer.
QUOTE_TTL_SECONDS = 60
EXP_TTL_SECONDS = 600
CHAIN_TTL_SECONDS = 90
HISTORY_TTL_SECONDS = 300

# Risk-free rate used by the Black-Scholes greeks calculator.
RISK_FREE_RATE = 0.0425

# Frontend auto-refresh cadence (mirrored in app.js; keep in sync).
FRONTEND_POLL_SECONDS = 60
