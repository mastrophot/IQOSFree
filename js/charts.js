import { formatMoney, getCurrencySymbol, getStickPluralForm } from "./utils.js";

let chartState = null;
let resizeObserver = null;
let activeCanvas = null;

function buildBuckets(smokeHistory, period) {
  const now = new Date();
  const labels = [];
  const fullLabels = [];
  const regularCounts = [];
  const emergencyCounts = [];

  if (period === "day") {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const ranges = ["00–03", "03–06", "06–09", "09–12", "12–15", "15–18", "18–21", "21–24"];
    for (let i = 0; i < 8; i++) {
      labels.push(ranges[i]);
      fullLabels.push(`${ranges[i]} год`);
      regularCounts.push(0);
      emergencyCounts.push(0);
    }

    for (const s of smokeHistory) {
      if (s.timestamp >= todayStart) {
        const hour = new Date(s.timestamp).getHours();
        const idx = Math.min(7, Math.max(0, Math.floor(hour / 3)));
        if (s.type === "emergency") emergencyCounts[idx]++;
        else regularCounts[idx]++;
      }
    }
  } else if (period === "week") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const weekday = d.toLocaleDateString("uk-UA", { weekday: "short" });
      const shortDate = d.toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
      labels.push(weekday.charAt(0).toUpperCase() + weekday.slice(1));
      fullLabels.push(i === 0 ? `Сьогодні (${shortDate})` : `${labels[labels.length - 1]}, ${shortDate}`);

      const startOfDay = d.getTime();
      const endOfDay = startOfDay + 86400000;
      let reg = 0;
      let em = 0;

      for (const s of smokeHistory) {
        if (s.timestamp >= startOfDay && s.timestamp < endOfDay) {
          if (s.type === "emergency") em++;
          else reg++;
        }
      }
      regularCounts.push(reg);
      emergencyCounts.push(em);
    }
  } else {
    // Last 6 calendar months
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const shortMonth = d.toLocaleDateString("uk-UA", { month: "short" }).replace(".", "");
      const fullMonth = d.toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
      labels.push(shortMonth.charAt(0).toUpperCase() + shortMonth.slice(1));
      fullLabels.push(fullMonth.charAt(0).toUpperCase() + fullMonth.slice(1));

      const startOfMonth = d.getTime();
      const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      let reg = 0;
      let em = 0;

      for (const s of smokeHistory) {
        if (s.timestamp >= startOfMonth && s.timestamp < endOfMonth) {
          if (s.type === "emergency") em++;
          else reg++;
        }
      }
      regularCounts.push(reg);
      emergencyCounts.push(em);
    }
  }

  return { labels, fullLabels, regularCounts, emergencyCounts };
}

function niceCeiling(maxVal, mode = "sticks") {
  const safeMax = Math.max(Number(maxVal) || 0, mode === "money" ? 1 : 4);
  const rawStep = safeMax / 4;

  if (mode !== "money" && rawStep <= 1) {
    return 4;
  }

  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const candidates = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

  for (const c of candidates) {
    const step = c * magnitude;
    if (mode !== "money" && !Number.isInteger(step)) continue;
    if (step + 1e-9 >= rawStep) {
      return step * 4;
    }
  }
  return Math.ceil(rawStep) * 4;
}

function drawRoundedRect(ctx, x, y, w, h, radii) {
  if (h <= 0 || w <= 0) return;
  const r = Math.min(radii, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  ctx.fill();
}

function paintChart() {
  if (!chartState || !activeCanvas) return;

  const parent = activeCanvas.parentElement;
  if (!parent) return;

  const rect = parent.getBoundingClientRect();
  const width = Math.max(220, Math.floor(rect.width));
  const height = Math.max(160, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  if (activeCanvas.width !== Math.round(width * dpr) || activeCanvas.height !== Math.round(height * dpr)) {
    activeCanvas.width = Math.round(width * dpr);
    activeCanvas.height = Math.round(height * dpr);
  }

  const ctx = activeCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const {
    labels,
    fullLabels,
    regularVals,
    emergencyVals,
    regularCounts,
    emergencyCounts,
    period,
    mode,
    limitValue,
    currency,
    pricePerStick,
    hoverIndex,
  } = chartState;

  const totals = regularVals.map((v, i) => v + emergencyVals[i]);
  const rawMax = Math.max(...totals, period === "week" ? limitValue || 0 : 0, 1);
  const yMax = niceCeiling(rawMax * 1.12, mode);

  const padLeft = mode === "money" ? 44 : 30;
  const padRight = 10;
  const padTop = 16;
  const padBottom = 26;
  const plotW = Math.max(40, width - padLeft - padRight);
  const plotH = Math.max(40, height - padTop - padBottom);

  ctx.font = "500 10px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";

  // Horizontal grid lines (4 steps)
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const ratio = s / steps;
    const val = yMax * (1 - ratio);
    const y = padTop + ratio * plotH;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, Math.round(y) + 0.5);
    ctx.lineTo(padLeft + plotW, Math.round(y) + 0.5);
    ctx.stroke();

    ctx.fillStyle = "#71717a";
    ctx.textAlign = "right";
    const tickLabel =
      mode === "money"
        ? val >= 100
          ? `${Math.round(val)}`
          : `${Number(val.toFixed(val % 1 === 0 ? 0 : 1))}`
        : `${Math.round(val)}`;
    ctx.fillText(tickLabel, padLeft - 6, y);
  }

  const count = labels.length;
  const slotW = plotW / count;
  const barW = Math.min(26, Math.max(10, Math.floor(slotW * 0.52)));
  chartState.geometry = { padLeft, padTop, plotW, plotH, slotW };

  // Hover column highlight
  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < count) {
    const colX = padLeft + hoverIndex * slotW;
    ctx.fillStyle = "rgba(255, 255, 255, 0.035)";
    drawRoundedRect(ctx, colX + 3, padTop, slotW - 6, plotH, 6);
  }

  const hasAnyData = totals.some((t) => t > 0);

  // Draw stacked bars
  for (let i = 0; i < count; i++) {
    const regV = regularVals[i];
    const emV = emergencyVals[i];
    const totalV = regV + emV;
    const centerX = padLeft + i * slotW + slotW / 2;
    const barX = Math.round(centerX - barW / 2);

    // X-axis label
    ctx.fillStyle = hoverIndex === i ? "#f4f4f6" : "#71717a";
    ctx.font = hoverIndex === i ? "600 10px Inter, system-ui, sans-serif" : "500 10px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(labels[i], centerX, padTop + plotH + 14);

    if (totalV <= 0) continue;

    const regH = Math.max(0, (regV / yMax) * plotH);
    const emH = Math.max(0, (emV / yMax) * plotH);
    const overLimit = period === "week" && limitValue > 0 && totalV > limitValue + 1e-6;

    if (regH > 0) {
      const regY = padTop + plotH - regH;
      ctx.fillStyle = overLimit ? "#f59e0b" : "#10b981";
      drawRoundedRect(ctx, barX, regY, barW, regH, emH > 0 ? 2 : 4);
    }

    if (emH > 0) {
      const emY = padTop + plotH - regH - emH;
      ctx.fillStyle = "#ef4444";
      drawRoundedRect(ctx, barX, emY, barW, Math.max(2, emH), 4);
    }
  }

  // Daily Goal dashed line on week view
  if (period === "week" && limitValue > 0 && limitValue <= yMax) {
    const limitY = Math.round(padTop + plotH - (limitValue / yMax) * plotH) + 0.5;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, limitY);
    ctx.lineTo(padLeft + plotW, limitY);
    ctx.stroke();
    ctx.restore();

    const limitLabel =
      mode === "money"
        ? `Ліміт ${Number(limitValue.toFixed(1))} ${getCurrencySymbol(currency)}`
        : `Ліміт ${limitValue}`;
    ctx.font = "600 9px Inter, system-ui, sans-serif";
    const textW = ctx.measureText(limitLabel).width + 8;
    const pillX = padLeft + plotW - textW - 2;
    const pillY = Math.max(padTop + 1, limitY - 15);
    ctx.fillStyle = "rgba(9, 12, 18, 0.88)";
    drawRoundedRect(ctx, pillX, pillY, textW, 13, 4);
    ctx.fillStyle = "#38bdf8";
    ctx.textAlign = "left";
    ctx.fillText(limitLabel, pillX + 4, pillY + 6.5);
  }

  if (!hasAnyData) {
    ctx.fillStyle = "#52525b";
    ctx.font = "500 11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Записів за обраний період немає", padLeft + plotW / 2, padTop + plotH / 2);
  }

  // Interactive tooltip on hover / tap
  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < count) {
    const regSticks = regularCounts[hoverIndex];
    const emSticks = emergencyCounts[hoverIndex];
    const sumSticks = regSticks + emSticks;
    const sumMoney = sumSticks * pricePerStick;

    const titleLine = fullLabels[hoverIndex];
    const detailLine = `${sumSticks} ${getStickPluralForm(sumSticks)} · ${formatMoney(sumMoney, currency)}`;
    const subLine = emSticks > 0 ? `За графіком: ${regSticks} · Поза: ${emSticks}` : `Усі за графіком (${regSticks})`;

    ctx.font = "600 10px Inter, system-ui, sans-serif";
    const w1 = ctx.measureText(titleLine).width;
    ctx.font = "700 11px Inter, system-ui, sans-serif";
    const w2 = ctx.measureText(detailLine).width;
    ctx.font = "500 9.5px Inter, system-ui, sans-serif";
    const w3 = ctx.measureText(subLine).width;

    const boxW = Math.ceil(Math.max(w1, w2, w3)) + 18;
    const boxH = 50;
    const anchorX = padLeft + hoverIndex * slotW + slotW / 2;
    const boxX = Math.max(padLeft + 2, Math.min(width - padRight - boxW - 2, anchorX - boxW / 2));
    const boxY = padTop + 4;

    ctx.fillStyle = "rgba(12, 14, 19, 0.96)";
    drawRoundedRect(ctx, boxX, boxY, boxW, boxH, 8);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "600 10px Inter, system-ui, sans-serif";
    ctx.fillText(titleLine, boxX + 9, boxY + 12);

    ctx.fillStyle = "#f4f4f6";
    ctx.font = "700 11px Inter, system-ui, sans-serif";
    ctx.fillText(detailLine, boxX + 9, boxY + 26.5);

    ctx.fillStyle = emSticks > 0 ? "#fca5a5" : "#6ee7b7";
    ctx.font = "500 9.5px Inter, system-ui, sans-serif";
    ctx.fillText(subLine, boxX + 9, boxY + 40);
  }
}

function handlePointer(e) {
  if (!chartState || !chartState.geometry || !activeCanvas) return;
  const rect = activeCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const { padLeft, plotW, slotW } = chartState.geometry;

  if (x < padLeft || x > padLeft + plotW) {
    if (chartState.hoverIndex !== null) {
      chartState.hoverIndex = null;
      paintChart();
    }
    return;
  }

  const idx = Math.min(chartState.labels.length - 1, Math.max(0, Math.floor((x - padLeft) / slotW)));
  if (chartState.hoverIndex !== idx) {
    chartState.hoverIndex = idx;
    paintChart();
  }
}

function handlePointerLeave() {
  if (chartState && chartState.hoverIndex !== null) {
    chartState.hoverIndex = null;
    paintChart();
  }
}

function bindCanvasEvents(canvasEl) {
  if (activeCanvas === canvasEl) return;
  destroyChart();
  activeCanvas = canvasEl;

  activeCanvas.addEventListener("pointermove", handlePointer);
  activeCanvas.addEventListener("pointerdown", handlePointer);
  activeCanvas.addEventListener("pointerleave", handlePointerLeave);

  if (typeof ResizeObserver !== "undefined" && activeCanvas.parentElement) {
    resizeObserver = new ResizeObserver(() => paintChart());
    resizeObserver.observe(activeCanvas.parentElement);
  }
}

export function renderSmokeChart(canvasEl, smokeHistory, period = "day", mode = "sticks", settings = {}) {
  if (!canvasEl) return;
  bindCanvasEvents(canvasEl);

  const { labels, fullLabels, regularCounts, emergencyCounts } = buildBuckets(smokeHistory || [], period);
  const packSize = Number(settings.packSize) > 0 ? Number(settings.packSize) : 20;
  const packPrice = Number(settings.packPrice) >= 0 ? Number(settings.packPrice) : 130;
  const currency = settings.currency || "UAH";
  const desiredDaily = Number(settings.desiredDailySticks) >= 0 ? Number(settings.desiredDailySticks) : 10;
  const pricePerStick = packPrice / packSize;

  const regularVals = mode === "money" ? regularCounts.map((c) => c * pricePerStick) : regularCounts;
  const emergencyVals = mode === "money" ? emergencyCounts.map((c) => c * pricePerStick) : emergencyCounts;
  const limitValue = mode === "money" ? desiredDaily * pricePerStick : desiredDaily;

  chartState = {
    labels,
    fullLabels,
    regularVals,
    emergencyVals,
    regularCounts,
    emergencyCounts,
    period,
    mode,
    limitValue,
    currency,
    pricePerStick,
    hoverIndex: null,
    geometry: null,
  };

  paintChart();
}

export function destroyChart() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (activeCanvas) {
    activeCanvas.removeEventListener("pointermove", handlePointer);
    activeCanvas.removeEventListener("pointerdown", handlePointer);
    activeCanvas.removeEventListener("pointerleave", handlePointerLeave);
    activeCanvas = null;
  }
  chartState = null;
}
