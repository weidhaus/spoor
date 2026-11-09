// Dates and numbers use the browser's locale. Detailed timestamps always show their time zone.

// dateStyle/timeStyle cannot be combined with timeZoneName, so the fields are listed explicitly.
const dateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const number = new Intl.NumberFormat();

export function formatDateTime(iso: string) {
  return dateTime.format(new Date(iso));
}

/** Calendar dates (YYYY-MM-DD) have no time zone; format them as written. */
export function formatDate(isoDate: string) {
  return dateOnly.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

export function formatNumber(n: number) {
  return number.format(n);
}

export function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
