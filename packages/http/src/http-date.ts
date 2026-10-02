import type { ObjectStat } from "@stowage/core";

const second = 1000;

/**
 * `lastModified` as `Last-Modified` carries it: at whole seconds, and never later than now.
 * RFC 9110 8.8.2 has a server send no `Last-Modified` in its future, which a provider's
 * clock ahead of the server's would otherwise produce. The server writes its `Date` after
 * this runs, so the cap stands in for that date and never lies after it.
 */
export function lastModifiedOf(stat: ObjectStat): Date {
  const modified = Math.floor(stat.lastModified.getTime() / second) * second;
  const now = Math.floor(Date.now() / second) * second;

  return new Date(Math.min(modified, now));
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = `(${months.join("|")})`;
const day = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const time = String.raw`(\d{2}):(\d{2}):(\d{2})`;

// RFC 9110 5.6.7: a recipient accepts the IMF-fixdate a server sends and both obsolete forms.
const imfFixdate = new RegExp(String.raw`^${day}, (\d{2}) ${monthName} (\d{4}) ${time} GMT$`, "u");
const rfc850Date = new RegExp(
  String.raw`^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (\d{2})-${monthName}-(\d{2}) ${time} GMT$`,
  "u",
);
const asctimeDate = new RegExp(String.raw`^${day} ${monthName} ([ \d]\d) ${time} (\d{4})$`, "u");

/** The time an HTTP-date names, `undefined` for a field that is no single HTTP-date. */
export function httpDateOf(field: string): number | undefined {
  const fixdate = imfFixdate.exec(field);

  if (fixdate !== null) {
    const [, date, name, year, ...clock] = fixdate;

    return timeOf([Number(year), months.indexOf(name ?? ""), Number(date), ...clock.map(Number)]);
  }

  const rfc850 = rfc850Date.exec(field);

  if (rfc850 !== null) {
    const [, date, name, year, ...clock] = rfc850;
    const fullYear = yearOfTwoDigits(Number(year));

    return timeOf([fullYear, months.indexOf(name ?? ""), Number(date), ...clock.map(Number)]);
  }

  const asctime = asctimeDate.exec(field);

  if (asctime !== null) {
    const [, name, date, hours, minutes, seconds, year] = asctime;

    return timeOf([year, months.indexOf(name ?? ""), date, hours, minutes, seconds].map(Number));
  }

  return undefined;
}

/**
 * The time of year, month, day, hours, minutes and seconds, `undefined` where `Date` would
 * roll one over into the next, as it does for the 31st of September.
 */
function timeOf(fields: readonly number[]): number | undefined {
  const [year = 0, month = 0, date = 0, hours = 0, minutes = 0, seconds = 0] = fields;
  const named = new Date(0);

  // Not `Date.UTC`, which reads a year below 100 as one of the 1900s.
  named.setUTCFullYear(year, month, date);
  named.setUTCHours(hours, minutes, seconds);

  const held = [
    named.getUTCFullYear(),
    named.getUTCMonth(),
    named.getUTCDate(),
    named.getUTCHours(),
    named.getUTCMinutes(),
    named.getUTCSeconds(),
  ];

  return held.every((value, index) => value === fields[index]) ? named.getTime() : undefined;
}

/**
 * RFC 9110 5.6.7 reads a two-digit year more than 50 years ahead as the latest past year
 * with those digits, so the year lies within 50 years either side of now.
 */
function yearOfTwoDigits(digits: number): number {
  const now = new Date().getUTCFullYear();
  const year = now - (now % 100) + digits;

  if (year > now + 50) return year - 100;
  if (year <= now - 50) return year + 100;

  return year;
}
