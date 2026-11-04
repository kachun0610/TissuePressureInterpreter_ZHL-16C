// UI theme (high-contrast light instrument palette)
const THEME = {
    canvasBg: '#f7fafc',
    panelBg: '#eef3f7',
    rowEven: '#f7fafc',
    rowOdd: '#eef3f7',
    ink: '#0b1f2a',
    inkSecondary: '#243b4a',
    muted: '#4a6574',
    border: '#c5d4de',
    axis: '#6b8494',
    n2: '#0a6e7a',
    he: '#8a4b12',
    onN2: '#ffffff',
    onHe: '#ffffff',
    ambient: '#9a5b00',
    depthLine: '#0a5f9e',
    ceiling: '#0f6b3c',
    cursor: '#b42318',
    decoZone: 'rgba(180, 35, 24, 0.12)',
    legendBg: 'rgba(255, 255, 255, 0.94)',
    font: 'IBM Plex Sans',
    mono: 'IBM Plex Mono'
};

/** Sharp, clean canvas type: integer px, reliable weights, system fallbacks. */
function graphFont(size, { weight = 'normal', mono = false, min = 8 } = {}) {
    const px = Math.max(min, Math.round(size));
    const family = mono
        ? `"${THEME.mono}", Consolas, "Courier New", monospace`
        : `"${THEME.font}", "Segoe UI", system-ui, sans-serif`;
    return `${weight} ${px}px ${family}`;
}

/** Keep text from overflowing short rows (portrait / tall layouts). */
function fitTextSize(preferred, rowH, ratio = 0.58) {
    const cap = Math.max(8, rowH * ratio);
    return Math.min(preferred, cap);
}

function prepareGraphText(ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.textBaseline = 'alphabetic';
}

function syncCanvasSize(canvasEl, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    canvasEl.style.width = `${w}px`;
    canvasEl.style.height = `${h}px`;
    canvasEl.width = Math.max(1, Math.round(w * dpr));
    canvasEl.height = Math.max(1, Math.round(h * dpr));
    const context = canvasEl.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: w, height: h };
}

// ZHL-16C Constants
const P_H2O_BAR = 0.0627;

const ZHL16C_N2_HALF = [4.0, 8.0, 12.5, 18.5, 27.0, 38.3, 54.3, 77.0,
                        109.0, 146.0, 187.0, 239.0, 305.0, 390.0, 498.0, 635.0];

const ZHL16C_HE_HALF = [1.51, 3.02, 4.72, 6.99, 10.21, 14.48, 20.53, 29.11,
                        41.20, 55.19, 70.69, 90.34, 115.29, 147.42, 188.24, 240.03];

// Bühlmann coefficients for ZHL-16C
const ZHL16C_N2_A = [1.2599, 1.0000, 0.8618, 0.7562, 0.6200, 0.5043, 0.4410, 0.4000,
                     0.3750, 0.3500, 0.3295, 0.3065, 0.2835, 0.2610, 0.2480, 0.2327];

const ZHL16C_N2_B = [0.5050, 0.6514, 0.7222, 0.7825, 0.8126, 0.8434, 0.8693, 0.8910,
                     0.9092, 0.9222, 0.9319, 0.9403, 0.9477, 0.9544, 0.9602, 0.9653];

const ZHL16C_HE_A = [1.6189, 1.3830, 1.1919, 1.0458, 0.9220, 0.8205, 0.7305, 0.6502,
                     0.5950, 0.5545, 0.5333, 0.5189, 0.5181, 0.5176, 0.5172, 0.5119];

const ZHL16C_HE_B = [0.4770, 0.5747, 0.6527, 0.7223, 0.7582, 0.7957, 0.8279, 0.8553,
                     0.8757, 0.8903, 0.8997, 0.9073, 0.9122, 0.9171, 0.9217, 0.9267];

// State
let settings = null;
let samples = [];
let tissueStates = [];
let times = [];
let ambientPressures = [];
let ceilings = [];
let ndls = [];
let currentIndex = 0;
let playing = false;
let frameDelay = 100;
let timeoutId = null;
let fixedScale = false;
let maxAmbientPressure = 0;
let gfLow = 30;
let gfHigh = 85;

// Interactive dragging state
let isDragging = false;
let graphMargins = { top: 0, right: 0, bottom: 0, left: 0 };

// Tissue bar hover (hit regions in CSS pixels, refreshed each redraw)
let tissueBarHitAreas = [];
let hoveredComp = -1;
let lastTissuePointer = null;

// Canvas
const canvas = document.getElementById('tissueCanvas');
const ctx = canvas.getContext('2d');
const tissueTooltip = document.getElementById('tissueTooltip');

const depthCanvas = document.getElementById('depthCanvas');
const depthCtx = depthCanvas.getContext('2d');
const depthGraphDiv = document.getElementById('depthGraph');

function resizeCanvas() {
    const mainDisplay = document.querySelector('.main-display');
    syncCanvasSize(canvas, mainDisplay.clientWidth, mainDisplay.clientHeight);
    syncCanvasSize(depthCanvas, depthGraphDiv.clientWidth, depthGraphDiv.clientHeight);
    redraw();
    redrawDepthGraph();
}

/** After layout changes (metrics panel, portrait resize), remeasure canvases. */
function resizeCanvasAfterLayout() {
    requestAnimationFrame(() => {
        resizeCanvas();
    });
}

// Resize on load, window resize, and container size changes
window.addEventListener('resize', resizeCanvas);
window.addEventListener('load', resizeCanvas);
if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => resizeCanvas());
    const mainDisplay = document.querySelector('.main-display');
    if (mainDisplay) ro.observe(mainDisplay);
    if (depthGraphDiv) ro.observe(depthGraphDiv);
}
resizeCanvas();

// Redraw once web fonts are ready so graph labels stay crisp
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
        resizeCanvas();
    });
}

function hideTissueTooltip() {
    hoveredComp = -1;
    lastTissuePointer = null;
    if (tissueTooltip) {
        tissueTooltip.hidden = true;
        tissueTooltip.innerHTML = '';
    }
    canvas.style.cursor = 'default';
}

function showTissueTooltip(compIndex, clientX, clientY) {
    if (!tissueTooltip || tissueStates.length === 0 || currentIndex >= tissueStates.length) {
        hideTissueTooltip();
        return;
    }

    const state = tissueStates[currentIndex];
    const pn2 = state.pn2[compIndex];
    const phe = state.phe[compIndex];
    const ptotal = pn2 + phe;
    const pamb = ambientPressures[currentIndex];

    tissueTooltip.innerHTML = `
        <strong>Comp ${compIndex + 1}</strong>
        <div class="tip-row tip-n2"><span>N₂ (PN2)</span><span>${pn2.toFixed(3)} bar</span></div>
        <div class="tip-row tip-he"><span>He (PHe)</span><span>${phe.toFixed(3)} bar</span></div>
        <div class="tip-row tip-total"><span>Total</span><span>${ptotal.toFixed(3)} bar</span></div>
        <div class="tip-row"><span>Ambient</span><span>${pamb.toFixed(3)} bar</span></div>
        <div class="tip-row"><span>T½</span><span>N₂ ${ZHL16C_N2_HALF[compIndex]}m · He ${ZHL16C_HE_HALF[compIndex]}m</span></div>
    `;
    tissueTooltip.hidden = false;

    const mainDisplay = document.querySelector('.main-display');
    const rect = mainDisplay.getBoundingClientRect();
    let left = clientX - rect.left;
    let top = clientY - rect.top;

    // Keep tooltip inside the main display
    tissueTooltip.style.left = `${left}px`;
    tissueTooltip.style.top = `${top}px`;
    tissueTooltip.style.transform = 'translate(-50%, calc(-100% - 10px))';

    const tipRect = tissueTooltip.getBoundingClientRect();
    if (tipRect.left < rect.left + 6) {
        left = tipRect.width / 2 + 6;
        tissueTooltip.style.left = `${left}px`;
    } else if (tipRect.right > rect.right - 6) {
        left = rect.width - tipRect.width / 2 - 6;
        tissueTooltip.style.left = `${left}px`;
    }
    if (tipRect.top < rect.top + 6) {
        tissueTooltip.style.transform = 'translate(-50%, 12px)';
    }
}

function hitTestTissueBar(cssX, cssY) {
    for (const area of tissueBarHitAreas) {
        if (cssX >= area.x && cssX <= area.x + area.w && cssY >= area.y && cssY <= area.y + area.h) {
            return area.comp;
        }
    }
    return -1;
}

function handleTissuePointerMove(e) {
    if (tissueStates.length === 0) {
        if (hoveredComp !== -1) {
            hideTissueTooltip();
            redraw();
        }
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    lastTissuePointer = { x, y, clientX: e.clientX, clientY: e.clientY };

    const comp = hitTestTissueBar(x, y);
    if (comp === hoveredComp) {
        if (comp >= 0) showTissueTooltip(comp, e.clientX, e.clientY);
        return;
    }

    hoveredComp = comp;
    if (comp >= 0) {
        canvas.style.cursor = 'pointer';
        showTissueTooltip(comp, e.clientX, e.clientY);
    } else {
        if (tissueTooltip) {
            tissueTooltip.hidden = true;
            tissueTooltip.innerHTML = '';
        }
        canvas.style.cursor = 'default';
    }
    redraw();
}

function handleTissuePointerLeave() {
    if (hoveredComp === -1 && (!tissueTooltip || tissueTooltip.hidden)) return;
    hideTissueTooltip();
    redraw();
}

canvas.addEventListener('pointermove', handleTissuePointerMove);
canvas.addEventListener('pointerleave', handleTissuePointerLeave);
canvas.addEventListener('pointerdown', handleTissuePointerMove);

// Interactive depth graph controls
depthGraphDiv.addEventListener('mousedown', handleMouseDown);
depthGraphDiv.addEventListener('mousemove', handleMouseMove);
depthGraphDiv.addEventListener('mouseup', handleMouseUp);
depthGraphDiv.addEventListener('mouseleave', handleMouseUp);

function handleMouseDown(e) {
    if (samples.length === 0) return;
    
    const rect = depthCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    
    // Check if click is within the graph area
    if (x >= graphMargins.left && x <= depthCanvas.width - graphMargins.right) {
        isDragging = true;
        depthGraphDiv.classList.add('dragging');
        
        // Pause playback if playing
        if (playing) {
            playing = false;
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            document.getElementById('playPauseBtn').textContent = 'Play';
        }
        
        updatePositionFromMouse(e);
    }
}

function handleMouseMove(e) {
    if (!isDragging || samples.length === 0) return;
    updatePositionFromMouse(e);
}

function handleMouseUp(e) {
    if (isDragging) {
        isDragging = false;
        depthGraphDiv.classList.remove('dragging');
    }
}

function updatePositionFromMouse(e) {
    const rect = depthCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    
    const graphWidth = depthCanvas.width - graphMargins.left - graphMargins.right;
    const relativeX = x - graphMargins.left;
    
    // Clamp to graph bounds
    const clampedX = Math.max(0, Math.min(graphWidth, relativeX));
    
    // Calculate index based on position
    const maxTime = Math.max(...times);
    const ratio = clampedX / graphWidth;
    const targetIndex = Math.round(ratio * (samples.length - 1));
    
    currentIndex = Math.max(0, Math.min(samples.length - 1, targetIndex));
    
    redraw();
    redrawDepthGraph();
    updateMetrics();
    if (hoveredComp >= 0 && lastTissuePointer) {
        showTissueTooltip(hoveredComp, lastTissuePointer.clientX, lastTissuePointer.clientY);
    }
}

// File handling
document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    resetState();
    
    try {
        const text = await file.text();
        parseCSV(text);
        document.getElementById('statusText').textContent = `Loaded ${samples.length} samples. Ready.`;
        document.getElementById('playPauseBtn').disabled = false;
        document.getElementById('restartBtn').disabled = false;
        document.getElementById('scaleBtn').disabled = false;
        document.getElementById('metricsDisplay').style.display = 'flex';
        renderSettings();
        updateMetrics();
        resizeCanvasAfterLayout();
    } catch (error) {
        document.getElementById('statusText').textContent = `Error: ${error.message}`;
    }
});

// Demo Data button handler
document.getElementById('demoBtn').addEventListener('click', async () => {
    loadDemoData('Demo Dive Log.csv');
});

// Demo Data (EAN32) button handler
document.getElementById('demoBtnEAN32').addEventListener('click', async () => {
    loadDemoData('Demo Dive Log (EAN32).csv');
});

async function loadDemoData(filename) {
    try {
        document.getElementById('statusText').textContent = `Loading ${filename}...`;
        
        const response = await fetch(filename);
        if (!response.ok) {
            throw new Error(`Could not load ${filename}. Make sure the file is in the same directory as this HTML file.`);
        }
        
        resetState();
        
        const text = await response.text();
        parseCSV(text);
        
        document.getElementById('statusText').textContent = `Loaded ${samples.length} samples from ${filename}. Ready.`;
        document.getElementById('playPauseBtn').disabled = false;
        document.getElementById('restartBtn').disabled = false;
        document.getElementById('scaleBtn').disabled = false;
        document.getElementById('metricsDisplay').style.display = 'flex';
        renderSettings();
        updateMetrics();
        resizeCanvasAfterLayout();
    } catch (error) {
        document.getElementById('statusText').textContent = `Error loading demo data: ${error.message}`;
    }
}

function resetState() {
    playing = false;
    isDragging = false;
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
    
    settings = null;
    samples = [];
    tissueStates = [];
    times = [];
    ambientPressures = [];
    ceilings = [];
    ndls = [];
    currentIndex = 0;
    fixedScale = false;
    maxAmbientPressure = 0;
    tissueBarHitAreas = [];
    hideTissueTooltip();
    
    document.getElementById('playPauseBtn').textContent = 'Play';
    document.getElementById('scaleBtn').textContent = 'Fix Scale';
    document.getElementById('metricsDisplay').style.display = 'none';
    depthGraphDiv.classList.remove('dragging');
    
    const tw = canvas.clientWidth || canvas.width;
    const th = canvas.clientHeight || canvas.height;
    ctx.fillStyle = THEME.canvasBg;
    ctx.fillRect(0, 0, tw, th);
    
    const dw = depthCanvas.clientWidth || depthCanvas.width;
    const dh = depthCanvas.clientHeight || depthCanvas.height;
    depthCtx.fillStyle = THEME.panelBg;
    depthCtx.fillRect(0, 0, dw, dh);
}

// Control buttons
document.getElementById('playPauseBtn').addEventListener('click', () => {
    if (playing) {
        playing = false;
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        document.getElementById('playPauseBtn').textContent = 'Play';
    } else {
        if (currentIndex >= tissueStates.length - 1) {
            currentIndex = 0;
        }
        playing = true;
        document.getElementById('playPauseBtn').textContent = 'Pause';
        animate();
    }
});

document.getElementById('restartBtn').addEventListener('click', () => {
    currentIndex = 0;
    playing = false;
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
    document.getElementById('playPauseBtn').textContent = 'Play';
    redraw();
    redrawDepthGraph();
    updateMetrics();
});

document.getElementById('scaleBtn').addEventListener('click', () => {
    fixedScale = !fixedScale;
    document.getElementById('scaleBtn').textContent = fixedScale ? 'Dynamic Scale' : 'Fix Scale';
    redraw();
});

// Speed buttons
document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        frameDelay = parseInt(btn.dataset.delay);
        
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const speedName = btn.textContent;
        document.getElementById('statusText').textContent = `Playback speed: ${speedName}`;
    });
});

// CSV Parsing
function parseCSV(text) {
    const lines = text.trim().split('\n');
    
    const settingsHeader = lines[0].split(',');
    const settingsValues = lines[1].split(',');
    settings = {};
    
    for (let i = 0; i < settingsHeader.length; i++) {
        const key = settingsHeader[i].trim().replace(/^["']|["']$/g, '');
        const value = settingsValues[i].trim().replace(/^["']|["']$/g, '');
        settings[key] = value;
    }
    
    // Parse GF settings
    const gfMin = settings['GF Minimum'] || settings['GF Low'];
    const gfMax = settings['GF Maximum'] || settings['GF High'];
    if (gfMin) gfLow = parseFloat(gfMin);
    if (gfMax) gfHigh = parseFloat(gfMax);
    
    let tsHeaderIdx = -1;
    for (let i = 2; i < lines.length; i++) {
        if (lines[i].startsWith('Time (sec)')) {
            tsHeaderIdx = i;
            break;
        }
    }
    
    if (tsHeaderIdx === -1) throw new Error('Time series header not found');
    
    const tsHeader = lines[tsHeaderIdx].split(',');
    const timeIdx = 0;
    const depthIdx = 1;
    const fo2Idx = 5;
    const fheIdx = 6;
    
    samples = [];
    for (let i = tsHeaderIdx + 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length > Math.max(timeIdx, depthIdx, fo2Idx, fheIdx)) {
            try {
                const timeInSec = parseFloat(row[timeIdx]);
                const depth = parseFloat(row[depthIdx]);
                const fo2 = parseFloat(row[fo2Idx]);
                const fhe = parseFloat(row[fheIdx]);
                
                if (!isNaN(timeInSec) && !isNaN(depth) && !isNaN(fo2) && !isNaN(fhe)) {
                    samples.push({
                        time: timeInSec * 1000,
                        depth: depth,
                        fo2: fo2,
                        fhe: fhe
                    });
                }
            } catch (e) {
                // Skip invalid rows
            }
        }
    }

    computeTissues();
}

function getSurfacePressure() {
    const startP = settings['Start Surface Pressure'];
    const endP = settings['End Surface Pressure'];
    
    if (startP && startP.trim()) {
        return parseFloat(startP) / 1000;
    }
    if (endP && endP.trim()) {
        return parseFloat(endP) / 1000;
    }
    return 1.013;
}

function ambientPressure(depth, surfaceBar) {
    return surfaceBar + (depth / 10.0);
}

function computeTissues() {
    const surfaceBar = getSurfacePressure();
    
    const f_he0 = samples[0].fhe;
    const f_o20 = samples[0].fo2;
    const f_n20 = Math.max(0, 1 - f_o20 - f_he0);
    const p_amb0 = ambientPressure(0, surfaceBar);
    const p_insp_n2_0 = Math.max(0, (p_amb0 - P_H2O_BAR) * f_n20);
    const p_insp_he_0 = Math.max(0, (p_amb0 - P_H2O_BAR) * f_he0);

    let state = {
        pn2: Array(16).fill(p_insp_n2_0),
        phe: Array(16).fill(p_insp_he_0)
    };

    tissueStates = [];
    times = [];
    ambientPressures = [];
    ceilings = [];
    ndls = [];

    let prev = samples[0];
    for (const sample of samples) {
        const dt_ms = sample.time - prev.time;
        const dt_min = Math.max(0, dt_ms) / 60000.0;

        const f_he = prev.fhe;
        const f_o2 = prev.fo2;
        const f_n2 = Math.max(0, 1 - f_o2 - f_he);

        const p_amb = ambientPressure(prev.depth, surfaceBar);
        const p_insp_n2 = Math.max(0, (p_amb - P_H2O_BAR) * f_n2);
        const p_insp_he = Math.max(0, (p_amb - P_H2O_BAR) * f_he);

        state = updateTissues(state, dt_min, p_insp_n2, p_insp_he);

        times.push(sample.time);
        ambientPressures.push(p_amb);
        tissueStates.push(JSON.parse(JSON.stringify(state)));
        
        // Pre-calculate ceiling and NDL for each point
        const ceiling = calculateCeiling(state, p_amb);
        const ceilingDepth = Math.max(0, (ceiling - surfaceBar) * 10);
        ceilings.push(ceilingDepth);
        
        const ndl = calculateNDL(state, p_amb, sample.depth, sample.fo2, sample.fhe);
        ndls.push(ndl);

        prev = sample;
    }
    
    maxAmbientPressure = Math.max(...ambientPressures) * 1.2;
}

function updateTissues(state, dt_min, p_insp_n2, p_insp_he) {
    const newState = {
        pn2: [...state.pn2],
        phe: [...state.phe]
    };

    for (let i = 0; i < 16; i++) {
        const k_n2 = Math.log(2) / ZHL16C_N2_HALF[i];
        const k_he = Math.log(2) / ZHL16C_HE_HALF[i];
        
        newState.pn2[i] = p_insp_n2 + (state.pn2[i] - p_insp_n2) * Math.exp(-k_n2 * dt_min);
        newState.phe[i] = p_insp_he + (state.phe[i] - p_insp_he) * Math.exp(-k_he * dt_min);
    }

    return newState;
}

function calculateMValue(comp, pn2, phe, gf) {
    // Calculate a and b coefficients for mixed gas
    const a = ((ZHL16C_N2_A[comp] * pn2) + (ZHL16C_HE_A[comp] * phe)) / (pn2 + phe);
    const b = ((ZHL16C_N2_B[comp] * pn2) + (ZHL16C_HE_B[comp] * phe)) / (pn2 + phe);
    
    const ptotal = pn2 + phe;
    
    // M-value at current loading: P_amb_tol = (P_tissue - a) / b
    const p_amb_tol = (ptotal - a) / b;
    
    // Apply gradient factor
    const p_amb_gf = p_amb_tol * (gf / 100.0);
    
    return p_amb_gf;
}

function calculateCeiling(state, pamb) {
    let maxCeiling = 0;
    
    // Calculate GF based on current depth
    const surfaceBar = getSurfacePressure();
    const depth = (pamb - surfaceBar) * 10;
    
    // Find first stop depth (simplified - actual algorithm is more complex)
    let gf = gfHigh;
    
    for (let i = 0; i < 16; i++) {
        if (state.pn2[i] + state.phe[i] > 0) {
            const ceiling = calculateMValue(i, state.pn2[i], state.phe[i], gf);
            maxCeiling = Math.max(maxCeiling, ceiling);
        }
    }
    
    return maxCeiling;
}

function calculateNDL(state, pamb, currentDepth, fo2, fhe) {
    const surfaceBar = getSurfacePressure();
    const fn2 = Math.max(0, 1 - fo2 - fhe);
    
    // Simulate tissue loading at current depth
    let simState = {
        pn2: [...state.pn2],
        phe: [...state.phe]
    };
    
    const p_insp_n2 = Math.max(0, (pamb - P_H2O_BAR) * fn2);
    const p_insp_he = Math.max(0, (pamb - P_H2O_BAR) * fhe);
    
    let ndl = 0;
    const maxNDL = 999; // Maximum NDL to calculate
    
    // Step forward in 1-minute increments
    for (let min = 0; min < maxNDL; min++) {
        simState = updateTissues(simState, 1.0, p_insp_n2, p_insp_he);
        
        const ceiling = calculateCeiling(simState, pamb);
        
        // If ceiling exceeds current depth, we've hit the NDL
        if (ceiling > surfaceBar) {
            ndl = min;
            break;
        }
        
        if (min === maxNDL - 1) {
            ndl = maxNDL;
        }
    }
    
    return ndl;
}

function calculateTTS(state, currentDepth, pamb, fo2, fhe) {
    // Simplified TTS calculation
    const surfaceBar = getSurfacePressure();
    const ceiling = calculateCeiling(state, pamb);
    
    // If no ceiling, TTS is just ascent time
    if (ceiling <= surfaceBar) {
        // Ascent at 10m/min
        const ascentTime = currentDepth / 10.0;
        return Math.ceil(ascentTime);
    }
    
    // If there's a ceiling, we have deco
    // This is a very simplified calculation
    const ceilingDepth = (ceiling - surfaceBar) * 10;
    const ascentToCeiling = (currentDepth - ceilingDepth) / 10.0;
    
    // Estimate deco time (very rough)
    const decoTime = ceilingDepth * 2; // Rough estimate
    
    return Math.ceil(ascentToCeiling + decoTime);
}

function updateMetrics() {
    if (tissueStates.length === 0 || currentIndex >= tissueStates.length) return;
    
    const state = tissueStates[currentIndex];
    const pamb = ambientPressures[currentIndex];
    const surfaceBar = getSurfacePressure();
    const sample = samples[currentIndex];
    
    // Use pre-calculated values
    const ceilingDepth = ceilings[currentIndex];
    const ndl = ndls[currentIndex];
    
    const ceilingEl = document.getElementById('ceilingValue');
    if (ceilingDepth < 0.1) {
        ceilingEl.textContent = '0 m';
        ceilingEl.className = 'metric-value safe';
    } else {
        ceilingEl.textContent = ceilingDepth.toFixed(1) + ' m';
        if (ceilingDepth > sample.depth) {
            ceilingEl.className = 'metric-value danger';
        } else {
            ceilingEl.className = 'metric-value warning';
        }
    }
    
    const ndlEl = document.getElementById('ndlValue');
    if (ndl >= 999) {
        ndlEl.textContent = '999+ min';
        ndlEl.className = 'metric-value safe';
    } else if (ndl === 0) {
        ndlEl.textContent = '0 min';
        ndlEl.className = 'metric-value danger';
    } else {
        ndlEl.textContent = ndl + ' min';
        if (ndl < 5) {
            ndlEl.className = 'metric-value warning';
        } else {
            ndlEl.className = 'metric-value safe';
        }
    }
    
    // Calculate TTS
    const tts = calculateTTS(state, sample.depth, pamb, sample.fo2, sample.fhe);
    const ttsEl = document.getElementById('ttsValue');
    if (tts === 0 || (tts === Math.ceil(sample.depth / 10.0) && ceilingDepth < 0.1)) {
        ttsEl.textContent = Math.ceil(sample.depth / 10.0) + ' min';
        ttsEl.className = 'metric-value safe';
    } else {
        ttsEl.textContent = tts + ' min';
        ttsEl.className = 'metric-value warning';
    }
}

function animate() {
    if (!playing) return;

    currentIndex++;

    redraw();
    redrawDepthGraph();
    updateMetrics();
    if (hoveredComp >= 0 && lastTissuePointer) {
        showTissueTooltip(hoveredComp, lastTissuePointer.clientX, lastTissuePointer.clientY);
    }

    if (currentIndex >= tissueStates.length - 1) {
        playing = false;
        document.getElementById('playPauseBtn').textContent = 'Play';
        document.getElementById('statusText').textContent = 'Finished. Press Play to restart.';
        return;
    }

    timeoutId = setTimeout(animate, frameDelay);
}

function redraw() {
    // Logical (CSS) pixels — matches setTransform(dpr) so text is not stretched
    const canvasWidth = canvas.clientWidth || canvas.width;
    const canvasHeight = canvas.clientHeight || canvas.height;
    if (canvasWidth < 2 || canvasHeight < 2) return;

    ctx.fillStyle = THEME.canvasBg;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    prepareGraphText(ctx);

    // Separate width/height scales so portrait layouts do not squash type
    const scaleX = canvasWidth / 1920;
    const scaleY = canvasHeight / 670;
    const scaleFactor = Math.min(scaleX, scaleY);
    const isPortrait = canvasHeight / canvasWidth > 1.05;
    
    // Header — keep compact on short / portrait canvases
    const headerHeight = Math.max(
        isPortrait ? 28 : 36,
        Math.min(canvasHeight * (isPortrait ? 0.07 : 0.104), 70)
    );
    ctx.fillStyle = THEME.panelBg;
    ctx.fillRect(0, 0, canvasWidth, headerHeight);
    ctx.strokeStyle = THEME.border;
    ctx.beginPath();
    ctx.moveTo(0, headerHeight);
    ctx.lineTo(canvasWidth, headerHeight);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const headerFontSize = fitTextSize(Math.max(11, 14 * scaleFactor), headerHeight, 0.5);
    if (tissueStates.length > 0 && currentIndex < samples.length) {
        const t_s = times[currentIndex] / 1000;
        const depth = samples[currentIndex].depth;
        const pamb = ambientPressures[currentIndex];
        const fo2 = samples[currentIndex].fo2;
        const fhe = samples[currentIndex].fhe;
        const fn2 = Math.max(0, 1 - fo2 - fhe);

        ctx.fillStyle = THEME.ink;
        ctx.font = graphFont(headerFontSize, { weight: '600', min: 8 });
        ctx.fillText(
            `t=${t_s.toFixed(1)}s   depth=${depth.toFixed(1)} m   Pamb=${pamb.toFixed(3)} bar   FO2=${fo2.toFixed(2)} FHe=${fhe.toFixed(2)} FN2=${fn2.toFixed(2)}   [Frame ${currentIndex + 1}/${tissueStates.length}]`,
            Math.round(12 * Math.max(scaleFactor, 0.5)), Math.round(headerHeight / 2)
        );
    } else {
        ctx.fillStyle = THEME.inkSecondary;
        ctx.font = graphFont(headerFontSize, { min: 8 });
        ctx.fillText('Load a CSV log to visualize ZHL-16C tissue pressures.', Math.round(12 * Math.max(scaleFactor, 0.5)), Math.round(headerHeight / 2));
    }

    // Legend — auto width from measured text + icons (no overlap)
    const legendFontSize = Math.max(9, Math.min(12, 12 * scaleFactor));
    const legendPadX = Math.max(10, 12 * scaleFactor);
    const legendPadY = Math.max(6, 8 * scaleFactor);
    const legendGap = Math.max(14, 18 * scaleFactor);
    const legendIconGap = Math.max(6, 8 * scaleFactor);
    const boxSize = Math.max(10, Math.round(12 * scaleFactor));
    const lineIconW = Math.max(16, Math.round(18 * scaleFactor));

    ctx.font = graphFont(legendFontSize);
    const legendItems = [
        { kind: 'swatch', color: THEME.n2, label: 'N₂ tissue pressure' },
        { kind: 'swatch', color: THEME.he, label: 'He tissue pressure' },
        { kind: 'line', color: THEME.ambient, label: 'Ambient pressure reference' }
    ];

    let legendContentW = 0;
    for (let li = 0; li < legendItems.length; li++) {
        const item = legendItems[li];
        const iconW = item.kind === 'line' ? lineIconW : boxSize;
        legendContentW += iconW + legendIconGap + ctx.measureText(item.label).width;
        if (li < legendItems.length - 1) legendContentW += legendGap;
    }

    const legendWidth = Math.ceil(legendPadX * 2 + legendContentW);
    const legendHeight = Math.ceil(legendPadY * 2 + Math.max(boxSize, legendFontSize + 2));
    const legendX = Math.max(10, canvasWidth - legendWidth - 10);
    const legendY = headerHeight + 10 * scaleFactor;

    ctx.fillStyle = THEME.legendBg;
    ctx.strokeStyle = THEME.border;
    ctx.fillRect(legendX, legendY, legendWidth, legendHeight);
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);

    let legendCursorX = legendX + legendPadX;
    const legendMidY = legendY + legendHeight / 2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const item of legendItems) {
        if (item.kind === 'swatch') {
            ctx.fillStyle = item.color;
            ctx.fillRect(
                Math.round(legendCursorX),
                Math.round(legendMidY - boxSize / 2),
                boxSize,
                boxSize
            );
            legendCursorX += boxSize + legendIconGap;
        } else {
            ctx.strokeStyle = item.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(legendCursorX, legendMidY);
            ctx.lineTo(legendCursorX + lineIconW, legendMidY);
            ctx.stroke();
            legendCursorX += lineIconW + legendIconGap;
        }

        ctx.fillStyle = THEME.ink;
        ctx.font = graphFont(legendFontSize);
        ctx.fillText(item.label, Math.round(legendCursorX), Math.round(legendMidY));
        legendCursorX += ctx.measureText(item.label).width + legendGap;
    }

    // Draw compartments — reserve bottom space so x-axis ticks/labels are never covered
    const tickFontSize = Math.max(9, Math.min(12, 10 * scaleFactor));
    const tickLen = Math.max(4, Math.round(6 * scaleFactor));
    const tickLabelGap = Math.max(3, Math.round(5 * scaleFactor));
    const axisBottomPad = Math.max(4, Math.round(6 * scaleFactor));
    const axisBottomSpace = tickLen + tickLabelGap + tickFontSize + axisBottomPad;

    const legendClearance = Math.max(
        isPortrait ? 8 : 12,
        legendHeight + (isPortrait ? 10 : 16) * Math.max(scaleFactor, 0.4)
    );
    const topY = headerHeight + legendClearance;
    const bottomY = Math.max(topY + 16 * 8, canvasHeight - axisBottomSpace);
    const leftX = Math.max(8, 40 * Math.max(scaleX, 0.4));
    const rightX = canvasWidth - Math.max(8, 40 * Math.max(scaleX, 0.4));
    const rowH = Math.max(1, (bottomY - topY) / 16);
    // Font sizes track row height so portrait layouts do not vertically crush glyphs
    const preferredComp = Math.max(10, 12 * scaleFactor);
    const preferredHalf = Math.max(9, 11 * scaleFactor);
    const preferredValue = Math.max(9, 12 * scaleFactor);
    const compFontSize = fitTextSize(preferredComp, rowH, 0.55);
    const halfFontSize = fitTextSize(preferredHalf, rowH, 0.5);
    const valueFontSize = fitTextSize(preferredValue, rowH, 0.5);
    const labelGap = Math.max(6, 12 * Math.max(scaleX, 0.45));
    const labelPadRight = Math.max(8, 14 * Math.max(scaleX, 0.45));

    // Combined left-column labels; measure so bars start after the text
    const rowLabels = [];
    let maxLabelW = 0;
    for (let i = 0; i < 16; i++) {
        const compText = `Comp ${i + 1}`;
        const halfText = `N₂ ${ZHL16C_N2_HALF[i]}m  He ${ZHL16C_HE_HALF[i]}m`;
        ctx.font = graphFont(compFontSize, { weight: '600', min: 8 });
        const compW = ctx.measureText(compText).width;
        ctx.font = graphFont(halfFontSize, { min: 8 });
        const halfW = ctx.measureText(halfText).width;
        const totalW = compW + labelGap + halfW;
        rowLabels.push({ compText, halfText, compW });
        maxLabelW = Math.max(maxLabelW, totalW);
    }

    const labelWidth = Math.ceil(maxLabelW + labelPadRight);
    const barStartX = leftX + labelWidth;
    const barMaxW = Math.max(40, rightX - barStartX);

    // Determine max pressure
    let maxP = 8.0;
    if (tissueStates.length > 0 && currentIndex < tissueStates.length) {
        if (fixedScale) {
            maxP = maxAmbientPressure;
        } else {
            const state = tissueStates[currentIndex];
            const totals = state.pn2.map((pn2, i) => pn2 + state.phe[i]);
            maxP = Math.max(Math.max(...totals), ambientPressures[currentIndex]) * 1.15;
        }
    }

    tissueBarHitAreas = [];

    // Draw rows first (stop at bottomY so they do not cover the x-axis band)
    for (let i = 0; i < 16; i++) {
        const y0 = topY + i * rowH;
        const y1 = y0 + rowH;
        const yc = (y0 + y1) / 2;
        const { compText, halfText, compW } = rowLabels[i];
        const isHovered = hoveredComp === i;

        // Alternating background — only within plot area
        ctx.fillStyle = isHovered
            ? '#dceaf0'
            : (i % 2 === 0 ? THEME.rowEven : THEME.rowOdd);
        ctx.fillRect(0, y0, canvasWidth, rowH);

        // Combined Comp N + half-times in the left column
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = THEME.ink;
        ctx.font = graphFont(compFontSize, { weight: '600', min: 8 });
        ctx.fillText(compText, Math.round(leftX), Math.round(yc));

        ctx.fillStyle = THEME.muted;
        ctx.font = graphFont(halfFontSize, { min: 8 });
        ctx.fillText(halfText, Math.round(leftX + compW + labelGap), Math.round(yc));

        // Bars start after the left column
        if (tissueStates.length > 0 && currentIndex < tissueStates.length) {
            const state = tissueStates[currentIndex];
            const pn2 = state.pn2[i];
            const phe = state.phe[i];
            const ptotal = pn2 + phe;

            const w_n2 = (pn2 / maxP) * barMaxW;
            const w_he = (phe / maxP) * barMaxW;
            const barW = Math.max(w_n2 + w_he, 4);
            
            const barPadding = rowH * 0.15;
            const barY = y0 + barPadding;
            const barH = rowH - 2 * barPadding;

            // Hit area covers the full pressure track for easier hover
            tissueBarHitAreas.push({
                comp: i,
                x: barStartX,
                y: y0,
                w: barMaxW,
                h: rowH
            });

            // N2 segment
            ctx.fillStyle = THEME.n2;
            ctx.fillRect(barStartX, barY, w_n2, barH);

            // He segment
            ctx.fillStyle = THEME.he;
            ctx.fillRect(barStartX + w_n2, barY, w_he, barH);

            if (isHovered) {
                ctx.strokeStyle = THEME.ink;
                ctx.lineWidth = 2;
                ctx.strokeRect(
                    Math.round(barStartX) + 0.5,
                    Math.round(barY) + 0.5,
                    Math.max(1, Math.round(barW) - 1),
                    Math.max(1, Math.round(barH) - 1)
                );
            }

            // Ambient pressure line
            const pamb = ambientPressures[currentIndex];
            const xm = barStartX + (pamb / maxP) * barMaxW;
            ctx.strokeStyle = THEME.ambient;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(xm, y0 + barPadding * 0.5);
            ctx.lineTo(xm, y1 - barPadding * 0.5);
            ctx.stroke();

            // Numeric readout
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = THEME.ink;
            ctx.font = graphFont(valueFontSize, { mono: true, min: 8 });
            ctx.fillText(
                `PN2 ${pn2.toFixed(3)}  PHe ${phe.toFixed(3)}  Total ${ptotal.toFixed(3)} bar`,
                Math.round(rightX), Math.round(yc)
            );
        }
    }

    // Clear and draw x-axis band above the rows so labels stay visible
    ctx.fillStyle = THEME.canvasBg;
    ctx.fillRect(0, bottomY, canvasWidth, canvasHeight - bottomY);

    ctx.strokeStyle = THEME.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(barStartX, topY);
    ctx.lineTo(barStartX, bottomY);
    ctx.lineTo(rightX, bottomY);
    ctx.stroke();

    ctx.fillStyle = THEME.muted;
    ctx.font = graphFont(tickFontSize, { min: 8 });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const numTicks = 8;
    for (let i = 0; i <= numTicks; i++) {
        const p = (i / numTicks) * maxP;
        const x = barStartX + (p / maxP) * barMaxW;
        ctx.beginPath();
        ctx.moveTo(x, bottomY);
        ctx.lineTo(x, bottomY + tickLen);
        ctx.stroke();
        ctx.fillText(p.toFixed(1), Math.round(x), Math.round(bottomY + tickLen + tickLabelGap));
    }
}

function redrawDepthGraph() {
    const canvasWidth = depthCanvas.clientWidth || depthCanvas.width;
    const canvasHeight = depthCanvas.clientHeight || depthCanvas.height;
    if (canvasWidth < 2 || canvasHeight < 2) return;

    depthCtx.fillStyle = THEME.panelBg;
    depthCtx.fillRect(0, 0, canvasWidth, canvasHeight);
    prepareGraphText(depthCtx);

    if (samples.length === 0) {
        depthCtx.fillStyle = THEME.muted;
        depthCtx.font = graphFont(Math.max(11, canvasHeight * 0.045), { min: 8 });
        depthCtx.textAlign = 'center';
        depthCtx.textBaseline = 'middle';
        depthCtx.fillText('Depth vs Time graph will appear here', Math.round(canvasWidth / 2), Math.round(canvasHeight / 2));
        return;
    }

    const scaleFactor = Math.min(canvasWidth / 960, canvasHeight / 280);

    const axisLabelSize = Math.max(11, 12 * scaleFactor);
    const tickSize = Math.max(11, 10 * scaleFactor);
    const titleSize = Math.max(13, 14 * scaleFactor);
    const bottomPad = Math.max(6, Math.round(8 * scaleFactor));
    const tickLabelGap = Math.max(6, Math.round(8 * scaleFactor));
    // Room for tick marks + tick labels + "Time (mm:ss)" above the canvas edge / footer
    const bottomMargin = Math.max(
        56,
        Math.round(tickLabelGap + tickSize + 6 + axisLabelSize + bottomPad + 8 * scaleFactor)
    );

    const margin = { 
        top: Math.max(30, 40 * scaleFactor), 
        right: Math.max(20, 30 * scaleFactor), 
        bottom: bottomMargin, 
        left: Math.max(60, 80 * scaleFactor) 
    };
    
    // Store margins for mouse interaction
    graphMargins = margin;
    
    const graphWidth = canvasWidth - margin.left - margin.right;
    const graphHeight = canvasHeight - margin.top - margin.bottom;

    const maxTime = Math.max(...times);
    const maxDepth = Math.max(...samples.map(s => s.depth));
    const surfaceBar = getSurfacePressure();

    // Draw axis labels FIRST (background layer) - FIXED POSITION
    depthCtx.fillStyle = THEME.inkSecondary;
    depthCtx.font = graphFont(axisLabelSize, { min: 8 });
    depthCtx.textAlign = 'center';
    depthCtx.textBaseline = 'middle';
    
    // Y-axis label - FIXED POSITION
    depthCtx.save();
    depthCtx.translate(Math.round(Math.max(12, 15 * scaleFactor)), Math.round(canvasHeight / 2));
    depthCtx.rotate(-Math.PI / 2);
    depthCtx.fillText('Depth (m)', 0, 0);
    depthCtx.restore();
    
    // X-axis title — baseline bottom so it stays inside the canvas above the footer
    depthCtx.textBaseline = 'bottom';
    depthCtx.fillText(
        'Time (mm:ss)',
        Math.round(canvasWidth / 2),
        Math.round(canvasHeight - bottomPad)
    );

    // Draw title - FIXED POSITION
    depthCtx.fillStyle = THEME.ink;
    depthCtx.font = graphFont(titleSize, { weight: '600', min: 8 });
    depthCtx.textAlign = 'center';
    depthCtx.textBaseline = 'top';
    depthCtx.fillText('Depth vs Time', Math.round(canvasWidth / 2), Math.round(Math.max(8, 10 * scaleFactor)));

    // Draw axes
    depthCtx.strokeStyle = THEME.axis;
    depthCtx.lineWidth = 1;
    depthCtx.beginPath();
    depthCtx.moveTo(margin.left, margin.top);
    depthCtx.lineTo(margin.left, margin.top + graphHeight);
    depthCtx.lineTo(margin.left + graphWidth, margin.top + graphHeight);
    depthCtx.stroke();

    // Y-axis labels
    depthCtx.fillStyle = THEME.muted;
    depthCtx.font = graphFont(tickSize, { min: 8 });
    depthCtx.textAlign = 'right';
    depthCtx.textBaseline = 'middle';
    
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
        const depth = (i / yTicks) * maxDepth;
        const y = margin.top + (i / yTicks) * graphHeight;
        
        depthCtx.beginPath();
        depthCtx.moveTo(margin.left - 5, y);
        depthCtx.lineTo(margin.left, y);
        depthCtx.stroke();
        
        depthCtx.fillText(depth.toFixed(1) + ' m', Math.round(margin.left - 8), Math.round(y));
    }

    // X-axis tick labels (above the "Time (mm:ss)" title)
    depthCtx.textAlign = 'center';
    depthCtx.textBaseline = 'top';
    const xTickLabelY = Math.round(margin.top + graphHeight + tickLabelGap);
    
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
        const time = (i / xTicks) * maxTime / 1000;
        const x = margin.left + (i / xTicks) * graphWidth;
        
        depthCtx.beginPath();
        depthCtx.moveTo(x, margin.top + graphHeight);
        depthCtx.lineTo(x, margin.top + graphHeight + 5);
        depthCtx.stroke();
        
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        depthCtx.fillText(`${minutes}:${seconds.toString().padStart(2, '0')}`, Math.round(x), xTickLabelY);
    }

    // Highlight deco zones (NDL = 0 or in deco)
    depthCtx.fillStyle = THEME.decoZone;
    for (let i = 0; i < samples.length - 1; i++) {
        if (ndls[i] === 0 || ceilings[i] > 0.1) {
            const x1 = margin.left + (times[i] / maxTime) * graphWidth;
            const x2 = margin.left + (times[i + 1] / maxTime) * graphWidth;
            depthCtx.fillRect(x1, margin.top, x2 - x1, graphHeight);
        }
    }

    // Draw depth profile
    depthCtx.strokeStyle = THEME.depthLine;
    depthCtx.lineWidth = Math.max(1.5, 2 * scaleFactor);
    depthCtx.beginPath();
    
    for (let i = 0; i < samples.length; i++) {
        const x = margin.left + (times[i] / maxTime) * graphWidth;
        const y = margin.top + (samples[i].depth / maxDepth) * graphHeight;
        
        if (i === 0) {
            depthCtx.moveTo(x, y);
        } else {
            depthCtx.lineTo(x, y);
        }
    }
    depthCtx.stroke();

    // Draw ceiling line (green)
    if (currentIndex < ceilings.length && ceilings[currentIndex] > 0.1) {
        const ceilingDepth = ceilings[currentIndex];
        const ceilingY = margin.top + (ceilingDepth / maxDepth) * graphHeight;
        
        depthCtx.strokeStyle = THEME.ceiling;
        depthCtx.lineWidth = Math.max(2, 2.5 * scaleFactor);
        depthCtx.setLineDash([8, 4]);
        depthCtx.beginPath();
        depthCtx.moveTo(margin.left, ceilingY);
        depthCtx.lineTo(margin.left + graphWidth, ceilingY);
        depthCtx.stroke();
        depthCtx.setLineDash([]);
        
        // Label for ceiling
        depthCtx.fillStyle = THEME.ceiling;
        depthCtx.font = graphFont(Math.max(11, 10 * scaleFactor), { weight: '600' });
        depthCtx.textAlign = 'left';
        depthCtx.textBaseline = 'bottom';
        depthCtx.fillText(`Ceiling: ${ceilingDepth.toFixed(1)} m`, Math.round(margin.left + 5), Math.round(ceilingY - 3));
    }

    // Draw current position indicator
    if (currentIndex < samples.length) {
        const currentX = margin.left + (times[currentIndex] / maxTime) * graphWidth;
        const currentY = margin.top + (samples[currentIndex].depth / maxDepth) * graphHeight;
        
        // Vertical line
        depthCtx.strokeStyle = THEME.cursor;
        depthCtx.lineWidth = Math.max(1.5, 2 * scaleFactor);
        depthCtx.setLineDash([5, 5]);
        depthCtx.beginPath();
        depthCtx.moveTo(currentX, margin.top);
        depthCtx.lineTo(currentX, margin.top + graphHeight);
        depthCtx.stroke();
        depthCtx.setLineDash([]);
        
        // Circle
        depthCtx.fillStyle = THEME.cursor;
        depthCtx.beginPath();
        depthCtx.arc(currentX, currentY, Math.max(3, 5 * scaleFactor), 0, Math.PI * 2);
        depthCtx.fill();
    }
}

function renderSettings() {
    if (!settings) return;

    const product = settings['Product'] || settings['product'] || settings['Product Name'] || 'N/A';
    const startCNS = settings['Start CNS'] || 'N/A';
    const endCNS = settings['End CNS'] || 'N/A';

    const html = `
        <p><strong>Product:</strong> ${product} &nbsp;&nbsp; <strong>Model:</strong> ${settings['Computer Model'] || ''} &nbsp;&nbsp; <strong>Serial:</strong> ${settings['Computer Serial Number'] || ''}</p>
        <p><strong>Start:</strong> ${settings['Start Date'] || ''} &nbsp;&nbsp; <strong>End:</strong> ${settings['End Date'] || ''}</p>
        <p><strong>Dive #:</strong> ${settings['Dive Number'] || ''} &nbsp;&nbsp; <strong>Max Depth:</strong> ${settings['Max Depth'] || ''} &nbsp;&nbsp; <strong>Max Time:</strong> ${settings['Max Time'] || ''}</p>
        <p><strong>Deco Model:</strong> ${settings['Deco Model'] || ''} &nbsp;&nbsp; <strong>GF:</strong> ${gfLow}/${gfHigh} &nbsp;&nbsp; <strong>VPM-B:</strong> ${settings['VPM-B Conservatism'] || ''}</p>
        <p><strong>Start CNS:</strong> ${startCNS} &nbsp;&nbsp; <strong>End CNS:</strong> ${endCNS}</p>
        <p><strong>Surface pressure (bar):</strong> ${getSurfacePressure().toFixed(3)} &nbsp;&nbsp; (Start mbar: ${settings['Start Surface Pressure'] || ''}, End mbar: ${settings['End Surface Pressure'] || ''})</p>
    `;

    document.getElementById('settingsPanel').innerHTML = html;
}
    