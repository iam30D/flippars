import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  GUEST_CREDENTIAL_HEADER,
  GUEST_INSTALLATION_ID_HEADER,
} from "@flippars/contracts";
import { ApiClient } from "./client";

const originalFetch = globalThis.fetch;

void afterEach(() => {
  globalThis.fetch = originalFetch;
});

void describe("API guest proof isolation", () => {
  void test("keeps guest identifiers off public reads and adds proof to mutations", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ status: "ready" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      );
    };
    const session = {
      installationId: "00000000-0000-4000-8000-000000000001",
      credential: "a".repeat(64),
    };
    const client = new ApiClient("https://api.flippars.test", session);

    assert.equal(await client.ready(), true);
    await client.deleteDevice();

    const publicHeaders = new Headers(calls[0]?.headers);
    assert.equal(publicHeaders.has(GUEST_INSTALLATION_ID_HEADER), false);
    assert.equal(publicHeaders.has(GUEST_CREDENTIAL_HEADER), false);
    const mutationHeaders = new Headers(calls[1]?.headers);
    assert.equal(
      mutationHeaders.get(GUEST_INSTALLATION_ID_HEADER),
      session.installationId,
    );
    assert.equal(mutationHeaders.get(GUEST_CREDENTIAL_HEADER), session.credential);
  });
});
