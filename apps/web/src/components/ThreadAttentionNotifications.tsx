import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import {
  newThreadAttentionCandidates,
  threadAttentionCandidate,
  threadAttentionNotificationBody,
  type ThreadAttentionCandidate,
} from "./ThreadAttentionNotifications.logic";

const NOTIFIED_KEYS_STORAGE_KEY = "ashler.thread-attention-notifications.v1";
const MAX_PERSISTED_NOTIFICATION_KEYS = 200;

function readNotifiedKeys(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NOTIFIED_KEYS_STORAGE_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistNotifiedKeys(keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(
      NOTIFIED_KEYS_STORAGE_KEY,
      JSON.stringify([...keys].slice(-MAX_PERSISTED_NOTIFICATION_KEYS)),
    );
  } catch {
    // Notifications are best-effort; storage policy must never affect chat.
  }
}

function requestNotificationPermissionFromUserGesture(): void {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  void Notification.requestPermission();
}

export function ThreadAttentionNotifications() {
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const router = useRouter();
  const hydratedRef = useRef(false);
  const previousKeysRef = useRef<Set<string>>(new Set());
  const notifiedKeysRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    const request = () => requestNotificationPermissionFromUserGesture();
    window.addEventListener("pointerdown", request, { once: true, capture: true });
    window.addEventListener("keydown", request, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", request, { capture: true });
      window.removeEventListener("keydown", request, { capture: true });
    };
  }, []);

  const openThread = useCallback(
    (candidate: ThreadAttentionCandidate) => {
      window.focus();
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(candidate.environmentId, candidate.threadId)),
      });
    },
    [router],
  );

  useEffect(() => {
    if (!bootstrapped) return;
    const candidates = threads.flatMap((thread) => {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const candidate = threadAttentionCandidate(thread, lastVisitedAtById[key]);
      return candidate ? [candidate] : [];
    });
    const currentKeys = new Set(candidates.map((candidate) => candidate.key));

    // Initial shell hydration is state restoration, not a new event.
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      previousKeysRef.current = currentKeys;
      notifiedKeysRef.current = readNotifiedKeys();
      return;
    }

    const notifiedKeys = notifiedKeysRef.current ?? readNotifiedKeys();
    notifiedKeysRef.current = notifiedKeys;
    const additions = newThreadAttentionCandidates({
      candidates,
      previousKeys: previousKeysRef.current,
      notifiedKeys,
    });
    previousKeysRef.current = currentKeys;

    for (const candidate of additions) {
      notifiedKeys.add(candidate.key);
      if (!("Notification" in window) || Notification.permission !== "granted") continue;
      // Native web/Electron notifications use the platform's configured T3/system sound.
      const notification = new Notification(candidate.title, {
        body: threadAttentionNotificationBody(candidate.reason),
        tag: candidate.key,
      });
      notification.addEventListener("click", () => {
        notification.close();
        openThread(candidate);
      });
    }
    if (additions.length > 0) persistNotifiedKeys(notifiedKeys);
  }, [bootstrapped, lastVisitedAtById, openThread, threads]);

  return null;
}
