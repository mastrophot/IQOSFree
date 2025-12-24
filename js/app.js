import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, linkWithPopup, signOut, signInWithCredential } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

import { firebaseConfig, appId } from './firebase-config.js';
import { getStickPluralForm, formatHoursToReadable, formatMinutesToReadable } from './utils.js';
import { renderDailySmokeChart, destroyChart } from './charts.js';

// --- APPLICATION STATE ---
let app;
let db;
let auth;

let userId = null;
let dataRef = null;
let appData = {
    lastSmokeTime: null,
    smokeHistory: [],
    settings: {
        packPrice: 100,
        packSize: 20,
        oldHabit: 20, 
        smokeIntervalMinutes: 60, 
        desiredDailySticks: 10 
    },
    longestSmokeFreeStreakHours: 0 
};

let eventListenersAttached = false;
let isInitialAuthCheckComplete = false;

// --- DOM ELEMENTS ---
// (Initialized in DOMContentLoaded)
let loader, appContainer, mainView, settingsView, timerEl, statusMessageEl;
let smokeButton, emergencySmokeButton, openSettingsButton, closeSettingsButton, saveSettingsButton, resetDataButton;
let smokedTodayValueEl, smokedTodayPlannedEl, spentTodayValueEl, spentTodayPlannedEl;
let totalMoneySavedEl, smokeFreeStreakEl, longestSmokeFreeStreakEl, expectedTotalMoneyEl;
let signInGoogleButton, signOutButton, userStatusDisplay;
let packPriceInput, packSizeInput, oldHabitInput, smokeIntervalMinutesInput, oldHabitMoneyEl, desiredDailySticksInput, desiredDailySticksMoneyEl;
let dailySmokingChartSection, dailySmokeChartCanvas;
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
            appData.appStartDate = loadedData.appStartDate || Date.now();
            appData.longestSmokeFreeStreakHours = loadedData.longestSmokeFreeStreakHours || 0;
        } else {
            console.log("No such document! Creating default.");
            appData.appStartDate = Date.now();
            appData.longestSmokeFreeStreakHours = 0; 
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

    if (!dailySmokingChartSection.hasAttribute('open')) {
        destroyChart();
    } else {
        renderDailySmokeChart(dailySmokeChartCanvas, appData.smokeHistory);
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
    
    spentTodayValueEl.textContent = `${actualSpentToday.toFixed(2)} грн`; 
    spentTodayPlannedEl.textContent = `З ${plannedSpentToday.toFixed(2)} грн запланованих`;

    if (smokedTodayCount > desiredDailySticks) {
        spentTodayValueEl.classList.remove('text-green-400');
        spentTodayValueEl.classList.add('text-red-500');
    } else {
        spentTodayValueEl.classList.remove('text-red-500');
        spentTodayValueEl.classList.add('text-green-400');
    }

    const daysSinceAppStart = (now - appData.appStartDate) / (1000 * 60 * 60 * 24);
    const expectedTotalSmokes = daysSinceAppStart * oldHabit; 
    const actualTotalSmokes = appData.smokeHistory.length;
    const totalMoneySaved = Math.max(0, Math.floor(expectedTotalSmokes - actualTotalSmokes)) * pricePerCig; 

    totalMoneySavedEl.textContent = `${totalMoneySaved.toFixed(2)} грн`;

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

    const expectedMoneyTodayBasedOnOldHabit = oldHabit * pricePerCig; 
    expectedTotalMoneyEl.textContent = `${expectedMoneyTodayBasedOnOldHabit.toFixed(2)} грн`;
}

function handleSmoke(type = 'regular') {
    console.log(`[handleSmoke] ${type} smoke button clicked!`);
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
    oldHabitMoneyEl.textContent = `${oldHabitCost.toFixed(2)} грн`;
}

function updateDesiredDailySticksMoneyDisplay() {
    const packPrice = Number(packPriceInput.value) || 0;
    const packSize = Number(packSizeInput.value) || 1;
    const desiredDailySticks = Number(desiredDailySticksInput.value) || 0;
    const pricePerCig = (packSize > 0) ? packPrice / packSize : 0;
    const desiredDailySticksCost = desiredDailySticks * pricePerCig;
    desiredDailySticksMoneyEl.textContent = `${desiredDailySticksCost.toFixed(2)} грн`;
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
        appData = {
            lastSmokeTime: null,
            smokeHistory: [],
            settings: { packPrice: 100, packSize: 20, oldHabit: 20, smokeIntervalMinutes: 60, desiredDailySticks: 10 }, 
            appStartDate: Date.now(),
            longestSmokeFreeStreakHours: 0 
        };
        await saveData();
        updateSettingsInputs();
        updateUI();
    });
}

function toggleSettingsView() {
    mainView.classList.toggle('hidden');
    settingsView.classList.toggle('hidden');
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
    smokeButton = document.getElementById('smokeButton');
    emergencySmokeButton = document.getElementById('emergencySmokeButton');
    
    smokedTodayValueEl = document.getElementById('smokedTodayValue');
    smokedTodayPlannedEl = document.getElementById('smokedTodayPlanned');
    spentTodayValueEl = document.getElementById('spentTodayValue');
    spentTodayPlannedEl = document.getElementById('spentTodayPlanned');
    totalMoneySavedEl = document.getElementById('totalMoneySaved');
    smokeFreeStreakEl = document.getElementById('smokeFreeStreak');
    longestSmokeFreeStreakEl = document.getElementById('longestSmokeFreeStreak');
    expectedTotalMoneyEl = document.getElementById('expectedTotalMoney');
    
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

    dailySmokingChartSection = document.getElementById('dailySmokingChartSection');
    dailySmokeChartCanvas = document.getElementById('dailySmokeChart');

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
                appData = { 
                    lastSmokeTime: null,
                    smokeHistory: [],
                    settings: { packPrice: 100, packSize: 20, oldHabit: 20, smokeIntervalMinutes: 60, desiredDailySticks: 10 },
                    appStartDate: Date.now(),
                    longestSmokeFreeStreakHours: 0
                };
                await loadData();
            }
        }
        isInitialAuthCheckComplete = true; 
    });

    setInterval(updateUI, 1000);
});
