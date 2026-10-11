// Which login a request belongs to (design doc AO 3): tabs share the tokens, so another tab may sign out
// or sign in meanwhile. A login is its refresh token (the access token is renewed within the same login).
export type Session = { access: string | null; refresh: string | null };

export function sameSession(start: Session, now: Session): boolean {
  return start.refresh === now.refresh;
}
