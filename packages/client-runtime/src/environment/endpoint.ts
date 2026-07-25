export * from "@t3tools/shared/advertisedEndpoint";

function appendPathname(basePathname: string, pathname: string): string {
  const base = basePathname.replace(/\/+$/, "");
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${suffix}` || "/";
}

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = appendPathname(url.pathname, pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const environmentWebSocketUrl = (wsBaseUrl: string): URL => {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url;
};
