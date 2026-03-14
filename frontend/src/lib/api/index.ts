// Barrel file — re-exports everything so existing `@/lib/api` imports keep working.
export { getToken, setToken, getRefreshToken, setRefreshToken, clearToken, apiFetch, API_BASE } from "./client";
export type * from "./types";
export * from "./auth";
export * from "./search";
export * from "./documents";
export * from "./admin";
