import { API_BASE, apiFetch, clearToken, currentSession, getRefreshToken, setRefreshToken, setToken, stillSession } from "./client";
import type { LoginResponse, User } from "./types";

export async function login(
  username: string,
  password: string,
): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed: ${body}`);
  }
  const data: LoginResponse = await res.json();
  setToken(data.access_token);
  setRefreshToken(data.refresh_token);
  return data;
}

export async function logout() {
  const start = currentSession(); // before any wait: another tab may sign in meanwhile
  await tellServer(start);
  if (!stillSession(start)) { // signed in again in another tab meanwhile: that login stays (design doc AO 3)
    window.location.href = "/";
    return;
  }
  clearToken();
  window.location.href = "/login";
}

/** The server revokes this browser's tokens (design doc AO 3); at most 5 s, failures ignored. */
async function tellServer(s: { access: string | null; refresh: string | null }) {
  if (!s.access && !s.refresh) return;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    // plain fetch: apiFetch would renew the token or go to /login on a 401
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(s.access ? { Authorization: `Bearer ${s.access}` } : {}) },
      body: JSON.stringify(s.refresh ? { refresh_token: s.refresh } : {}),
      signal: stop.signal,
    });
  } catch {
    // signed out anyway
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshToken(): Promise<{ access_token: string }> {
  const start = currentSession();
  const rt = getRefreshToken();
  if (!rt) throw new Error("No refresh token");
  const data = await apiFetch<{ access_token: string }>("/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
  if (!stillSession(start)) throw new Error("Signed out meanwhile"); // design doc AO 3
  setToken(data.access_token);
  return data;
}

export async function getMe(): Promise<User> {
  return apiFetch<User>("/auth/me");
}

export async function updateProfile(data: {
  display_name?: string;
  avatar_url?: string;
  email?: string;
  locale?: string;
}): Promise<User> {
  return apiFetch<User>("/auth/me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function uploadAvatar(file: File): Promise<User> {
  const formData = new FormData();
  formData.append("file", file);
  const token = (await import("./client")).getToken();
  const res = await fetch(`${API_BASE}/auth/avatar`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export async function deleteAvatar(): Promise<User> {
  return apiFetch<User>("/auth/avatar", { method: "DELETE" });
}

export async function changePassword(data: {
  current_password: string;
  new_password: string;
}): Promise<void> {
  await apiFetch("/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
