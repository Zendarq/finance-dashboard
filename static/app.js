/* Stocks Dashboard frontend — Alpine.js component.
 * NOTE: this file must be loaded BEFORE the Alpine CDN script (see skill:
 * Alpine 3.14+ boots via queueMicrotask and misses late alpine:init listeners). */

const POLL_MS = 60000;
const SMA_PERIODS = [10, 50, 100, 200];
const SMA_COLORS = { 10: "#facc15", 50: "#fb923c", 100: "#a78bfa", 200: "#2dd4bf" };

if (window.Chart) {
  Chart.defaults.font.family = "'SF Mono', ui-monospace, Menlo, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = "#7d8ba1";
}

document.addEventListener("alpine:init", () => {
  Alpine.data("dashboard", () => ({
    /* ---------- state ---------- */
    quotes: [],
    lastTs: null,
    busy: false,
    selected: null,
    news: [],
    newsLoading: false,
    adding: "",
    pollTimer: null,
    sparkData: {},      // SYM -> {labels, close} (1y daily)
    sparkCharts: {},    // SYM -> Chart instance
    smaVals: {},        // SYM -> {10: v, 50: v, 100: v, 200: v}
    smaPeriods: SMA_PERIODS,
    smaColors: SMA_COLORS,

    /* ---------- lifecycle ---------- */
    init() {
      this.pollTimer = setInterval(() => {
        this.loadSnapshot(true);
        this.loadSparks();
      }, POLL_MS);
      this.$watch("selected", () => this.loadNews());
      this.loadSnapshot().then(() => this.loadSparks());
    },
    destroy() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      Object.values(this.sparkCharts).forEach((c) => c && c.destroy());
    },

    /* ---------- data loading ---------- */
    async loadSnapshot(silent = false) {
      if (this.busy && silent) return;
      if (!silent) this.busy = true;
      try {
        const d = await (await fetch("/api/snapshot")).json();
        this.quotes = d.quotes || [];
        this.lastTs = d.last_ts;
        if (this.selected && !this.quotes.some((q) => q.symbol === this.selected)) {
          this.selected = this.quotes.length ? this.quotes[0].symbol : null;
        } else if (!this.selected && this.quotes.length) {
          this.selected = this.quotes[0].symbol;
        }
        this.$nextTick(() => requestAnimationFrame(() => this.drawSparks()));
      } catch (e) {
        /* keep last good data */
      }
      this.busy = false;
    },

    select(sym) {
      if (sym !== this.selected) this.selected = sym;
    },

    async loadNews() {
      if (!this.selected) return;
      this.newsLoading = true;
      try {
        const d = await (await fetch(`/api/news?symbol=${this.selected}`)).json();
        this.news = Array.isArray(d) ? d : [];
      } catch (e) {
        this.news = [];
      }
      this.newsLoading = false;
    },

    async addSymbol() {
      const sym = this.adding.trim().toUpperCase();
      if (!sym || this.busy) return;
      this.busy = true;
      try {
        const r = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert(d.detail || "Couldn't add " + sym);
        } else {
          this.adding = "";
          await this.loadSnapshot();
          await this.loadSparks();
          this.select(sym);
        }
      } catch (e) {
        alert("Couldn't add " + sym);
      }
      this.busy = false;
    },

    async removeSymbol(sym) {
      if (this.busy) return;
      this.busy = true;
      try {
        await fetch("/api/watchlist/" + sym, { method: "DELETE" });
        if (this.sparkCharts[sym]) {
          this.sparkCharts[sym].destroy();
          delete this.sparkCharts[sym];
        }
        delete this.sparkData[sym];
        delete this.smaVals[sym];
        await this.loadSnapshot();
      } catch (e) {
        /* ignore */
      }
      this.busy = false;
    },

    /* ---------- sparkline + SMA ---------- */
    sma(arr, n) {
      const out = new Array(arr.length).fill(null);
      let sum = 0;
      for (let i = 0; i < arr.length; i++) {
        sum += arr[i];
        if (i >= n) sum -= arr[i - n];
        if (i >= n - 1) out[i] = sum / n;
      }
      return out;
    },

    async loadSparks() {
      if (!this.quotes.length) return;
      const syms = this.quotes.map((q) => q.symbol);
      const results = await Promise.allSettled(
        syms.map((s) => fetch(`/api/history?symbol=${s}&period=1y`).then((r) => r.json()))
      );
      results.forEach((r, i) => {
        const s = syms[i];
        if (r.status !== "fulfilled" || !r.value?.close || r.value.close.length < 200) return;
        this.sparkData[s] = r.value;
        const vals = {};
        for (const p of SMA_PERIODS) {
          const series = this.sma(r.value.close, p);
          vals[p] = series[series.length - 1];
        }
        this.smaVals[s] = vals;
      });
      this.$nextTick(() => requestAnimationFrame(() => this.drawSparks()));
    },

    smaVal(sym, p) {
      const v = this.smaVals[sym]?.[p];
      return v == null ? "—" : v.toFixed(1);
    },

    /* Points moved today (price − prev close), complements the % change. */
    chgPts(q) {
      if (!q || q.price == null || q.prev_close == null) return "—";
      const pts = q.price - q.prev_close;
      return (pts > 0 ? "+" : "") + pts.toFixed(2);
    },

    /* Momentum: return % over the trailing N trading days (from 1y daily closes).
     * Falls back to the earliest fetched point when N exceeds the window. */
    mom(n) {
      const d = this.sparkData[this.selected];
      if (!d || !d.close || d.close.length < 2) return null;
      const c = d.close;
      const base = c.length - 1 - n >= 0 ? c.length - 1 - n : 0;
      return c[c.length - 1] / c[base] - 1;
    },

    drawSparks() {
      for (const q of this.quotes) {
        const d = this.sparkData[q.symbol];
        const el = document.querySelector(`.card canvas[data-sym="${q.symbol}"]`);
        if (!el || !d || !d.close.length) continue;
        if (this.sparkCharts[q.symbol]) {
          this.sparkCharts[q.symbol].destroy();
          delete this.sparkCharts[q.symbol];
        }
        const N = 30; // trailing 30 trading days
        const datasets = [
          { label: q.symbol, data: d.close.slice(-N), borderColor: "#38bdf8", borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
        ];
        for (const p of SMA_PERIODS) {
          datasets.push({
            label: "SMA" + p,
            data: this.sma(d.close, p).slice(-N),
            borderColor: SMA_COLORS[p],
            borderWidth: 1,
            pointRadius: 0,
            tension: 0.2,
          });
        }
        this.sparkCharts[q.symbol] = new Chart(el, {
          type: "line",
          data: { labels: d.labels.slice(-N), datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
          },
        });
      }
    },

    /* ---------- formatters ---------- */
    fmtPrice(v) {
      if (v == null) return "—";
      return Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    fmtChg(v) {
      if (v == null) return "—";
      return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
    },
    chgClass(v) {
      if (v == null) return "flat";
      return v > 0.0001 ? "up" : v < -0.0001 ? "down" : "flat";
    },
    fmtNum(v) {
      if (v == null) return "—";
      const a = Math.abs(v);
      if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
      if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return String(Math.round(v));
    },
    fmtPct(x) {
      if (x == null) return "—";
      return (x * 100).toFixed(2) + "%";
    },
    fmtRange(lo, hi) {
      if (lo == null || hi == null) return "—";
      return this.fmtPrice(lo) + " – " + this.fmtPrice(hi);
    },

    fmtEarnings(ts) {
      if (!ts) return "—";
      return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    },
    fmtNewsDate(ts) {
      return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    },

    /* ---------- derived ---------- */
    selQuote() {
      return this.quotes.find((q) => q.symbol === this.selected) || null;
    },
    selName() {
      return this.selQuote()?.name || this.selected || "";
    },
    selPrice() {
      return this.selQuote()?.price ?? null;
    },
    marketState() {
      const sp = this.quotes.find((q) => q.symbol === "SPY");
      const q = sp || this.quotes.find((q) => q.market_state);
      return q?.market_state || "";
    },
    marketLabel() {
      const s = this.marketState();
      if (s === "REGULAR") return "Market open";
      if (s === "PRE" || s === "PREPRE") return "Pre-market";
      if (s === "POST" || s === "POSTPOST") return "After hours";
      return "Market closed";
    },
    marketClass() {
      const s = this.marketState();
      return s === "REGULAR" || s === "PRE" || s === "PREPRE" || s === "POST" || s === "POSTPOST" ? "open" : "closed";
    },
    get lastUpdated() {
      if (!this.lastTs) return "—";
      return new Date(this.lastTs * 1000).toLocaleTimeString("en-US", { hour12: false });
    },
  }));
});
