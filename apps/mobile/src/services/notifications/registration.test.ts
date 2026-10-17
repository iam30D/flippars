import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { notificationSyncDecision } from "./registration";

void describe("notification registration consent", () => {
  void test("never uploads a previously granted token before in-app opt-in", () => {
    assert.deepEqual(
      notificationSyncDecision(false, { status: "granted", token: "native-token" }),
      { pushToken: null, notificationsEnabled: false },
    );
  });

  void test("only enables synchronization when permission, token, and opt-in agree", () => {
    assert.deepEqual(
      notificationSyncDecision(true, { status: "granted", token: "native-token" }),
      { pushToken: "native-token", notificationsEnabled: true },
    );
    assert.deepEqual(
      notificationSyncDecision(true, { status: "denied", token: null }),
      { pushToken: null, notificationsEnabled: false },
    );
  });
});
