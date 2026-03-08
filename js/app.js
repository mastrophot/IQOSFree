import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, linkWithPopup, signOut, signInWithCredential } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

import { firebaseConfig, appId } from './firebase-config.js';
import { getStickPluralForm, formatHoursToReadable, formatMinutesToReadable } from './utils.js';
import { renderSmokeChart, destroyChart } from './charts.js';

// --- BIO-CORE 2.0 CONSTANTS (Original User Request) ---
const REGEN_PER_HOUR = 10;       // +10% per hour (full recovery in 10 hours)
const DAMAGE_REGULAR = 5;        // -5% per regular stick
const DAMAGE_EMERGENCY = 10;     // -10% per emergency stick
const PENALTY_REGULAR_MS = 1000 * 60 * 60 * 6;   // 6h XP penalty
const PENALTY_EMERGENCY_MS = 1000 * 60 * 60 * 12; // 12h XP penalty

// --- APPLICATION STATE ---
let app;
let db;
let auth;

const LOCAL_STORAGE_KEY = `iqosfree_data_${appId}`;

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
    settingsUpdatedAt: Date.now(),
    updatedAt: Date.now()
});

function loadLocalData() {
    const local = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (local) {
        try {
            return JSON.parse(local);
        } catch (e) {
            console.error("Error parsing local data", e);
        }
    }
    return null;
}

function saveLocalData(data, updateTimestamp = true) {
    if (!data) return;
    if (updateTimestamp) data.updatedAt = Date.now();
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
}

// Backup system to prevent data loss
const BACKUP_KEY = `${LOCAL_STORAGE_KEY}_backup`;

function saveBackup(data) {
    if (!data || !data.smokeHistory || data.smokeHistory.length === 0) return;
    // Only save backup if data has meaningful content
    localStorage.setItem(BACKUP_KEY, JSON.stringify({
        ...data,
        backupTime: Date.now()
    }));
    console.log('[Backup] Data backed up successfully');
}

function loadBackup() {
    const backup = localStorage.getItem(BACKUP_KEY);
    if (backup) {
        try {
            return JSON.parse(backup);
        } catch (e) {
            console.error('[Backup] Error parsing backup', e);
        }
    }
    return null;
}

function shouldRestoreFromBackup(currentData, backupData) {
    if (!backupData) return false;
    if (!currentData || !currentData.smokeHistory) return true;
    
    // Restore if backup has more history AND is not too old (less than 7 days)
    const backupAge = Date.now() - (backupData.backupTime || 0);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    
    return backupData.smokeHistory.length > currentData.smokeHistory.length && backupAge < sevenDays;
}

let appData = loadLocalData() || getDefaultAppData();

let eventListenersAttached = false;
let isInitialAuthCheckComplete = false;
let lastFirebaseSyncTime = 0;
const FIREBASE_SYNC_INTERVAL = 10000; // 10 секунд — швидша крос-девайс синхронізація
let isLocalOnlyMode = false;
let userId = null;
let dataRef = null;
let unsubscribeSnapshot = null; // Real-time listener cleanup

// --- DOM ELEMENTS ---
// (Initialized in DOMContentLoaded)
let loader, appContainer, mainView, settingsView, timerEl, statusMessageEl, accountBadge;
let smokeButton, emergencySmokeButton, openSettingsButton, closeSettingsButton, saveSettingsButton, resetDataButton, forceSyncButton, deepResetButton;
let smokedTodayValueEl, smokedTodayPlannedEl, spentTodayValueEl, spentTodayPlannedEl;
let smokeFreeStreakEl, longestSmokeFreeStreakEl;
let balanceCardEl, financialBalanceLabelEl, financialBalanceValueEl, balanceIconEl;
let signInGoogleButton, signOutButton, userStatusDisplay;
let packPriceInput, packSizeInput, oldHabitInput, smokeIntervalMinutesInput, oldHabitMoneyEl, desiredDailySticksInput, desiredDailySticksMoneyEl;
let dailySmokingChartSection, dailySmokeChartCanvas;
let statisticsSection, smokeChartCanvas;
let totalSmokesAllTimeEl, avgSmokesPerDayEl;
let statsTabs, statsModeBtns;
let treeContainerEl, toxicCloudEl, healthValueEl, growthStageEl; // New Life Tree Elements 2025
let lastSettingsSyncTimeEl, hardRefreshButton;
let undoNotificationEl, undoActionBtn, undoTimerTextEl;
let undoTimeout = null, undoInterval = null;
// DOM Elements
const syncIndicator = document.getElementById('syncIndicator');

function updateSyncStatus(status) {
    if (!syncIndicator) return;
    syncIndicator.classList.remove('bg-slate-700', 'bg-emerald-500', 'bg-red-500', 'animate-pulse');
    if (status === 'syncing') {
        syncIndicator.classList.add('bg-slate-700', 'animate-pulse');
    } else if (status === 'online') {
        syncIndicator.classList.add('bg-emerald-500');
    } else if (status === 'error') {
        syncIndicator.classList.add('bg-red-500');
    }
}

function applyLocalOnlyUiState() {
    if (userStatusDisplay) {
        userStatusDisplay.textContent = "Локальний режим (без авторизації)";
    }
    if (accountBadge) {
        accountBadge.textContent = "LOCAL-ONLY";
        accountBadge.classList.remove('hidden');
        accountBadge.className = "text-[8px] px-1.5 py-0.5 rounded font-bold inline-block bg-amber-500/20 text-amber-500";
    }
    if (signInGoogleButton) {
        signInGoogleButton.classList.add('hidden');
        signInGoogleButton.disabled = true;
    }
    if (signOutButton) {
        signOutButton.classList.add('hidden');
    }
    if (forceSyncButton) {
        forceSyncButton.disabled = true;
        forceSyncButton.classList.add('opacity-60', 'cursor-not-allowed');
        forceSyncButton.title = "Firebase недоступний: локальний режим";
    }
    updateSyncStatus('error');
}

async function switchToLocalOnlyMode(reason, error = null) {
    if (isLocalOnlyMode) return;
    isLocalOnlyMode = true;
    console.warn(`[LocalOnly] ${reason}`, error || '');

    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
    }

    userId = null;
    dataRef = null;
    applyLocalOnlyUiState();
    await loadData();
}
let insightsSection, peakHourValueEl, activityHeatmapEl, heatmapLabelsEl;
let currentChartPeriod = 'day';
let currentChartMode = 'sticks';
let confirmModal, modalText, confirmYes, confirmNo;

let confirmCallback = null;

function showConfirm(text, onConfirm) {
    console.log("[showConfirm] Opening dialog with text:", text);
    modalText.textContent = text;
    confirmCallback = onConfirm;
    
    if (typeof confirmModal.showModal === 'function') {
        confirmModal.showModal();
    } else {
        confirmModal.setAttribute('open', '');
    }
}

// Global listeners for confirm buttons once in DOMContentLoaded
function setupConfirmModalListeners() {
    confirmYes.onclick = () => {
        console.log("[showConfirm] Confirmed");
        if (confirmCallback) confirmCallback();
        
        if (typeof confirmModal.close === 'function') confirmModal.close();
        else confirmModal.removeAttribute('open');
        
        confirmCallback = null;
    };
    confirmNo.onclick = () => {
        console.log("[showConfirm] Cancelled");
        
        if (typeof confirmModal.close === 'function') confirmModal.close();
        else confirmModal.removeAttribute('open');
        
        confirmCallback = null;
    };
}

// Expose handlers to window for inline onclick fallbacks
window.handleResetData = handleResetData;
window.handleDeepReset = handleDeepReset;

async function loadData() {
    if (!userId) {
        console.warn("[loadData] userId is null. Using local data.");
        updateSettingsInputs(); 
        if (!eventListenersAttached) attachEventListeners();
        loader.classList.add('hidden');
        appContainer.classList.remove('hidden');
        return;
    }

    // Cleanup previous listener if exists
    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
    }

    // CRITICAL: Save backup BEFORE any sync operation
    const currentLocalData = loadLocalData();
    if (currentLocalData && currentLocalData.smokeHistory && currentLocalData.smokeHistory.length > 0) {
        saveBackup(currentLocalData);
    }

    console.log(`[loadData] Initializing real-time listener for userId: ${userId}`);
    dataRef = doc(db, `artifacts/${appId}/users/${userId}/smokingData/data`);

    // Use onSnapshot for REAL-TIME synchronization
    unsubscribeSnapshot = onSnapshot(dataRef, async (docSnap) => {
        updateSyncStatus('online');
        let remoteData = null;
        if (docSnap.exists()) {
            remoteData = docSnap.data();
            console.log("[loadData] Remote update received via onSnapshot");
        }

        const localData = loadLocalData();

        // SMART MERGE: Separates Settings (latest wins) from History (additive wins)
            if (remoteData && localData) {
                const remoteUpdateTime = remoteData.updatedAt || 0;
                const localUpdateTime = localData.updatedAt || 0;
                
                console.log(`[Sync] Check. Remote Update: ${new Date(remoteUpdateTime).toLocaleTimeString()} (${remoteUpdateTime})`);
                console.log(`[Sync] Check. Local Update: ${new Date(localUpdateTime).toLocaleTimeString()} (${localUpdateTime})`);

                // 1. SETTINGS: Trust the latest settings update specifically
                const remoteSettingsTime = remoteData.settingsUpdatedAt || 0;
                const localSettingsTime = localData.settingsUpdatedAt || 0;
                
                if (remoteSettingsTime > localSettingsTime) {
                    console.log("[Sync] Remote settings are NEWER. Updating settings.");
                    appData.settings = remoteData.settings || appData.settings;
                    appData.settingsUpdatedAt = remoteSettingsTime;
                    
                    if (lastSettingsSyncTimeEl) {
                        lastSettingsSyncTimeEl.textContent = new Date(remoteSettingsTime).toLocaleTimeString();
                    }
                }

                // 2. STATE & MERGE: Only if remote update is strictly newer
                if (remoteUpdateTime > localUpdateTime) {
                    console.log("[Sync] Remote data is NEWER. Merging state...");
                    if (remoteData.appStartDate !== undefined) appData.appStartDate = Number(remoteData.appStartDate);
                    appData.updatedAt = remoteUpdateTime;
                } else {
                    console.log("[Sync] Local data is up-to-date or newer. Skipping state merge.");
                }

                // 3. RECORDS: Maximum wins
                const oldRecord = appData.longestSmokeFreeStreakHours || 0;
                appData.longestSmokeFreeStreakHours = Math.max(oldRecord, remoteData.longestSmokeFreeStreakHours || 0);
                if (appData.longestSmokeFreeStreakHours > oldRecord) console.log("[Sync] New record updated from remote!");

                // 4. HISTORY: Additive Merge
                const localHist = (localData.smokeHistory || []).map(s => typeof s === 'number' ? {timestamp:s, type:'regular'} : s);
                const remoteHist = (remoteData.smokeHistory || []).map(s => typeof s === 'number' ? {timestamp:s, type:'regular'} : s);
                
                if (remoteHist.length === 0 && localHist.length > 0 && remoteUpdateTime > localUpdateTime + 5000) {
                    console.log("[Sync] Remote Reset detected. Clearing local history.");
                    appData.smokeHistory = [];
                } else {
                    const allSmokes = [...localHist, ...remoteHist];
                    const seen = new Set();
                    const unique = [];
                    for (const s of allSmokes) {
                        if (!seen.has(s.timestamp)) {
                            seen.add(s.timestamp);
                            unique.push(s);
                        }
                    }
                    unique.sort((a, b) => a.timestamp - b.timestamp);
                    if (unique.length !== appData.smokeHistory.length) {
                        console.log(`[Sync] History merged. Count: ${appData.smokeHistory.length} -> ${unique.length}`);
                    }
                    appData.smokeHistory = unique;
                }

                appData.lastSmokeTime = appData.smokeHistory.length > 0 ? appData.smokeHistory[appData.smokeHistory.length-1].timestamp : null;
                saveLocalData(appData, false);
                
            } else if (remoteData) {
            console.log("[loadData] Using remote data.");
            appData = { ...getDefaultAppData(), ...remoteData };
        } else if (localData) {
            console.log("[loadData] Using local data and pushing to Firebase.");
            appData = { ...getDefaultAppData(), ...localData };
            await saveData(); 
        } else {
            console.log("[loadData] No data found. Using defaults.");
            appData = getDefaultAppData();
            await saveData(); 
        }

        // Sanitize & Migrations
        appData.smokeHistory = (appData.smokeHistory || []).map(smoke => {
            if (typeof smoke === 'number') return { timestamp: smoke, type: 'regular' };
            return { timestamp: smoke.timestamp, type: smoke.type || 'regular' }; 
        });

        // Backup check
        const backup = loadBackup();
        if (shouldRestoreFromBackup(appData, backup)) {
            console.warn('[loadData] Potential data loss in sync! Restoring from backup...');
            appData = { ...getDefaultAppData(), ...backup };
            delete appData.backupTime;
            await saveData();
        }

        saveLocalData(appData);
        // Only update inputs if the user is NOT currently editing them
        if (settingsView.classList.contains('hidden')) {
            updateSettingsInputs();
        }
        updateUI();
        
        // Handle Widget Actions (Once per initial load)
        const urlParams = new URLSearchParams(window.location.search);
        const action = urlParams.get('action');
        if (action && !window.initialActionTriggered) {
             console.log("[DeepLink] Action detected:", action);
             window.initialActionTriggered = true;
             // Clear param to avoid double action on refresh
             window.history.replaceState({}, document.title, window.location.pathname);
             setTimeout(() => {
                if (action === 'smoke') handleSmoke('regular');
                else if (action === 'emergency') handleSmoke('emergency');
             }, 500); // Small delay to ensure UI is ready
        }

        if (!eventListenersAttached) attachEventListeners();
        loader.classList.add('hidden');
        appContainer.classList.remove('hidden');
    }, async (error) => {
        console.error("[loadData] Firestore listener error:", error);
        await switchToLocalOnlyMode("Firestore unavailable", error);
    });
}

async function saveData(updateTimestamp = false) {
    if (updateTimestamp) {
        appData.updatedAt = Date.now();
        console.log(`[Sync] Manually bumping updatedAt: ${appData.updatedAt}`);
    }
    saveLocalData(appData, false); 
    if (!dataRef || !userId) return;
    updateSyncStatus('syncing');
    try {
        await setDoc(dataRef, appData);
        updateSyncStatus('online');
        console.log("[Sync] Data pushed to Firestore.");
    } catch (error) {
        updateSyncStatus('error');
        console.error("[Sync] Error pushing to Firestore: ", error);
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
    updateAvatar();
    updateGlobalStats();
    renderSmokeChart(smokeChartCanvas, appData.smokeHistory, currentChartPeriod, currentChartMode, appData.settings);


    // Show sync status visually (optional polish)
    if (userStatusDisplay) {
        const syncDot = document.getElementById('syncIndicator') || document.createElement('span');
        syncDot.id = 'syncIndicator';
        syncDot.className = 'inline-block w-2 h-2 rounded-full bg-green-500 ml-2 animate-pulse';
        syncDot.title = 'Синхронізація активна';
        if (!userStatusDisplay.contains(syncDot)) {
            userStatusDisplay.appendChild(syncDot);
        }
    }
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
    
    // Today-Centric Balance Logic (Savings/Loss vs Goal)
    const todayGoalCount = desiredDailySticks;
    const todayBalance = (todayGoalCount - smokedTodayCount) * pricePerCig;
    financialBalanceValueEl.textContent = `${todayBalance < 0 ? '-' : '+'}$${Math.abs(todayBalance).toFixed(2)}`;

    const isDailyGoalExceeded = smokedTodayCount > desiredDailySticks;

    if (!isDailyGoalExceeded) {
        financialBalanceValueEl.classList.remove('text-red-500');
        financialBalanceValueEl.classList.add('text-emerald-400');
        financialBalanceLabelEl.textContent = 'Баланс за сьогодні (Економія)';
        balanceCardEl.classList.remove('border-red-500/50');
        balanceCardEl.classList.add('border-emerald-500/50');
        balanceIconEl.textContent = '💰';
    } else {
        financialBalanceValueEl.classList.remove('text-emerald-400');
        financialBalanceValueEl.classList.add('text-red-500');
        financialBalanceLabelEl.textContent = 'Ціль на сьогодні порушена!';
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



/**
 * BIO-CORE 3.0: High-Precision Mathematical State Engine
 * Calculates Health and Evolution points on-the-fly from history.
 */
function calculateTreeState() {
    const now = Date.now();
    const appStart = appData.appStartDate || (now - 86400000); // Fallback to 1 day ago
    
    // 1. Calculate Health (Sequential Integration)
    let health = 100;
    let lastT = appStart;
    
    // Sort history just in case it's not
    const history = [...appData.smokeHistory].sort((a,b) => a.timestamp - b.timestamp);
    
    for (const record of history) {
        if (record.timestamp < appStart) continue; // Ignore pre-app sticks
        
        // Regen since last event
        const elapsedHours = (record.timestamp - lastT) / 3600000;
        if (elapsedHours > 0) {
            health = Math.min(100, health + (elapsedHours * REGEN_PER_HOUR));
        }
        
        // Damage from this stick
        const damage = record.type === 'emergency' ? DAMAGE_EMERGENCY : DAMAGE_REGULAR;
        health = Math.max(0, health - damage);
        
        lastT = record.timestamp;
    }
    
    // Final regen up to NOW
    const finalElapsedHours = (now - lastT) / 3600000;
    if (finalElapsedHours > 0) {
        health = Math.min(100, health + (finalElapsedHours * REGEN_PER_HOUR));
    }
    
    // 2. Calculate Evolution (Total Time - Total Penalties)
    const totalPossibleTime = now - appStart;
    const totalPenalty = history.reduce((acc, s) => {
        const penalty = s.type === 'emergency' ? PENALTY_EMERGENCY_MS : PENALTY_REGULAR_MS;
        return acc + penalty;
    }, 0);
    
    const evolutionMs = Math.max(0, totalPossibleTime - totalPenalty);
    
    return { 
        health: Math.round(health), 
        evolutionMs 
    };
}


function updateAvatar() { 
    if (!treeContainerEl || !healthValueEl) return;
    
    const now = Date.now();
    const { health, evolutionMs } = calculateTreeState();
    
    // Periodic synchronization with Firestore (still needed to push history reliably)
    if (now - lastFirebaseSyncTime > 15000) {
        lastFirebaseSyncTime = now;
        console.log("[Sync] Background history sync...");
        saveData(false); 
    }

    // 3. Evolution Stage (Based on Evolution Points / Experience)
    const evolutionDays = evolutionMs / (1000 * 60 * 60 * 24);
    
    let stage = 1;
    let stageTitle = "Паросток";
    if (evolutionDays >= 14) { stage = 5; stageTitle = "Міфічний Дуб"; }
    else if (evolutionDays >= 7) { stage = 4; stageTitle = "Велике Дерево"; }
    else if (evolutionDays >= 3) { stage = 3; stageTitle = "Середнє Дерево"; }
    else if (evolutionDays >= 1) { stage = 2; stageTitle = "Саджанець"; }

    // 4. Render Tree Stage & Health Levels
    renderLifeTree(stage, health);

    // 5. Update Labels
    healthValueEl.textContent = `Здоров'я: ${health}%`;
    if (growthStageEl) growthStageEl.textContent = `Стадія: ${stage} / 5 (${stageTitle})`;
    
    healthValueEl.classList.remove('text-primary-glow', 'text-warning', 'text-error', 'border-emerald-500/20', 'border-warning/20', 'border-error/20');
    if (health > 70) {
        healthValueEl.classList.add('text-primary-glow', 'border-emerald-500/20');
    } else if (health > 30) {
        healthValueEl.classList.add('text-warning', 'border-warning/20');
    } else {
        healthValueEl.classList.add('text-error', 'border-error/20');
    }
}

const processedTrees = {};

/**
 * Procedurally removes black background from images using Canvas.
 * Optimized for mobile PWA performance.
 */
async function getTransparentTree(src) {
    if (processedTrees[src]) return processedTrees[src];
    
    return new Promise((resolve) => {
        const tempImg = new Image();
        tempImg.src = src;
        tempImg.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = tempImg.width;
            canvas.height = tempImg.height;
            ctx.drawImage(tempImg, 0, 0);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i+1], b = data[i+2];
                const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                if (luminance < 40) {
                    data[i + 3] = Math.max(0, (luminance - 15) * 5);
                    if (luminance < 15) data[i + 3] = 0;
                }
            }

            ctx.putImageData(imageData, 0, 0);
            const dataUrl = canvas.toDataURL("image/png");
            processedTrees[src] = dataUrl;
            resolve(dataUrl);
        };
    });
}

async function renderLifeTree(stage, health) {
    const container = treeContainerEl;
    let img = container.querySelector('#treeImage');
    
    if (!img) {
        container.innerHTML = '<div class="toxic-cloud" id="toxicCloud"></div>';
        img = document.createElement('img');
        img.id = 'treeImage';
        container.appendChild(img);
        toxicCloudEl = document.getElementById('toxicCloud');
    }

    let assetIndex = stage;
    if (assetIndex > 4) assetIndex = 4;
    // assetIndex mapping: 1 (parostok), 2 (sadzanets), 3 (serednie), 4 (velike)
    
    const rawSrc = `assets/tree_${assetIndex}.png`;
    const processedSrc = await getTransparentTree(rawSrc);
    
    if (img.src !== processedSrc) {
        img.src = processedSrc;
    }

    const healthLevel = Math.max(1, Math.min(10, Math.floor(health / 10) + (health % 10 > 5 ? 1 : 0))); // Floor + bonus for >5%
    if (health === 100) img.className = 'tree-full-health'; // Exact 100% marker if needed
    else img.className = '';
    
    img.classList.add(`tree-lvl-${healthLevel}`);
    if (stage === 5) img.classList.add('tree-stage-5');
    if (healthLevel < 5) img.classList.add('tree-sick');

    // Breathing effect via CSS Class
    img.classList.add('tree-breathing');
}

// Removing unused helper function logic.
// renderLeafParticles removed. logic.

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
    
    if (navigator.vibrate) navigator.vibrate(20);

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
}

function handleChartModeClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    if (navigator.vibrate) navigator.vibrate(20);

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
    
    // Haptic Feedback 2026
    if (navigator.vibrate) {
        navigator.vibrate(type === 'emergency' ? [50, 50, 50] : 50);
    }
    
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
    
    appData.lastSmokeTime = new Date().getTime();
    appData.smokeHistory.push({ timestamp: appData.lastSmokeTime, type: type });
    appData.updatedAt = Date.now(); // CRITICAL: Bump timestamp so sync logic honors this change
    
    // Show undo button for 60 seconds
    showUndoToast();
    
    saveData(true);
    updateUI();
}

function showUndoToast() {
    if (!undoNotificationEl) return;
    
    clearTimeout(undoTimeout);
    clearInterval(undoInterval);
    
    let secondsLeft = 60;
    undoTimerTextEl.textContent = `У вас є ${secondsLeft} секунд`;
    
    undoNotificationEl.classList.remove('translate-y-32', 'opacity-0', 'pointer-events-none');
    
    undoInterval = setInterval(() => {
        secondsLeft--;
        if (secondsLeft <= 0) {
            hideUndoToast();
        } else {
            undoTimerTextEl.textContent = `У вас є ${secondsLeft} секунд`;
        }
    }, 1000);
    
    undoTimeout = setTimeout(() => {
        hideUndoToast();
    }, 60000);
}

function hideUndoToast() {
    if (!undoNotificationEl) return;
    undoNotificationEl.classList.add('translate-y-32', 'opacity-0', 'pointer-events-none');
    clearInterval(undoInterval);
    clearTimeout(undoTimeout);
}

function handleUndoSmoke() {
    if (appData.smokeHistory.length === 0) return;
    
    appData.smokeHistory.pop();
    appData.lastSmokeTime = appData.smokeHistory.length > 0 ? appData.smokeHistory[appData.smokeHistory.length - 1].timestamp : null;
    appData.updatedAt = Date.now();
    
    hideUndoToast();
    saveData(true);
    updateUI();
    console.log("[Undo] Smoke action undone.");
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
    
    appData.settingsUpdatedAt = Date.now();
    appData.updatedAt = Date.now();
    
    saveData(false); // Already updated timestamps above
    updateUI();
    toggleSettingsView();
}

async function handleResetData() {
    console.log("[handleResetData] Triggered");
    if (!confirm("Це видалить всю вашу історію та статистику. Ви впевнені?")) return;
    
    console.log("[handleResetData] Resetting data...");
    
    // 0. STOP listener
    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
    }

    // 1. Update local state with a NUKED timestamp (5 seconds in future)
    // This allows settings to be saved almost immediately after reset
    appData = getDefaultAppData();
    appData.updatedAt = Date.now() + 5000; 
    saveLocalData(appData, false); 
    
    // 2. Overwrite Firestore
    updateSyncStatus('syncing');
    if (dataRef && userId) {
        try {
            await setDoc(dataRef, appData);
            updateSyncStatus('online');
            console.log("[saveData] Saved to Firestore successfully");
        } catch (e) {
            updateSyncStatus('error');
            console.error("[saveData] Failed to save to Firestore:", e);
            alert("Помилка синхронізації при видаленні. Спробуйте ще раз.");
        }
    }
    
    // 3. NUCLEAR RELOAD
    // Instead of rebuilding UI, we reload the whole page to get a fresh loadData cycle
    alert("Дані успішно видалено. Додаток перезавантажиться.");
    window.location.reload();
}

async function handleForceSync() {
    if (!userId || !dataRef) return;
    console.log("[handleForceSync] Manual sync triggered...");
    forceSyncButton.disabled = true;
    forceSyncButton.innerHTML = "🕒 СИНХРОНІЗУЄМО...";
    updateSyncStatus('syncing');
    
    try {
        const docSnap = await getDoc(dataRef);
        if (docSnap.exists()) {
            const remoteData = docSnap.data();
            const localData = loadLocalData();
            
            // Perform a hard merge
            const localHistory = (localData.smokeHistory || []);
            const remoteHistory = (remoteData.smokeHistory || []);
            const allSmokes = [...localHistory, ...remoteHistory];
            const uniqueSmokes = [];
            const seenTimestamps = new Set();
            for (const s of allSmokes) {
                const ts = typeof s === 'number' ? s : s.timestamp;
                if (!seenTimestamps.has(ts)) {
                    seenTimestamps.add(ts);
                    uniqueSmokes.push(typeof s === 'number' ? {timestamp:s, type:'regular'} : s);
                }
            }
            uniqueSmokes.sort((a,b) => a.timestamp - b.timestamp);
            
            appData = {
                ...getDefaultAppData(),
                ...remoteData,
                smokeHistory: uniqueSmokes,
                longestSmokeFreeStreakHours: Math.max(localData.longestSmokeFreeStreakHours || 0, remoteData.longestSmokeFreeStreakHours || 0),
                updatedAt: Date.now()
            };
            
            saveLocalData(appData);
            updateSettingsInputs();
            updateUI();
            console.log("[handleForceSync] Sync complete. Merged sticks:", uniqueSmokes.length);
        }
        updateSyncStatus('online');
    } catch (e) {
        console.error("[handleForceSync] Error:", e);
        updateSyncStatus('error');
    } finally {
        setTimeout(() => {
            if (forceSyncButton) {
                forceSyncButton.disabled = false;
                forceSyncButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-emerald-500 group-hover:rotate-180 transition-transform duration-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> СИНХРОНІЗАЦІЯ`;
            }
        }, 1000);
    }
}

async function handleDeepReset() {
    console.log("[handleDeepReset] Triggered");
    if (!confirm("Це повністю очистить кеш додатку та вийде з акаунту. Ви впевнені?")) return;

    console.log("[DeepReset] Starting nuclear cleanup...");
    
    // 0. Sign out from Firebase if authenticated
    if (auth) {
        try {
            await signOut(auth);
            console.log("[DeepReset] Firebase signed out");
        } catch (e) {
            console.error("[DeepReset] Sign out error:", e);
        }
    }

    // 1. Clear Local Storage
    localStorage.clear();
    
    // 2. Unregister ALL Service Workers
    if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (let reg of regs) {
            await reg.unregister();
            console.log("[DeepReset] SW unregistered");
        }
    }
    
    // 3. Clear Caches
    if ('caches' in window) {
        const keys = await caches.keys();
        for (let key of keys) {
            await caches.delete(key);
            console.log("[DeepReset] Cache deleted:", key);
        }
    }

    // 4. Reload
    window.location.href = window.location.origin + window.location.pathname + '?reset=' + Date.now();
}

function toggleSettingsView() {
    if (navigator.vibrate) navigator.vibrate(30);

    const action = () => {
        // Toggle <dialog> state
        if (settingsView.open) {
            settingsView.close();
            // Enable scrolling on body again if needed
            document.body.style.overflow = '';
        } else {
            settingsView.showModal();
            updateSettingsInputs();
            // Prevent body scroll behind dialog
            document.body.style.overflow = 'hidden';
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
    if (isLocalOnlyMode || !auth) {
        if (userStatusDisplay) {
            userStatusDisplay.textContent = "Локальний режим: вхід через Google вимкнено";
        }
        return;
    }
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
    if (!auth) return;
    try {
        await signOut(auth);
    } catch (error) {
        console.error("SignOut error:", error);
    }
}

async function handleHardRefresh() {
    if (!confirm("Це очистить кеш програми та перезавантажить її. Допомагає, якщо пристрої показують різні дані. Продовжити?")) return;
    
    updateSyncStatus('syncing');
    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let registration of registrations) {
            await registration.unregister();
        }
    }
    const names = await caches.keys();
    for (let name of names) {
        await caches.delete(name);
    }
    
    // Clear reset flag just in case
    localStorage.removeItem('FORCE_FIREBASE_RESET');
    
    alert("Кеш очищено. Програма перезавантажується...");
    window.location.reload(true);
}

const attachEventListeners = () => {
    smokeButton.addEventListener('click', () => handleSmoke('regular'));
    emergencySmokeButton.addEventListener('click', () => handleSmoke('emergency'));
    openSettingsButton.addEventListener('click', toggleSettingsView);
    closeSettingsButton.addEventListener('click', toggleSettingsView);
    saveSettingsButton.addEventListener('click', handleSaveSettings);
    if (undoActionBtn) undoActionBtn.addEventListener('click', handleUndoSmoke);
    if (forceSyncButton) forceSyncButton.addEventListener('click', handleForceSync);
    if (hardRefreshButton) hardRefreshButton.addEventListener('click', handleHardRefresh);
    deepResetButton.addEventListener('click', handleDeepReset);
    resetDataButton.addEventListener('click', handleResetData);
    signInGoogleButton.addEventListener('click', handleGoogleSignIn);
    signOutButton.addEventListener('click', handleSignOut);

    packPriceInput.addEventListener('input', () => { updateOldHabitMoneyDisplay(); updateDesiredDailySticksMoneyDisplay(); });
    packSizeInput.addEventListener('input', () => { updateOldHabitMoneyDisplay(); updateDesiredDailySticksMoneyDisplay(); });
    oldHabitInput.addEventListener('input', updateOldHabitMoneyDisplay);
    desiredDailySticksInput.addEventListener('input', updateDesiredDailySticksMoneyDisplay);
    
    window.addEventListener('online', () => {
        console.log("[Network] Back online. Syncing...");
        saveData(true);
    });

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
    growthStageEl = document.getElementById('growthStage');
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
    forceSyncButton = document.getElementById('forceSyncButton');
    deepResetButton = document.getElementById('deepResetButton');
    resetDataButton = document.getElementById('resetDataButton');
    accountBadge = document.getElementById('accountBadge');
    hardRefreshButton = document.getElementById('hardRefreshButton');
    lastSettingsSyncTimeEl = document.getElementById('lastSettingsSyncTime');
    undoNotificationEl = document.getElementById('undoNotification');
    undoActionBtn = document.getElementById('undoActionBtn');
    undoTimerTextEl = document.getElementById('undoTimerText');

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

    setupConfirmModalListeners();
    attachEventListeners(); // Force attachment here

    // Init Firebase
    try {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
    } catch (error) {
        console.error("Firebase init error:", error);
        await switchToLocalOnlyMode("Firebase init failed", error);
        return;
    }

    // Handle Redirect Result
    // Handle Redirect Result logic removed - using Popup now


    // Auth State Listener
    onAuthStateChanged(auth, async (user) => {
        if (isLocalOnlyMode) {
            await loadData();
            return;
        }
        if (user) {
            userId = user.uid;
            if (user.isAnonymous) {
                userStatusDisplay.textContent = "Анонімний режим";
                accountBadge.textContent = "LOCAL-ONLY";
                accountBadge.classList.replace('hidden', 'inline-block');
                accountBadge.className = "text-[8px] px-1.5 py-0.5 rounded font-bold inline-block bg-amber-500/20 text-amber-500";
                signInGoogleButton.classList.remove('hidden'); 
                signOutButton.classList.add('hidden'); 
            } else {
                const userName = user.displayName || user.email || "Користувач";
                userStatusDisplay.textContent = `Привіт, ${userName}!`;
                accountBadge.textContent = "GOOGLE SYNC";
                accountBadge.classList.replace('hidden', 'inline-block');
                accountBadge.innerHTML = `GOOGLE SYNC <span class="text-[8px] bg-slate-800 text-emerald-500 px-1.5 py-0.5 rounded-md font-mono border border-emerald-500/20">v2.4.0</span>`;
                accountBadge.className = "text-[8px] px-1.5 py-0.5 rounded font-bold inline-block bg-emerald-500/20 text-emerald-500";
                signInGoogleButton.classList.add('hidden'); 
                signOutButton.classList.remove('hidden'); 
            }

            // --- NUCLEAR SERVER RESET LOGIC ---
            if (localStorage.getItem('FORCE_FIREBASE_RESET') === 'true') {
                console.log("[AUTH] NUCLEAR RESET FLAG DETECTED. Wiping Firestore...");
                updateSyncStatus('syncing');
                try {
                    const dataRefForce = doc(db, `artifacts/${appId}/users/${userId}/smokingData/data`);
                    const nukeData = getDefaultAppData();
                    nukeData.updatedAt = Date.now() + 5000; // 5 seconds in future
                    await setDoc(dataRefForce, nukeData);
                    localStorage.removeItem('FORCE_FIREBASE_RESET');
                    console.log("[AUTH] Firestore wiped successfully. Flag cleared.");
                    updateSyncStatus('online');
                } catch (e) {
                    console.error("[AUTH] Firestore wipe failed:", e);
                    updateSyncStatus('error');
                }
            }
            // ----------------------------------

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
                    await switchToLocalOnlyMode("Anonymous auth failed", e);
                }
            } else {
                // User signed out, keep local data for now instead of resetting
                console.log("User signed out. Preserving local data.");
                // appData = getDefaultAppData(); // Removed reset to prevent data loss on logout
                await loadData();
            }
        }
        isInitialAuthCheckComplete = true; 
    });

    // PWA Shortcut handling logic.
    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get('action');
    if (action === 'smoke') {
        setTimeout(() => handleSmoke('regular'), 1500); // Small delay to let app load logic.
    } else if (action === 'emergency') {
        setTimeout(() => handleSmoke('emergency'), 1500);
    }

    // Зберігаємо прогрес при закритті вкладки/браузера
    window.addEventListener('beforeunload', () => {
        saveLocalData(appData);
    });

    // Зберігаємо прогрес коли користувач згортає вкладку або застосунок
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
            console.log('[visibilitychange] Saving data before hiding...');
            appData.updatedAt = Date.now();
            saveLocalData(appData);
            // Force sync to Firebase when going background
            if (dataRef && userId) {
                try {
                    await setDoc(dataRef, appData);
                    console.log('[visibilitychange] Sync to Firebase successful');
                } catch (e) {
                    console.error('[visibilitychange] Sync to Firebase failed', e);
                }
            }
        }
    });

    setInterval(updateUI, 1000);
});

