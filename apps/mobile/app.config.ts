import type { ConfigContext, ExpoConfig } from "expo/config";

type BuildProfile = "development" | "preview" | "production";

function buildProfile(): BuildProfile {
  const value = String(process.env.FLIPPARS_BUILD_PROFILE ?? "development");
  if (value === "development" || value === "preview" || value === "production")
    return value;
  throw new Error(`Invalid FLIPPARS_BUILD_PROFILE: ${value}`);
}

function validatedBuildValues(profile: BuildProfile): {
  projectId: string | undefined;
} {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  const demoMode = process.env.EXPO_PUBLIC_DEMO_MODE?.trim().toLowerCase();
  const projectId = process.env.EAS_PROJECT_ID?.trim();
  if (profile !== "production") return { projectId };

  if (!apiUrl) throw new Error("EXPO_PUBLIC_API_URL is required for production builds");
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("EXPO_PUBLIC_API_URL must be a valid URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "Production EXPO_PUBLIC_API_URL must use HTTPS without credentials, a query, or a fragment",
    );
  }
  if (demoMode !== "false") {
    throw new Error(
      "EXPO_PUBLIC_DEMO_MODE must be explicitly false for production builds",
    );
  }
  if (
    !projectId ||
    projectId === "00000000-0000-0000-0000-000000000000" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      projectId,
    )
  ) {
    throw new Error(
      "EAS_PROJECT_ID must be a real EAS project UUID for production builds",
    );
  }
  return { projectId };
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const profile = buildProfile();
  const { projectId } = validatedBuildValues(profile);
  return {
    ...config,
    name: "Flippars",
    slug: "flippars",
    scheme: "flippars",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    icon: "./assets/icon.png",
    ios: {
      supportsTablet: false,
      bundleIdentifier: "com.flippars.mobile",
      icon: "./assets/icon.png",
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes: [
          {
            NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeDeviceID",
            NSPrivacyCollectedDataTypeLinked: false,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              "NSPrivacyCollectedDataTypePurposeAppFunctionality",
            ],
          },
        ],
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
            NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
          },
        ],
      },
    },
    android: {
      package: "com.flippars.mobile",
    },
    plugins: [
      [
        "expo-splash-screen",
        {
          image: "./assets/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#0B1020",
        },
      ],
      "expo-router",
      [
        "expo-notifications",
        {
          defaultChannel: "signals",
          icon: "./assets/notification-icon.png",
          color: "#54D6A0",
        },
      ],
      [
        "expo-secure-store",
        {
          configureAndroidBackup: true,
          faceIDPermission:
            "Allow Flippars to securely access your guest installation.",
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      releaseAccess: "guest-full",
      buildProfile: profile,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
