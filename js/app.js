import {
  getStickPluralForm,
  formatHoursToReadable,
  formatMinutesToReadable,
  formatCountdownMs,
  formatMoney,
} from "./utils.js";
import { renderSmokeChart } from "./charts.js";

// --- Bio-Core 3.0 Constants ---
const REGEN_PER_HOUR = 10;
const DAMAGE_REGULAR = 5;
const DAMAGE_EMERGENCY = 10;
const PENALTY_REGULAR_MS = 6 * 60 * 60 * 1000;
const PENALTY_EMERGENCY_MS = 12 * 60 * 60 * 1000;

const STORAGE_KEY = "iqosfree_data_v4";
const BACKUP_KEY = "iqosfree_data_v4_backup";
const LEGACY_KEYS = [
  "iqosfree_data_1:53877466841:web:cde808b8a76596b19740c8",
  "iqosfree_data_quit-smoking-app-default",
];

const DETOX_STAGES = [
  { id: "20m", ms: 20 * 60 * 1000 },
  { id: "8h", ms: 8 * 60 * 60 * 1000 },
  { id: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "48h", ms: 48 * 60 * 60 * 1000 },
];

function getDefaultAppData() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return {
    lastSmokeTime: null,
    smokeHistory: [],
    settings: {
      currency: "UAH",
      packPrice: 130,
      packSize: 20,
      oldHabit: 20,
      smokeIntervalMinutes: 60,
      desiredDailySticks: 10,
    },
    longestSmokeFreeStreakHours: 0,
    appStartDate: startOfToday.getTime(),
    settingsUpdatedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  const seen = new Set();
  const cleaned = [];

  for (const item of rawHistory) {
    const ts = typeof item === "number" ? item : Number(item && item.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (seen.has(ts)) continue;
    seen.add(ts);
    const type = item && item.type === "emergency" ? "emergency" : "regular";
    cleaned.push({ timestamp: ts, type });
  }

  cleaned.sort((a, b) => a.timestamp - b.timestamp);
  return cleaned;
}

function sanitizeAppData(raw) {
  const defaults = getDefaultAppData();
  if (!raw || typeof raw !== "object") return defaults;

  const history = sanitizeHistory(raw.smokeHistory);
  const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};

  const packPrice = Number.isFinite(Number(rawSettings.packPrice)) && Number(rawSettings.packPrice) >= 0
    ? Number(rawSettings.packPrice)
    : defaults.settings.packPrice;

  // Preserve currency choice; for migrated legacy configs without currency, infer USD if packPrice <= 25
  let currency = rawSettings.currency;
  if (!["UAH", "USD", "EUR"].includes(currency)) {
    currency = rawSettings.packPrice !== undefined && packPrice > 0 && packPrice <= 25 ? "USD" : "UAH";
  }

  const packSize = Number.isFinite(Number(rawSettings.packSize)) && Number(rawSettings.packSize) >= 1
    ? Math.round(Number(rawSettings.packSize))
    : defaults.settings.packSize;

  const oldHabit = Number.isFinite(Number(rawSettings.oldHabit)) && Number(rawSettings.oldHabit) >= 0
    ? Number(rawSettings.oldHabit)
    : defaults.settings.oldHabit;

  const desiredDailySticks =
    Number.isFinite(Number(rawSettings.desiredDailySticks)) && Number(rawSettings.desiredDailySticks) >= 0
      ? Number(rawSettings.desiredDailySticks)
      : defaults.settings.desiredDailySticks;

  const smokeIntervalMinutes =
    Number.isFinite(Number(rawSettings.smokeIntervalMinutes)) && Number(rawSettings.smokeIntervalMinutes) >= 1
      ? Math.round(Number(rawSettings.smokeIntervalMinutes))
      : defaults.settings.smokeIntervalMinutes;

  const earliestSmoke = history.length > 0 ? history[0].timestamp : null;
  let appStartDate = Number(raw.appStartDate);
  if (!Number.isFinite(appStartDate) || appStartDate <= 0) {
    appStartDate = earliestSmoke || defaults.appStartDate;
  } else if (earliestSmoke && earliestSmoke < appStartDate) {
    appStartDate = earliestSmoke;
  }

  const lastSmokeTime = history.length > 0 ? history[history.length - 1].timestamp : null;
  const longestSmokeFreeStreakHours = Math.max(0, Math.floor(Number(raw.longestSmokeFreeStreakHours) || 0));

  return {
    lastSmokeTime,
    smokeHistory: history,
    settings: {
      currency,
      packPrice,
      packSize,
      oldHabit,
      smokeIntervalMinutes,
      desiredDailySticks,
    },
    longestSmokeFreeStreakHours,
    appStartDate,
    settingsUpdatedAt: Number(raw.settingsUpdatedAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function readJsonKey(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadInitialState() {
  const current = readJsonKey(STORAGE_KEY);
  if (current) return sanitizeAppData(current);

  // Migrate seamlessly from legacy storage keys if present
  for (const legacyKey of LEGACY_KEYS) {
    const legacy = readJsonKey(legacyKey) || readJsonKey(`${legacyKey}_backup`);
    if (legacy) {
      const migrated = sanitizeAppData(legacy);
      persistState(migrated);
      return migrated;
    }
  }

  const backup = readJsonKey(BACKUP_KEY);
  if (backup) return sanitizeAppData(backup);

  return getDefaultAppData();
}

function persistState(state, bumpTimestamp = true) {
  if (!state) return;
  if (bumpTimestamp) state.updatedAt = Date.now();
  try {
    const serialized = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, serialized);
    if (state.smokeHistory.length > 0) {
      localStorage.setItem(BACKUP_KEY, serialized);
    }
  } catch (err) {
    console.error("[Storage] Save failed:", err);
  }
}

// --- Runtime State ---
let appData = loadInitialState();
let currentChartPeriod = "day";
let currentChartMode = "sticks";

let tickIntervalId = null;
let undoTimeoutId = null;
let undoIntervalId = null;
let toastTimeoutId = null;
let breatheRafId = null;
let breatheStartMs = 0;

let lastRenderedStage = -1;
let lastRenderedHealth = -1;

// --- DOM References ---
const dom = {};

function cacheDom() {
  dom.storageStatusText = document.getElementById("storageStatusText");
  dom.openSettingsButton = document.getElementById("openSettingsButton");
  dom.closeSettingsButton = document.getElementById("closeSettingsButton");
  dom.saveSettingsButton = document.getElementById("saveSettingsButton");
  dom.settingsModal = document.getElementById("settingsModal");

  dom.currencySelect = document.getElementById("currencySelect");
  dom.packPrice = document.getElementById("packPrice");
  dom.packSize = document.getElementById("packSize");
  dom.oldHabit = document.getElementById("oldHabit");
  dom.oldHabitMoney = document.getElementById("oldHabitMoney");
  dom.desiredDailySticks = document.getElementById("desiredDailySticks");
  dom.desiredDailySticksMoney = document.getElementById("desiredDailySticksMoney");
  dom.smokeIntervalMinutes = document.getElementById("smokeIntervalMinutes");

  dom.exportBackupButton = document.getElementById("exportBackupButton");
  dom.importBackupButton = document.getElementById("importBackupButton");
  dom.importBackupInput = document.getElementById("importBackupInput");
  dom.hardRefreshButton = document.getElementById("hardRefreshButton");
  dom.resetDataButton = document.getElementById("resetDataButton");

  dom.treeContainer = document.getElementById("treeContainer");
  dom.toxicCloud = document.getElementById("toxicCloud");
  dom.treeImage = document.getElementById("treeImage");
  dom.growthStage = document.getElementById("growthStage");
  dom.healthValue = document.getElementById("healthValue");

  dom.timer = document.getElementById("timer");
  dom.statusMessage = document.getElementById("statusMessage");

  dom.sosButton = document.getElementById("sosButton");
  dom.smokeButton = document.getElementById("smokeButton");
  dom.smokeButtonLabel = document.getElementById("smokeButtonLabel");
  dom.smokeButtonSub = document.getElementById("smokeButtonSub");
  dom.emergencySmokeButton = document.getElementById("emergencySmokeButton");

  dom.smokedTodayValue = document.getElementById("smokedTodayValue");
  dom.smokedTodayPlanned = document.getElementById("smokedTodayPlanned");
  dom.spentTodayValue = document.getElementById("spentTodayValue");
  dom.spentTodayPlanned = document.getElementById("spentTodayPlanned");
  dom.smokeFreeStreak = document.getElementById("smokeFreeStreak");
  dom.longestSmokeFreeStreak = document.getElementById("longestSmokeFreeStreak");
  dom.financialBalanceLabel = document.getElementById("financialBalanceLabel");
  dom.financialBalanceValue = document.getElementById("financialBalanceValue");
  dom.allTimeSavingsSub = document.getElementById("allTimeSavingsSub");

  dom.detoxEls = DETOX_STAGES.map((stage) => ({
    ...stage,
    valEl: document.getElementById(`detoxVal-${stage.id}`),
    barEl: document.getElementById(`detoxBar-${stage.id}`),
  }));

  dom.modeBtns = document.querySelectorAll(".mode-btn");
  dom.statsTabs = document.querySelectorAll(".stats-tab");
  dom.totalSmokesAllTime = document.getElementById("totalSmokesAllTime");
  dom.avgSmokesPerDay = document.getElementById("avgSmokesPerDay");
  dom.smokeChart = document.getElementById("smokeChart");

  dom.insightsTitle = document.getElementById("insightsTitle");
  dom.peakHourValue = document.getElementById("peakHourValue");
  dom.activityHeatmap = document.getElementById("activityHeatmap");
  dom.heatmapLabels = document.getElementById("heatmapLabels");

  dom.confirmModal = document.getElementById("confirmModal");
  dom.confirmTitle = document.getElementById("confirmTitle");
  dom.modalText = document.getElementById("modalText");
  dom.confirmNo = document.getElementById("confirmNo");
  dom.confirmYes = document.getElementById("confirmYes");

  dom.breatheModal = document.getElementById("breatheModal");
  dom.breatheCircle = document.getElementById("breatheCircle");
  dom.breatheText = document.getElementById("breatheText");
  dom.breatheTimer = document.getElementById("breatheTimer");
  dom.closeBreatheBtn = document.getElementById("closeBreatheBtn");

  dom.undoNotification = document.getElementById("undoNotification");
  dom.undoTimerText = document.getElementById("undoTimerText");
  dom.undoActionBtn = document.getElementById("undoActionBtn");

  dom.pwaInstallBanner = document.getElementById("pwaInstallBanner");
  dom.pwaInstallBtn = document.getElementById("pwaInstallBtn");

  dom.statusToast = document.getElementById("statusToast");
  dom.statusToastTitle = document.getElementById("statusToastTitle");
  dom.statusToastSub = document.getElementById("statusToastSub");
  dom.statusToastAction = document.getElementById("statusToastAction");
}

// --- Bio-Core 3.0 Calculation (History already kept sorted) ---
function calculateTreeState(now) {
  const appStart = appData.appStartDate || now - 86400000;
  let health = 100;
  let lastT = appStart;
  let totalPenalty = 0;

  for (const record of appData.smokeHistory) {
    totalPenalty += record.type === "emergency" ? PENALTY_EMERGENCY_MS : PENALTY_REGULAR_MS;
    if (record.timestamp < appStart) continue;

    const elapsedHours = (record.timestamp - lastT) / 3600000;
    if (elapsedHours > 0) {
      health = Math.min(100, health + elapsedHours * REGEN_PER_HOUR);
    }

    const damage = record.type === "emergency" ? DAMAGE_EMERGENCY : DAMAGE_REGULAR;
    health = Math.max(0, health - damage);
    lastT = record.timestamp;
  }

  const finalElapsedHours = (now - lastT) / 3600000;
  if (finalElapsedHours > 0) {
    health = Math.min(100, health + finalElapsedHours * REGEN_PER_HOUR);
  }

  const totalPossibleTime = Math.max(0, now - appStart);
  const evolutionMs = Math.max(0, totalPossibleTime - totalPenalty);

  return {
    health: Math.round(health),
    evolutionMs,
  };
}

function getStageMeta(evolutionMs) {
  const days = evolutionMs / 86400000;
  if (days >= 14) return { stage: 5, title: "Міфічний дуб" };
  if (days >= 7) return { stage: 4, title: "Велике дерево" };
  if (days >= 3) return { stage: 3, title: "Середнє дерево" };
  if (days >= 1) return { stage: 2, title: "Саджанець" };
  return { stage: 1, title: "Паросток" };
}

// --- Lightweight 1 Hz Realtime Tick (Zero Canvas/Heatmap Churn) ---
function tickRealtimeUI() {
  const now = Date.now();
  const intervalMs = appData.settings.smokeIntervalMinutes * 60 * 1000;
  const elapsedSinceLast = appData.lastSmokeTime ? Math.max(0, now - appData.lastSmokeTime) : intervalMs;
  const remainingMs = intervalMs - elapsedSinceLast;

  if (remainingMs > 0) {
    const formatted = formatCountdownMs(remainingMs);
    dom.timer.textContent = formatted;
    dom.timer.classList.add("is-locked");
    dom.timer.classList.remove("is-open");
    dom.statusMessage.textContent = "До наступного вікна за графіком";
    dom.smokeButton.disabled = true;
    dom.smokeButtonLabel.textContent = `Закрито · ${formatted}`;
  } else {
    const cleanMinutes = appData.lastSmokeTime
      ? Math.floor((now - appData.lastSmokeTime) / 60000)
      : Math.floor((now - appData.appStartDate) / 60000);
    dom.timer.textContent = formatCountdownMs(
      appData.lastSmokeTime ? now - appData.lastSmokeTime : now - appData.appStartDate
    );
    dom.timer.classList.remove("is-locked");
    dom.timer.classList.add("is-open");
    dom.statusMessage.textContent =
      cleanMinutes >= 60 ? "Чистий час (вікно відкрите)" : "Пауза витримана · вікно відкрите";
    dom.smokeButton.disabled = false;
    dom.smokeButtonLabel.textContent = "Зафіксувати стік";
  }

  // Streak & Record
  const streakMs = appData.lastSmokeTime ? Math.max(0, now - appData.lastSmokeTime) : Math.max(0, now - appData.appStartDate);
  const streakMinutes = Math.floor(streakMs / 60000);
  const streakHours = Math.floor(streakMinutes / 60);

  if (streakHours > appData.longestSmokeFreeStreakHours) {
    appData.longestSmokeFreeStreakHours = streakHours;
    persistState(appData, false);
  }

  dom.smokeFreeStreak.textContent = formatMinutesToReadable(streakMinutes);
  dom.longestSmokeFreeStreak.textContent = formatHoursToReadable(appData.longestSmokeFreeStreakHours);

  // Detox progress bars
  const detoxElapsed = appData.lastSmokeTime ? Math.max(0, now - appData.lastSmokeTime) : 48 * 3600000;
  for (const item of dom.detoxEls) {
    const pct = Math.min(100, Math.floor((detoxElapsed / item.ms) * 100));
    const pctText = `${pct}%`;
    if (item.valEl.textContent !== pctText) {
      item.valEl.textContent = pctText;
      item.barEl.style.width = pctText;
      item.valEl.classList.toggle("is-complete", pct === 100);
      item.barEl.classList.toggle("is-complete", pct === 100);
    }
  }

  // Tree state (DOM touched ONLY when integer health or stage changes)
  const { health, evolutionMs } = calculateTreeState(now);
  const { stage, title } = getStageMeta(evolutionMs);

  if (stage !== lastRenderedStage || health !== lastRenderedHealth) {
    lastRenderedStage = stage;
    lastRenderedHealth = health;

    const targetSrc = `assets/tree_${stage}.webp`;
    if (dom.treeImage.getAttribute("src") !== targetSrc) {
      dom.treeImage.setAttribute("src", targetSrc);
    }

    const healthLevel = Math.max(1, Math.min(10, Math.ceil(health / 10) || 1));
    dom.treeImage.className = `tree-lvl-${healthLevel}${stage === 5 ? " tree-stage-5" : ""}`;

    dom.growthStage.textContent = `Стадія ${stage}/5 · ${title}`;
    dom.healthValue.textContent = `Здоров'я: ${health}%`;

    dom.healthValue.classList.remove("hp-good", "hp-warn", "hp-bad");
    if (health > 70) dom.healthValue.classList.add("hp-good");
    else if (health > 30) dom.healthValue.classList.add("hp-warn");
    else dom.healthValue.classList.add("hp-bad");
  }
}

// --- Heavy Dashboard Render (Runs ONLY on Data / Tab Changes) ---
function renderFullDashboard() {
  const now = Date.now();
  tickRealtimeUI();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayTs = startOfToday.getTime();

  const { currency, packPrice, packSize, oldHabit, desiredDailySticks } = appData.settings;
  const pricePerStick = packSize > 0 ? packPrice / packSize : 0;

  let smokedTodayCount = 0;
  for (let i = appData.smokeHistory.length - 1; i >= 0; i--) {
    if (appData.smokeHistory[i].timestamp >= todayTs) smokedTodayCount++;
    else break;
  }

  dom.smokedTodayValue.textContent = `${smokedTodayCount} ${getStickPluralForm(smokedTodayCount)}`;
  dom.smokedTodayPlanned.textContent = `Ліміт: ${desiredDailySticks} на день`;

  const actualSpentToday = smokedTodayCount * pricePerStick;
  const plannedSpentToday = desiredDailySticks * pricePerStick;

  dom.spentTodayValue.textContent = formatMoney(actualSpentToday, currency);
  dom.spentTodayPlanned.textContent = `План: ${formatMoney(plannedSpentToday, currency)}`;
  dom.spentTodayValue.classList.toggle("val-bad", smokedTodayCount > desiredDailySticks);
  dom.spentTodayValue.classList.toggle("val-good", smokedTodayCount <= desiredDailySticks);

  const todayBalance = (desiredDailySticks - smokedTodayCount) * pricePerStick;
  const overLimit = smokedTodayCount > desiredDailySticks;

  dom.financialBalanceLabel.textContent = overLimit ? "Перевитрата за сьогодні" : "Денний резерв ліміту";
  dom.financialBalanceValue.textContent = formatMoney(todayBalance, currency, true);
  dom.financialBalanceValue.classList.toggle("val-good", !overLimit);
  dom.financialBalanceValue.classList.toggle("val-bad", overLimit);

  // All-time savings vs old habit
  const daysActive = Math.max(1, (now - appData.appStartDate) / 86400000);
  const expectedOldHabitSticks = daysActive * oldHabit;
  const savedTotalMoney = (expectedOldHabitSticks - appData.smokeHistory.length) * pricePerStick;
  dom.allTimeSavingsSub.textContent = `Від старої звички: ${formatMoney(savedTotalMoney, currency, true)}`;

  // Global summary
  const totalSmokes = appData.smokeHistory.length;
  dom.totalSmokesAllTime.textContent = String(totalSmokes);
  dom.avgSmokesPerDay.textContent = (totalSmokes / daysActive).toFixed(1);

  dom.storageStatusText.textContent = `Локально · записів: ${totalSmokes}`;

  // Chart & Insights Heatmap
  renderSmokeChart(dom.smokeChart, appData.smokeHistory, currentChartPeriod, currentChartMode, appData.settings);
  renderInsightsHeatmap(now);
}

function renderInsightsHeatmap(now) {
  let buckets = [];
  let axisLabels = [];
  let peakText = "Недостатньо даних";

  if (currentChartPeriod === "day") {
    dom.insightsTitle.textContent = "Пікове вікно (останні 30 днів)";
    buckets = new Array(24).fill(0);
    axisLabels = ["00:00", "06:00", "12:00", "18:00", "23:59"];

    const cutoff = now - 30 * 86400000;
    for (const s of appData.smokeHistory) {
      if (s.timestamp >= cutoff) {
        buckets[new Date(s.timestamp).getHours()]++;
      }
    }

    let maxSum = 0;
    let bestHour = 0;
    for (let h = 0; h <= 21; h++) {
      const sum = buckets[h] + buckets[h + 1] + buckets[h + 2];
      if (sum > maxSum) {
        maxSum = sum;
        bestHour = h;
      }
    }
    if (maxSum > 0) {
      peakText = `${String(bestHour).padStart(2, "0")}:00–${String(bestHour + 3).padStart(2, "0")}:00`;
    }
  } else if (currentChartPeriod === "week") {
    dom.insightsTitle.textContent = "Найважчий день тижня (90 днів)";
    const rawDays = new Array(7).fill(0);
    const cutoff = now - 90 * 86400000;
    for (const s of appData.smokeHistory) {
      if (s.timestamp >= cutoff) {
        rawDays[new Date(s.timestamp).getDay()]++;
      }
    }
    const order = [1, 2, 3, 4, 5, 6, 0];
    axisLabels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
    buckets = order.map((idx) => rawDays[idx]);

    const maxVal = Math.max(...buckets, 0);
    if (maxVal > 0) {
      peakText = axisLabels[buckets.indexOf(maxVal)];
    }
  } else {
    dom.insightsTitle.textContent = "Піковий місяць";
    buckets = new Array(12).fill(0);
    const months = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];
    axisLabels = ["Січ", "Кві", "Лип", "Жов", "Гру"];

    for (const s of appData.smokeHistory) {
      buckets[new Date(s.timestamp).getMonth()]++;
    }
    const maxVal = Math.max(...buckets, 0);
    if (maxVal > 0) {
      peakText = months[buckets.indexOf(maxVal)];
    }
  }

  dom.peakHourValue.textContent = peakText;

  const maxBucket = Math.max(...buckets, 1);
  const frag = document.createDocumentFragment();
  for (const val of buckets) {
    const cell = document.createElement("div");
    cell.className = "heatmap-cell";
    const ratio = val / maxBucket;
    cell.style.backgroundColor =
      val === 0 ? "rgba(255, 255, 255, 0.04)" : `rgba(239, 68, 68, ${(0.18 + ratio * 0.78).toFixed(2)})`;
    frag.appendChild(cell);
  }
  dom.activityHeatmap.replaceChildren(frag);

  const labelFrag = document.createDocumentFragment();
  for (const text of axisLabels) {
    const span = document.createElement("span");
    span.textContent = text;
    labelFrag.appendChild(span);
  }
  dom.heatmapLabels.replaceChildren(labelFrag);
}

// --- Actions: Smoke, Leaf Fall & Undo ---
function triggerLeafFall(count) {
  for (let i = 0; i < count; i++) {
    const leaf = document.createElement("div");
    leaf.className = "leaf-falling";
    leaf.style.left = `${95 + (Math.random() * 54 - 27)}px`;
    leaf.style.top = `${72 + (Math.random() * 36 - 18)}px`;
    dom.treeContainer.appendChild(leaf);
    setTimeout(() => leaf.remove(), 1550);
  }
}

function handleSmoke(type = "regular") {
  if (navigator.vibrate) {
    navigator.vibrate(type === "emergency" ? [40, 40, 40] : 35);
  }

  const isEmergency = type === "emergency";
  const shakeClass = isEmergency ? "tree-shake-heavy" : "tree-shake-light";
  dom.treeContainer.classList.add(shakeClass);
  dom.toxicCloud.classList.add("active");
  triggerLeafFall(isEmergency ? 10 : 4);

  setTimeout(() => {
    dom.treeContainer.classList.remove(shakeClass);
    dom.toxicCloud.classList.remove("active");
  }, 900);

  const now = Date.now();
  appData.lastSmokeTime = now;
  appData.smokeHistory.push({ timestamp: now, type: isEmergency ? "emergency" : "regular" });

  persistState(appData, true);
  renderFullDashboard();
  showUndoToast();
}

function showUndoToast() {
  clearTimeout(undoTimeoutId);
  clearInterval(undoIntervalId);

  let secondsLeft = 60;
  dom.undoTimerText.textContent = `Скасувати можна ще ${secondsLeft} с`;
  dom.undoNotification.classList.add("is-visible");

  undoIntervalId = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      hideUndoToast();
    } else {
      dom.undoTimerText.textContent = `Скасувати можна ще ${secondsLeft} с`;
    }
  }, 1000);

  undoTimeoutId = setTimeout(hideUndoToast, 60000);
}

function hideUndoToast() {
  dom.undoNotification.classList.remove("is-visible");
  clearInterval(undoIntervalId);
  clearTimeout(undoTimeoutId);
}

function handleUndoSmoke() {
  if (appData.smokeHistory.length === 0) return;
  appData.smokeHistory.pop();
  appData.lastSmokeTime =
    appData.smokeHistory.length > 0
      ? appData.smokeHistory[appData.smokeHistory.length - 1].timestamp
      : null;

  hideUndoToast();
  persistState(appData, true);
  renderFullDashboard();
  showStatusToast("Останній стік скасовано", "Історію та здоров'я дерева відновлено");
}

// --- Phase-Locked Urge Surfing Breathing (5s Inhale Expand, 5s Exhale Contract) ---
function stepBreathingFrame(nowPerf) {
  const elapsedMs = nowPerf - breatheStartMs;
  const remainingMs = 60000 - elapsedMs;

  if (remainingMs <= 0) {
    stopBreathing();
    showStatusToast("Хвилю тяги пройдено", "60 секунд дихання завершено без стіка");
    return;
  }

  const secondsLeft = Math.ceil(remainingMs / 1000);
  if (dom.breatheTimer.textContent !== String(secondsLeft)) {
    dom.breatheTimer.textContent = String(secondsLeft);
  }

  const cyclePos = elapsedMs % 10000; // 0..10000 ms
  const isInhale = cyclePos < 5000;
  const phaseLabel = isInhale ? "Вдих" : "Видих";
  if (dom.breatheText.textContent !== phaseLabel) {
    dom.breatheText.textContent = phaseLabel;
  }

  // Smooth cosine wave: 0 ms -> scale 1.00, 5000 ms -> scale 1.28, 10000 ms -> scale 1.00
  const progress01 = (1 - Math.cos((cyclePos / 5000) * Math.PI)) / 2;
  const scale = 1 + progress01 * 0.28;
  dom.breatheCircle.style.transform = `scale(${scale.toFixed(4)})`;

  breatheRafId = requestAnimationFrame(stepBreathingFrame);
}

function startBreathing() {
  cancelAnimationFrame(breatheRafId);
  breatheStartMs = performance.now();
  dom.breatheTimer.textContent = "60";
  dom.breatheText.textContent = "Вдих";
  dom.breatheCircle.style.transform = "scale(1)";

  if (!dom.breatheModal.open) {
    dom.breatheModal.showModal();
  }
  breatheRafId = requestAnimationFrame(stepBreathingFrame);
}

function stopBreathing() {
  cancelAnimationFrame(breatheRafId);
  breatheRafId = null;
  dom.breatheCircle.style.transform = "scale(1)";
  if (dom.breatheModal.open) {
    dom.breatheModal.close();
  }
}

// --- Accessible Native Dialog Helpers ---
function askConfirm(title, message, confirmLabel = "Підтвердити") {
  return new Promise((resolve) => {
    dom.confirmTitle.textContent = title;
    dom.modalText.textContent = message;
    dom.confirmYes.textContent = confirmLabel;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      dom.confirmYes.removeEventListener("click", onYes);
      dom.confirmNo.removeEventListener("click", onNo);
      dom.confirmModal.removeEventListener("close", onClose);
      if (dom.confirmModal.open) dom.confirmModal.close();
      resolve(result);
    };

    const onYes = () => finish(true);
    const onNo = () => finish(false);
    const onClose = () => finish(false);

    dom.confirmYes.addEventListener("click", onYes);
    dom.confirmNo.addEventListener("click", onNo);
    dom.confirmModal.addEventListener("close", onClose);

    dom.confirmModal.showModal();
  });
}

function showStatusToast(title, sub = "", actionLabel = "", onAction = null, durationMs = 3600) {
  clearTimeout(toastTimeoutId);
  dom.statusToastTitle.textContent = title;
  dom.statusToastSub.textContent = sub;

  if (actionLabel && typeof onAction === "function") {
    dom.statusToastAction.textContent = actionLabel;
    dom.statusToastAction.classList.remove("hidden");
    dom.statusToastAction.onclick = () => {
      dom.statusToast.classList.remove("is-visible");
      onAction();
    };
  } else {
    dom.statusToastAction.classList.add("hidden");
    dom.statusToastAction.onclick = null;
  }

  dom.statusToast.classList.add("is-visible");
  if (!onAction && durationMs > 0) {
    toastTimeoutId = setTimeout(() => {
      dom.statusToast.classList.remove("is-visible");
    }, durationMs);
  }
}

// --- Settings & Backup Management ---
function updateSettingsMoneyPreviews() {
  const currency = dom.currencySelect.value || "UAH";
  const packPrice = Math.max(0, Number(dom.packPrice.value) || 0);
  const packSize = Math.max(1, Number(dom.packSize.value) || 1);
  const oldHabit = Math.max(0, Number(dom.oldHabit.value) || 0);
  const desiredDaily = Math.max(0, Number(dom.desiredDailySticks.value) || 0);
  const perStick = packPrice / packSize;

  dom.oldHabitMoney.textContent = `${formatMoney(oldHabit * perStick, currency)}/день`;
  dom.desiredDailySticksMoney.textContent = `${formatMoney(desiredDaily * perStick, currency)}/день`;
}

function populateSettingsForm() {
  const s = appData.settings;
  dom.currencySelect.value = s.currency || "UAH";
  dom.packPrice.value = s.packPrice;
  dom.packSize.value = s.packSize;
  dom.oldHabit.value = s.oldHabit;
  dom.desiredDailySticks.value = s.desiredDailySticks;
  dom.smokeIntervalMinutes.value = s.smokeIntervalMinutes;
  updateSettingsMoneyPreviews();
}

function openSettingsModal() {
  populateSettingsForm();
  document.body.style.overflow = "hidden";
  dom.settingsModal.showModal();
}

function closeSettingsModal() {
  if (dom.settingsModal.open) {
    dom.settingsModal.close();
  }
  document.body.style.overflow = "";
}

function handleSaveSettings() {
  appData.settings = {
    currency: ["UAH", "USD", "EUR"].includes(dom.currencySelect.value) ? dom.currencySelect.value : "UAH",
    packPrice: Math.max(0, Number(dom.packPrice.value) || 0),
    packSize: Math.max(1, Math.round(Number(dom.packSize.value) || 20)),
    oldHabit: Math.max(0, Number(dom.oldHabit.value) || 0),
    desiredDailySticks: Math.max(0, Number(dom.desiredDailySticks.value) || 0),
    smokeIntervalMinutes: Math.max(1, Math.round(Number(dom.smokeIntervalMinutes.value) || 60)),
  };
  appData.settingsUpdatedAt = Date.now();

  persistState(appData, true);
  closeSettingsModal();
  renderFullDashboard();
  showStatusToast("Параметри збережено", "Ліміти, інтервал та валюту оновлено");
}

function handleExportBackup() {
  const payload = {
    schema: "iqosfree-v4",
    exportedAt: new Date().toISOString(),
    data: appData,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const dateTag = new Date().toISOString().slice(0, 10);
  const link = document.createElement("a");
  link.href = url;
  link.download = `iqosfree-backup-${dateTag}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showStatusToast("Резервну копію збережено", `Файл iqosfree-backup-${dateTag}.json завантажено`);
}

async function handleImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const candidate = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!candidate || (!Array.isArray(candidate.smokeHistory) && !candidate.settings)) {
      showStatusToast("Некоректний файл", "JSON не містить структури IQOSFree");
      return;
    }

    const sanitized = sanitizeAppData(candidate);
    const ok = await askConfirm(
      "Відновити резервну копію?",
      `У файлі знайдено записів стіків: ${sanitized.smokeHistory.length}. Поточні дані буде замінено.`,
      "Відновити"
    );
    if (!ok) return;

    appData = sanitized;
    lastRenderedStage = -1;
    lastRenderedHealth = -1;
    persistState(appData, true);
    closeSettingsModal();
    renderFullDashboard();
    showStatusToast("Дані відновлено", `Імпортовано записів: ${appData.smokeHistory.length}`);
  } catch {
    showStatusToast("Помилка читання JSON", "Перевірте цілісність файлу резервної копії");
  }
}

async function handleHardRefresh() {
  const ok = await askConfirm(
    "Оновити кеш застосунку?",
    "Історія куріння та налаштування збережуться, оновиться лише офлайн-кеш файлів.",
    "Оновити кеш"
  );
  if (!ok) return;

  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    for (const key of keys) await caches.delete(key);
  }
  window.location.reload();
}

async function handleResetData() {
  const ok = await askConfirm(
    "Скинути всю історію?",
    "Усі записи про викурені стіки та рекорди буде остаточно видалено з цього пристрою.",
    "Видалити все"
  );
  if (!ok) return;

  localStorage.removeItem(BACKUP_KEY);
  for (const legacyKey of LEGACY_KEYS) {
    localStorage.removeItem(legacyKey);
    localStorage.removeItem(`${legacyKey}_backup`);
  }

  appData = getDefaultAppData();
  lastRenderedStage = -1;
  lastRenderedHealth = -1;
  hideUndoToast();
  persistState(appData, true);
  closeSettingsModal();
  renderFullDashboard();
  showStatusToast("Історію очищено", "Відлік розпочато з чистого аркуша");
}

// --- Timer Lifecycle (0% CPU in Hidden Tabs) ---
function startRealtimeTicker() {
  if (tickIntervalId !== null) return;
  tickIntervalId = setInterval(tickRealtimeUI, 1000);
}

function stopRealtimeTicker() {
  if (tickIntervalId !== null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
}

// --- PWA Install & Service Worker ---
function setupPwaAndServiceWorker() {
  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    dom.pwaInstallBanner.classList.add("is-visible");
  });

  dom.pwaInstallBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    dom.pwaInstallBanner.classList.remove("is-visible");
  });

  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              showStatusToast(
                "Доступне оновлення IQOSFree",
                "Натисніть, щоб застосувати нову версію",
                "Оновити",
                () => {
                  worker.postMessage({ type: "SKIP_WAITING" });
                  window.location.reload();
                },
                0
              );
            }
          });
        });
      })
      .catch((err) => console.warn("[SW] Registration skipped:", err));
  });
}

// --- Handle Manifest Shortcut Deep Links Safely ---
function handleShortcutDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get("action");
  if (!action) return;

  window.history.replaceState({}, document.title, window.location.pathname);
  if (action === "sos") {
    startBreathing();
  } else if (action === "smoke") {
    if (!dom.smokeButton.disabled) {
      handleSmoke("regular");
    } else {
      showStatusToast("Вікно за графіком ще закрите", "Скористайтесь SOS або кнопкою поза графіком");
    }
  } else if (action === "emergency") {
    handleSmoke("emergency");
  }
}

// --- Bootstrap ---
document.addEventListener("DOMContentLoaded", () => {
  cacheDom();

  dom.sosButton.addEventListener("click", startBreathing);
  dom.closeBreatheBtn.addEventListener("click", stopBreathing);
  dom.breatheModal.addEventListener("close", stopBreathing);

  dom.smokeButton.addEventListener("click", () => handleSmoke("regular"));
  dom.emergencySmokeButton.addEventListener("click", () => handleSmoke("emergency"));
  dom.undoActionBtn.addEventListener("click", handleUndoSmoke);

  dom.openSettingsButton.addEventListener("click", openSettingsModal);
  dom.closeSettingsButton.addEventListener("click", closeSettingsModal);
  dom.settingsModal.addEventListener("close", () => {
    document.body.style.overflow = "";
  });
  dom.settingsModal.addEventListener("click", (e) => {
    if (e.target === dom.settingsModal) closeSettingsModal();
  });

  dom.saveSettingsButton.addEventListener("click", handleSaveSettings);
  dom.currencySelect.addEventListener("change", updateSettingsMoneyPreviews);
  dom.packPrice.addEventListener("input", updateSettingsMoneyPreviews);
  dom.packSize.addEventListener("input", updateSettingsMoneyPreviews);
  dom.oldHabit.addEventListener("input", updateSettingsMoneyPreviews);
  dom.desiredDailySticks.addEventListener("input", updateSettingsMoneyPreviews);

  dom.exportBackupButton.addEventListener("click", handleExportBackup);
  dom.importBackupButton.addEventListener("click", () => dom.importBackupInput.click());
  dom.importBackupInput.addEventListener("change", handleImportFile);
  dom.hardRefreshButton.addEventListener("click", handleHardRefresh);
  dom.resetDataButton.addEventListener("click", handleResetData);

  dom.statsTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      currentChartPeriod = tab.dataset.period || "day";
      dom.statsTabs.forEach((t) => t.classList.toggle("active", t === tab));
      renderFullDashboard();
    });
  });

  dom.modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentChartMode = btn.dataset.mode || "sticks";
      dom.modeBtns.forEach((b) => b.classList.toggle("active", b === btn));
      renderFullDashboard();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRealtimeTicker();
    } else {
      renderFullDashboard();
      startRealtimeTicker();
    }
  });

  renderFullDashboard();
  startRealtimeTicker();
  setupPwaAndServiceWorker();
  handleShortcutDeepLink();
});
