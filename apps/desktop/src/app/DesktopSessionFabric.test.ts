import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopSessionFabricRelayUrl } from "./DesktopSessionFabric.ts";

describe("DesktopSessionFabric", () => {
  it("prefers a valid runtime relay URL over the packaged default", () => {
    assert.equal(
      resolveDesktopSessionFabricRelayUrl(
        " https://runtime-fabric.example.test/base ",
        "https://build-fabric.example.test/",
      ),
      "https://runtime-fabric.example.test/base",
    );
  });

  it("uses the packaged relay URL when the runtime is unconfigured", () => {
    assert.equal(
      resolveDesktopSessionFabricRelayUrl(undefined, "https://build-fabric.example.test"),
      "https://build-fabric.example.test/",
    );
  });

  it("rejects malformed, credential-bearing, and unsupported relay URLs", () => {
    assert.isUndefined(resolveDesktopSessionFabricRelayUrl("not a URL", undefined));
    assert.isUndefined(
      resolveDesktopSessionFabricRelayUrl("https://user:secret@fabric.example.test", undefined),
    );
    assert.isUndefined(
      resolveDesktopSessionFabricRelayUrl("file:///tmp/session-fabric", undefined),
    );
  });
});
