import { assert, describe, it } from "@effect/vitest";

import * as DesktopProduct from "./DesktopProduct.ts";

describe("DesktopProduct", () => {
  it("derives the desktop identity from the Ashler product manifest", () => {
    assert.equal(DesktopProduct.PRODUCT_NAME, "Ashler Code");
    assert.equal(DesktopProduct.DESKTOP_BUNDLE_IDENTIFIER, "ai.ashler.code");
    assert.equal(DesktopProduct.DESKTOP_HELPER_BUNDLE_IDENTIFIER, "ai.ashler.code.helper");
    assert.equal(
      DesktopProduct.DESKTOP_LOGIN_HELPER_BUNDLE_IDENTIFIER,
      "ai.ashler.code.login-helper",
    );
    assert.equal(DesktopProduct.PRODUCTION_URL_SCHEME, "ashler-code");
    assert.equal(DesktopProduct.DEVELOPMENT_URL_SCHEME, "ashler-code-dev");
    assert.equal(DesktopProduct.HOME_DIRECTORY_NAME, ".ashler-code");
    assert.equal(DesktopProduct.UPDATE_FEED_ENVIRONMENT_NAME, "ASHLER_CODE_UPDATE_FEED_URL");
    assert.equal(DesktopProduct.TELEMETRY_ENABLED_BY_DEFAULT, false);
  });

  it("uses stable names for production, nightly, and development builds", () => {
    assert.equal(
      DesktopProduct.resolveProductDisplayName({ isDevelopment: false, isNightly: false }),
      "Ashler Code",
    );
    assert.equal(
      DesktopProduct.resolveProductDisplayName({ isDevelopment: false, isNightly: true }),
      "Ashler Code (Nightly)",
    );
    assert.equal(
      DesktopProduct.resolveProductDisplayName({ isDevelopment: true, isNightly: false }),
      "Ashler Code (Dev)",
    );
  });
});
