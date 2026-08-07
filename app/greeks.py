"""Black-Scholes greeks (with continuous dividend yield q).

Yahoo's free options feed gives us underlying price, strike, time to expiry,
and implied volatility but no greeks — so we compute them ourselves.
Conventions: theta = $ per calendar day, vega = $ per 1 vol point (1%).
"""

import math


def _ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def greeks(S: float, K: float, T: float, sigma: float, r: float, q: float, kind: str):
    """Return dict with delta/gamma/theta/vega, or None if inputs invalid.

    S, K  : underlying price, strike (same currency unit)
    T     : time to expiry in years (> 0)
    sigma : implied volatility as decimal (0.25 = 25%)
    r, q  : risk-free rate, dividend yield as decimals
    kind  : 'call' | 'put'
    """
    if not all(x > 0 for x in (S, K, T, sigma)):
        return None
    if T < 1.0 / 365.0:  # expires today — greeks are meaningless
        return None

    sqrtT = math.sqrt(T)
    try:
        d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    except (ValueError, ZeroDivisionError):
        return None
    d2 = d1 - sigma * sqrtT
    nd1 = _npdf(d1)
    eq = math.exp(-q * T)
    er = math.exp(-r * T)

    if kind == "call":
        delta = eq * _ncdf(d1)
        theta = (
            -S * nd1 * sigma * eq / (2.0 * sqrtT)
            - r * K * er * _ncdf(d2)
            + q * S * eq * _ncdf(d1)
        ) / 365.0
    else:
        delta = eq * (_ncdf(d1) - 1.0)
        theta = (
            -S * nd1 * sigma * eq / (2.0 * sqrtT)
            + r * K * er * _ncdf(-d2)
            - q * S * eq * _ncdf(-d1)
        ) / 365.0

    gamma = eq * nd1 / (S * sigma * sqrtT)
    vega = S * eq * nd1 * sqrtT / 100.0

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta, 4),
        "vega": round(vega, 4),
    }
