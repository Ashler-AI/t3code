function hasInvalidBasePathCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      character === "?" ||
      character === "#" ||
      character === "\\" ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
}

function isCanonicalRootRelativePath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || hasInvalidBasePathCharacter(value)) {
    return false;
  }

  // This is an injected mount path, not an arbitrary URL. Its decoded spelling
  // prevents proxies and URL implementations from disagreeing about encoded
  // separators, traversal segments, or nested escapes.
  if (value.includes("%")) {
    return false;
  }

  const segments = value.split("/");
  if (segments.slice(1).some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }

  try {
    const parsed = new URL(value, "https://t3code.invalid");
    return (
      parsed.origin === "https://t3code.invalid" &&
      parsed.pathname === value &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function normalizeRuntimeBasePath(value: string | undefined): string {
  const basePath = value ?? "";
  if (!basePath || basePath === "/") {
    return "";
  }

  const normalizedBasePath = basePath.replace(/\/+$/, "");
  if (!isCanonicalRootRelativePath(normalizedBasePath)) {
    throw new Error("window.__T3CODE_BASE_PATH__ must be a root-relative URL path.");
  }

  return normalizedBasePath;
}

export function readRuntimeBasePath(): string {
  if (typeof window === "undefined") {
    return "";
  }

  if (window.__T3CODE_BASE_PATH__ !== undefined) {
    return normalizeRuntimeBasePath(window.__T3CODE_BASE_PATH__);
  }

  if (typeof document === "undefined" || !document.baseURI) {
    return "";
  }

  const documentBase = new URL(document.baseURI);
  if (documentBase.origin !== window.location.origin) {
    throw new Error("The document base URL must use the current window origin.");
  }
  return normalizeRuntimeBasePath(documentBase.pathname);
}

export function resolveRuntimePathname(pathname: string): string {
  const absolutePathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${readRuntimeBasePath()}${absolutePathname}`;
}
