const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_PATTERN = /^[a-f0-9]{64}$/;

export interface GuestSession {
  readonly installationId: string;
  readonly credential: string;
}

export const isInstallationId = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

export const isGuestSession = (value: unknown): value is GuestSession =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "installationId" in value &&
  isInstallationId(value.installationId) &&
  "credential" in value &&
  typeof value.credential === "string" &&
  CREDENTIAL_PATTERN.test(value.credential);

export const appendPendingDeletion = (
  pending: readonly GuestSession[],
  session: GuestSession,
): readonly GuestSession[] => {
  const withoutDuplicate = pending.filter(
    (value) => value.installationId !== session.installationId,
  );
  return [...withoutDuplicate, session];
};

export const removePendingDeletion = (
  pending: readonly GuestSession[],
  installationId: string,
): readonly GuestSession[] =>
  pending.filter((value) => value.installationId !== installationId);
