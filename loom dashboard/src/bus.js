// In-process event bus: the dashboard's live feed and the conductor's wakeups both listen here.
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(event, payload = {}) { for (const fn of listeners) { try { fn(event, payload); } catch {} } }
