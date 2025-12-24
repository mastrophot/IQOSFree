/**
 * Returns the correct Ukrainian plural form for the word "стік" based on the number.
 * @param {number} number The number of sticks.
 * @returns {string} The plural form ("стік", "стіки", or "стіків").
 */
export function getStickPluralForm(number) {
  const lastDigit = number % 10;
  const lastTwoDigits = number % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "стіків";
  }
  if (lastDigit === 1) {
    return "стік";
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return "стіки";
  }
  return "стіків";
}

/**
 * Returns the correct Ukrainian plural form for the word "година" based on the number.
 * @param {number} number The number of hours.
 * @returns {string} The plural form ("година", "години", or "годин").
 */
export function getHourPluralForm(number) {
  const lastDigit = number % 10;
  const lastTwoDigits = number % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "годин";
  }
  if (lastDigit === 1) {
    return "година";
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return "години";
  }
  return "годин";
}

/**
 * Returns the correct Ukrainian plural form for the word "хвилина" based on the number.
 * @param {number} totalMinutes The total number of minutes.
 * @returns {string} The plural form ("хвилина", "хвилини", or "хвилин").
 */
export function getMinutePluralForm(number) {
  const lastDigit = number % 10;
  const lastTwoDigits = number % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "хвилин";
  }
  if (lastDigit === 1) {
    return "хвилина";
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return "хвилини";
  }
  return "хвилин";
}

/**
 * Returns the correct Ukrainian plural form for the word "день" based on the number.
 * @param {number} number The number of days.
 * @returns {string} The plural form ("день", "дні", or "днів").
 */
export function getDayPluralForm(number) {
  const lastDigit = number % 10;
  const lastTwoDigits = number % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "днів";
  }
  if (lastDigit === 1) {
    return "день";
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return "дні";
  }
  return "днів";
}

/**
 * Formats total hours into a readable string with correct pluralization for days and hours.
 * @param {number} totalHours The total number of hours.
 * @returns {string} Formatted string (e.g., "1 день 2 години", "5 годин").
 */
export function formatHoursToReadable(totalHours) {
  if (totalHours < 24) {
    return `${totalHours} ${getHourPluralForm(totalHours)}`;
  } else {
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    let result = `${days} ${getDayPluralForm(days)}`;
    if (remainingHours > 0) {
      result += ` ${remainingHours} ${getHourPluralForm(remainingHours)}`;
    }
    return result;
  }
}

/**
 * Formats total minutes into a readable string with correct pluralization for hours and minutes.
 * @param {number} totalMinutes The total number of minutes.
 * @returns {string} Formatted string (e.g., "1 година 2 хвилини", "5 хвилин").
 */
export function formatMinutesToReadable(totalMinutes) {
  if (totalMinutes < 60) {
    return `${totalMinutes} ${getMinutePluralForm(totalMinutes)}`;
  } else {
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    let result = `${hours} ${getHourPluralForm(hours)}`;
    if (remainingMinutes > 0) {
      result += ` ${remainingMinutes} ${getMinutePluralForm(remainingMinutes)}`;
    }
    return result;
  }
}
