// Runs a job once a day at HH:MM IST. Re-arms itself after each run.
const IST_MS = 330 * 60e3;

function msUntil(hhmm, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const ist = new Date(now + IST_MS);
  const target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST_MS;
  return target > now ? target - now : target + 864e5 - now;
}

function scheduleDaily(hhmm, job) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`Bad SYNC_AT_IST "${hhmm}", use HH:MM`);
  const arm = () => {
    const wait = msUntil(hhmm);
    setTimeout(() => {
      try { job(); } catch (e) { console.error('[schedule]', e); }
      setTimeout(arm, 60e3); // avoid double-firing within the same minute
    }, wait).unref?.();
  };
  arm();
}

module.exports = { scheduleDaily, msUntil };
