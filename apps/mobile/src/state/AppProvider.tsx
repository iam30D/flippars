import { AppState } from "react-native";
import type { PropsWithChildren } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { env } from "../config/env";
import {
  DEFAULT_PREFERENCES,
  type GuestPreferencesView,
  type MarketView,
  type SignalView,
} from "../domain/models";
import { ApiClient, ApiError } from "../services/api/client";
import { mergeSignals } from "../services/api/recovery";
import { SignalStream } from "../services/api/stream";
import { DemoRepository } from "../services/demo";
import {
  deleteInstallationId,
  getOrCreateInstallationId,
} from "../services/installation";
import {
  clearFlipparsStorage,
  readCachedMarket,
  readCachedSignals,
  readOnboardingComplete,
  readPreferences,
  writeCachedMarket,
  writeCachedSignals,
  writeOnboardingComplete,
  writePreferences,
} from "../services/storage";
import {
  requestNotificationToken,
  clearDeliveredNotifications,
  getExistingNotificationRegistration,
  type ExistingNotificationRegistration,
  setNotificationPreferences,
} from "../services/notifications";

type NotificationStatus = "unknown" | "granted" | "denied" | "unavailable";

interface AppContextValue {
  readonly ready: boolean;
  readonly onboardingComplete: boolean;
  readonly demoMode: boolean;
  readonly market: MarketView;
  readonly signals: readonly SignalView[];
  readonly preferences: GuestPreferencesView;
  readonly notificationStatus: NotificationStatus;
  readonly refreshing: boolean;
  readonly historyLoading: boolean;
  readonly historyCursor: string | null;
  readonly errorMessage: string | null;
  readonly refresh: () => Promise<void>;
  readonly loadMoreHistory: () => Promise<void>;
  readonly fetchSignal: (id: string) => Promise<SignalView | null>;
  readonly completeOnboarding: (enableNotifications: boolean) => Promise<void>;
  readonly enableNotifications: () => Promise<boolean>;
  readonly updatePreferences: (preferences: GuestPreferencesView) => Promise<void>;
  readonly resetAnonymousData: () => Promise<void>;
}

const initialMarket: MarketView = {
  compositePrice: null,
  observedAt: null,
  health: "connecting",
  healthMessage: "Preparing the guest session and connecting to market data.",
  venues: [],
  fiveMinute: null,
  fifteenMinute: null,
};

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = ({ children }: PropsWithChildren): React.JSX.Element => {
  const [ready, setReady] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketView>(initialMarket);
  const [signals, setSignals] = useState<readonly SignalView[]>([]);
  const [preferences, setPreferences] =
    useState<GuestPreferencesView>(DEFAULT_PREFERENCES);
  const [notificationStatus, setNotificationStatus] =
    useState<NotificationStatus>("unknown");
  const [refreshing, setRefreshing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const apiRef = useRef<ApiClient | null>(null);
  const streamRef = useRef<SignalStream | null>(null);
  const demoRef = useRef(new DemoRepository());
  const sequenceRef = useRef<number | null>(null);
  const marketPersistedAtRef = useRef(0);
  const deviceRegistrationRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getOrCreateInstallationId(),
      readOnboardingComplete(),
      readPreferences(),
      readCachedSignals(),
      readCachedMarket(),
    ])
      .then(([id, onboarded, savedPreferences, cachedSignals, cachedMarket]) => {
        if (!active) return;
        const resolvedPreferences = savedPreferences ?? DEFAULT_PREFERENCES;
        setInstallationId(id);
        setOnboardingComplete(onboarded);
        setPreferences(resolvedPreferences);
        setNotificationPreferences(resolvedPreferences);
        if (cachedSignals) setSignals(cachedSignals);
        if (cachedMarket)
          setMarket({
            ...cachedMarket,
            health: "connecting",
            healthMessage: "Restoring a fresh market connection.",
          });
        setReady(true);
      })
      .catch(() => {
        if (!active) return;
        setMarket({
          ...initialMarket,
          health: "offline",
          healthMessage: "Secure guest storage could not be initialized.",
        });
        setErrorMessage("Secure guest storage could not be initialized.");
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const applySignal = useCallback((signal: SignalView) => {
    setSignals((current) => mergeSignals(current, [signal]));
  }, []);

  const recoverLiveState = useCallback(async (): Promise<number | null> => {
    const api = apiRef.current;
    if (!api) return null;
    const [nextMarket, candles, signalPage] = await Promise.all([
      api.market(),
      api.currentCandles(),
      api.signals(null, 100),
    ]);
    setMarket({
      ...nextMarket,
      fiveMinute: candles.find((candle) => candle.durationMinutes === 5) ?? null,
      fifteenMinute: candles.find((candle) => candle.durationMinutes === 15) ?? null,
    });
    setSignals((current) => mergeSignals(current, signalPage.signals));
    setHistoryCursor(signalPage.nextCursor);
    sequenceRef.current = signalPage.sequence;
    setErrorMessage(null);
    return signalPage.sequence;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!ready || !installationId) return;
    setRefreshing(true);
    try {
      if (env.demoMode) {
        const nextMarket = demoRef.current.market();
        setMarket(nextMarket);
        setSignals(demoRef.current.signals());
        setHistoryCursor(null);
        setErrorMessage(null);
      } else if (!env.apiUrl) {
        setMarket({
          ...initialMarket,
          health: "offline",
          healthMessage: "EXPO_PUBLIC_API_URL is not configured.",
        });
        setErrorMessage("Live API URL is not configured. Demo mode remains off.");
      } else {
        await recoverLiveState();
      }
    } catch {
      setMarket((current) => ({
        ...current,
        health: "offline",
        healthMessage:
          "Live data is unavailable. Showing the last locally stored state.",
      }));
      setErrorMessage("Could not refresh live data. Pull to retry.");
    } finally {
      setRefreshing(false);
    }
  }, [installationId, ready, recoverLiveState]);

  useEffect(() => {
    if (!ready || !installationId) return;
    if (env.demoMode) {
      void refresh();
      const interval = setInterval(
        () => {
          setMarket(demoRef.current.market());
          const nextSignals = demoRef.current.signals();
          setSignals((current) =>
            current[0]?.id === nextSignals[0]?.id ? current : nextSignals,
          );
        },
        preferences.reducedData ? 5_000 : 1_000,
      );
      return () => clearInterval(interval);
    }
    if (!env.apiUrl) {
      void refresh();
      return;
    }
    const api = new ApiClient(env.apiUrl, installationId);
    apiRef.current = api;
    const deviceRegistration = (async (): Promise<void> => {
      let registration: ExistingNotificationRegistration;
      try {
        registration = await getExistingNotificationRegistration();
      } catch {
        registration = { token: null, status: "unavailable" as const };
      }
      setNotificationStatus(registration.status);
      await api.registerDevice(registration.token);
      await api.updatePreferences(preferences, registration.status === "granted");
    })();
    deviceRegistrationRef.current = deviceRegistration;
    void deviceRegistration.catch(() => {
      setErrorMessage(
        "Anonymous notification preferences could not be synchronized yet.",
      );
    });
    const stream = new SignalStream(env.apiUrl, {
      onConnected: () => {
        void recoverLiveState().catch(() => {
          setMarket((current) => ({
            ...current,
            health: "degraded",
            healthMessage: "Stream connected; snapshot recovery is delayed.",
          }));
        });
      },
      onDisconnected: () => {
        setMarket((current) => ({
          ...current,
          health: "connecting",
          healthMessage: "Reconnecting to the live event stream.",
        }));
      },
      onMarket: (nextMarket) =>
        setMarket((current) => ({
          ...nextMarket,
          fiveMinute: nextMarket.fiveMinute ?? current.fiveMinute,
          fifteenMinute: nextMarket.fifteenMinute ?? current.fifteenMinute,
        })),
      onCandle: (candle) =>
        setMarket((current) => ({
          ...current,
          fiveMinute: candle.durationMinutes === 5 ? candle : current.fiveMinute,
          fifteenMinute: candle.durationMinutes === 15 ? candle : current.fifteenMinute,
        })),
      onSignal: applySignal,
      onOutcome: (update) =>
        setSignals((current) =>
          current.map((signal) => {
            if (signal.id !== update.signalId) return signal;
            return update.outcomePrice === undefined
              ? { ...signal, outcome: update.outcome }
              : {
                  ...signal,
                  outcome: update.outcome,
                  outcomePrice: update.outcomePrice,
                };
          }),
        ),
      onGap: async (_afterSequence, receivedSequence) => {
        await recoverLiveState();
        return receivedSequence - 1;
      },
    });
    streamRef.current = stream;
    void refresh().then(() => stream.start(sequenceRef.current));
    return () => {
      stream.stop();
      streamRef.current = null;
      apiRef.current = null;
      if (deviceRegistrationRef.current === deviceRegistration)
        deviceRegistrationRef.current = null;
    };
  }, [
    applySignal,
    installationId,
    preferences.reducedData,
    ready,
    recoverLiveState,
    refresh,
  ]);

  useEffect(() => {
    if (!ready) return;
    void writeCachedSignals(signals);
  }, [ready, signals]);

  useEffect(() => {
    if (!ready || market.observedAt === null) return;
    const now = Date.now();
    if (now - marketPersistedAtRef.current < 5_000) return;
    marketPersistedAtRef.current = now;
    void writeCachedMarket(market);
  }, [market, ready]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void refresh();
      void getExistingNotificationRegistration()
        .then(async (registration) => {
          setNotificationStatus(registration.status);
          const api = apiRef.current;
          if (!api) return;
          await api.registerDevice(registration.token);
          await api.updatePreferences(preferences, registration.status === "granted");
        })
        .catch(() => {
          // Market refresh remains independent when native notification state is unavailable.
        });
    });
    return () => subscription.remove();
  }, [preferences, refresh]);

  const enableNotifications = useCallback(async (): Promise<boolean> => {
    try {
      const token = await requestNotificationToken();
      if (!token) {
        const registration = await getExistingNotificationRegistration();
        setNotificationStatus(registration.status);
        return false;
      }
      await apiRef.current?.registerDevice(token);
      await apiRef.current?.updatePreferences(preferences, true);
      setNotificationStatus("granted");
      return true;
    } catch {
      setNotificationStatus("denied");
      return false;
    }
  }, [preferences]);

  const completeOnboarding = useCallback(
    async (shouldEnableNotifications: boolean): Promise<void> => {
      if (shouldEnableNotifications) await enableNotifications();
      await writeOnboardingComplete();
      setOnboardingComplete(true);
    },
    [enableNotifications],
  );

  const updatePreferences = useCallback(
    async (nextPreferences: GuestPreferencesView): Promise<void> => {
      const previous = preferences;
      setPreferences(nextPreferences);
      setNotificationPreferences(nextPreferences);
      await writePreferences(nextPreferences);
      try {
        try {
          await deviceRegistrationRef.current;
        } catch {
          // Retry below; the initial registration can fail during a transient outage.
        }
        const api = apiRef.current;
        if (api) {
          try {
            await api.updatePreferences(
              nextPreferences,
              notificationStatus === "granted",
            );
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
            const registration = await getExistingNotificationRegistration();
            await api.registerDevice(registration.token);
            await api.updatePreferences(
              nextPreferences,
              registration.status === "granted",
            );
            setNotificationStatus(registration.status);
          }
        }
      } catch {
        setPreferences(previous);
        setNotificationPreferences(previous);
        await writePreferences(previous);
        setErrorMessage("Preference sync failed; your previous choices were restored.");
      }
    },
    [notificationStatus, preferences],
  );

  const loadMoreHistory = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (!api || !historyCursor || historyLoading) return;
    setHistoryLoading(true);
    try {
      const page = await api.signals(historyCursor, 100);
      setSignals((current) => mergeSignals(current, page.signals));
      setHistoryCursor(page.nextCursor);
    } catch {
      setErrorMessage("Older signals could not be loaded. Try again.");
    } finally {
      setHistoryLoading(false);
    }
  }, [historyCursor, historyLoading]);

  const fetchSignal = useCallback(
    async (id: string): Promise<SignalView | null> => {
      const local = signals.find((signal) => signal.id === id);
      if (local) return local;
      if (env.demoMode)
        return demoRef.current.signals().find((signal) => signal.id === id) ?? null;
      try {
        const signal = (await apiRef.current?.signal(id)) ?? null;
        if (signal) applySignal(signal);
        return signal;
      } catch {
        return null;
      }
    },
    [applySignal, signals],
  );

  const resetAnonymousData = useCallback(async (): Promise<void> => {
    try {
      await deviceRegistrationRef.current;
    } catch {
      // Continue deletion even if initial registration never reached the service.
    }
    try {
      await apiRef.current?.deleteDevice();
    } catch {
      // Local deletion must still complete when the server is unavailable.
    }
    streamRef.current?.stop();
    await clearFlipparsStorage();
    await clearDeliveredNotifications();
    await deleteInstallationId();
    const freshId = await getOrCreateInstallationId();
    setInstallationId(freshId);
    setSignals([]);
    setMarket(initialMarket);
    setPreferences(DEFAULT_PREFERENCES);
    setNotificationPreferences(DEFAULT_PREFERENCES);
    setNotificationStatus("unknown");
    setOnboardingComplete(false);
    setErrorMessage(null);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      onboardingComplete,
      demoMode: env.demoMode,
      market,
      signals,
      preferences,
      notificationStatus,
      refreshing,
      historyLoading,
      historyCursor,
      errorMessage,
      refresh,
      loadMoreHistory,
      fetchSignal,
      completeOnboarding,
      enableNotifications,
      updatePreferences,
      resetAnonymousData,
    }),
    [
      completeOnboarding,
      enableNotifications,
      errorMessage,
      fetchSignal,
      historyCursor,
      historyLoading,
      loadMoreHistory,
      market,
      notificationStatus,
      onboardingComplete,
      preferences,
      ready,
      refresh,
      refreshing,
      resetAnonymousData,
      signals,
      updatePreferences,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppContextValue => {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider.");
  return value;
};
