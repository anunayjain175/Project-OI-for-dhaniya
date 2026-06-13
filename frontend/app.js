// Setup client-side logging back to the server
const originalLog = console.log;
const originalError = console.error;
let isSendingLog = false;

async function sendClientLog(level, message) {
    if (isSendingLog) return;
    isSendingLog = true;
    try {
        await fetch("/api/client-log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ level, message })
        });
    } catch (e) {
        originalError.call(console, "Failed to send client log:", e);
    } finally {
        isSendingLog = false;
    }
}

console.log = function(...args) {
    originalLog.apply(console, args);
    sendClientLog('INFO', args.join(' '));
};
console.error = function(...args) {
    originalError.apply(console, args);
    sendClientLog('ERROR', args.join(' '));
};

window.addEventListener('error', function(event) {
    const msg = event.message || '';
    if (msg.includes('ResizeObserver loop') || msg.includes('Script error')) {
        return;
    }
    const errMsg = 'JS Error: ' + msg + '\nSource: ' + event.filename + ':' + event.lineno + ':' + event.colno;
    showErrorBanner(errMsg);
    sendClientLog('ERROR', errMsg);
});
window.addEventListener('unhandledrejection', function(event) {
    const errMsg = 'JS Promise Rejection: ' + event.reason + (event.reason && event.reason.stack ? '\nStack: ' + event.reason.stack : '');
    showErrorBanner(errMsg);
    sendClientLog('ERROR', errMsg);
});

function showErrorBanner(message) {
    if (document.getElementById('debug-error-banner')) return;
    const errorBanner = document.createElement('div');
    errorBanner.id = 'debug-error-banner';
    errorBanner.style.position = 'fixed';
    errorBanner.style.top = '0';
    errorBanner.style.left = '0';
    errorBanner.style.width = '100%';
    errorBanner.style.backgroundColor = '#ef4444';
    errorBanner.style.color = '#ffffff';
    errorBanner.style.padding = '12px';
    errorBanner.style.zIndex = '99999';
    errorBanner.style.fontFamily = 'monospace';
    errorBanner.style.fontSize = '12px';
    errorBanner.style.whiteSpace = 'pre-wrap';
    errorBanner.innerText = message;
    document.body.appendChild(errorBanner);
}

// Check if epoch seconds (UTC) represents NCDEX market hours in IST (10:00 AM to 5:00 PM on weekdays)
function isMarketHours(epochSeconds) {
    if (!epochSeconds) return false;
    // IST is UTC + 5.5 hours (19800 seconds)
    const date = new Date((epochSeconds + 19800) * 1000);
    const day = date.getUTCDay();
    if (day === 0 || day === 6) {
        return false;
    }
    const hours = date.getUTCHours();
    if (hours < 10 || hours >= 17) {
        return false;
    }
    return true;
}

// Check if two epoch seconds represent the same day in IST
function isSameDayIST(epochSeconds1, epochSeconds2) {
    if (!epochSeconds1 || !epochSeconds2) return false;
    const offsetSeconds = 19800; // 5.5 hours for IST
    const date1 = new Date((epochSeconds1 + offsetSeconds) * 1000);
    const date2 = new Date((epochSeconds2 + offsetSeconds) * 1000);
    return date1.getUTCDate() === date2.getUTCDate() &&
           date1.getUTCMonth() === date2.getUTCMonth() &&
           date1.getUTCFullYear() === date2.getUTCFullYear();
}

// ===== Technical Indicator Calculations =====
function calcSMA(data, period) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            result.push(null);
        } else {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                sum += data[j].close;
            }
            result.push({ time: data[i].time, value: sum / period });
        }
    }
    return result.filter(v => v !== null);
}

function calcEMA(data, period) {
    const result = [];
    const multiplier = 2 / (period + 1);
    let ema = null;
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            result.push(null);
        } else if (i === period - 1) {
            let sum = 0;
            for (let j = 0; j < period; j++) sum += data[j].close;
            ema = sum / period;
            result.push({ time: data[i].time, value: ema });
        } else {
            ema = (data[i].close - ema) * multiplier + ema;
            result.push({ time: data[i].time, value: ema });
        }
    }
    return result.filter(v => v !== null);
}

function calcRSI(data, period = 14) {
    const result = [];
    if (data.length === 0) return result;
    
    // Fill the warmup period with null values to preserve index alignment
    const limit = Math.min(data.length, period);
    for (let i = 0; i < limit; i++) {
        result.push({ time: data[i].time, value: null });
    }
    
    if (data.length < period + 1) return result;
    
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = data[i].close - data[i - 1].close;
        if (change > 0) gains += change;
        else losses -= change;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    let rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
    result.push({ time: data[period].time, value: rsi });
    
    for (let i = period + 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
        result.push({ time: data[i].time, value: rsi });
    }
    return result;
}

function calcATR(data, period = 14) {
    const result = [];
    if (data.length === 0) return result;
    
    if (data.length < 2) {
        for (let i = 0; i < data.length; i++) {
            result.push({ time: data[i].time, value: null });
        }
        return result;
    }
    
    const trValues = [];
    trValues.push({
        time: data[0].time,
        value: data[0].high - data[0].low
    });
    
    for (let i = 1; i < data.length; i++) {
        const tr = Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - data[i - 1].close),
            Math.abs(data[i].low - data[i - 1].close)
        );
        trValues.push({ time: data[i].time, value: tr });
    }
    
    const limit = Math.min(data.length, period);
    for (let i = 0; i < limit; i++) {
        result.push({ time: data[i].time, value: null });
    }
    
    if (trValues.length < period) return result;
    
    let atr = 0;
    for (let i = 0; i < period; i++) atr += trValues[i].value;
    atr /= period;
    result[period - 1] = { time: trValues[period - 1].time, value: atr };
    
    for (let i = period; i < trValues.length; i++) {
        atr = (atr * (period - 1) + trValues[i].value) / period;
        result.push({ time: trValues[i].time, value: atr });
    }
    return result;
}

// Global State
let socket = null;
let currentSymbol = "JEERA-FUT";
let config = {};

// Cached unified data for chart legend lookup
let currentHistoryData = [];
let isCrosshairActive = false;
let raw1mHistory = [];
let currentTimeframe = 5; // Default to 5-minute (5m) timeframe
let isSyncingSuspended = false;


// Charts Instances
let priceChart = null;
let oiChart = null;
let rsiChart = null;
let atrChart = null;

// Chart Series
let candlestickSeries = null;
let volumeSeries = null;
let oiSeries = null;
let rsiSeries = null;
let atrSeries = null;
let rsiOverboughtLine = null;
let rsiOversoldLine = null;
let rsiMiddleLine = null;

// MA line series on price chart
let maSeriesMap = {};
const MA_CONFIG = [
    { type: 'SMA', period: 5, color: '#4caf50', visible: false },
    { type: 'SMA', period: 10, color: '#8bc34a', visible: false },
    { type: 'SMA', period: 21, color: '#ffeb3b', visible: false },
    { type: 'SMA', period: 50, color: '#ff9800', visible: false },
    { type: 'SMA', period: 200, color: '#e91e63', visible: false },
    { type: 'EMA', period: 5, color: '#03a9f4', visible: false },
    { type: 'EMA', period: 9, color: '#00bcd4', visible: false },
    { type: 'EMA', period: 10, color: '#009688', visible: false },
    { type: 'EMA', period: 21, color: '#9c27b0', visible: false },
    { type: 'EMA', period: 50, color: '#673ab7', visible: false },
    { type: 'EMA', period: 200, color: '#f44336', visible: false },
];

// Cached baseline data for calculating net daily changes
let startingOI = null;
let yesterdayClose = 0.0;
let lastOITick = 0;
let lastPriceTick = 0.0;
let lastLiveVolume = null;
let lastLiveTime = null;

// State variables for active 1-minute candle aggregation
let activeMinuteTime = null;
let activeMinuteOpen = null;
let activeMinuteHigh = null;
let activeMinuteLow = null;
let activeMinuteClose = null;
let activeMinuteVolumeStart = null;
let activeMinuteVolume = 0;

// DOM Elements (declared globally, assigned after DOM loads)
let symbolSelect;
let modeBadge;
let connectionBadge;
let brokerBadge;
let settingsBtn;
let settingsModal;
let closeModalBtn;
let settingsForm;
let cancelSettingsBtn;
let modeSelect;
let liveSettingsFields;

// PIN Lock elements
let pinModal;
let pinHiddenInput;
let enteredPin = "";

// KPI Elements
let futuresPriceEl;
let futuresChangeEl;
let futuresOiEl;
let futuresOiChangePctEl;
let futuresOiChangeAbsEl;
let futuresOiDirEl;
let futuresVolumeEl;
let sentimentValueEl;
let sentimentDescEl;
let chartSymbolNameEl;

// Stats Table Elements
let statOpenEl;
let statHighEl;
let statLowEl;
let statPrevCloseEl;
let statTokenEl;

// Price Range Elements
let priceRangePinEl;
let priceRangeLowEl;
let priceRangeHighEl;

// Tab Controls
let tabButtons;
let tabContents;

// Initialize application
document.addEventListener("DOMContentLoaded", async () => {
    // Assign DOM Elements now that body has been parsed
    symbolSelect = document.getElementById("symbol-select");
    modeBadge = document.getElementById("mode-badge");
    connectionBadge = document.getElementById("connection-badge");
    brokerBadge = document.getElementById("broker-badge");
    settingsBtn = document.getElementById("settings-btn");
    settingsModal = document.getElementById("settings-modal");
    closeModalBtn = document.getElementById("close-modal-btn");
    settingsForm = document.getElementById("settings-form");
    cancelSettingsBtn = document.getElementById("cancel-settings-btn");
    modeSelect = document.getElementById("mode-select");
    liveSettingsFields = document.getElementById("live-settings-fields");
    pinModal = document.getElementById("pin-modal");
    pinHiddenInput = document.getElementById("pin-hidden-input");

    // KPI Elements
    futuresPriceEl = document.getElementById("futures-price");
    futuresChangeEl = document.getElementById("futures-change");
    futuresOiEl = document.getElementById("futures-oi");
    futuresOiChangePctEl = document.getElementById("futures-oi-change-pct");
    futuresOiChangeAbsEl = document.getElementById("futures-oi-change-absolute");
    futuresOiDirEl = document.getElementById("futures-oi-direction");
    futuresVolumeEl = document.getElementById("futures-volume");
    sentimentValueEl = document.getElementById("sentiment-value");
    sentimentDescEl = document.getElementById("sentiment-desc");
    chartSymbolNameEl = document.getElementById("chart-symbol-name");

    // Stats Table Elements
    statOpenEl = document.getElementById("stat-open");
    statHighEl = document.getElementById("stat-high");
    statLowEl = document.getElementById("stat-low");
    statPrevCloseEl = document.getElementById("stat-prev-close");
    statTokenEl = document.getElementById("stat-token");

    // Price Range Elements
    priceRangePinEl = document.getElementById("price-range-pin");
    priceRangeLowEl = document.getElementById("price-range-low");
    priceRangeHighEl = document.getElementById("price-range-high");

    // Tab Controls
    tabButtons = document.querySelectorAll(".tab-btn");
    tabContents = document.querySelectorAll(".tab-content");

    // 1. Fetch config settings
    console.log("App startup: fetching config...");
    await fetchConfig();
    if (chartSymbolNameEl && currentSymbol) {
        chartSymbolNameEl.innerText = `${currentSymbol} LIVE CHART`;
    }
    
    // 2. Initialize Lightweight Price Chart, OI Chart & Indicator Charts
    console.log("App startup: initializing Lightweight charts...");
    initPriceChart();
    initOIChart();
    initRSIChart();
    initATRChart();
    setupChartSynchronization();
    
    // 3. Setup Events
    console.log("App startup: setting up event listeners...");
    setupEventListeners();
    
    // 4. Fetch initial OI chart history & commodity curve statistics
    console.log(`App startup: loading history for ${currentSymbol}...`);
    await loadOIHistory(currentSymbol);
    await loadCommodityCurveHistory(currentSymbol);
    
    // 5. Connect WebSocket
    console.log("App startup: connecting websocket...");
    connectWebSocket();
    
    // 6. Regular stats check (backup polling every 2s)
    console.log("App startup: starting backup stats polling...");
    setInterval(fetchStatsData, 2000);

    // Diagnostic size checking after layout settling
    setTimeout(() => {
        const priceContainer = document.getElementById("price-chart");
        const oiContainer = document.getElementById("oi-chart");
        const priceCanvas = priceContainer ? priceContainer.querySelector("canvas") : null;
        const oiCanvas = oiContainer ? oiContainer.querySelector("canvas") : null;
        console.log(`DOM check: price-container=${priceContainer ? priceContainer.clientWidth : 0}x${priceContainer ? priceContainer.clientHeight : 0}, price-canvas=${priceCanvas ? `${priceCanvas.width}x${priceCanvas.height}` : "none"}`);
        console.log(`DOM check: oi-container=${oiContainer ? oiContainer.clientWidth : 0}x${oiContainer ? oiContainer.clientHeight : 0}, oi-canvas=${oiCanvas ? `${oiCanvas.width}x${oiCanvas.height}` : "none"}`);
    }, 2000);
});

// Event Listeners
function setupEventListeners() {
    // Symbol Select Trigger
    symbolSelect.addEventListener("change", async (e) => {
        currentSymbol = e.target.value;
        if (!currentSymbol) return;
        chartSymbolNameEl.innerText = `${currentSymbol} LIVE CHART`;

        // Reset trade activity baselines
        lastLiveVolume = null;
        lastLiveTime = null;

        // Reset active 1-minute candle tracking state
        activeMinuteTime = null;
        activeMinuteOpen = null;
        activeMinuteHigh = null;
        activeMinuteLow = null;
        activeMinuteClose = null;
        activeMinuteVolumeStart = null;
        activeMinuteVolume = 0;

        // Notify backend of symbol change
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                action: "change_symbol",
                symbol: currentSymbol
            }));
        }

        isSyncingSuspended = true;
        // Clear existing chart data instead of destroying/recreating chart widgets to avoid DOM settle race conditions
        if (candlestickSeries) candlestickSeries.setData([]);
        if (volumeSeries) volumeSeries.setData([]);
        if (oiSeries) oiSeries.setData([]);
        // Clear indicator series
        Object.values(maSeriesMap).forEach(ma => ma.series.setData([]));
        if (rsiSeries) rsiSeries.setData([]);
        if (rsiOverboughtLine) rsiOverboughtLine.setData([]);
        if (rsiOversoldLine) rsiOversoldLine.setData([]);
        if (rsiMiddleLine) rsiMiddleLine.setData([]);
        if (atrSeries) atrSeries.setData([]);
        
        await loadOIHistory(currentSymbol);
        await loadCommodityCurveHistory(currentSymbol);
        await fetchStatsData();
    });

    // Tab switcher
    tabButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            tabButtons.forEach(b => b.classList.remove("active"));
            tabContents.forEach(c => c.classList.remove("active"));
            
            btn.classList.add("active");
            const tabId = btn.getAttribute("data-tab");
            document.getElementById(tabId).classList.add("active");
        });
    });

    // Helper to open settings modal
    function openSettingsModalDirectly() {
        document.getElementById("angel_client_id").value = config.angel_client_id || "";
        document.getElementById("angel_password").value = config.angel_password || "";
        document.getElementById("angel_totp_secret").value = config.angel_totp_secret || "";
        document.getElementById("angel_api_key").value = config.angel_api_key || "";
        document.getElementById("active_symbol").value = config.active_symbol || "";
        document.getElementById("active_token").value = config.active_token || "";
        document.getElementById("active_segment").value = config.active_segment || "7";
        document.getElementById("settings_pin").value = config.settings_pin || "";
        modeSelect.value = config.mode || "mock";
        
        const activeSymInfo = (config.futures_symbols && config.futures_symbols[currentSymbol]) || {};
        document.getElementById("open_oi").value = activeSymInfo.open_oi || "";
        
        toggleLiveFields(modeSelect.value);
        settingsModal.style.display = "block";
    }

    // Settings Modal (with PIN security check)
    settingsBtn.addEventListener("click", () => {
        if (config.settings_pin && config.settings_pin.trim() !== "") {
            enteredPin = "";
            pinHiddenInput.value = "";
            initPinDots();
            pinModal.style.display = "block";
            setTimeout(() => pinHiddenInput.focus(), 50);
        } else {
            openSettingsModalDirectly();
        }
    });

    function initPinDots() {
        const dotsContainer = document.getElementById("pin-dots-container");
        if (!dotsContainer) return;
        dotsContainer.innerHTML = "";
        const len = config.settings_pin ? config.settings_pin.length : 4;
        for (let i = 0; i < len; i++) {
            const dot = document.createElement("div");
            dot.className = "pin-dot";
            dotsContainer.appendChild(dot);
        }
    }

    function updatePinDots() {
        const dotsContainer = document.getElementById("pin-dots-container");
        if (!dotsContainer) return;
        const dots = dotsContainer.querySelectorAll(".pin-dot");
        dots.forEach((dot, idx) => {
            if (idx < enteredPin.length) {
                dot.classList.add("filled");
            } else {
                dot.classList.remove("filled");
            }
        });
    }

    function checkPin() {
        const targetPin = config.settings_pin || "";
        if (enteredPin === targetPin) {
            pinModal.style.display = "none";
            openSettingsModalDirectly();
            enteredPin = "";
            pinHiddenInput.value = "";
            updatePinDots();
        } else if (enteredPin.length >= targetPin.length) {
            const content = document.querySelector(".pin-modal-content");
            content.classList.add("error-shake");
            
            const dotsContainer = document.getElementById("pin-dots-container");
            const dots = dotsContainer ? dotsContainer.querySelectorAll(".pin-dot") : [];
            dots.forEach(dot => dot.classList.add("error"));
            
            setTimeout(() => {
                content.classList.remove("error-shake");
                dots.forEach(dot => dot.classList.remove("error"));
                enteredPin = "";
                pinHiddenInput.value = "";
                updatePinDots();
            }, 600);
        }
    }

    // Keypad triggers
    document.querySelectorAll(".pin-key").forEach(key => {
        key.addEventListener("click", (e) => {
            e.stopPropagation();
            const val = key.getAttribute("data-val");
            const targetLen = config.settings_pin ? config.settings_pin.length : 4;
            if (val !== null) {
                if (enteredPin.length < targetLen) {
                    enteredPin += val;
                    pinHiddenInput.value = enteredPin;
                    updatePinDots();
                    checkPin();
                }
            }
            pinHiddenInput.focus();
        });
    });

    const btnClear = document.getElementById("pin-btn-clear");
    if (btnClear) {
        btnClear.addEventListener("click", (e) => {
            e.stopPropagation();
            enteredPin = "";
            pinHiddenInput.value = "";
            updatePinDots();
            pinHiddenInput.focus();
        });
    }

    const btnBackspace = document.getElementById("pin-btn-backspace");
    if (btnBackspace) {
        btnBackspace.addEventListener("click", (e) => {
            e.stopPropagation();
            enteredPin = enteredPin.slice(0, -1);
            pinHiddenInput.value = enteredPin;
            updatePinDots();
            pinHiddenInput.focus();
        });
    }

    pinHiddenInput.addEventListener("input", (e) => {
        enteredPin = e.target.value;
        updatePinDots();
        checkPin();
    });

    pinModal.addEventListener("click", (e) => {
        if (e.target === pinModal) {
            pinModal.style.display = "none";
            enteredPin = "";
            pinHiddenInput.value = "";
            updatePinDots();
        } else {
            pinHiddenInput.focus();
        }
    });

    const pinCancelBtn = document.getElementById("pin-cancel-btn");
    if (pinCancelBtn) {
        pinCancelBtn.addEventListener("click", () => {
            pinModal.style.display = "none";
            enteredPin = "";
            pinHiddenInput.value = "";
            updatePinDots();
        });
    }

    closeModalBtn.addEventListener("click", () => {
        settingsModal.style.display = "none";
    });

    cancelSettingsBtn.addEventListener("click", () => {
        settingsModal.style.display = "none";
    });

    window.addEventListener("click", (e) => {
        if (e.target === settingsModal) {
            settingsModal.style.display = "none";
        }
    });

    modeSelect.addEventListener("change", (e) => {
        toggleLiveFields(e.target.value);
    });

    settingsForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const formData = new FormData(settingsForm);
        const newSettings = {};
        formData.forEach((val, key) => {
            newSettings[key] = val;
        });
        
        try {
            const res = await fetch("/api/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(newSettings)
            });
            const data = await res.json();
            if (data.status === "success") {
                alert("Settings saved successfully! Connector will restart.");
                settingsModal.style.display = "none";
                await fetchConfig();
                initPriceChart();
                initOIChart();
                initRSIChart();
                initATRChart();
                setupChartSynchronization();
                await loadOIHistory(currentSymbol);
                await loadCommodityCurveHistory(currentSymbol);
            } else {
                alert("Error saving settings: " + data.message);
            }
        } catch (err) {
            alert("Connection error: " + err);
        }
    });

    // EOD Data Apply Button
    const applyEodBtn = document.getElementById("apply-eod-btn");
    const eodStatus  = document.getElementById("eod-status");
    if (applyEodBtn) {
        applyEodBtn.addEventListener("click", async () => {
            const open      = parseFloat(document.getElementById("eod_open").value)      || 0;
            const high      = parseFloat(document.getElementById("eod_high").value)      || 0;
            const low       = parseFloat(document.getElementById("eod_low").value)       || 0;
            const close     = parseFloat(document.getElementById("eod_close").value)     || 0;
            const volume    = parseInt(document.getElementById("eod_volume").value)      || 0;
            const oi        = parseInt(document.getElementById("eod_oi").value)          || 0;
            const prevClose = parseFloat(document.getElementById("eod_prev_close").value)|| 0;

            if (!close) {
                eodStatus.style.color = "#ef4444";
                eodStatus.innerText = "⚠ Please enter at least the Closing Price.";
                eodStatus.style.display = "block";
                return;
            }

            try {
                applyEodBtn.disabled = true;
                applyEodBtn.innerText = "Applying...";
                const res = await fetch("/api/set-closing-data", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        open: open || close, high: high || close,
                        low: low || close, close,
                        volume, oi,
                        yesterday_close: prevClose || close
                    })
                });
                const data = await res.json();
                if (data.status === "success") {
                    eodStatus.style.color = "#00e676";
                    eodStatus.innerText = `✓ EOD data applied for ${data.data.symbol} — Close: ₹${data.data.price}`;
                    eodStatus.style.display = "block";
                    // Refresh dashboard immediately
                    await fetchStatsData();
                    await loadOIHistory(currentSymbol);
                    await loadCommodityCurveHistory(currentSymbol);
                } else {
                    eodStatus.style.color = "#ef4444";
                    eodStatus.innerText = "Error: " + JSON.stringify(data);
                    eodStatus.style.display = "block";
                }
            } catch (err) {
                eodStatus.style.color = "#ef4444";
                eodStatus.innerText = "Request failed: " + err;
                eodStatus.style.display = "block";
            } finally {
                applyEodBtn.disabled = false;
                applyEodBtn.innerHTML = '<i class="fa-solid fa-database"></i> Apply EOD Data';
            }
        });
    }

    // Timeframe Selector Click Handlers
    const timeframeBtns = document.querySelectorAll(".timeframe-btn");
    timeframeBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            timeframeBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            const mins = parseInt(btn.getAttribute("data-minutes"));
            
            isSyncingSuspended = true;
            
            // Re-aggregate and render history with the selected timeframe
            applyTimeframe(mins);
            
            // Force timescale refresh so it rescales correctly
            priceChart.timeScale().fitContent();
            
            // Sync the visible logical range after a tiny delay to allow the layout to calculate
            setTimeout(() => {
                if (priceChart) {
                    const range = priceChart.timeScale().getVisibleLogicalRange();
                    if (range) {
                        if (oiChart) oiChart.timeScale().setVisibleLogicalRange(range);
                        if (rsiChart) rsiChart.timeScale().setVisibleLogicalRange(range);
                        if (atrChart) atrChart.timeScale().setVisibleLogicalRange(range);
                    }
                }
                setTimeout(() => {
                    isSyncingSuspended = false;
                }, 150);
            }, 100);
        });
    });

    // Indicator dropdown toggle
    const indicatorToggleBtn = document.getElementById('indicator-toggle-btn');
    const indicatorDropdownMenu = document.getElementById('indicator-dropdown-menu');
    if (indicatorToggleBtn && indicatorDropdownMenu) {
        indicatorToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            indicatorDropdownMenu.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            if (!indicatorDropdownMenu.contains(e.target) && e.target !== indicatorToggleBtn) {
                indicatorDropdownMenu.classList.remove('open');
            }
        });
    }

    // Populate MA checkboxes grouped by SMA and EMA
    const maCheckboxContainer = document.getElementById('ma-checkboxes');
    if (maCheckboxContainer) {
        const smaGroup = MA_CONFIG.filter(ma => ma.type === 'SMA');
        const emaGroup = MA_CONFIG.filter(ma => ma.type === 'EMA');

        function createMACheckbox(ma, container) {
            const key = `${ma.type}_${ma.period}`;
            const label = document.createElement('label');
            label.className = 'indicator-checkbox';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = ma.visible;
            checkbox.id = `toggle-ma-${key}`;
            const dot = document.createElement('span');
            dot.className = 'indicator-color-dot';
            dot.style.backgroundColor = ma.color;
            if (ma.type === 'EMA') {
                dot.style.borderBottom = '2px dashed ' + ma.color;
                dot.style.backgroundColor = 'transparent';
                dot.style.height = '0';
            }
            label.appendChild(checkbox);
            label.appendChild(dot);
            label.appendChild(document.createTextNode(` ${ma.period}`));
            container.appendChild(label);

            checkbox.addEventListener('change', () => {
                const maEntry = maSeriesMap[key];
                if (maEntry) {
                    maEntry.visible = checkbox.checked;
                    maEntry.series.applyOptions({ visible: checkbox.checked });
                }
            });
        }

        // SMA sub-header
        const smaHeader = document.createElement('div');
        smaHeader.className = 'indicator-sub-title';
        smaHeader.textContent = 'SMA (Simple)';
        maCheckboxContainer.appendChild(smaHeader);
        smaGroup.forEach(ma => createMACheckbox(ma, maCheckboxContainer));

        // EMA sub-header
        const emaHeader = document.createElement('div');
        emaHeader.className = 'indicator-sub-title';
        emaHeader.textContent = 'EMA (Exponential)';
        maCheckboxContainer.appendChild(emaHeader);
        emaGroup.forEach(ma => createMACheckbox(ma, maCheckboxContainer));
    }

    // RSI toggle
    const toggleRsi = document.getElementById('toggle-rsi');
    if (toggleRsi) {
        toggleRsi.addEventListener('change', () => {
            const rsiContainer = document.getElementById('rsi-chart');
            if (rsiContainer) {
                rsiContainer.style.display = toggleRsi.checked ? '' : 'none';
                if (toggleRsi.checked && priceChart && rsiChart) {
                    setTimeout(() => {
                        try {
                            const rect = rsiContainer.getBoundingClientRect();
                            rsiChart.resize(rect.width, rect.height);
                            const range = priceChart.timeScale().getVisibleLogicalRange();
                            if (range) {
                                rsiChart.timeScale().setVisibleLogicalRange(range);
                            }
                        } catch (e) {
                            console.error("Error resizing/syncing RSI:", e);
                        }
                    }, 50);
                }
            }
        });
    }

    // ATR toggle
    const toggleAtr = document.getElementById('toggle-atr');
    if (toggleAtr) {
        toggleAtr.addEventListener('change', () => {
            const atrContainer = document.getElementById('atr-chart');
            if (atrContainer) {
                atrContainer.style.display = toggleAtr.checked ? '' : 'none';
                if (toggleAtr.checked && priceChart && atrChart) {
                    setTimeout(() => {
                        try {
                            const rect = atrContainer.getBoundingClientRect();
                            atrChart.resize(rect.width, rect.height);
                            const range = priceChart.timeScale().getVisibleLogicalRange();
                            if (range) {
                                atrChart.timeScale().setVisibleLogicalRange(range);
                            }
                        } catch (e) {
                            console.error("Error resizing/syncing ATR:", e);
                        }
                    }, 50);
                }
            }
        });
    }
}


function toggleLiveFields(mode) {
    if (mode === "live") {
        liveSettingsFields.style.display = "block";
    } else {
        liveSettingsFields.style.display = "none";
    }
}

// Fetch Configuration and populate contracts dropdown
async function fetchConfig() {
    try {
        const res = await fetch("/api/config");
        config = await res.json();
        currentSymbol = config.active_symbol || "";

        // Update broker status
        updateBrokerBadge(config.broker_connected);

        // Update mode badge
        if (config.mode === "live") {
            modeBadge.className = "badge badge-live";
            modeBadge.innerHTML = '<i class="fa-solid fa-tower-broadcast"></i> LIVE MODE';
        } else {
            modeBadge.className = "badge badge-mock";
            modeBadge.innerHTML = '<i class="fa-solid fa-cube"></i> MOCK MODE';
        }

        // Populate contract dropdown from API
        await populateContractsDropdown();

    } catch (err) {
        console.error("Error fetching config:", err);
    }
}

// Populate the Active Contract dropdown with all NCDEX contracts grouped by commodity
async function populateContractsDropdown() {
    try {
        const res = await fetch("/api/ncdex-contracts");
        const data = await res.json();
        const groups = data.groups || {};
        const active = currentSymbol || data.active_symbol || "";

        // Sort commodity group names alphabetically
        const sortedCommodities = Object.keys(groups).sort();

        // Clear existing options
        symbolSelect.innerHTML = "";

        for (const commodity of sortedCommodities) {
            const optgroup = document.createElement("optgroup");
            optgroup.label = commodity;

            for (const contract of groups[commodity]) {
                const opt = document.createElement("option");
                opt.value = contract.label;
                opt.textContent = contract.label;
                if (contract.label === active) opt.selected = true;
                optgroup.appendChild(opt);
            }
            symbolSelect.appendChild(optgroup);
        }

        // If active symbol is set but not selected, pick first option
        if (!symbolSelect.value && symbolSelect.options.length > 0) {
            symbolSelect.selectedIndex = 0;
            currentSymbol = symbolSelect.value;
        }

    } catch (err) {
        console.error("Error loading NCDEX contracts:", err);
    }
}

// Initialize native Price Chart using Lightweight Charts
function initPriceChart() {
    if (priceChart) {
        try {
            priceChart.remove();
        } catch (e) {
            console.error("Error removing priceChart:", e);
        }
        priceChart = null;
    }
    const priceContainer = document.getElementById("price-chart");
    priceContainer.innerHTML = "";
    
    const chartOptions = {
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: '#d1d5db',
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            timeVisible: true,
            secondsVisible: false,
            fixRightEdge: false,
            fixLeftEdge: false,
            tickMarkFormatter: (time, tickMarkType, locale) => {
                const date = new Date(time * 1000);
                if (tickMarkType < 3) {
                    const day = String(date.getUTCDate()).padStart(2, '0');
                    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                    return `${day}/${month}`;
                } else {
                    const hours = String(date.getUTCHours()).padStart(2, '0');
                    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                    return `${hours}:${minutes}`;
                }
            }
        },
        localization: {
            timeFormatter: (time) => {
                const date = new Date(time * 1000);
                const hours = String(date.getUTCHours()).padStart(2, '0');
                const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                const day = String(date.getUTCDate()).padStart(2, '0');
                const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                return `${day}/${month} ${hours}:${minutes}`;
            }
        }
    };

    priceChart = LightweightCharts.createChart(priceContainer, {
        ...chartOptions,
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            scaleMargins: { top: 0.15, bottom: 0.25 },
            minimumWidth: 90,
        }
    });

    candlestickSeries = priceChart.addCandlestickSeries({
        upColor: '#00e676',
        downColor: '#ff1744',
        borderDownColor: '#ff1744',
        borderUpColor: '#00e676',
        wickDownColor: '#ff1744',
        wickUpColor: '#00e676',
    });

    volumeSeries = priceChart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: {
            type: 'volume',
        },
        priceScaleId: '',
    });
    
    volumeSeries.priceScale().applyOptions({
        scaleMargins: {
            top: 0.65,
            bottom: 0,
        },
    });

    // Initialize MA line series on price chart
    maSeriesMap = {};
    MA_CONFIG.forEach(ma => {
        const key = `${ma.type}_${ma.period}`;
        const series = priceChart.addLineSeries({
            color: ma.color,
            lineWidth: 1,
            lineStyle: ma.type === 'EMA' ? 2 : 0,
            title: '',
            visible: ma.visible,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });
        maSeriesMap[key] = { series, visible: ma.visible, config: ma };
    });

    // Resize Observer
    const resizeObserver = new ResizeObserver(entries => {
        if (priceChart) {
            priceChart.resize(priceContainer.getBoundingClientRect().width, priceContainer.getBoundingClientRect().height);
        }
    });
    resizeObserver.observe(priceContainer);
}

// Global synchronization handlers to prevent memory leaks and duplicate subscriptions
let priceLogicalRangeChangeHandler = null;
let oiLogicalRangeChangeHandler = null;
let priceCrosshairMoveHandler = null;
let oiCrosshairMoveHandler = null;
let rsiLogicalRangeChangeHandler = null;
let atrLogicalRangeChangeHandler = null;
let rsiCrosshairMoveHandler = null;
let atrCrosshairMoveHandler = null;

function setupChartSynchronization() {
    if (!priceChart || !oiChart) {
        console.warn("setupChartSynchronization: priceChart or oiChart not initialized yet. Skipping sync setup.");
        return;
    }

    // Helper to check chart container visibility to prevent syncing issues with hidden/0-size charts
    function isChartVisible(chart) {
        if (chart === priceChart) return true;
        if (chart === oiChart) return true;
        if (chart === rsiChart) {
            const toggleRsi = document.getElementById('toggle-rsi');
            return toggleRsi ? toggleRsi.checked : false;
        }
        if (chart === atrChart) {
            const toggleAtr = document.getElementById('toggle-atr');
            return toggleAtr ? toggleAtr.checked : false;
        }
        return false;
    }

    // All charts to sync
    const allCharts = [priceChart, oiChart, rsiChart, atrChart].filter(c => c !== null);

    // Unsubscribe previous handlers if they exist to prevent memory leaks and multiple triggers
    if (priceLogicalRangeChangeHandler) {
        try { priceChart.timeScale().unsubscribeVisibleLogicalRangeChange(priceLogicalRangeChangeHandler); } catch(e) {}
    }
    if (oiLogicalRangeChangeHandler) {
        try { oiChart.timeScale().unsubscribeVisibleLogicalRangeChange(oiLogicalRangeChangeHandler); } catch(e) {}
    }
    if (rsiLogicalRangeChangeHandler && rsiChart) {
        try { rsiChart.timeScale().unsubscribeVisibleLogicalRangeChange(rsiLogicalRangeChangeHandler); } catch(e) {}
    }
    if (atrLogicalRangeChangeHandler && atrChart) {
        try { atrChart.timeScale().unsubscribeVisibleLogicalRangeChange(atrLogicalRangeChangeHandler); } catch(e) {}
    }
    if (priceCrosshairMoveHandler) {
        try { priceChart.unsubscribeCrosshairMove(priceCrosshairMoveHandler); } catch(e) {}
    }
    if (oiCrosshairMoveHandler) {
        try { oiChart.unsubscribeCrosshairMove(oiCrosshairMoveHandler); } catch(e) {}
    }
    if (rsiCrosshairMoveHandler && rsiChart) {
        try { rsiChart.unsubscribeCrosshairMove(rsiCrosshairMoveHandler); } catch(e) {}
    }
    if (atrCrosshairMoveHandler && atrChart) {
        try { atrChart.unsubscribeCrosshairMove(atrCrosshairMoveHandler); } catch(e) {}
    }

    let isSyncing = false;

    // Helper to sync range from one chart to all others
    function syncRangeFrom(sourceChart) {
        return (range) => {
            if (isSyncingSuspended || isSyncing || !range) return;
            isSyncing = true;
            allCharts.forEach(c => {
                if (c !== sourceChart && isChartVisible(c)) {
                    try { c.timeScale().setVisibleLogicalRange(range); } catch(e) {}
                }
            });
            isSyncing = false;
        };
    }

    // Helper to sync crosshair from one chart to all others
    function syncCrosshairFrom(sourceChart, sourceSeries) {
        return (param) => {
            if (isSyncingSuspended || isSyncing) return;
            isSyncing = true;
            if (param.time) {
                // Set crosshair on all other charts
                if (sourceChart !== oiChart && oiChart && oiSeries) oiChart.setCrosshairPosition(0, param.time, oiSeries);
                if (sourceChart !== priceChart && priceChart && candlestickSeries) priceChart.setCrosshairPosition(0, param.time, candlestickSeries);
                if (sourceChart !== rsiChart && rsiChart && rsiSeries && isChartVisible(rsiChart)) rsiChart.setCrosshairPosition(0, param.time, rsiSeries);
                if (sourceChart !== atrChart && atrChart && atrSeries && isChartVisible(atrChart)) atrChart.setCrosshairPosition(0, param.time, atrSeries);
                isCrosshairActive = true;
                if (sourceChart === priceChart || sourceChart === oiChart) {
                    updateLegendValues(param);
                }
            } else {
                allCharts.forEach(c => {
                    if (c !== sourceChart && isChartVisible(c)) {
                        try { c.clearCrosshairPosition(); } catch(e) {}
                    }
                });
                isCrosshairActive = false;
                clearLegendValues();
            }
            isSyncing = false;
        };
    }

    // Define handlers
    priceLogicalRangeChangeHandler = syncRangeFrom(priceChart);
    oiLogicalRangeChangeHandler = syncRangeFrom(oiChart);
    priceCrosshairMoveHandler = syncCrosshairFrom(priceChart, candlestickSeries);
    oiCrosshairMoveHandler = syncCrosshairFrom(oiChart, oiSeries);

    // Subscribe price and OI
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(priceLogicalRangeChangeHandler);
    oiChart.timeScale().subscribeVisibleLogicalRangeChange(oiLogicalRangeChangeHandler);
    priceChart.subscribeCrosshairMove(priceCrosshairMoveHandler);
    oiChart.subscribeCrosshairMove(oiCrosshairMoveHandler);

    // Subscribe RSI
    if (rsiChart) {
        rsiLogicalRangeChangeHandler = syncRangeFrom(rsiChart);
        rsiCrosshairMoveHandler = syncCrosshairFrom(rsiChart, rsiSeries);
        rsiChart.timeScale().subscribeVisibleLogicalRangeChange(rsiLogicalRangeChangeHandler);
        rsiChart.subscribeCrosshairMove(rsiCrosshairMoveHandler);
    }

    // Subscribe ATR
    if (atrChart) {
        atrLogicalRangeChangeHandler = syncRangeFrom(atrChart);
        atrCrosshairMoveHandler = syncCrosshairFrom(atrChart, atrSeries);
        atrChart.timeScale().subscribeVisibleLogicalRangeChange(atrLogicalRangeChangeHandler);
        atrChart.subscribeCrosshairMove(atrCrosshairMoveHandler);
    }
}

// Initialize Open Interest chart under TradingView pane
function initOIChart() {
    if (oiChart) {
        try {
            oiChart.remove();
        } catch (e) {
            console.error("Error removing oiChart:", e);
        }
        oiChart = null;
    }
    const oiContainer = document.getElementById("oi-chart");
    oiContainer.innerHTML = "";
    
    const chartOptions = {
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: '#d1d5db',
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            timeVisible: true,
            secondsVisible: false,
            fixRightEdge: false,
            fixLeftEdge: false,
            tickMarkFormatter: (time, tickMarkType, locale) => {
                const date = new Date(time * 1000);
                if (tickMarkType < 3) {
                    const day = String(date.getUTCDate()).padStart(2, '0');
                    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                    return `${day}/${month}`;
                } else {
                    const hours = String(date.getUTCHours()).padStart(2, '0');
                    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                    return `${hours}:${minutes}`;
                }
            }
        },
        localization: {
            timeFormatter: (time) => {
                const date = new Date(time * 1000);
                const hours = String(date.getUTCHours()).padStart(2, '0');
                const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                const day = String(date.getUTCDate()).padStart(2, '0');
                const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                return `${day}/${month} ${hours}:${minutes}`;
            }
        }
    };

    oiChart = LightweightCharts.createChart(oiContainer, {
        ...chartOptions,
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            scaleMargins: { top: 0.1, bottom: 0.1 },
            minimumWidth: 90,
        }
    });
    
    oiSeries = oiChart.addAreaSeries({
        topColor: 'rgba(59, 130, 246, 0.4)',
        bottomColor: 'rgba(59, 130, 246, 0.0)',
        lineColor: '#3b82f6',
        lineWidth: 2,
        title: 'Open Interest'
    });

    // Resize Observer
    const resizeObserver = new ResizeObserver(entries => {
        if (oiChart) {
            oiChart.resize(oiContainer.getBoundingClientRect().width, oiContainer.getBoundingClientRect().height);
        }
    });
    resizeObserver.observe(oiContainer);
}

// Shared chart options builder for indicator panes
function getIndicatorChartOptions() {
    return {
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: '#d1d5db',
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            timeVisible: true,
            secondsVisible: false,
            fixRightEdge: false,
            fixLeftEdge: false,
            tickMarkFormatter: (time, tickMarkType, locale) => {
                const date = new Date(time * 1000);
                if (tickMarkType < 3) {
                    const day = String(date.getUTCDate()).padStart(2, '0');
                    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                    return `${day}/${month}`;
                } else {
                    const hours = String(date.getUTCHours()).padStart(2, '0');
                    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                    return `${hours}:${minutes}`;
                }
            }
        },
        localization: {
            timeFormatter: (time) => {
                const date = new Date(time * 1000);
                const hours = String(date.getUTCHours()).padStart(2, '0');
                const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                const day = String(date.getUTCDate()).padStart(2, '0');
                const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                return `${day}/${month} ${hours}:${minutes}`;
            }
        }
    };
}

// Initialize RSI chart pane
function initRSIChart() {
    if (rsiChart) {
        try { rsiChart.remove(); } catch (e) {}
        rsiChart = null;
    }
    const rsiContainer = document.getElementById('rsi-chart');
    rsiContainer.innerHTML = '';

    // Add pane label
    const label = document.createElement('div');
    label.className = 'indicator-pane-label';
    label.innerText = 'RSI (14)';
    rsiContainer.appendChild(label);

    rsiChart = LightweightCharts.createChart(rsiContainer, {
        ...getIndicatorChartOptions(),
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            scaleMargins: { top: 0.08, bottom: 0.08 },
            minimumWidth: 90,
        }
    });

    rsiSeries = rsiChart.addLineSeries({
        color: '#7c4dff',
        lineWidth: 2,
        title: '',
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
    });

    // Overbought line (70)
    rsiOverboughtLine = rsiChart.addLineSeries({
        color: 'rgba(255, 23, 68, 0.5)',
        lineWidth: 1,
        lineStyle: 1,
        title: '',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
    });

    // Oversold line (30)
    rsiOversoldLine = rsiChart.addLineSeries({
        color: 'rgba(0, 230, 118, 0.5)',
        lineWidth: 1,
        lineStyle: 1,
        title: '',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
    });

    // Middle line (50)
    rsiMiddleLine = rsiChart.addLineSeries({
        color: 'rgba(255, 255, 255, 0.2)',
        lineWidth: 1,
        lineStyle: 1,
        title: '',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
    });

    const rsiResizeObserver = new ResizeObserver(() => {
        if (rsiChart) {
            rsiChart.resize(rsiContainer.getBoundingClientRect().width, rsiContainer.getBoundingClientRect().height);
        }
    });
    rsiResizeObserver.observe(rsiContainer);
}

// Initialize ATR chart pane
function initATRChart() {
    if (atrChart) {
        try { atrChart.remove(); } catch (e) {}
        atrChart = null;
    }
    const atrContainer = document.getElementById('atr-chart');
    atrContainer.innerHTML = '';

    // Add pane label
    const label = document.createElement('div');
    label.className = 'indicator-pane-label';
    label.innerText = 'ATR (14)';
    atrContainer.appendChild(label);

    atrChart = LightweightCharts.createChart(atrContainer, {
        ...getIndicatorChartOptions(),
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            scaleMargins: { top: 0.1, bottom: 0.05 },
            minimumWidth: 90,
        }
    });

    atrSeries = atrChart.addHistogramSeries({
        color: '#26a69a',
        title: '',
        priceLineVisible: false,
        lastValueVisible: true,
    });

    const atrResizeObserver = new ResizeObserver(() => {
        if (atrChart) {
            atrChart.resize(atrContainer.getBoundingClientRect().width, atrContainer.getBoundingClientRect().height);
        }
    });
    atrResizeObserver.observe(atrContainer);
}

// Calculate and render all indicators
function updateIndicators(data) {
    if (!data || data.length === 0) return;
    
    // Update MAs
    Object.keys(maSeriesMap).forEach(key => {
        const ma = maSeriesMap[key];
        const [type, periodStr] = key.split('_');
        const period = parseInt(periodStr);
        const values = type === 'SMA' ? calcSMA(data, period) : calcEMA(data, period);
        ma.series.setData(values);
    });
    
    // Update RSI
    if (rsiSeries) {
        const rsiData = calcRSI(data, 14);
        rsiSeries.setData(rsiData);
        
        if (rsiData.length > 0) {
            const firstTime = rsiData[0].time;
            const lastTime = rsiData[rsiData.length - 1].time;
            if (rsiOverboughtLine) rsiOverboughtLine.setData([{time: firstTime, value: 70}, {time: lastTime, value: 70}]);
            if (rsiOversoldLine) rsiOversoldLine.setData([{time: firstTime, value: 30}, {time: lastTime, value: 30}]);
            if (rsiMiddleLine) rsiMiddleLine.setData([{time: firstTime, value: 50}, {time: lastTime, value: 50}]);
        }
    }
    
    // Update ATR
    if (atrSeries) {
        const atrData = calcATR(data, 14);
        atrSeries.setData(atrData);
    }
}

// Apply timeframe aggregation and render to chart
function applyTimeframe(timeframeMinutes) {
    currentTimeframe = timeframeMinutes;
    
    if (!raw1mHistory || raw1mHistory.length === 0) return;
    
    // Filter history to strictly keep market trading hours (10 AM to 5 PM IST weekdays)
    const filteredHistory = raw1mHistory.filter(c => isMarketHours(c.time));
    if (filteredHistory.length === 0) return;
    
    const intervalSeconds = timeframeMinutes * 60;
    const offsetSeconds = 19800; // 5.5 hours for IST
    
    // 1. Pre-calculate 1-minute incremental volumes
    const ticks1m = filteredHistory.map((c, i) => {
        let diff = 0;
        if (i > 0) {
            const prevD = new Date(filteredHistory[i - 1].time * 1000);
            const currD = new Date(c.time * 1000);
            const isSameDay = prevD.getUTCFullYear() === currD.getUTCFullYear() &&
                              prevD.getUTCMonth() === currD.getUTCMonth() &&
                              prevD.getUTCDate() === currD.getUTCDate();
            if (!isSameDay) {
                // Day changed! Check if broker carried over yesterday's closing volume
                const yesterdayVolume = filteredHistory[i - 1].volume;
                if (c.volume >= yesterdayVolume) {
                    diff = c.volume - yesterdayVolume;
                } else {
                    diff = c.volume;
                }
            } else {
                diff = c.volume - filteredHistory[i - 1].volume;
                if (diff < 0) {
                    // Reset occurred during the day (delayed reset)
                    diff = c.volume;
                }
            }
        } else {
            diff = c.volume;
        }
        return {
            time: Math.floor(c.time) + offsetSeconds,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            oi: c.oi || 0,
            volume: diff >= 0 ? diff : 0
        };
    });
    
    // 2. Group into intervals
    const grouped = {};
    ticks1m.forEach(tick => {
        const intervalTime = tick.time - (tick.time % intervalSeconds);
        if (!grouped[intervalTime]) {
            grouped[intervalTime] = [];
        }
        grouped[intervalTime].push(tick);
    });
    
    // 3. Aggregate each group
    const aggregated = Object.keys(grouped).sort((a, b) => a - b).map(timeStr => {
        const timeVal = parseInt(timeStr);
        const group = grouped[timeVal];
        
        const openVal = group[0].open;
        const closeVal = group[group.length - 1].close;
        const highVal = Math.max(...group.map(t => t.high));
        const lowVal = Math.min(...group.map(t => t.low));
        const volumeVal = group.reduce((sum, t) => sum + t.volume, 0);
        const oiVal = group[group.length - 1].oi;
        
        return {
            time: timeVal,
            open: openVal,
            high: highVal,
            low: lowVal,
            close: closeVal,
            volume: volumeVal,
            oi: oiVal
        };
    });
    
    // 4. Set chart series data
    const priceData = aggregated.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
    }));
    candlestickSeries.setData(priceData);
    
    const volumeData = aggregated.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(0, 230, 118, 0.75)' : 'rgba(255, 23, 68, 0.75)'
    }));
    volumeSeries.setData(volumeData);
    
    const oiData = aggregated.map(c => ({
        time: c.time,
        value: c.oi
    }));
    oiSeries.setData(oiData);
    
    // Cache for crosshair legend lookup
    currentHistoryData = aggregated;
    
    // Calculate and render indicators
    updateIndicators(aggregated);
    
    // Reset active interval aggregation based on the last tick to support live ticks
    if (ticks1m.length > 0) {
        const lastTick1m = ticks1m[ticks1m.length - 1];
        activeMinuteTime = lastTick1m.time - (lastTick1m.time % intervalSeconds);
        
        const currentGroup = grouped[activeMinuteTime] || [lastTick1m];
        activeMinuteOpen = currentGroup[0].open;
        activeMinuteHigh = Math.max(...currentGroup.map(t => t.high));
        activeMinuteLow = Math.min(...currentGroup.map(t => t.low));
        activeMinuteClose = lastTick1m.close;
        activeMinuteVolume = currentGroup.reduce((sum, t) => sum + t.volume, 0);
        
        const firstActiveTickIndex = raw1mHistory.findIndex(c => (Math.floor(c.time) + offsetSeconds) >= activeMinuteTime);
        if (firstActiveTickIndex > 0) {
            activeMinuteVolumeStart = raw1mHistory[firstActiveTickIndex - 1].volume;
        } else {
            activeMinuteVolumeStart = 0;
        }
    }
}

// Load historical price & OI data
async function loadOIHistory(symbol) {
    isSyncingSuspended = true;
    try {
        // 1. Fetch real historical data from local/cloud database
        let oiList = [];
        try {
            const oiRes = await fetch(`/api/historical-oi?symbol=${symbol}&_=${Date.now()}`);
            oiList = await oiRes.json();
        } catch (err) {
            console.error("Error loading historical OI from DB:", err);
        }

        if (oiList && oiList.length > 0) {
            console.log(`Loaded ${oiList.length} historical data points from database.`);
            raw1mHistory = oiList;
            
            const now = new Date();
            const todayOpenUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 30, 0));
            const todayOpenEpoch = Math.floor(todayOpenUTC.getTime() / 1000);
            
            let todayStartCandle = oiList.find(c => c.time >= todayOpenEpoch) || oiList[0];
            startingOI = todayStartCandle.oi || 0;
            yesterdayClose = todayStartCandle.open;
            
            applyTimeframe(currentTimeframe);
        } else {
            // Database is empty (e.g. first run). Fall back to simulated baseline history
            console.log("Database history is empty. Generating simulated historical data points for timeline...");
            
            let candlesList = [];
            const res = await fetch(`/api/historical-candles?symbol=${symbol}&_=${Date.now()}`);
            candlesList = await res.json();
            
            if (candlesList.length > 0) {
                let currentOi = (config.futures_symbols && config.futures_symbols[symbol] && config.futures_symbols[symbol].oi) || 10000;
                
                raw1mHistory = candlesList.map((c, i) => {
                    const change = (Math.random() - 0.48) * 150;
                    currentOi = Math.max(1000, Math.floor(currentOi + change));
                    return {
                        time: c.time,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                        volume: c.volume,
                        oi: currentOi
                    };
                });
                
                startingOI = raw1mHistory[0].oi;
                yesterdayClose = raw1mHistory[0].open;
                
                applyTimeframe(currentTimeframe);
            } else {
                raw1mHistory = [];
                candlestickSeries.setData([]);
                volumeSeries.setData([]);
                oiSeries.setData([]);
                startingOI = null;
                currentHistoryData = [];
            }
        }
        
        if (priceChart) {
            priceChart.priceScale('right').applyOptions({ autoScale: true });
            priceChart.timeScale().fitContent();
        }
        if (oiChart) {
            oiChart.priceScale('right').applyOptions({ autoScale: true });
            oiChart.timeScale().fitContent();
        }
        if (rsiChart) {
            rsiChart.priceScale('right').applyOptions({ autoScale: true });
            rsiChart.timeScale().fitContent();
        }
        if (atrChart) {
            atrChart.priceScale('right').applyOptions({ autoScale: true });
            atrChart.timeScale().fitContent();
        }
        
        if (raw1mHistory && raw1mHistory.length > 0) {
            lastLiveVolume = raw1mHistory[raw1mHistory.length - 1].volume;
            lastLiveTime = raw1mHistory[raw1mHistory.length - 1].time;
        } else {
            lastLiveVolume = null;
            lastLiveTime = null;
        }
        
        // Sync the visible logical range after a tiny delay to allow the layout to calculate
        setTimeout(() => {
            if (priceChart) {
                const range = priceChart.timeScale().getVisibleLogicalRange();
                if (range) {
                    if (oiChart) oiChart.timeScale().setVisibleLogicalRange(range);
                    if (rsiChart) rsiChart.timeScale().setVisibleLogicalRange(range);
                    if (atrChart) atrChart.timeScale().setVisibleLogicalRange(range);
                }
            }
            setTimeout(() => {
                isSyncingSuspended = false;
            }, 150);
        }, 100);
        
        clearLegendValues();
    } catch (err) {
        console.error("Error loading history:", err);
        isSyncingSuspended = false;
    }
}

// Connect to WebSocket
function connectWebSocket() {
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Use 127.0.0.1 when on localhost to bypass Windows IPv6→IPv4 fallback (avoids ~2s first-connection delay)
    const wsHost = window.location.hostname === "localhost"
        ? `127.0.0.1:${window.location.port || 80}`
        : window.location.host;
    const wsUrl = `${wsProto}//${wsHost}/ws`;
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        connectionBadge.className = "badge badge-connected";
        connectionBadge.innerHTML = '<i class="fa-solid fa-circle-dot"></i> WS CONNECTED';
        console.log("WebSocket connected");
        
        // Sync active contract on connect/reconnect
        if (currentSymbol && socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                action: "change_symbol",
                symbol: currentSymbol
            }));
        }
    };
    
    socket.onclose = () => {
        connectionBadge.className = "badge badge-disconnected";
        connectionBadge.innerHTML = '<i class="fa-solid fa-circle-dot"></i> WS DISCONNECTED';
        console.log("WebSocket disconnected, reconnecting in 3s...");
        setTimeout(connectWebSocket, 3000);
    };
    
    socket.onmessage = (event) => {
        const tick = JSON.parse(event.data);
        handleLiveTick(tick);
    };
}

// Handle incoming websocket ticks
// Handle incoming websocket ticks
function handleLiveTick(tick) {
    if (tick.symbol === currentSymbol) {
        console.log(`Client WS: Received tick for ${tick.symbol} - Price: ${tick.price}, OI: ${tick.oi}`);
        // Update broker status immediately since we are receiving live data
        if (tick.hasOwnProperty("broker_connected")) {
            updateBrokerBadge(tick.broker_connected);
        } else {
            updateBrokerBadge(true);
        }

        // Update stats UI panels (always, even after hours or on weekends)
        updateUIPanels(tick);
        updateCurveHistoryTodayRow(tick);
        
        if (!isMarketHours(tick.time)) {
            // Ignore ticks for chart rendering if they occur outside market hours
            return;
        }

        // Check if this is a trade tick (volume changed, reset occurred, or first tick)
        const sameDay = isSameDayIST(tick.time, lastLiveTime);
        const volumeIncreased = lastLiveVolume !== null && tick.volume > lastLiveVolume;
        const volumeReset = lastLiveVolume !== null && tick.volume < lastLiveVolume;
        
        lastLiveTime = tick.time;
        
        if (lastLiveVolume !== null && sameDay && !volumeReset && !volumeIncreased) {
            // No new trade. We do NOT update the candlestick or volume series on the chart.
            // But we STILL update the OI series and the UI panels.
            if (oiSeries && activeMinuteTime !== null) {
                oiSeries.update({
                    time: activeMinuteTime,
                    value: tick.oi
                });
            }
            
            let dataPoint = currentHistoryData.find(d => d.time === activeMinuteTime);
            if (dataPoint) {
                dataPoint.oi = tick.oi;
            }
            
            if (!isCrosshairActive) {
                clearLegendValues();
            }
            return;
        }
        
        const prevVolume = lastLiveVolume;
        lastLiveVolume = tick.volume;
        
        const offsetSeconds = 19800; // 5.5 hours for IST
        const intervalSeconds = currentTimeframe * 60;
        const timeVal = Math.floor(tick.time) - (Math.floor(tick.time) % intervalSeconds) + offsetSeconds;
        
        // Update raw1mHistory memory cache
        const tickMinEpoch = Math.floor(tick.time) - (Math.floor(tick.time) % 60);
        let rawMinCandle = raw1mHistory.find(c => c.time === tickMinEpoch);
        if (rawMinCandle) {
            rawMinCandle.high = Math.max(rawMinCandle.high, tick.price);
            rawMinCandle.low = Math.min(rawMinCandle.low, tick.price);
            rawMinCandle.close = tick.price;
            rawMinCandle.volume = tick.volume;
            rawMinCandle.oi = tick.oi;
        } else {
            raw1mHistory.push({
                time: tickMinEpoch,
                open: tick.price,
                high: tick.price,
                low: tick.price,
                close: tick.price,
                volume: tick.volume,
                oi: tick.oi
            });
        }

        // 1. Aggregate timeframe price candlestick
        if (activeMinuteTime !== timeVal) {
            // New interval has started! Set volume baseline to the previous tick's volume to prevent data loss
            if (prevVolume !== null && sameDay && !volumeReset) {
                activeMinuteVolumeStart = prevVolume;
            } else {
                activeMinuteVolumeStart = 0;
            }
            
            activeMinuteTime = timeVal;
            activeMinuteOpen = tick.price;
            activeMinuteHigh = tick.price;
            activeMinuteLow = tick.price;
            activeMinuteClose = tick.price;
            
            let diff = tick.volume - activeMinuteVolumeStart;
            if (diff < 0) diff = tick.volume;
            activeMinuteVolume = diff;
        } else {
            // Inside the same interval
            activeMinuteHigh = Math.max(activeMinuteHigh, tick.price);
            activeMinuteLow = Math.min(activeMinuteLow, tick.price);
            activeMinuteClose = tick.price;
            if (activeMinuteVolumeStart !== null) {
                let diff = tick.volume - activeMinuteVolumeStart;
                if (diff < 0) {
                    // Reset occurred during the day (delayed reset)
                    activeMinuteVolumeStart = 0;
                    diff = tick.volume;
                }
                activeMinuteVolume = diff;
            } else {
                activeMinuteVolumeStart = tick.volume;
                activeMinuteVolume = 0;
            }
        }
        
        // Update price candle (LTP) on price chart
        if (candlestickSeries) {
            candlestickSeries.update({
                time: activeMinuteTime,
                open: activeMinuteOpen,
                high: activeMinuteHigh,
                low: activeMinuteLow,
                close: activeMinuteClose
            });
        }
        
        // Update volume on price chart
        if (volumeSeries) {
            volumeSeries.update({
                time: activeMinuteTime,
                value: activeMinuteVolume,
                color: activeMinuteClose >= activeMinuteOpen ? 'rgba(0, 230, 118, 0.75)' : 'rgba(255, 23, 68, 0.75)'
            });
        }
        
        // Update OI Area Series
        if (oiSeries) {
            oiSeries.update({
                time: activeMinuteTime,
                value: tick.oi
            });
        }
 
        // Store current values
        lastOITick = tick.oi;
        lastPriceTick = tick.price;

        // Update currentHistoryData cache for legend lookup
        let dataPoint = currentHistoryData.find(d => d.time === activeMinuteTime);
        if (dataPoint) {
            dataPoint.open = activeMinuteOpen;
            dataPoint.high = activeMinuteHigh;
            dataPoint.low = activeMinuteLow;
            dataPoint.close = activeMinuteClose;
            dataPoint.volume = activeMinuteVolume;
            dataPoint.oi = tick.oi;
        } else {
            currentHistoryData.push({
                time: activeMinuteTime,
                open: activeMinuteOpen,
                high: activeMinuteHigh,
                low: activeMinuteLow,
                close: activeMinuteClose,
                volume: activeMinuteVolume,
                oi: tick.oi
            });
        }

        // Update indicators with live data
        updateIndicators(currentHistoryData);

        // If crosshair is not active, keep legend updated to show the latest live tick info
        if (!isCrosshairActive) {
            clearLegendValues();
        }
    }
}

// Regular stats fetch (backup polling)
async function fetchStatsData() {
    try {
        if (!window.fetchStatsCount) window.fetchStatsCount = 0;
        window.fetchStatsCount++;
        if (window.fetchStatsCount % 10 === 1) {
            console.log(`Polling stats data for: ${currentSymbol}...`);
        }
        const res = await fetch(`/api/futures-data?symbol=${encodeURIComponent(currentSymbol)}&_=${Date.now()}`);
        const stats = await res.json();
        
        if (stats) {
            updateBrokerBadge(stats.broker_connected);
            if (stats.price > 0) {
                updateUIPanels(stats);
                
                if (!startingOI && stats.oi > 0) {
                    startingOI = stats.oi;
                }
            }
        }
    } catch (err) {
        console.error("Error fetching stats data:", err);
    }
}

function updateBrokerBadge(connected) {
    if (!brokerBadge) return;
    if (connected) {
        brokerBadge.className = "badge badge-connected";
        brokerBadge.innerHTML = '<i class="fa-solid fa-key"></i> BROKER CONNECTED';
    } else {
        brokerBadge.className = "badge badge-disconnected";
        brokerBadge.innerHTML = '<i class="fa-solid fa-key"></i> BROKER DISCONNECTED';
    }
}

// Update KPI cards and stats tables
function updateUIPanels(data) {
    const price = data.price;
    const oi = data.oi;
    const volume = data.volume || 0;
    const ohlc = data.ohlc || {};
    
    const yestClose = ohlc.yesterday_close || yesterdayClose || price;
    yesterdayClose = yestClose;
    
    // 1. Futures LTP Card
    futuresPriceEl.innerText = price.toFixed(2);
    const priceChange = price - yestClose;
    const priceChangePct = yestClose > 0 ? (priceChange / yestClose) * 100 : 0.0;
    const sign = priceChange >= 0 ? "+" : "";
    
    futuresChangeEl.innerText = `${sign}${priceChange.toFixed(2)} (${sign}${priceChangePct.toFixed(2)}%)`;
    futuresChangeEl.className = priceChange >= 0 ? "kpi-change text-positive" : "kpi-change text-negative";

    // 2. Open Interest (OI) Card
    futuresOiEl.innerText = formatNumber(oi);
    
    // Calculate OI shift relative to day's starting value
    const baseOI = data.market_open_oi || startingOI || oi;
    const oiDiff = oi - baseOI;
    const oiDiffPct = baseOI > 0 ? (oiDiff / baseOI) * 100 : 0.0;
    const oiSign = oiDiff >= 0 ? "+" : "";
    
    futuresOiChangePctEl.innerText = `${oiSign}${oiDiffPct.toFixed(2)}% Today`;
    futuresOiChangePctEl.className = oiDiff >= 0 ? "kpi-change text-positive" : "kpi-change text-negative";

    // 3. Net OI Change Card
    futuresOiChangeAbsEl.innerText = `${oiSign}${formatNumber(oiDiff)}`;
    const oiDirection = oiDiff > 0 ? "OI Addition" : (oiDiff < 0 ? "OI Liquidation" : "No change");
    futuresOiDirEl.innerText = oiDirection;
    futuresOiDirEl.className = oiDiff > 0 ? "kpi-change text-positive" : (oiDiff < 0 ? "kpi-change text-negative" : "kpi-change");

    // 4. Volume Card
    futuresVolumeEl.innerText = formatNumber(volume);

    // 5. Sentiment Card (Price + OI Build-up combo)
    let sentiment = "RANGE BOUND";
    let sentDesc = "OI is consolidating.";
    let sentClass = "kpi-value";
    
    if (Math.abs(priceChangePct) > 0.02 && Math.abs(oiDiffPct) > 0.05) {
        if (priceChange > 0 && oiDiff > 0) {
            sentiment = "LONG BUILD-UP";
            sentDesc = "Aggressive long additions. Strong bullish momentum.";
            sentClass += " text-positive";
        } else if (priceChange < 0 && oiDiff > 0) {
            sentiment = "SHORT BUILD-UP";
            sentDesc = "Aggressive short additions. Strong bearish pressure.";
            sentClass += " text-negative";
        } else if (priceChange > 0 && oiDiff < 0) {
            sentiment = "SHORT COVERING";
            sentDesc = "Sellers covering positions. Short-term relief rally.";
            sentClass += " text-positive";
        } else if (priceChange < 0 && oiDiff < 0) {
            sentiment = "LONG UNWINDING";
            sentDesc = "Buyers liquidating longs. Profit booking / weak hands exit.";
            sentClass += " text-negative";
        }
    } else {
        sentiment = "ACCUMULATION";
        sentDesc = "Sideways range. High institutional accumulation.";
        sentClass += " text-accent";
    }
    
    sentimentValueEl.innerText = sentiment;
    sentimentValueEl.className = sentClass;
    sentimentDescEl.innerText = sentDesc;

    if (statOpenEl) statOpenEl.innerText = ohlc.open ? ohlc.open.toFixed(2) : price.toFixed(2);
    if (statHighEl) statHighEl.innerText = ohlc.high ? ohlc.high.toFixed(2) : price.toFixed(2);
    if (statLowEl) statLowEl.innerText = ohlc.low ? ohlc.low.toFixed(2) : price.toFixed(2);
    if (statPrevCloseEl) statPrevCloseEl.innerText = yestClose.toFixed(2);
    if (statTokenEl) statTokenEl.innerText = config.active_token || "-";

    // 7. Today's Price Range Slider
    const statLow = ohlc.low || price;
    const statHigh = ohlc.high || price;

    if (priceRangeLowEl) priceRangeLowEl.innerText = statLow.toFixed(2);
    if (priceRangeHighEl) priceRangeHighEl.innerText = statHigh.toFixed(2);

    if (priceRangePinEl) {
        let pct = 50.0;
        if (statHigh > statLow) {
            pct = ((price - statLow) / (statHigh - statLow)) * 100;
        }
        const boundedPct = Math.min(100, Math.max(0, pct));
        priceRangePinEl.style.left = `${boundedPct}%`;
    }
}

// Utility Helpers
function formatNumber(num) {
    const isNegative = num < 0;
    const val = Math.abs(num);
    const formatted = val.toLocaleString("en-IN");
    return (isNegative ? "-" : "") + formatted;
}

// Update Legend element texts
function updateLegendValues(param) {
    if (!param || !param.time) return;
    
    // Convert param.time to integer robustly
    const targetTime = typeof param.time === 'number' ? param.time : (typeof param.time === 'string' ? parseInt(param.time) : param.time);
    
    // Find matching candle in currentHistoryData (matching integer time values)
    const dataPoint = currentHistoryData.find(d => Math.floor(d.time) === Math.floor(targetTime));
    if (dataPoint) {
        document.getElementById("legend-open").innerText = dataPoint.open !== undefined ? dataPoint.open.toFixed(2) : "-";
        document.getElementById("legend-high").innerText = dataPoint.high !== undefined ? dataPoint.high.toFixed(2) : "-";
        document.getElementById("legend-low").innerText = dataPoint.low !== undefined ? dataPoint.low.toFixed(2) : "-";
        document.getElementById("legend-close").innerText = dataPoint.close !== undefined ? dataPoint.close.toFixed(2) : "-";
        document.getElementById("legend-volume").innerText = dataPoint.volume !== undefined ? dataPoint.volume : "0";
        document.getElementById("legend-oi").innerText = dataPoint.oi !== undefined ? dataPoint.oi : "-";
    } else if (param.seriesData) {
        // Try to get data directly from the series price values if we can't find it in cache
        const price = param.seriesData.get(candlestickSeries);
        const volume = param.seriesData.get(volumeSeries);
        const oi = param.seriesData.get(oiSeries);
        
        if (price) {
            document.getElementById("legend-open").innerText = price.open !== undefined ? price.open.toFixed(2) : "-";
            document.getElementById("legend-high").innerText = price.high !== undefined ? price.high.toFixed(2) : "-";
            document.getElementById("legend-low").innerText = price.low !== undefined ? price.low.toFixed(2) : "-";
            document.getElementById("legend-close").innerText = price.close !== undefined ? price.close.toFixed(2) : "-";
        }
        if (volume) {
            document.getElementById("legend-volume").innerText = volume.value !== undefined ? volume.value : "0";
        }
        if (oi) {
            document.getElementById("legend-oi").innerText = oi.value !== undefined ? oi.value : "-";
        }
    }
}

function clearLegendValues() {
    if (currentHistoryData && currentHistoryData.length > 0) {
        const lastCandle = currentHistoryData[currentHistoryData.length - 1];
        document.getElementById("legend-open").innerText = lastCandle.open !== undefined ? lastCandle.open.toFixed(2) : "-";
        document.getElementById("legend-high").innerText = lastCandle.high !== undefined ? lastCandle.high.toFixed(2) : "-";
        document.getElementById("legend-low").innerText = lastCandle.low !== undefined ? lastCandle.low.toFixed(2) : "-";
        document.getElementById("legend-close").innerText = lastCandle.close !== undefined ? lastCandle.close.toFixed(2) : "-";
        document.getElementById("legend-volume").innerText = lastCandle.volume !== undefined ? lastCandle.volume : "0";
        document.getElementById("legend-oi").innerText = lastCandle.oi !== undefined ? lastCandle.oi : "-";
    } else {
        document.getElementById("legend-open").innerText = "-";
        document.getElementById("legend-high").innerText = "-";
        document.getElementById("legend-low").innerText = "-";
        document.getElementById("legend-close").innerText = "-";
        document.getElementById("legend-volume").innerText = "-";
        document.getElementById("legend-oi").innerText = "-";
    }
}

// Fetch and render last 5 days total OI & closing prices for all contracts of the commodity
async function loadCommodityCurveHistory(symbol) {
    try {
        const res = await fetch(`/api/commodity-history?symbol=${symbol}&_=${Date.now()}`);
        const data = await res.json();
        
        const contracts = data.contracts || [];
        const history = data.history || [];
        
        // 1. Update super headers
        const h1 = document.getElementById("header-contract-1");
        const h2 = document.getElementById("header-contract-2");
        const h3 = document.getElementById("header-contract-3");
        
        if (h1) h1.innerText = contracts[0] ? getShortExpiryName(contracts[0]) : "-";
        if (h2) h2.innerText = contracts[1] ? getShortExpiryName(contracts[1]) : "-";
        if (h3) h3.innerText = contracts[2] ? getShortExpiryName(contracts[2]) : "-";
        
        // 2. Populate body
        const tbody = document.getElementById("stats-history-tbody");
        if (tbody) {
            tbody.innerHTML = "";
            
            history.forEach(day => {
                const tr = document.createElement("tr");
                
                // Format date from YYYY-MM-DD to DD/MM
                const dateParts = day.date.split("-");
                const formattedDate = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}` : day.date;
                
                // Date column
                const tdDate = document.createElement("td");
                tdDate.innerText = formattedDate;
                tdDate.style.fontWeight = "600";
                tdDate.style.color = "var(--text-secondary)";
                tr.appendChild(tdDate);
                
                // Contracts
                contracts.forEach((c, idx) => {
                    const cData = day.contracts[c] || { close: null, change: null, oi: null };
                    
                    const tdClose = document.createElement("td");
                    
                    // Display change instead of close
                    if (cData.change !== null) {
                        const sign = cData.change > 0 ? "+" : "";
                        tdClose.innerText = `${sign}${cData.change.toFixed(0)}`;
                        if (cData.change > 0) {
                            tdClose.className = "text-positive";
                        } else if (cData.change < 0) {
                            tdClose.className = "text-negative";
                        } else {
                            tdClose.style.color = "#d1d5db";
                        }
                    } else {
                        tdClose.innerText = "-";
                        tdClose.style.color = "#d1d5db";
                    }
                    
                    // Cache yesterday's close on today's row cells for real-time updates
                    if (day === history[0]) {
                        const nextDay = history[1];
                        const yestCloseVal = nextDay && nextDay.contracts[c] ? nextDay.contracts[c].close : null;
                        if (yestCloseVal !== null) {
                            tdClose.setAttribute("data-yest-close", yestCloseVal);
                        }
                    }
                    
                    const tdOi = document.createElement("td");
                    tdOi.innerText = cData.oi !== null ? formatNumber(cData.oi) : "-";
                    
                    // Add color coding for OI column
                    if (idx === 0) {
                        tdOi.style.color = "var(--color-ce)";
                    } else if (idx === 1) {
                        tdOi.style.color = "var(--color-pe)";
                    } else {
                        tdOi.style.color = "#d1d5db";
                    }
                    
                    tr.appendChild(tdClose);
                    tr.appendChild(tdOi);
                });
                
                // Total OI
                const tdTotal = document.createElement("td");
                tdTotal.innerText = formatNumber(day.total_oi);
                tdTotal.style.fontWeight = "bold";
                tdTotal.style.color = "var(--color-accent)";
                tr.appendChild(tdTotal);
                
                tbody.appendChild(tr);
            });
        }
    } catch (err) {
        console.error("Error loading commodity curve history:", err);
    }
}

// Extract short expiry name from full symbol (e.g. "DHANIYA JUN 26" -> "JUN 26")
function getShortExpiryName(symbol) {
    const parts = symbol.split(" ");
    if (parts.length >= 3) {
        return `${parts[parts.length - 2]} ${parts[parts.length - 1]}`;
    }
    return symbol;
}

// Update Today's row values in the curve history table on live tick updates
function updateCurveHistoryTodayRow(tick) {
    const tbody = document.getElementById("stats-history-tbody");
    if (!tbody || !tbody.rows || tbody.rows.length === 0) return;
    
    const now = new Date();
    const todayStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    // Check if the first row is today's row
    const firstRow = tbody.rows[0];
    const dateCellText = firstRow.cells[0].innerText;
    if (dateCellText !== todayStr) return;
    
    const activeShortName = getShortExpiryName(currentSymbol);
    let contractIdx = -1;
    for (let i = 1; i <= 3; i++) {
        const h = document.getElementById(`header-contract-${i}`);
        if (h && h.innerText === activeShortName) {
            contractIdx = i - 1;
            break;
        }
    }
    
    if (contractIdx === -1) return;
    
    const closeCellIdx = 1 + contractIdx * 2;
    const oiCellIdx = 2 + contractIdx * 2;
    
    const closeCell = firstRow.cells[closeCellIdx];
    const yestCloseAttr = closeCell.getAttribute("data-yest-close");
    const yestClose = yestCloseAttr ? parseFloat(yestCloseAttr) : null;
    
    if (yestClose !== null) {
        const priceChange = tick.price - yestClose;
        const sign = priceChange > 0 ? "+" : "";
        closeCell.innerText = `${sign}${priceChange.toFixed(0)}`;
        
        closeCell.classList.remove("text-positive", "text-negative");
        closeCell.style.color = "";
        
        if (priceChange > 0) {
            closeCell.classList.add("text-positive");
        } else if (priceChange < 0) {
            closeCell.classList.add("text-negative");
        } else {
            closeCell.style.color = "#d1d5db";
        }
    } else {
        closeCell.innerText = "-";
        closeCell.style.color = "#d1d5db";
    }
    
    firstRow.cells[oiCellIdx].innerText = formatNumber(tick.oi);
    
    // Recalculate Total OI for today's row
    let totalOi = 0;
    for (let i = 0; i < 3; i++) {
        const oiValStr = firstRow.cells[2 + i * 2].innerText.replace(/,/g, '');
        const oiVal = parseInt(oiValStr) || 0;
        totalOi += oiVal;
    }
    firstRow.cells[7].innerText = formatNumber(totalOi);
}
