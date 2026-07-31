/// <reference types="expo/types" />

declare namespace NodeJS {
  interface ProcessEnv {
    readonly EXPO_PUBLIC_API_URL?: string;
    readonly EXPO_PUBLIC_DEMO_MODE?: string;
    readonly EAS_PROJECT_ID?: string;
  }
}
