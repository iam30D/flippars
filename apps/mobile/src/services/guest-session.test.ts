import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  appendPendingDeletion,
  isGuestSession,
  removePendingDeletion,
  type GuestSession,
} from "./guest-session";

const session = (index: number): GuestSession => ({
  installationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  credential: index.toString(16).padStart(64, "0"),
});

void describe("guest session tombstones", () => {
  void test("validates high-entropy credential records", () => {
    assert.equal(isGuestSession(session(1)), true);
    assert.equal(isGuestSession({ ...session(1), credential: "short" }), false);
  });

  void test("deduplicates and only removes the confirmed installation", () => {
    const queued = appendPendingDeletion([session(1), session(2)], session(1));
    assert.deepEqual(queued, [session(2), session(1)]);
    assert.deepEqual(removePendingDeletion(queued, session(2).installationId), [
      session(1),
    ]);
  });

  void test("does not drop or cap pending deletion credentials", () => {
    const pending = Array.from({ length: 32 }, (_, index) => session(index + 1));
    const queued = appendPendingDeletion(pending, session(33));
    assert.equal(queued.length, 33);
    assert.deepEqual(queued.at(-1), session(33));
  });
});
