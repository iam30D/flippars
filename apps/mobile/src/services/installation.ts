import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  appendPendingDeletion,
  isGuestSession,
  isInstallationId,
  type GuestSession,
} from "./guest-session";

const SESSION_KEY = "flippars.anonymous-installation-session.v2";
const LEGACY_INSTALLATION_KEY = "flippars.anonymous-installation-id.v1";
const PENDING_DELETION_INDEX_KEY =
  "@flippars/mobile/v1/pending-installation-deletion-ids";
const PENDING_DELETION_PREFIX = "flippars.pending-installation-deletion.v1";
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let currentSessionPromise: Promise<GuestSession> | null = null;

const randomCredential = async (): Promise<string> => {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
};

const createSession = async (
  installationId = Crypto.randomUUID(),
): Promise<GuestSession> => ({
  installationId,
  credential: await randomCredential(),
});

const writeSession = async (session: GuestSession): Promise<void> => {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), secureOptions);
  await SecureStore.deleteItemAsync(LEGACY_INSTALLATION_KEY);
};

const loadOrCreateSession = async (): Promise<GuestSession> => {
  const stored = await SecureStore.getItemAsync(SESSION_KEY);
  if (stored) {
    const parsed = JSON.parse(stored) as unknown;
    if (!isGuestSession(parsed)) throw new Error("Secure guest session is invalid");
    return parsed;
  }
  const legacy = await SecureStore.getItemAsync(LEGACY_INSTALLATION_KEY);
  const session = await createSession(isInstallationId(legacy) ? legacy : undefined);
  await writeSession(session);
  return session;
};

export const getOrCreateGuestSession = (): Promise<GuestSession> => {
  currentSessionPromise ??= loadOrCreateSession();
  return currentSessionPromise;
};

export const rotateGuestSession = async (): Promise<GuestSession> => {
  const session = await createSession();
  await writeSession(session);
  currentSessionPromise = Promise.resolve(session);
  return session;
};

const pendingDeletionKey = (installationId: string): string =>
  `${PENDING_DELETION_PREFIX}.${installationId}`;

const readPendingDeletionIds = async (): Promise<readonly string[]> => {
  const stored = await SecureStore.getItemAsync(PENDING_DELETION_INDEX_KEY);
  if (!stored) return [];
  const parsed = JSON.parse(stored) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isInstallationId))
    throw new Error("Pending guest deletion index is invalid");
  return [...new Set(parsed)];
};

const writePendingDeletionIds = async (ids: readonly string[]): Promise<void> => {
  if (ids.length === 0) {
    await SecureStore.deleteItemAsync(PENDING_DELETION_INDEX_KEY);
    return;
  }
  await SecureStore.setItemAsync(
    PENDING_DELETION_INDEX_KEY,
    JSON.stringify(ids),
    secureOptions,
  );
};

export const readPendingGuestDeletions = async (): Promise<readonly GuestSession[]> => {
  const ids = await readPendingDeletionIds();
  return await Promise.all(
    ids.map(async (installationId) => {
      const stored = await SecureStore.getItemAsync(pendingDeletionKey(installationId));
      if (!stored) throw new Error("Secure pending-deletion credential is missing");
      const session = JSON.parse(stored) as unknown;
      if (!isGuestSession(session) || session.installationId !== installationId)
        throw new Error("Secure pending-deletion credential is invalid");
      return session;
    }),
  );
};

export const queuePendingGuestDeletion = async (
  session: GuestSession,
): Promise<void> => {
  const pending = await readPendingGuestDeletions();
  const next = appendPendingDeletion(pending, session);
  await SecureStore.setItemAsync(
    pendingDeletionKey(session.installationId),
    JSON.stringify(session),
    secureOptions,
  );
  await writePendingDeletionIds(next.map((value) => value.installationId));
};

export const confirmPendingGuestDeletion = async (
  installationId: string,
): Promise<void> => {
  const ids = await readPendingDeletionIds();
  await writePendingDeletionIds(ids.filter((value) => value !== installationId));
  await SecureStore.deleteItemAsync(pendingDeletionKey(installationId));
};

export type { GuestSession } from "./guest-session";
