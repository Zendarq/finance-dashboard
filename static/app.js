/* Options Dashboard frontend — Alpine.js component.
 * NOTE: this file must be loaded BEFORE the Alpine CDN script (see skill:
 * Alpine 3.14+ boots via queueMicrotask and misses late alpine:init listeners). */

const POLL_MS = 60000;

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
    exps: [],
    exp: null,
    chain: null,
    chainLoading: false,
    history: null,
    histPeriod: "3mo",
    adding: "",
    pollTimer: null,
    charts: { trend: null, iv: null, oi: null },

    /* ---------- lifecycle ---------- */
    init() {
      this.loadSnapshot();
      this.pollTimer = setInterval(() => this.loadSnapshot(true), POLL_MS);
      this.$watch("selected", () => this.onSelect());
    },
    destroy() {
      if (this.pollTimer) clearInterval(this.pollTimer);
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
      } catch (e) {
        /* keep last good data */
      }
      this.busy = false;
    },

    select(sym) {
      if (sym !== this.selected) this.selected = sym;
    },

    async onSelect() {
      if (!this.selected) return;
      this.chain = null;
      this.exp = null;
      this.exps = [];
      this.loadHistory(this.histPeriod);
      try {
        const d = await (await fetch(`/api/expirations?symbol=${this.selected}`)).json();
        this.exps = d.dates || [];
        if (this.exps.length) this.pickExp(this.exps[0]);
      } catch (e) {
        this.exps = [];
      }
    },

    async loadHistory(period) {
      if (!this.selected) return;
      this.histPeriod = period;
      try {
        const d = await (await fetch(`/api/history?symbol=${this.selected}&period=${period}`)).json();
        this.history = d;
        this.$nextTick(() => requestAnimationFrame(() => this.drawTrend()));
      } catch (e) {
        /* ignore */
      }
    },

    pickExp(e) {
      this.exp = e;
      this.loadChain(false);
    },

    async loadChain(force = false) {
      if (!this.selected || !this.exp) return;
      this.chainLoading = true;
      try {
        const q = `symbol=${this.selected}&exp=${this.exp}${force ? "&force=true" : ""}`;
        const d = await (await fetch("/api/chain?" + q)).json();
        this.chain = d;
        this.$nextTick(() => requestAnimationFrame(() => this.drawCharts()));
      } catch (e) {
        this.chain = null;
      }
      this.chainLoading = false;
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
        await this.loadSnapshot();
      } catch (e) {
        /* ignore */
      }
      this.busy = false;
    },

    /* ---------- chain helpers ---------- */
    chainRows() {
      if (!this.chain) return [];
      const puts = new Map(this.chain.puts.map((p) => [p.strike, p]));
      return this.chain.calls.map((c) => ({ call: c, put: puts.get(c.strike) || null }));
    },

    cells(c, kind) {
      const g = c.greeks || {};
      const fmt = (v, d) => (v == null ? "—" : Number(v).toFixed(d));
      return [
        { k: "last", v: this.fmtPrice(c.last) },
        { k: "bid", v: this.fmtPrice(c.bid) },
        { k: "ask", v: this.fmtPrice(c.ask) },
        { k: "iv", v: c.iv == null ? "—" : c.iv.toFixed(1) + "%" },
        { k: "delta", v: fmt(g.delta, 2) },
        { k: "gamma", v: g.gamma == null ? "—" : (Math.abs(g.gamma) >= 1 ? g.gamma.toFixed(2) : g.gamma.toFixed(4)) },
        { k: "theta", v: fmt(g.theta, 3) },
        { k: "vega", v: fmt(g.vega, 2) },
        { k: "oi", v: this.fmtNum(c.oi) },
        { k: "vol", v: this.fmtNum(c.volume) },
      ];
    },

    cellCls(c, k) {
      const cls = ["num"];
      if ((k === "last" || k === "oi" || k === "vol") && c[k] == null) cls.push("muted");
      return cls.join(" ");
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
    fmtExp(e) {
      return new Date(e + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    },
    fmtStrike(v) {
      return v == null ? "—" : Number(v).toFixed(2);
    },
    dte(e) {
      return Math.max(0, Math.round((new Date(e + "T00:00:00") - Date.now()) / 86400000));
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

    /* ---------- charts ---------- */
    drawCharts() {
      this.drawIv();
      this.drawOi();
    },

    drawTrend() {
      const el = document.getElementById("trendChart");
      if (!el || !this.history) return;
      if (this.charts.trend) this.charts.trend.destroy();
      const h = this.history;
      this.charts.trend = new Chart(el, {
        type: "line",
        data: {
          labels: h.labels,
          datasets: [{
            label: this.selected,
            data: h.close,
            borderColor: "#38bdf8",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            fill: true,
            backgroundColor: (c) => {
              const { ctx, chartArea } = c.chart;
              if (!chartArea) return "rgba(56,189,248,0)";
              const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              g.addColorStop(0, "rgba(56,189,248,.22)");
              g.addColorStop(1, "rgba(56,189,248,0)");
              return g;
            },
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 8, color: "#64748b" }, grid: { color: "rgba(148,163,184,.08)" } },
            y: { position: "right", ticks: { color: "#64748b" }, grid: { color: "rgba(148,163,184,.08)" } },
          },
        },
      });
    },

    drawIv() {
      const el = document.getElementById("ivChart");
      if (!el || !this.chain) return;
      if (this.charts.iv) this.charts.iv.destroy();
      const strikes = this.chain.calls.map((c) => c.strike);
      const putIv = new Map(this.chain.puts.map((p) => [p.strike, p.iv]));
      this.charts.iv = new Chart(el, {
        type: "line",
        data: {
          labels: strikes,
          datasets: [
            { label: "calls", data: this.chain.calls.map((c) => c.iv), borderColor: "#38bdf8", backgroundColor: "#38bdf8", pointRadius: 2, borderWidth: 2, tension: 0.2 },
            { label: "puts", data: strikes.map((s) => putIv.get(s) ?? null), borderColor: "#fbbf24", backgroundColor: "#fbbf24", pointRadius: 2, borderWidth: 2, tension: 0.2 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { boxWidth: 10, boxHeight: 10 } },
            tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y?.toFixed(1)}%` } },
          },
          scales: {
            x: { title: { display: true, text: "strike" }, ticks: { color: "#64748b" }, grid: { color: "rgba(148,163,184,.08)" } },
            y: { title: { display: true, text: "IV" }, ticks: { color: "#64748b", callback: (v) => v + "%" }, grid: { color: "rgba(148,163,184,.08)" } },
          },
        },
      });
    },

    drawOi() {
      const el = document.getElementById("oiChart");
      if (!el || !this.chain) return;
      if (this.charts.oi) this.charts.oi.destroy();
      const strikes = this.chain.calls.map((c) => c.strike);
      const putOi = new Map(this.chain.puts.map((p) => [p.strike, p.oi ?? 0]));
      this.charts.oi = new Chart(el, {
        type: "bar",
        data: {
          labels: strikes,
          datasets: [
            { label: "calls OI", data: this.chain.calls.map((c) => c.oi ?? 0), backgroundColor: "rgba(56,189,248,.65)" },
            { label: "puts OI", data: strikes.map((s) => -(putOi.get(s) ?? 0)), backgroundColor: "rgba(251,191,36,.65)" },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { boxWidth: 10, boxHeight: 10 } },
            tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${Math.abs(c.parsed.y).toLocaleString()}` } },
          },
          scales: {
            x: { ticks: { color: "#64748b", maxRotation: 60, autoSkip: true, maxTicksLimit: 12 }, grid: { color: "rgba(148,163,184,.08)" } },
            y: { ticks: { color: "#64748b", callback: (v) => Math.abs(v).toLocaleString() }, grid: { color: "rgba(148,163,184,.08)" } },
          },
        },
      });
    },
  }));
});
