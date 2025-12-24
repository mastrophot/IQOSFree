import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, linkWithPopup, signOut, signInWithCredential } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

import { firebaseConfig, appId } from './firebase-config.js';
import { getStickPluralForm, formatHoursToReadable, formatMinutesToReadable } from './utils.js';
import { renderSmokeChart, destroyChart } from './charts.js';

// --- APPLICATION STATE ---
let app;
let db;
let auth;

let userId = null;
let dataRef = null;
const getDefaultAppData = () => ({
    lastSmokeTime: null,
    smokeHistory: [],
    settings: {
        packPrice: 5,
        packSize: 20,
        oldHabit: 20, 
        smokeIntervalMinutes: 60, 
        desiredDailySticks: 10 
    },
    longestSmokeFreeStreakHours: 0,
    appStartDate: new Date().setHours(0,0,0,0),
    healthIntegrity: 100,
    lastIntegrityUpdate: Date.now()
});

let appData = getDefaultAppData();

let eventListenersAttached = false;
let isInitialAuthCheckComplete = false;

// --- DOM ELEMENTS ---
// (Initialized in DOMContentLoaded)
let loader, appContainer, mainView, settingsView, timerEl, statusMessageEl;
let smokeButton, emergencySmokeButton, openSettingsButton, closeSettingsButton, saveSettingsButton, resetDataButton;
let smokedTodayValueEl, smokedTodayPlannedEl, spentTodayValueEl, spentTodayPlannedEl;
let smokeFreeStreakEl, longestSmokeFreeStreakEl;
let balanceCardEl, financialBalanceLabelEl, financialBalanceValueEl, balanceIconEl;
let signInGoogleButton, signOutButton, userStatusDisplay;
let packPriceInput, packSizeInput, oldHabitInput, smokeIntervalMinutesInput, oldHabitMoneyEl, desiredDailySticksInput, desiredDailySticksMoneyEl;
let dailySmokingChartSection, dailySmokeChartCanvas;
let statisticsSection, smokeChartCanvas;
let totalSmokesAllTimeEl, avgSmokesPerDayEl;
let statsTabs, statsModeBtns;
let treeContainerEl, toxicCloudEl, healthValueEl; // New Life Tree Elements 2025
let insightsSection, peakHourValueEl, activityHeatmapEl, heatmapLabelsEl;
let currentChartPeriod = 'day';
let currentChartMode = 'sticks';
let confirmModal, modalText, confirmYes, confirmNo;

function showConfirm(text, onConfirm) {
    modalText.textContent = text;
    confirmModal.classList.remove('hidden');
    
    // Remove old listeners by cloning
    const newConfirmYes = confirmYes.cloneNode(true);
    confirmYes.parentNode.replaceChild(newConfirmYes, confirmYes);
    confirmYes = newConfirmYes;
    
    const newConfirmNo = confirmNo.cloneNode(true);
    confirmNo.parentNode.replaceChild(newConfirmNo, confirmNo);
    confirmNo = newConfirmNo;

    confirmYes.onclick = () => {
        onConfirm();
        confirmModal.classList.add('hidden');
    };
    confirmNo.onclick = () => {
        confirmModal.classList.add('hidden');
    };
}

async function loadData() {
    if (!userId) {
        console.warn("[loadData] userId is null. Using default/local data.");
        updateSettingsInputs(); 
        if (!eventListenersAttached) attachEventListeners();
        loader.classList.add('hidden');
        appContainer.classList.remove('hidden');
        return;
    }

    console.log(`[loadData] Loading data for userId: ${userId}`);
    dataRef = doc(db, `artifacts/${appId}/users/${userId}/smokingData/data`);
    try {
        const docSnap = await getDoc(dataRef);
        if (docSnap.exists()) {
            const loadedData = docSnap.data();
            appData.lastSmokeTime = loadedData.lastSmokeTime || null;
            appData.smokeHistory = (loadedData.smokeHistory || []).map(smoke => {
                if (typeof smoke === 'number') return { timestamp: smoke, type: 'regular' };
                return { timestamp: smoke.timestamp, type: smoke.type || 'regular' }; 
            });
            // Migrate hours to minutes if needed
            if (loadedData.settings && loadedData.settings.smokeIntervalHours !== undefined && loadedData.settings.smokeIntervalMinutes === undefined) {
                loadedData.settings.smokeIntervalMinutes = loadedData.settings.smokeIntervalHours * 60;
            }
            appData.settings = { ...appData.settings, ...loadedData.settings };
            appData.settings.desiredDailySticks = loadedData.settings?.desiredDailySticks ?? 10;
            
            // Health Migration/Fallbacks
            appData.healthIntegrity = loadedData.healthIntegrity ?? 100;
            appData.lastIntegrityUpdate = loadedData.lastIntegrityUpdate || Date.now();

            // Date Migration: If appStartDate is missing or history exists MUCH earlier, prefer first smoke date
            const savedStartDate = loadedData.appStartDate || 0;
            const firstSmokeTime = appData.smokeHistory.length > 0 ? appData.smokeHistory[0].timestamp : Date.now();
            const startOfDayOfFirstSmoke = new Date(firstSmokeTime).setHours(0,0,0,0);
            
            if (savedStartDate === 0) {
                appData.appStartDate = startOfDayOfFirstSmoke;
            } else {
                // Ensure the saved date is also normalized to start of day for consistency
                appData.appStartDate = new Date(Math.min(savedStartDate, startOfDayOfFirstSmoke)).setHours(0,0,0,0);
            }
            
            appData.longestSmokeFreeStreakHours = loadedData.longestSmokeFreeStreakHours || 0;
        } else {
            console.log("No such document! Creating default.");
            appData = getDefaultAppData();
            await saveData(); 
        }
    } catch (error) {
        console.error("Error loading data: ", error);
        loader.textContent = "Помилка завантаження даних. Спробуйте оновити сторінку.";
        return; 
    }

    updateSettingsInputs();
    if (!eventListenersAttached) attachEventListeners();
    loader.classList.add('hidden');
    appContainer.classList.remove('hidden');
}

async function saveData() {
    if (!dataRef || !userId) return;
    try {
        await setDoc(dataRef, appData);
        console.log("Data saved.");
    } catch (error) {
        console.error("Error saving data: ", error);
    }
}

// --- WIDGET SYNC ---
// Removed by user request

function updateUI() {
    const now = new Date().getTime();
    const currentSmokeInterval = appData.settings.smokeIntervalMinutes * 60 * 1000;
    const timeSinceLastSmoke = appData.lastSmokeTime ? now - appData.lastSmokeTime : currentSmokeInterval;
    const timeRemaining = currentSmokeInterval - timeSinceLastSmoke;

    if (timeRemaining > 0) {
        const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeRemaining % (1000 * 60)) / 1000);
        timerEl.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        timerEl.classList.remove('text-green-400');
        timerEl.classList.add('text-red-500');
        statusMessageEl.textContent = 'Час до наступної';
        smokeButton.disabled = true;
    } else {
        timerEl.textContent = "GO!";
        timerEl.classList.remove('text-red-500');
        timerEl.classList.add('text-green-400');
        statusMessageEl.textContent = 'Можна курити';
        smokeButton.disabled = false;
    }

    emergencySmokeButton.disabled = false;
    updateStatistics(now);

    renderSmokeChart(smokeChartCanvas, appData.smokeHistory, currentChartPeriod, currentChartMode, appData.settings);
    updateStatistics(now);
    updateAvatar(); // Call Avatar Update

    renderSmokeChart(smokeChartCanvas, appData.smokeHistory, currentChartPeriod, currentChartMode, appData.settings);
    updateGlobalStats();
}

function updateStatistics(now) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const smokedTodayCount = appData.smokeHistory.filter(smoke => smoke.timestamp >= todayTimestamp).length; 
    const { packPrice, packSize, oldHabit, desiredDailySticks } = appData.settings; 
    const pricePerCig = (packSize > 0) ? packPrice / packSize : 0;

    smokedTodayValueEl.textContent = `${smokedTodayCount} ${getStickPluralForm(smokedTodayCount)}`; 
    smokedTodayPlannedEl.textContent = `З ${desiredDailySticks} запланованих`;

    const actualSpentToday = smokedTodayCount * pricePerCig;
    const plannedSpentToday = desiredDailySticks * pricePerCig;
    
    spentTodayValueEl.textContent = `$${actualSpentToday.toFixed(2)}`; 
    spentTodayPlannedEl.textContent = `З $${plannedSpentToday.toFixed(2)} запланованих`;

    if (smokedTodayCount > desiredDailySticks) {
        spentTodayValueEl.classList.remove('text-green-400');
        spentTodayValueEl.classList.add('text-red-500');
    } else {
        spentTodayValueEl.classList.remove('text-red-500');
        spentTodayValueEl.classList.add('text-green-400');
    }

    const daysSinceAppStart = Math.max(0.0001, (now - appData.appStartDate) / (1000 * 60 * 60 * 24));
    const expectedTotalSmokes = daysSinceAppStart * oldHabit; 
    const actualTotalSmokes = appData.smokeHistory.length;
    
    // Financial Balance Logic (Signed Profit/Loss)
    const balance = (expectedTotalSmokes - actualTotalSmokes) * pricePerCig;
    financialBalanceValueEl.textContent = `${balance < 0 ? '-' : '+'}$${Math.abs(balance).toFixed(2)}`;

    if (balance >= 0) {
        financialBalanceValueEl.classList.remove('text-red-500');
        financialBalanceValueEl.classList.add('text-emerald-400');
        financialBalanceLabelEl.textContent = 'Зекономлено (Профіт)';
        balanceCardEl.classList.replace('border-red-500/50', 'border-emerald-500/50');
        balanceIconEl.textContent = '💰';
    } else {
        financialBalanceValueEl.classList.remove('text-emerald-400');
        financialBalanceValueEl.classList.add('text-red-500');
        financialBalanceLabelEl.textContent = 'Перевитрата (Дефіцит)';
        balanceCardEl.classList.remove('border-emerald-500/50');
        balanceCardEl.classList.add('border-red-500/50');
        balanceIconEl.textContent = '⚠️';
    }


    let streakMinutes = 0;
    if (appData.lastSmokeTime === null) {
        streakMinutes = Math.floor((now - appData.appStartDate) / (1000 * 60));
    } else {
        const diffTime = Math.abs(now - appData.lastSmokeTime);
        streakMinutes = Math.floor(diffTime / (1000 * 60));
    }
    
    let currentStreakHoursForLongest = Math.floor(streakMinutes / 60); 
    if (currentStreakHoursForLongest > appData.longestSmokeFreeStreakHours) {
        appData.longestSmokeFreeStreakHours = currentStreakHoursForLongest;
        saveData(); 
    }
    longestSmokeFreeStreakEl.textContent = formatHoursToReadable(appData.longestSmokeFreeStreakHours);
    smokeFreeStreakEl.textContent = formatMinutesToReadable(streakMinutes);


    updateInsights();
}

function updateInsights() {
    insightsSection.classList.remove('hidden');
    
    let labels = [];
    let data = [];
    let peakLabel = '';
    let peakValueText = '';

    const now = new Date();

    if (currentChartPeriod === 'day') {
        // Day Logic (Hourly)
        document.querySelector('#insightsSection span.uppercase').textContent = 'Пікова активність (Години)';
        labels = ['00:00', '06:00', '12:00', '18:00', '23:59'];
        data = new Array(24).fill(0);
        
        // Use last 30 days history for better hourly insights
        const recentHistory = appData.smokeHistory.filter(s => s.timestamp > (Date.now() - 30 * 24 * 60 * 60 * 1000));
        recentHistory.forEach(s => {
            const h = new Date(s.timestamp).getHours();
            data[h]++;
        });

        // Find peak 3-hour window
        let maxWindowSum = 0;
        let maxWindowStart = 0;
        for (let i = 0; i < 22; i++) {
            const sum = data[i] + data[i+1] + data[i+2];
            if (sum > maxWindowSum) {
                maxWindowSum = sum;
                maxWindowStart = i;
            }
        }
        peakValueText = `${maxWindowStart}:00 - ${maxWindowStart+3}:00`;

    } else if (currentChartPeriod === 'week') {
        // Week Logic (Daily)
        document.querySelector('#insightsSection span.uppercase').textContent = 'Найважчий день';
        data = new Array(7).fill(0);
        const dayNames = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']; 
        labels = []; 

        // Analyze last 3 months to find "Busiest Day of Week" generally
        const recentHistory = appData.smokeHistory.filter(s => s.timestamp > (Date.now() - 90 * 24 * 60 * 60 * 1000));
        recentHistory.forEach(s => {
            const day = new Date(s.timestamp).getDay(); // 0 = Sun, 1 = Mon
            data[day]++;
        });

        // Shift to start from Monday (standard in UA)
        // JS getDay(): 0=Sun. We want Mon, Tue ... Sun.
        // Data index: 0(Sun), 1(Mon)...
        // We want display: 1, 2, 3, 4, 5, 6, 0
        const orderedData = [];
        const orderedLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
        const map = [1, 2, 3, 4, 5, 6, 0];
        
        map.forEach(dayIdx => {
            orderedData.push(data[dayIdx]);
        });
        
        data = orderedData;
        labels = orderedLabels; // Just show all or first/last? For 7 bars we can verify layout.

        const maxVal = Math.max(...data, 0);
        const maxIdx = data.indexOf(maxVal);
        peakValueText = orderedLabels[maxIdx];

    } else if (currentChartPeriod === 'all') {
        // All Logic (Monthly)
        document.querySelector('#insightsSection span.uppercase').textContent = 'Найважчий місяць';
        data = new Array(12).fill(0);
        const monthNames = ['Січ', 'Лют', 'Бер', 'Кві', 'Тра', 'Чер', 'Лип', 'Сер', 'Вер', 'Жов', 'Лис', 'Гру'];
        labels = ['Січ', '', '', '', '', '', '', '', '', '', '', 'Гру'];

        appData.smokeHistory.forEach(s => {
            const m = new Date(s.timestamp).getMonth();
            data[m]++;
        });

        const maxVal = Math.max(...data, 0);
        const maxIdx = data.indexOf(maxVal);
        peakValueText = monthNames[maxIdx];
    }

    peakHourValueEl.textContent = peakValueText;

    // Render Heatmap
    const maxValInsights = Math.max(...data, 1);
    activityHeatmapEl.innerHTML = '';
    
    data.forEach(val => {
        const intensity = val / maxValInsights;
        const bar = document.createElement('div');
        bar.className = 'flex-1 h-full mx-[1px] rounded-sm'; // Added margin for separate bars
        if (currentChartPeriod === 'day') bar.className = 'flex-1 h-full'; // Continous for time
        
        bar.style.backgroundColor = `rgba(239, 68, 68, ${intensity * 0.8 + 0.1})`; 
        if (intensity >= 0.9) bar.classList.add('shadow-[0_0_10px_rgba(239,68,68,0.5)]', 'z-10', 'relative');
        activityHeatmapEl.appendChild(bar);
    });

    // Render Labels
    if (heatmapLabelsEl) {
        heatmapLabelsEl.innerHTML = '';
        if (currentChartPeriod === 'day') {
             labels.forEach(l => {
                 const s = document.createElement('span');
                 s.textContent = l;
                 heatmapLabelsEl.appendChild(s);
             });
        } else {
             // For Week/All spread evenly
             labels.forEach(l => {
                 const s = document.createElement('span');
                 s.textContent = l;
                 heatmapLabelsEl.appendChild(s);
             });
        }
    }
}



function updateAvatar() { // Life Tree Logic 2025
    if (!treeContainerEl || !healthValueEl) return;
    
    // Safety Fallback for NaN
    appData.healthIntegrity = Number(appData.healthIntegrity);
    appData.lastIntegrityUpdate = Number(appData.lastIntegrityUpdate);
    
    if (isNaN(appData.healthIntegrity)) appData.healthIntegrity = 100;
    if (isNaN(appData.lastIntegrityUpdate)) appData.lastIntegrityUpdate = Date.now();

    // 1. Regenerate Health (1% per hour)
    const now = Date.now();
    const lastUpdate = appData.lastIntegrityUpdate || now;
    const diffHours = (now - lastUpdate) / (1000 * 60 * 60);
    
    if (diffHours > 0) {
        const regenAmount = diffHours * 1; 
        if (appData.healthIntegrity < 100) {
            appData.healthIntegrity = Math.min(100, appData.healthIntegrity + regenAmount);
            appData.lastIntegrityUpdate = now;
        }
    }

    // 2. Evolution Stage (Based on Current Streak)
    // We use lastSmokeTime to determine the "age" of the current tree
    const streakMs = appData.lastSmokeTime ? (now - appData.lastSmokeTime) : (now - appData.appStartDate);
    const streakDays = streakMs / (1000 * 60 * 60 * 24);
    
    let stage = 1; // Sprout
    if (streakDays >= 7) stage = 4; // Oak
    else if (streakDays >= 3) stage = 3; // Tree
    else if (streakDays >= 1) stage = 2; // Sapling

    // 3. Render Tree SVG
    renderLifeTree(stage, appData.healthIntegrity);

    // 4. Update Labels
    const health = Math.round(appData.healthIntegrity);
    healthValueEl.textContent = `Дерево Життя: ${health}%`;
    
    // Dynamic styling for health label
    healthValueEl.classList.remove('text-primary-glow', 'text-warning', 'text-error', 'border-emerald-500/20', 'border-warning/20', 'border-error/20');
    if (health > 70) {
        healthValueEl.classList.add('text-primary-glow', 'border-emerald-500/20');
    } else if (health > 30) {
        healthValueEl.classList.add('text-warning', 'border-warning/20');
    } else {
        healthValueEl.classList.add('text-error', 'border-error/20');
    }
}

function renderLifeTree(stage, health) {
    const container = treeContainerEl;
    let svg = container.querySelector('svg');
    
    if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 240 240");
        svg.setAttribute("class", "w-full h-full relative z-0");
        container.appendChild(svg);
    }

    // 1. Define Colors & Gradients logic.
    const isSick = health < 40;
    const foliageColor = isSick ? 'oklch(65% 0.15 70)' : 'oklch(75% 0.18 165)';
    const foliageDark = isSick ? 'oklch(50% 0.12 70)' : 'oklch(60% 0.15 165)';
    const trunkColor = 'oklch(35% 0.05 45)';

    let innerHTML = `
        <defs>
            <radialGradient id="foliageGrad" cx="40%" cy="40%" r="60%">
                <stop offset="0%" style="stop-color:${foliageColor};" />
                <stop offset="100%" style="stop-color:${foliageDark};" />
            </radialGradient>
            <filter id="softBlur" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="2" />
            </filter>
        </defs>
    `;

    // 2. Trunk Design (Flared and textured) logic.
    const trunkW = 16 + (stage * 6);
    const trunkH = 50 + (stage * 20);
    const baseY = 210;
    const topY = baseY - trunkH;
    
    // More organic trunk path logic.
    const trunkPath = `
        M ${120 - trunkW/1.2} ${baseY} 
        Q ${120 - trunkW} ${baseY + 10} ${120 - trunkW*1.5} ${baseY + 15}
        L ${120 + trunkW*1.5} ${baseY + 15}
        Q ${120 + trunkW} ${baseY + 10} ${120 + trunkW/1.2} ${baseY}
        L ${120 + trunkW/3} ${topY}
        Q ${120} ${topY - 10} ${120 - trunkW/3} ${topY}
        Z
    `;
    
    innerHTML += `<path class="tree-trunk" d="${trunkPath}" fill="${trunkColor}" />`;
    
    // Bark texture (simple vertical lines) logic.
    for(let j=0; j<3; j++) {
        const lineX = 120 - (trunkW/4) + (j * (trunkW/4));
        innerHTML += `<path d="M ${lineX} ${baseY} Q ${lineX + (Math.random()*4-2)} ${baseY-trunkH/2} ${lineX} ${topY+10}" stroke="oklch(0% 0 0 / 15%)" stroke-width="2" fill="none" opacity="0.4" />`;
    }

    // 3. Fluffy Canopy Blobs logic.
    // Each blob is an overlapping cloud section logic.
    const blobCount = 3 + (stage * 2);
    const radius = 30 + (stage * 12);
    const centerX = 120;
    const centerY = topY + 10;
    
    const visiblePercent = health / 100;
    const leavesToRender = Math.floor(visiblePercent * blobCount);

    for (let i = 0; i < blobCount; i++) {
        const angle = (i / blobCount) * Math.PI * 2 - Math.PI/2;
        const dist = radius * 0.7;
        const bx = centerX + Math.cos(angle) * dist;
        const by = centerY + Math.sin(angle) * (dist * 0.8);
        const bRadius = radius * (0.8 + Math.sin(i)*0.2);
        
        const isVisible = i < leavesToRender || i === 0; // Center blob always partially visible logic.
        const opacity = isVisible ? 1 : 0.2;
        const scale = isVisible ? 1 : 0.5;

        // The Cloud Blob logic.
        innerHTML += `
            <g style="transition: all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1); transform: translate(${bx}px, ${by}px) scale(${scale}); opacity: ${opacity}">
                <circle cx="0" cy="0" r="${bRadius}" fill="url(#foliageGrad)" />
                <!-- Small Leaves on top of blob -->
                ${renderLeafParticles(bRadius, isSick)}
            </g>
        `;
    }

    svg.innerHTML = innerHTML;
}

function renderLeafParticles(radius, isSick) {
    let leaves = '';
    const leafColor = isSick ? 'oklch(55% 0.12 75)' : 'oklch(85% 0.15 165)';
    for(let l=0; l<4; l++) {
        const la = (l/4) * Math.PI * 2;
        const lx = Math.cos(la) * (radius * 0.6);
        const ly = Math.sin(la) * (radius * 0.6);
        const rot = (la * 180 / Math.PI) + 45;
        leaves += `<ellipse cx="${lx}" cy="${ly}" rx="6" ry="3" fill="${leafColor}" transform="rotate(${rot} ${lx} ${ly})" opacity="0.8" />`;
    }
    return leaves;
}

function updateGlobalStats() {
    const totalSmokes = appData.smokeHistory.length;
    totalSmokesAllTimeEl.textContent = totalSmokes;

    const daysSinceStart = Math.max(1, (new Date().getTime() - appData.appStartDate) / (1000 * 60 * 60 * 24));
    const avg = totalSmokes / daysSinceStart;
    avgSmokesPerDayEl.textContent = avg.toFixed(1);
}

function handleChartTabClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    // Update State
    currentChartPeriod = btn.dataset.period;

    // Update UI
    statsTabs.forEach(t => {
        t.classList.remove('active', 'bg-slate-700', 'text-white', 'font-bold', 'shadow-sm');
        t.classList.add('text-slate-400', 'font-medium');
        if (t === btn) {
            t.classList.add('active', 'bg-slate-700', 'text-white', 'font-bold', 'shadow-sm');
            t.classList.remove('text-slate-400', 'font-medium');
        }
    });

    updateUI();
    updateUI();
}

function handleChartModeClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    currentChartMode = btn.dataset.mode;

    statsModeBtns.forEach(b => {
        b.classList.remove('active', 'bg-slate-700', 'text-white', 'shadow-sm');
        b.classList.add('text-slate-400');
        if (b === btn) {
            b.classList.add('active', 'bg-slate-700', 'text-white', 'shadow-sm');
            b.classList.remove('text-slate-400');
        }
    });
    updateUI();
}

function triggerLeafFall(count = 5) {
    if (!treeContainerEl) return;
    
    for (let i = 0; i < count; i++) {
        const leaf = document.createElement('div');
        leaf.className = 'leaf-falling absolute';
        
        // Random start position within tree canopy area logic.
        const x = 110 + (Math.random() * 60 - 30);
        const y = 80 + (Math.random() * 40 - 20);
        
        leaf.style.left = `${x}px`;
        leaf.style.top = `${y}px`;
        leaf.style.width = '12px';
        leaf.style.height = '6px';
        leaf.style.borderRadius = '50%';
        leaf.style.background = 'oklch(60% 0.15 165)';
        leaf.style.zIndex = '5';
        
        treeContainerEl.appendChild(leaf);
        setTimeout(() => leaf.remove(), 2000);
    }
}

function handleSmoke(type = 'regular') {
    console.log(`[handleSmoke] ${type} smoke button clicked!`);
    
    // Tree Feedback Logic 2025
    if (treeContainerEl && toxicCloudEl) {
        const isEmergency = type === 'emergency';
        const shakeClass = isEmergency ? 'tree-shake-heavy' : 'tree-shake-light';
        
        treeContainerEl.classList.add(shakeClass);
        toxicCloudEl.classList.add('active');
        
        // Trigger leaf particles logic.
        triggerLeafFall(isEmergency ? 12 : 5);
        
        setTimeout(() => {
            treeContainerEl.classList.remove(shakeClass);
            toxicCloudEl.classList.remove('active');
        }, 1200);
    }

    // Integrity Deduction Logic (User custom: Emergency is HEAVIER)
    const damage = type === 'regular' ? 10 : 25;
    appData.healthIntegrity = Math.max(0, appData.healthIntegrity - damage);
    
    appData.lastSmokeTime = new Date().getTime();
    appData.smokeHistory.push({ timestamp: appData.lastSmokeTime, type: type });
    saveData();
    updateUI();
}

function updateSettingsInputs() {
    packPriceInput.value = appData.settings.packPrice;
    packSizeInput.value = appData.settings.packSize;
    oldHabitInput.value = appData.settings.oldHabit;
    smokeIntervalMinutesInput.value = appData.settings.smokeIntervalMinutes;
    desiredDailySticksInput.value = appData.settings.desiredDailySticks; 
    updateOldHabitMoneyDisplay(); 
    updateDesiredDailySticksMoneyDisplay(); 
}

function updateOldHabitMoneyDisplay() {
    const packPrice = Number(packPriceInput.value) || 0;
    const packSize = Number(packSizeInput.value) || 1;
    const oldHabit = Number(oldHabitInput.value) || 0;
    const pricePerCig = (packSize > 0) ? packPrice / packSize : 0;
    const oldHabitCost = oldHabit * pricePerCig;
    oldHabitMoneyEl.textContent = `$${oldHabitCost.toFixed(2)}/день`;
}

function updateDesiredDailySticksMoneyDisplay() {
    const packPrice = Number(packPriceInput.value) || 0;
    const packSize = Number(packSizeInput.value) || 1;
    const desiredDailySticks = Number(desiredDailySticksInput.value) || 0;
    const pricePerCig = (packSize > 0) ? packPrice / packSize : 0;
    const desiredDailySticksCost = desiredDailySticks * pricePerCig;
    desiredDailySticksMoneyEl.textContent = `$${desiredDailySticksCost.toFixed(2)}/день`;
}

function handleSaveSettings() {
    console.log("[handleSaveSettings] Save button clicked!");
    appData.settings.packPrice = Number(packPriceInput.value) || 0;
    appData.settings.packSize = Number(packSizeInput.value) || 1;
    appData.settings.oldHabit = Number(oldHabitInput.value) || 0;
    appData.settings.desiredDailySticks = Number(desiredDailySticksInput.value) || 0; 
    let newInterval = Number(smokeIntervalMinutesInput.value);
    appData.settings.smokeIntervalMinutes = (newInterval > 0) ? newInterval : 60;
    
    saveData();
    updateUI();
    toggleSettingsView();
}

async function handleResetData() {
    showConfirm("Це видалить всю вашу історію та статистику. Ви впевнені?", async () => {
        if (dataRef) await deleteDoc(dataRef);
        appData = getDefaultAppData();
        await saveData();
        updateSettingsInputs();
        updateUI();
    });
}

function toggleSettingsView() {
    const action = () => {
        mainView.classList.toggle('hidden');
        settingsView.classList.toggle('hidden');
        if (!settingsView.classList.contains('hidden')) {
            updateSettingsInputs();
        }
    };

    if (!document.startViewTransition) {
        action();
    } else {
        document.startViewTransition(action);
    }
}

// Auth Handlers
async function handleGoogleSignIn() {
    const provider = new GoogleAuthProvider();
    signInGoogleButton.disabled = true;
    signInGoogleButton.textContent = "Вхід...";
    try {
        if (auth.currentUser && auth.currentUser.isAnonymous) {
            await linkWithPopup(auth.currentUser, provider);
        } else {
            await signInWithPopup(auth, provider);
        }
    } catch (error) {
        console.error("Auth error:", error);
        if (error.code === 'auth/credential-already-in-use') {
             userStatusDisplay.textContent = "Акаунт існує. Переходимо...";
             const credential = GoogleAuthProvider.credentialFromError(error);
             if (credential) {
                 try {
                     await signInWithCredential(auth, credential);
                 } catch (reauthError) {
                     console.error("Reauth error:", reauthError);
                     userStatusDisplay.textContent = "Помилка входу в існуючий.";
                 }
             }
        } else {
             userStatusDisplay.textContent = `Помилка: ${error.message}`;
        }
    } finally {
        signInGoogleButton.disabled = false;
        signInGoogleButton.textContent = "Увійти через Google";
    }
}

async function handleSignOut() {
    try {
        await signOut(auth);
    } catch (error) {
        console.error("SignOut error:", error);
    }
}

function attachEventListeners() {
    smokeButton.addEventListener('click', () => handleSmoke('regular'));
    emergencySmokeButton.addEventListener('click', () => handleSmoke('emergency'));
    openSettingsButton.addEventListener('click', toggleSettingsView);
    closeSettingsButton.addEventListener('click', toggleSettingsView);
    saveSettingsButton.addEventListener('click', handleSaveSettings);
    resetDataButton.addEventListener('click', handleResetData);
    signInGoogleButton.addEventListener('click', handleGoogleSignIn);
    signOutButton.addEventListener('click', handleSignOut);

    packPriceInput.addEventListener('input', () => { updateOldHabitMoneyDisplay(); updateDesiredDailySticksMoneyDisplay(); });
    packSizeInput.addEventListener('input', () => { updateOldHabitMoneyDisplay(); updateDesiredDailySticksMoneyDisplay(); });
    oldHabitInput.addEventListener('input', updateOldHabitMoneyDisplay);
    desiredDailySticksInput.addEventListener('input', updateDesiredDailySticksMoneyDisplay);

    eventListenersAttached = true;
}

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
    // Select elements
    loader = document.getElementById('loader'); 
    appContainer = document.getElementById('app');
    mainView = document.getElementById('main-view');
    settingsView = document.getElementById('settings-view');
    timerEl = document.getElementById('timer');
    statusMessageEl = document.getElementById('statusMessage');
    treeContainerEl = document.getElementById('treeContainer');
    toxicCloudEl = document.getElementById('toxicCloud');
    healthValueEl = document.getElementById('healthValue');
    smokeButton = document.getElementById('smokeButton');
    emergencySmokeButton = document.getElementById('emergencySmokeButton');
    
    smokedTodayValueEl = document.getElementById('smokedTodayValue');
    smokedTodayPlannedEl = document.getElementById('smokedTodayPlanned');
    spentTodayValueEl = document.getElementById('spentTodayValue');
    spentTodayPlannedEl = document.getElementById('spentTodayPlanned');
    balanceCardEl = document.getElementById('balanceCard');
    financialBalanceLabelEl = document.getElementById('financialBalanceLabel');
    financialBalanceValueEl = document.getElementById('financialBalanceValue');
    balanceIconEl = document.getElementById('balanceIcon');
    smokeFreeStreakEl = document.getElementById('smokeFreeStreak');
    longestSmokeFreeStreakEl = document.getElementById('longestSmokeFreeStreak');
    
    openSettingsButton = document.getElementById('openSettingsButton');
    closeSettingsButton = document.getElementById('closeSettingsButton');
    saveSettingsButton = document.getElementById('saveSettingsButton');
    resetDataButton = document.getElementById('resetDataButton');

    signInGoogleButton = document.getElementById('signInGoogleButton'); 
    signOutButton = document.getElementById('signOutButton'); 
    userStatusDisplay = document.getElementById('userStatusDisplay'); 
    
    packPriceInput = document.getElementById('packPrice');
    packSizeInput = document.getElementById('packSize'); 
    oldHabitInput = document.getElementById('oldHabit');
    smokeIntervalMinutesInput = document.getElementById('smokeIntervalMinutes');
    oldHabitMoneyEl = document.getElementById('oldHabitMoney');
    desiredDailySticksInput = document.getElementById('desiredDailySticks');
    desiredDailySticksMoneyEl = document.getElementById('desiredDailySticksMoney');

    statisticsSection = document.getElementById('statisticsSection');
    smokeChartCanvas = document.getElementById('smokeChart');
    totalSmokesAllTimeEl = document.getElementById('totalSmokesAllTime');
    avgSmokesPerDayEl = document.getElementById('avgSmokesPerDay');
    avgSmokesPerDayEl = document.getElementById('avgSmokesPerDay');
    statsTabs = document.querySelectorAll('.stats-tab');
    statsModeBtns = document.querySelectorAll('.mode-btn');
    insightsSection = document.getElementById('insightsSection');
    peakHourValueEl = document.getElementById('peakHourValue');
    activityHeatmapEl = document.getElementById('activityHeatmap');
    heatmapLabelsEl = document.getElementById('heatmapLabels');
    
    statsTabs.forEach(tab => tab.addEventListener('click', handleChartTabClick));
    statsModeBtns.forEach(btn => btn.addEventListener('click', handleChartModeClick));

    confirmModal = document.getElementById('confirmModal');
    modalText = document.getElementById('modalText');
    confirmYes = document.getElementById('confirmYes');
    confirmNo = document.getElementById('confirmNo');

    // Init Firebase
    try {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
    } catch (error) {
        console.error("Firebase init error:", error);
        if (loader) loader.textContent = "Error initializing Firebase.";
        return;
    }

    // Handle Redirect Result
    // Handle Redirect Result logic removed - using Popup now


    // Auth State Listener
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            userId = user.uid;
            if (user.isAnonymous) {
                userStatusDisplay.textContent = "Ви анонімний користувач";
                signInGoogleButton.classList.remove('hidden'); 
                signOutButton.classList.add('hidden'); 
            } else {
                const userName = user.displayName || user.email || "Користувач";
                userStatusDisplay.textContent = `Привіт, ${userName}!`;
                signInGoogleButton.classList.add('hidden'); 
                signOutButton.classList.remove('hidden'); 
            }
            if (!isInitialAuthCheckComplete || (appData.currentUserId !== userId)) {
                appData.currentUserId = userId;
                await loadData(); 
            }
        } else {
            console.log("No user.");
            userId = null; 
            userStatusDisplay.textContent = "Ви не увійшли"; 
            signInGoogleButton.classList.remove('hidden'); 
            signOutButton.classList.add('hidden'); 

            if (!isInitialAuthCheckComplete) {
                try {
                    await signInAnonymously(auth);
                } catch (e) {
                    console.error("Anon sign-in failed", e);
                }
            } else {
                // User signed out, reset to local/anon
                appData = getDefaultAppData();
                await loadData();
            }
        }
        isInitialAuthCheckComplete = true; 
    });

    setInterval(updateUI, 1000);
});


