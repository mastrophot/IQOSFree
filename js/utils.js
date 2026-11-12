function pluralizeUk(value, one, few, many) {
  const n = Math.abs(Math.trunc(Number(value) || 0));
  const lastTwo = n % 100;
  const lastOne = n % 10;

  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (lastOne === 1) return one;
  if (lastOne >= 2 && lastOne <= 4) return few;
  return many;
}

export function getStickPluralForm(number) {
  return pluralizeUk(number, "стік", "стіки", "стіків");
}

export function getHourPluralForm(number) {
  return pluralizeUk(number, "година", "години", "годин");
}

export function getMinutePluralForm(number) {
  return pluralizeUk(number, "хвилина", "хвилини", "хвилин");
}

export function getDayPluralForm(number) {
  return pluralizeUk(number, "день", "дні", "днів");
}

export function formatHoursToReadable(totalHours) {
  const hoursInt = Math.max(0, Math.floor(Number(totalHours) || 0));
  if (hoursInt < 24) {
    return `${hoursInt} ${getHourPluralForm(hoursInt)}`;
  }
  const days = Math.floor(hoursInt / 24);
  const remainingHours = hoursInt % 24;
  let result = `${days} ${getDayPluralForm(days)}`;
  if (remainingHours > 0) {
    result += ` ${remainingHours} ${getHourPluralForm(remainingHours)}`;
  }
  return result;
}

export function formatMinutesToReadable(totalMinutes) {
  const minsInt = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  if (minsInt < 60) {
    return `${minsInt} ${getMinutePluralForm(minsInt)}`;
  }
  if (minsInt < 1440) {
    const hours = Math.floor(minsInt / 60);
    const remainingMinutes = minsInt % 60;
    let result = `${hours} ${getHourPluralForm(hours)}`;
    if (remainingMinutes > 0) {
      result += ` ${remainingMinutes} хв`;
    }
    return result;
  }
  const days = Math.floor(minsInt / 1440);
  const hours = Math.floor((minsInt % 1440) / 60);
  let result = `${days} ${getDayPluralForm(days)}`;
  if (hours > 0) {
    result += ` ${hours} год`;
  }
  return result;
}

export function formatCountdownMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function getCurrencySymbol(currency = "UAH") {
  if (currency === "USD") return "$";
  if (currency === "EUR") return "€";
  return "₴";
}

export function formatMoney(amount, currency = "UAH", signed = false) {
  const numeric = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const absVal = Math.abs(numeric);
  const signPrefix = signed ? (numeric < -0.004 ? "−" : "+") : numeric < -0.004 ? "−" : "";
  const formatted = absVal.toFixed(2);

  if (currency === "USD") return `${signPrefix}$${formatted}`;
  if (currency === "EUR") return `${signPrefix}€${formatted}`;
  return `${signPrefix}${formatted} ₴`;
}
