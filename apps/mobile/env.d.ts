/// <reference types="expo/types" />

declare namespace NodeJS {
  interface ProcessEnv {
    readonly EAS_PROJECT_ID?: string;
    readonly EXPO_PUBLIC_API_URL?: string;
    readonly EXPO_PUBLIC_DEMO_MODE?: string;
    readonly FLIPPARS_BUILD_PROFILE?: "development" | "preview" | "production";
  }
}
