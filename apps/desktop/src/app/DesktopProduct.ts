import productManifest from "../../../../ashler/product.json" with { type: "json" };

function requiredValue(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Ashler product manifest is missing ${field}.`);
  }
  return value;
}

function placeholderEnvironmentName(value: string, field: string): string {
  const match = /^\$\{([A-Z][A-Z0-9_]*)\}$/u.exec(value);
  if (!match?.[1]) {
    throw new Error(`Ashler product manifest ${field} must be an environment placeholder.`);
  }
  return match[1];
}

export const PRODUCT_NAME = productManifest.productName;
export const DESKTOP_BUNDLE_IDENTIFIER = requiredValue(
  productManifest.bundleIdentifiers.desktop,
  "bundleIdentifiers.desktop",
);
export const DESKTOP_HELPER_BUNDLE_IDENTIFIER = requiredValue(
  productManifest.bundleIdentifiers.desktopHelper,
  "bundleIdentifiers.desktopHelper",
);
export const DESKTOP_LOGIN_HELPER_BUNDLE_IDENTIFIER = requiredValue(
  productManifest.bundleIdentifiers.desktopLoginHelper,
  "bundleIdentifiers.desktopLoginHelper",
);
export const PRODUCTION_URL_SCHEME = requiredValue(productManifest.urlSchemes[0], "urlSchemes[0]");
export const DEVELOPMENT_URL_SCHEME = `${PRODUCTION_URL_SCHEME}-dev`;
export const HOME_DIRECTORY_NAME = productManifest.dataDirectories.home;
export const USER_DATA_DIRECTORY_NAME = productManifest.dataDirectories.userData;
export const DEVELOPMENT_USER_DATA_DIRECTORY_NAME =
  productManifest.dataDirectories.developmentUserData;
export const UPDATE_FEED_ENVIRONMENT_NAME = placeholderEnvironmentName(
  productManifest.updateFeed,
  "updateFeed",
);
export const TELEMETRY_ENABLED_BY_DEFAULT = productManifest.telemetry.enabledByDefault;

export function resolveProductDisplayName(input: {
  readonly isDevelopment: boolean;
  readonly isNightly: boolean;
}): string {
  if (input.isDevelopment) return `${PRODUCT_NAME} (Dev)`;
  if (input.isNightly) return `${PRODUCT_NAME} (Nightly)`;
  return PRODUCT_NAME;
}
