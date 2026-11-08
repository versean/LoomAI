// Per-request context (who is making this request), available anywhere in the call stack.
// Used so git commits, activity and gateway records name the actual person, not just "human".
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();
export const runWith = (ctx, fn) => als.run(ctx, fn);
export const current = () => als.getStore() || {};
export const currentUser = () => current().user || null;
