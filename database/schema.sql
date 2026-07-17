-- =========================================================
-- COINDCX FUTURES AI TRADING DESK — POSTGRES SCHEMA
-- =========================================================

CREATE TABLE IF NOT EXISTS contracts (
    symbol            VARCHAR(20) PRIMARY KEY,
    base_asset        VARCHAR(10) NOT NULL,
    quote_asset       VARCHAR(10) NOT NULL,
    coin_family       VARCHAR(10) NOT NULL,   -- e.g. BTC, ETH, SOL (used for "one trade per family" rule)
    is_active         BOOLEAN DEFAULT TRUE,
    last_price        NUMERIC(20,8),
    updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Rolling OHLCV candles (per symbol / timeframe)
CREATE TABLE IF NOT EXISTS candles (
    id                BIGSERIAL PRIMARY KEY,
    symbol            VARCHAR(20) NOT NULL REFERENCES contracts(symbol),
    timeframe         VARCHAR(5)  NOT NULL,   -- 1m, 5m, 15m, 1h
    open_time         TIMESTAMPTZ NOT NULL,
    open              NUMERIC(20,8),
    high              NUMERIC(20,8),
    low               NUMERIC(20,8),
    close             NUMERIC(20,8),
    volume            NUMERIC(24,8),
    UNIQUE(symbol, timeframe, open_time)
);
CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_time ON candles(symbol, timeframe, open_time DESC);

CREATE TABLE IF NOT EXISTS funding_rates (
    id                BIGSERIAL PRIMARY KEY,
    symbol            VARCHAR(20) NOT NULL REFERENCES contracts(symbol),
    funding_rate      NUMERIC(12,8),
    next_funding_time TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS open_interest (
    id                BIGSERIAL PRIMARY KEY,
    symbol            VARCHAR(20) NOT NULL REFERENCES contracts(symbol),
    open_interest     NUMERIC(24,8),
    recorded_at       TIMESTAMPTZ DEFAULT now()
);

-- =========================================================
-- EMPLOYEE ANALYSIS SNAPSHOTS (one row per scan cycle per symbol)
-- =========================================================

CREATE TABLE IF NOT EXISTS trend_analysis (
    id                BIGSERIAL PRIMARY KEY,
    symbol            VARCHAR(20) NOT NULL,
    ema9              NUMERIC(20,8),
    ema21             NUMERIC(20,8),
    separation_pct    NUMERIC(10,4),
    slope             NUMERIC(10,4),
    structure         VARCHAR(20),     -- HH, HL, LH, LL
    direction         VARCHAR(10),     -- LONG, SHORT, NEUTRAL
    strength          VARCHAR(10),     -- WEAK, MODERATE, STRONG
    score             NUMERIC(5,2),
    reasoning         TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS liquidity_analysis (
    id                BIGSERIAL PRIMARY KEY,
    symbol            VARCHAR(20) NOT NULL,
    liquidity_type    VARCHAR(30),     -- SWEEP_HIGH, SWEEP_LOW, EQ_HIGHS, EQ_LOWS, NONE
    quality           VARCHAR(10),     -- LOW, MEDIUM, HIGH
    volume_spike      BOOLEAN,
    rejection_candle  BOOLEAN,
    score             NUMERIC(5,2),
    reasoning         TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_analysis (
    id                BIGSERIAL PRIMARY KEY,
    symbol            VARCHAR(20) NOT NULL,
    atr               NUMERIC(20,8),
    volatility_pct    NUMERIC(10,4),
    spread_pct        NUMERIC(10,4),
    distance_ema21_pct NUMERIC(10,4),
    overextended      BOOLEAN,
    suggested_sl      NUMERIC(20,8),
    suggested_size_pct NUMERIC(6,2),
    grade             CHAR(1),         -- A,B,C,D,F
    score             NUMERIC(5,2),
    reasoning         TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portfolio_rankings (
    id                BIGSERIAL PRIMARY KEY,
    scan_id           UUID NOT NULL,
    rank              INT,
    symbol            VARCHAR(20) NOT NULL,
    direction         VARCHAR(10),
    trend_score       NUMERIC(5,2),
    liquidity_score   NUMERIC(5,2),
    risk_score        NUMERIC(5,2),
    combined_score    NUMERIC(5,2),
    confidence        NUMERIC(5,2),
    expected_rr       NUMERIC(6,2),
    created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rankings_scan ON portfolio_rankings(scan_id);

-- =========================================================
-- CEO DECISIONS + TRADE LIFECYCLE
-- =========================================================

CREATE TABLE IF NOT EXISTS ceo_decisions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id           UUID NOT NULL,
    slot              VARCHAR(20) NOT NULL,   -- PRIMARY, ALT_1, ALT_2, WATCHLIST_4, WATCHLIST_5, WATCHLIST_6
    symbol            VARCHAR(20),
    direction         VARCHAR(10),
    state             VARCHAR(12) NOT NULL,   -- APPROVED, WAIT, REJECTED, NO_TRADE
    confidence        NUMERIC(5,2),
    grade             CHAR(1),
    entry             NUMERIC(20,8),
    stop_loss         NUMERIC(20,8),
    tp1               NUMERIC(20,8),
    tp2               NUMERIC(20,8),
    expected_rr       NUMERIC(6,2),
    reasoning         TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rejection_reports (
    id                BIGSERIAL PRIMARY KEY,
    scan_id           UUID NOT NULL,
    symbol            VARCHAR(20) NOT NULL,
    trend_score       NUMERIC(5,2),
    liquidity_score   NUMERIC(5,2),
    risk_score        NUMERIC(5,2),
    final_score       NUMERIC(5,2),
    rejected_reasons  TEXT[],
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_lifecycle (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ceo_decision_id   UUID REFERENCES ceo_decisions(id),
    symbol            VARCHAR(20) NOT NULL,
    direction         VARCHAR(10) NOT NULL,
    entry             NUMERIC(20,8) NOT NULL,
    stop_loss         NUMERIC(20,8),
    tp1               NUMERIC(20,8),
    tp2               NUMERIC(20,8),
    status            VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    -- OPEN, ACTIVE, TP1_HIT, TP2_HIT, STOP_LOSS, CANCELLED, EXPIRED
    profit_pct        NUMERIC(8,3) DEFAULT 0,
    opened_at         TIMESTAMPTZ DEFAULT now(),
    closed_at         TIMESTAMPTZ,
    duration_seconds  INT
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_status ON trade_lifecycle(status);

-- =========================================================
-- EMPLOYEE PERFORMANCE TRACKING
-- =========================================================

CREATE TABLE IF NOT EXISTS employee_performance (
    id                BIGSERIAL PRIMARY KEY,
    employee          VARCHAR(20) NOT NULL,   -- TREND, LIQUIDITY, RISK, PORTFOLIO, CEO
    period            DATE NOT NULL,          -- daily rollup date
    win_rate          NUMERIC(6,2),
    accuracy          NUMERIC(6,2),
    total_analyses    INT DEFAULT 0,
    avg_rr            NUMERIC(6,2),
    extra_metrics     JSONB,                  -- e.g. {"alt1_win_rate":.., "risk_reduction_pct":..}
    UNIQUE(employee, period)
);

-- =========================================================
-- ALERTS (Telegram + Push) — audit trail
-- =========================================================

CREATE TABLE IF NOT EXISTS alert_subscribers (
    id                BIGSERIAL PRIMARY KEY,
    channel           VARCHAR(10) NOT NULL,   -- TELEGRAM, PUSH
    chat_id           VARCHAR(64),            -- telegram chat id
    push_subscription JSONB,                  -- web-push subscription object
    is_active         BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_log (
    id                BIGSERIAL PRIMARY KEY,
    ceo_decision_id   UUID REFERENCES ceo_decisions(id),
    channel           VARCHAR(10) NOT NULL,   -- TELEGRAM, PUSH
    subscriber_id     BIGINT REFERENCES alert_subscribers(id),
    payload           JSONB,
    status            VARCHAR(10),            -- SENT, FAILED
    error             TEXT,
    sent_at           TIMESTAMPTZ DEFAULT now()
);
