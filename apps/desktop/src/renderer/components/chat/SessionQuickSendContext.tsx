// Lets a message-level control send text as the user through the session's own send path; null outside the session view.
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

export interface SessionQuickSend {
  /** Resolves false when the session refused the message (read-only, locked, failed). */
  send(text: string, options?: { literalText?: boolean; independent?: boolean }): Promise<boolean>;
}

const SessionQuickSendContext = createContext<SessionQuickSend | null>(null);

export const SessionQuickSendProvider = SessionQuickSendContext.Provider;
export function useSessionQuickSend(): SessionQuickSend | null {
  return useContext(SessionQuickSendContext);
}

/*
 * The same sender, reachable by session id for controls outside the message stream (the right
 * sidebar's Learning "Today" tab). Only the session view that owns the route registers, and only
 * while it can send, so a lookup returns null whenever the session's own provider would.
 */
const registered = new Map<string, { sender: SessionQuickSend; token: symbol }>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function registerSessionQuickSend(sessionId: string, sender: SessionQuickSend): () => void {
  const token = Symbol(sessionId);
  registered.set(sessionId, { sender, token });
  notify();
  return () => {
    // A newer registration for the same session (route remount) is left in place.
    if (registered.get(sessionId)?.token !== token) return;
    registered.delete(sessionId);
    notify();
  };
}

export function SessionQuickSendRegistration({ sessionId, sender }: { sessionId: string; sender: SessionQuickSend | null }) {
  useEffect(() => (sender ? registerSessionQuickSend(sessionId, sender) : undefined), [sessionId, sender]);
  return null;
}

export function useRegisteredSessionQuickSend(sessionId: string): SessionQuickSend | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => registered.get(sessionId)?.sender ?? null,
  );
}
