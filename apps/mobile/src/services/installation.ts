import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const INSTALLATION_KEY = "flippars.anonymous-installation-id.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const getOrCreateInstallationId = async (): Promise<string> => {
  const existing = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (existing && UUID_PATTERN.test(existing)) return existing;
  if (existing) await SecureStore.deleteItemAsync(INSTALLATION_KEY);
  const installationId = Crypto.randomUUID();
  await SecureStore.setItemAsync(INSTALLATION_KEY, installationId, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return installationId;
};

export const deleteInstallationId = (): Promise<void> =>
  SecureStore.deleteItemAsync(INSTALLATION_KEY);
