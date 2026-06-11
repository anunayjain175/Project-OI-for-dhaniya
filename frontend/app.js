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
    const minutes = date.getUTCMinutes();
    const seconds = date.getUTCSeconds();
    if (hours < 10 || hours > 17) {
        return false;
    }
    if (hours === 17 && (minutes > 0 || seconds > 0)) {
        return false;
    }
    return true;
}

// Global State
let socket = null;
let currentSymbol = "JEERA-FUT";
let config = {};

// Cached unified data for chart legend lookup
let currentHistoryData = [];
let isCrosshairActive = false;
let raw1mHistory = [];
let currentTimeframe = 1; // Default to 1-minute (1m) timeframe
let isSyncingSuspended = false;


// Charts Instances
let priceChart = null;
let oiChart = null;

// Chart Series
let candlestickSeries = null;
let volumeSeries = null;
let oiSeries = null;

// Cached baseline data for calculating net daily changes
let startingOI = null;
let yesterdayClose = 0.0;
let lastOITick = 0;
let lastPriceTick = 0.0;

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

    // Tab Controls
    tabButtons = document.querySelectorAll(".tab-btn");
    tabContents = document.querySelectorAll(".tab-content");

    // 1. Fetch config settings
    console.log("App startup: fetching config...");
    await fetchConfig();
    if (chartSymbolNameEl && currentSymbol) {
        chartSymbolNameEl.innerText = `${currentSymbol} LIVE CHART (ANGEL ONE SMARTAPI)`;
    }
    
    // 2. Initialize Lightweight Price Chart & OI Chart
    console.log("App startup: initializing Lightweight charts...");
    initPriceChart();
    initOIChart();
    setupChartSynchronization();
    
    // 3. Setup Events
    console.log("App startup: setting up event listeners...");
    setupEventListeners();
    
    // 4. Fetch initial OI chart history
    console.log(`App startup: loading history for ${currentSymbol}...`);
    await loadOIHistory(currentSymbol);
    
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
        chartSymbolNameEl.innerText = `${currentSymbol} LIVE CHART (ANGEL ONE SMARTAPI)`;

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
        
        await loadOIHistory(currentSymbol);
        
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

    // Settings Modal
    settingsBtn.addEventListener("click", () => {
        document.getElementById("angel_client_id").value = config.angel_client_id || "";
        document.getElementById("angel_password").value = config.angel_password || "";
        document.getElementById("angel_totp_secret").value = config.angel_totp_secret || "";
        document.getElementById("angel_api_key").value = config.angel_api_key || "";
        document.getElementById("active_symbol").value = config.active_symbol || "";
        document.getElementById("active_token").value = config.active_token || "";
        document.getElementById("active_segment").value = config.active_segment || "7";
        modeSelect.value = config.mode || "mock";
        
        const activeSymInfo = (config.futures_symbols && config.futures_symbols[currentSymbol]) || {};
        document.getElementById("open_oi").value = activeSymInfo.open_oi || "";
        
        toggleLiveFields(modeSelect.value);
        settingsModal.style.display = "block";
    });

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
                setupChartSynchronization();
                await loadOIHistory(currentSymbol);
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
                if (priceChart && oiChart) {
                    const range = priceChart.timeScale().getVisibleLogicalRange();
                    if (range) {
                        oiChart.timeScale().setVisibleLogicalRange(range);
                    }
                }
                setTimeout(() => {
                    isSyncingSuspended = false;
                }, 150);
            }, 100);
        });
    });
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
            top: 0.8,
            bottom: 0,
        },
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

function setupChartSynchronization() {
    if (!priceChart || !oiChart) {
        console.warn("setupChartSynchronization: priceChart or oiChart not initialized yet. Skipping sync setup.");
        return;
    }

    // Unsubscribe previous handlers if they exist to prevent memory leaks and multiple triggers
    if (priceLogicalRangeChangeHandler) {
        try {
            priceChart.timeScale().unsubscribeVisibleLogicalRangeChange(priceLogicalRangeChangeHandler);
        } catch(e) {}
    }
    if (oiLogicalRangeChangeHandler) {
        try {
            oiChart.timeScale().unsubscribeVisibleLogicalRangeChange(oiLogicalRangeChangeHandler);
        } catch(e) {}
    }
    if (priceCrosshairMoveHandler) {
        try {
            priceChart.unsubscribeCrosshairMove(priceCrosshairMoveHandler);
        } catch(e) {}
    }
    if (oiCrosshairMoveHandler) {
        try {
            oiChart.unsubscribeCrosshairMove(oiCrosshairMoveHandler);
        } catch(e) {}
    }

    let isSyncing = false;

    // Define new handlers
    priceLogicalRangeChangeHandler = (range) => {
        if (isSyncingSuspended || isSyncing || !range) return;
        isSyncing = true;
        oiChart.timeScale().setVisibleLogicalRange(range);
        isSyncing = false;
    };

    oiLogicalRangeChangeHandler = (range) => {
        if (isSyncingSuspended || isSyncing || !range) return;
        isSyncing = true;
        priceChart.timeScale().setVisibleLogicalRange(range);
        isSyncing = false;
    };

    priceCrosshairMoveHandler = (param) => {
        if (isSyncingSuspended || isSyncing) return;
        isSyncing = true;
        if (param.time) {
            oiChart.setCrosshairPosition(0, param.time, oiSeries);
            isCrosshairActive = true;
            updateLegendValues(param);
        } else {
            oiChart.clearCrosshairPosition();
            isCrosshairActive = false;
            clearLegendValues();
        }
        isSyncing = false;
    };

    oiCrosshairMoveHandler = (param) => {
        if (isSyncingSuspended || isSyncing) return;
        isSyncing = true;
        if (param.time) {
            priceChart.setCrosshairPosition(0, param.time, candlestickSeries);
            isCrosshairActive = true;
            updateLegendValues(param);
        } else {
            priceChart.clearCrosshairPosition();
            isCrosshairActive = false;
            clearLegendValues();
        }
        isSyncing = false;
    };

    // Subscribe
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(priceLogicalRangeChangeHandler);
    oiChart.timeScale().subscribeVisibleLogicalRangeChange(oiLogicalRangeChangeHandler);
    priceChart.subscribeCrosshairMove(priceCrosshairMoveHandler);
    oiChart.subscribeCrosshairMove(oiCrosshairMoveHandler);
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
                diff = c.volume;
            } else {
                diff = c.volume - filteredHistory[i - 1].volume;
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
        color: c.close >= c.open ? 'rgba(0, 230, 118, 0.4)' : 'rgba(255, 23, 68, 0.4)'
    }));
    volumeSeries.setData(volumeData);
    
    const oiData = aggregated.map(c => ({
        time: c.time,
        value: c.oi
    }));
    oiSeries.setData(oiData);
    
    // Cache for crosshair legend lookup
    currentHistoryData = aggregated;
    
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
        
        priceChart.timeScale().fitContent();
        
        // Sync the visible logical range after a tiny delay to allow the layout to calculate
        setTimeout(() => {
            if (priceChart && oiChart) {
                const range = priceChart.timeScale().getVisibleLogicalRange();
                if (range) {
                    oiChart.timeScale().setVisibleLogicalRange(range);
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
        
        if (!isMarketHours(tick.time)) {
            // Ignore ticks for chart rendering if they occur outside market hours
            return;
        }
        
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
            // New interval has started! Set volume baseline to the previous minute's last volume
            activeMinuteVolumeStart = tick.volume;
            
            activeMinuteTime = timeVal;
            activeMinuteOpen = tick.price;
            activeMinuteHigh = tick.price;
            activeMinuteLow = tick.price;
            activeMinuteClose = tick.price;
            activeMinuteVolume = 0;
        } else {
            // Inside the same interval
            activeMinuteHigh = Math.max(activeMinuteHigh, tick.price);
            activeMinuteLow = Math.min(activeMinuteLow, tick.price);
            activeMinuteClose = tick.price;
            if (activeMinuteVolumeStart !== null) {
                const diff = tick.volume - activeMinuteVolumeStart;
                activeMinuteVolume = diff >= 0 ? diff : 0;
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
                color: activeMinuteClose >= activeMinuteOpen ? 'rgba(0, 230, 118, 0.4)' : 'rgba(255, 23, 68, 0.4)'
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

    // 6. Stats Table
    statOpenEl.innerText = ohlc.open ? ohlc.open.toFixed(2) : price.toFixed(2);
    statHighEl.innerText = ohlc.high ? ohlc.high.toFixed(2) : price.toFixed(2);
    statLowEl.innerText = ohlc.low ? ohlc.low.toFixed(2) : price.toFixed(2);
    statPrevCloseEl.innerText = yestClose.toFixed(2);
    statTokenEl.innerText = config.active_token || "-";
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
