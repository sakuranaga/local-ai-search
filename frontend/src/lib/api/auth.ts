import { API_BASE, apiFetch, clearToken, getRefreshToken, setRefreshToken, setToken } from "./client";
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

export function logout() {
  clearToken();
  window.location.href = "/login";
}

export async function refreshToken(): Promise<{ access_token: string }> {
  const rt = getRefreshToken();
  if (!rt) throw new Error("No refresh token");
  const data = await apiFetch<{ access_token: string }>("/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
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
}): Promise<User> {
  return apiFetch<User>("/auth/me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
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
