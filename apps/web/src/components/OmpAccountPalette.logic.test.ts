import { OmpAccountRef, type OmpLoginChallenge } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOmpAccountRowPresentation,
  buildOmpOverviewStatusPresentation,
  buildOmpUsageDisplayRows,
  completeOmpLoginFlow,
  describeOmpLoginTerminalFailure,
  describeOmpLoginFailure,
  formatOmpUsageAmount,
  getOmpLoginActionPresentation,
  InvalidOmpAuthorizationUrlError,
  normalizeOmpLoginChallengeResponse,
  normalizeOmpAuthorizationUrl,
  observeOmpLoginBrowserWindowClose,
  ompLoginChallengeExpiryDelay,
  prepareOmpLoginBrowserWindow,
  preserveOmpOverviewAfterRefreshFailure,
  providerDisplayName,
  reconcileOmpLoginSubmitSupport,
  reserveOmpLoginFlow,
  throwOmpLoginCancelFailure,
} from "./OmpAccountPalette.logic";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
  };
}

describe("OMP account palette presentation", () => {
  it("reserves a browser tab synchronously and navigates it after the login RPC", () => {
    const events: string[] = [];
    const popup = {
      closed: false,
      opener: {} as unknown,
      location: {
        replace: (url: string) => events.push(`navigate:${url}`),
      },
      close: () => events.push("close"),
    };

    const prepared = prepareOmpLoginBrowserWindow(() => {
      events.push("reserve");
      return popup;
    });
    events.push("rpc-complete");

    expect(prepared.navigate("https://example.test/oauth")).toBe(true);
    prepared.closeIfUnused();
    expect(events).toEqual(["reserve", "rpc-complete", "navigate:https://example.test/oauth"]);
    expect(popup.opener).toBeNull();
  });

  it("closes an unused login tab and tolerates popup blocking", () => {
    let closeCalls = 0;
    const prepared = prepareOmpLoginBrowserWindow(() => ({
      closed: false,
      opener: null,
      location: { replace: () => undefined },
      close: () => {
        closeCalls += 1;
      },
    }));

    prepared.closeIfUnused();
    prepared.closeIfUnused();
    expect(closeCalls).toBe(1);

    const blocked = prepareOmpLoginBrowserWindow(() => null);
    expect(blocked.navigate("https://example.test/oauth")).toBe(false);
    expect(() => blocked.closeIfUnused()).not.toThrow();
  });

  it("accepts HTTPS and loopback HTTP authorization URLs only", () => {
    expect(normalizeOmpAuthorizationUrl("https://accounts.example.test/oauth")).toBe(
      "https://accounts.example.test/oauth",
    );
    expect(normalizeOmpAuthorizationUrl("http://localhost:54545/callback")).toBe(
      "http://localhost:54545/callback",
    );
    expect(normalizeOmpAuthorizationUrl("http://127.0.0.1:54545/callback")).toBe(
      "http://127.0.0.1:54545/callback",
    );
    expect(normalizeOmpAuthorizationUrl("http://[::1]:54545/callback")).toBe(
      "http://[::1]:54545/callback",
    );
    expect(normalizeOmpAuthorizationUrl("http://accounts.example.test/oauth")).toBeNull();
    expect(normalizeOmpAuthorizationUrl("http://127.example.test/oauth")).toBeNull();
    expect(normalizeOmpAuthorizationUrl("http://127.999.0.1/oauth")).toBeNull();
    expect(normalizeOmpAuthorizationUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeOmpAuthorizationUrl("data:text/html,unsafe")).toBeNull();
  });

  it("never navigates a reserved popup to an unsafe authorization URL", () => {
    const navigated: string[] = [];
    const prepared = prepareOmpLoginBrowserWindow(() => ({
      closed: false,
      opener: null,
      location: { replace: (url) => navigated.push(String(url)) },
      close: () => undefined,
    }));

    expect(prepared.navigate("javascript:alert(1)")).toBe(false);
    expect(prepared.navigate("http://accounts.example.test/oauth")).toBe(false);
    expect(navigated).toEqual([]);
  });

  it("closes and discards a popup when its opener cannot be cleared", () => {
    let closeCalls = 0;
    let navigateCalls = 0;
    const popup = {
      closed: false,
      get opener(): unknown {
        return {};
      },
      set opener(_value: unknown) {
        throw new Error("opener access denied");
      },
      location: {
        replace: () => {
          navigateCalls += 1;
        },
      },
      close: () => {
        closeCalls += 1;
      },
    };

    const prepared = prepareOmpLoginBrowserWindow(() => popup);

    expect(closeCalls).toBe(1);
    expect(prepared.navigate("https://accounts.example.test/oauth")).toBe(false);
    expect(navigateCalls).toBe(0);
  });

  it("falls back cleanly when the reserved popup was closed before navigation", () => {
    let navigateCalls = 0;
    const prepared = prepareOmpLoginBrowserWindow(() => ({
      closed: true,
      opener: null,
      location: {
        replace: () => {
          navigateCalls += 1;
        },
      },
      close: () => undefined,
    }));

    expect(prepared.navigate("https://accounts.example.test/oauth")).toBe(false);
    expect(navigateCalls).toBe(0);
  });

  it("observes a user-closed provider window without cancelling the OAuth flow", async () => {
    const popup = {
      closed: false,
      opener: null,
      location: { replace: () => undefined },
      close: () => undefined,
    };
    const prepared = prepareOmpLoginBrowserWindow(() => popup);
    expect(prepared.navigate("https://accounts.example.test/oauth")).toBe(true);

    const monitor = prepared.waitUntilClosed(new AbortController().signal, 1);
    popup.closed = true;

    await expect(monitor).resolves.toBe(true);
  });

  it("keeps manual code login usable when an embedded browser closes the provider window", async () => {
    const popup = {
      closed: false,
      opener: null,
      location: { replace: () => undefined },
      close: () => undefined,
    };
    const prepared = prepareOmpLoginBrowserWindow(() => popup);
    const browserMonitor = new AbortController();
    let observedClose = false;
    let monitor: Promise<void> | undefined;
    let cancelCalls = 0;
    let responseCalls = 0;

    const result = await completeOmpLoginFlow(
      {
        flowId: "login_embedded_browser",
        provider: "anthropic",
        kind: "browser",
        url: "https://accounts.example.test/oauth",
      },
      {
        openBrowser: (url) => {
          expect(prepared.navigate(url)).toBe(true);
          monitor = observeOmpLoginBrowserWindowClose(
            prepared,
            browserMonitor.signal,
            () => {
              observedClose = true;
            },
            1,
          );
          popup.closed = true;
        },
        requestInput: () => "manual-code",
        respond: async (flowId, response) => {
          responseCalls += 1;
          if (responseCalls === 1) {
            expect(response).toBe("");
            return {
              flowId,
              provider: "anthropic",
              kind: "input",
              prompt: "Paste the authorization code.",
            };
          }
          expect(response).toBe("manual-code");
          return {
            flowId,
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          };
        },
        submit: async () => ({ supported: false, accepted: false }),
        getSubmitSupport: () => false,
        setSubmitSupported: () => undefined,
        dismissInput: () => undefined,
        cancel: async () => {
          cancelCalls += 1;
        },
      },
    );

    await monitor;
    expect(observedClose).toBe(true);
    expect(cancelCalls).toBe(0);
    expect(result).toMatchObject({ kind: "complete", outcome: "success" });
  });

  it("stops watching an open provider window after the login completes", async () => {
    const popup = {
      closed: false,
      opener: null,
      location: { replace: () => undefined },
      close: () => undefined,
    };
    const prepared = prepareOmpLoginBrowserWindow(() => popup);
    expect(prepared.navigate("https://accounts.example.test/oauth")).toBe(true);
    const controller = new AbortController();
    const monitor = prepared.waitUntilClosed(controller.signal, 1);

    controller.abort();

    await expect(monitor).resolves.toBe(false);
  });

  it("distinguishes a closed sign-in window from a provider timeout", () => {
    expect(
      describeOmpLoginTerminalFailure({
        message: "Login did not complete.",
        browserWindowClosed: true,
      }),
    ).toContain("window closed");
    expect(
      describeOmpLoginTerminalFailure({
        message: "Login timed out. Start sign-in again.",
        browserWindowClosed: true,
      }),
    ).toBe("Login timed out. Start sign-in again.");
  });

  it("cancels a login flow before exposing an unsafe provider URL", async () => {
    const opened: string[] = [];
    let cancelCalls = 0;

    await expect(
      completeOmpLoginFlow(
        {
          flowId: "login_unsafe_url",
          provider: "openai",
          kind: "browser",
          url: "javascript:alert(1)",
        },
        {
          openBrowser: (url) => opened.push(url),
          requestInput: () => null,
          respond: async () => {
            throw new Error("unsafe URL must stop before polling");
          },
          submit: async () => ({ supported: false, accepted: false }),
          getSubmitSupport: () => undefined,
          setSubmitSupported: () => undefined,
          dismissInput: () => undefined,
          cancel: async () => {
            cancelCalls += 1;
          },
        },
      ),
    ).rejects.toBeInstanceOf(InvalidOmpAuthorizationUrlError);
    expect(opened).toEqual([]);
    expect(cancelCalls).toBe(1);
  });

  it("polls a browser OAuth challenge until OMP reports its terminal outcome", async () => {
    const opened: string[] = [];
    const responses: string[] = [];
    const result = await completeOmpLoginFlow(
      {
        flowId: "login_123",
        provider: "anthropic",
        kind: "browser",
        url: "https://example.test/oauth",
      },
      {
        openBrowser: (url) => opened.push(url),
        requestInput: () => null,
        respond: async (_flowId, response) => {
          responses.push(response);
          return {
            flowId: "login_123",
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          };
        },
        submit: async () => {
          throw new Error("browser login must not submit manual input");
        },
        getSubmitSupport: () => undefined,
        setSubmitSupported: () => undefined,
        dismissInput: () => undefined,
        cancel: async () => undefined,
      },
    );

    expect(opened).toEqual(["https://example.test/oauth"]);
    expect(responses).toEqual([""]);
    expect(result?.outcome).toBe("success");
  });

  it("keeps a successful OAuth result when browser-close cancellation finishes later", async () => {
    let browserCancel: (() => Promise<void>) | undefined;
    const completed = completeOmpLoginFlow(
      {
        flowId: "login_callback_succeeded",
        provider: "openai",
        kind: "browser",
        url: "https://accounts.example.test/oauth",
      },
      {
        openBrowser: (_url, _flowId, cancel) => {
          browserCancel = cancel;
        },
        requestInput: () => null,
        respond: async () => ({
          flowId: "login_callback_succeeded",
          provider: "openai",
          kind: "complete",
          outcome: "success",
        }),
        submit: async () => ({ supported: false, accepted: false }),
        getSubmitSupport: () => undefined,
        setSubmitSupported: () => undefined,
        dismissInput: () => undefined,
        cancel: async () => {
          throw new Error("completed flow is no longer cancelable");
        },
      },
    );

    await expect(completed).resolves.toMatchObject({ outcome: "success" });
    await expect(browserCancel?.()).rejects.toThrow("completed flow is no longer cancelable");
    await expect(completed).resolves.toMatchObject({ outcome: "success" });
  });

  it("shares one exact-flow cancellation across concurrent browser cancel requests", async () => {
    const poll = deferred<OmpLoginChallenge>();
    const cancelGate = deferred<void>();
    let browserCancel: (() => Promise<void>) | undefined;
    let cancelCalls = 0;
    const completed = completeOmpLoginFlow(
      {
        flowId: "login_browser_cancel",
        provider: "openai",
        kind: "browser",
        url: "https://accounts.example.test/oauth",
      },
      {
        openBrowser: (_url, flowId, cancel) => {
          expect(flowId).toBe("login_browser_cancel");
          browserCancel = cancel;
        },
        requestInput: () => null,
        respond: async () => poll.promise,
        submit: async () => ({ supported: false, accepted: false }),
        getSubmitSupport: () => undefined,
        setSubmitSupported: () => undefined,
        dismissInput: () => undefined,
        cancel: async (flowId) => {
          expect(flowId).toBe("login_browser_cancel");
          cancelCalls += 1;
          await cancelGate.promise;
          poll.resolve({
            flowId,
            provider: "openai",
            kind: "complete",
            outcome: "failure",
          });
        },
      },
    );

    expect(browserCancel).toBeDefined();
    const firstCancel = browserCancel?.();
    const secondCancel = browserCancel?.();
    await Promise.resolve();
    expect(cancelCalls).toBe(1);

    cancelGate.resolve(undefined);
    await expect(Promise.all([firstCancel, secondCancel])).resolves.toEqual([undefined, undefined]);
    await expect(completed).resolves.toMatchObject({
      flowId: "login_browser_cancel",
      kind: "complete",
      outcome: "failure",
    });
  });

  it("cancels a browser flow once and preserves a rejected long-poll failure", async () => {
    const pollFailure = new Error("browser authorization poll failed");
    const canceledFlowIds: string[] = [];

    await expect(
      completeOmpLoginFlow(
        {
          flowId: "login_browser_poll_failure",
          provider: "anthropic",
          kind: "browser",
          url: "https://example.test/oauth",
        },
        {
          openBrowser: () => undefined,
          requestInput: () => null,
          respond: async () => {
            throw pollFailure;
          },
          submit: async () => ({ supported: false, accepted: false }),
          getSubmitSupport: () => undefined,
          setSubmitSupported: () => undefined,
          dismissInput: () => undefined,
          cancel: async (flowId) => {
            canceledFlowIds.push(flowId);
            throw new Error("cancel also failed");
          },
        },
      ),
    ).rejects.toBe(pollFailure);
    expect(canceledFlowIds).toEqual(["login_browser_poll_failure"]);
  });

  it("submits an in-app code while the existing response request remains a long poll", async () => {
    const events: string[] = [];
    const nextChallenge = deferred<OmpLoginChallenge>();
    const completed = await completeOmpLoginFlow(
      {
        flowId: "login_code",
        provider: "anthropic",
        kind: "input",
        inputType: "code",
        prompt: "Paste the authorization code.",
      },
      {
        openBrowser: () => undefined,
        requestInput: async (challenge) => {
          events.push(`input:${challenge.kind}`);
          return "  claude-code-123  ";
        },
        respond: async (_flowId, response) => {
          events.push(`poll:${response}`);
          return nextChallenge.promise;
        },
        submit: async (flowId, response) => {
          events.push(`submit:${flowId}:${response}`);
          nextChallenge.resolve({
            flowId: "login_code",
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          });
          return { supported: true, accepted: true };
        },
        getSubmitSupport: () => true,
        setSubmitSupported: () => undefined,
        dismissInput: () => undefined,
        cancel: async () => undefined,
      },
    );

    expect(events).toEqual(["poll:", "input:input", "submit:login_code:  claude-code-123  "]);
    expect(completed?.outcome).toBe("success");
  });

  it("fails after a bounded wait when OMP rejects manual input and the callback poll stays pending", async () => {
    const nextChallenge = deferred<OmpLoginChallenge>();
    let cancelCalls = 0;

    await expect(
      completeOmpLoginFlow(
        {
          flowId: "login_not_accepted",
          provider: "openai",
          kind: "input",
          inputType: "code",
        },
        {
          openBrowser: () => undefined,
          requestInput: async () => "rejected-code",
          respond: async () => nextChallenge.promise,
          submit: async () => ({ supported: true, accepted: false }),
          getSubmitSupport: () => true,
          setSubmitSupported: () => undefined,
          dismissInput: () => undefined,
          cancel: async () => {
            cancelCalls += 1;
          },
        },
        16,
        5,
      ),
    ).rejects.toThrow(
      "Sign-in response was not accepted before the authorization callback completed.",
    );
    expect(cancelCalls).toBe(1);
  });

  it("keeps a macrotask-later callback completion when manual input is no longer accepted", async () => {
    const nextChallenge = deferred<OmpLoginChallenge>();
    let submitCalls = 0;
    const completed = await completeOmpLoginFlow(
      {
        flowId: "login_callback_completed",
        provider: "openai",
        kind: "input",
        inputType: "code",
      },
      {
        openBrowser: () => undefined,
        requestInput: async () => "late-code",
        respond: async () => nextChallenge.promise,
        submit: async () => {
          submitCalls += 1;
          setTimeout(() => {
            nextChallenge.resolve({
              flowId: "login_callback_completed",
              provider: "openai",
              kind: "complete",
              outcome: "success",
            });
          }, 0);
          return { supported: true, accepted: false };
        },
        getSubmitSupport: () => true,
        setSubmitSupported: () => undefined,
        dismissInput: () => undefined,
        cancel: async () => {
          throw new Error("completed callback must not be canceled");
        },
      },
      16,
      100,
    );

    expect(completed?.outcome).toBe("success");
    expect(submitCalls).toBe(1);
  });

  it("preserves a callback poll failure after manual input is no longer accepted", async () => {
    const pollFailure = new Error("authorization callback transport failed");
    let cancelCalls = 0;

    await expect(
      completeOmpLoginFlow(
        {
          flowId: "login_callback_failed",
          provider: "openai",
          kind: "input",
          inputType: "code",
        },
        {
          openBrowser: () => undefined,
          requestInput: async () => "late-code",
          respond: async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            throw pollFailure;
          },
          submit: async () => ({ supported: true, accepted: false }),
          getSubmitSupport: () => true,
          setSubmitSupported: () => undefined,
          dismissInput: () => undefined,
          cancel: async () => {
            cancelCalls += 1;
          },
        },
        16,
        100,
      ),
    ).rejects.toBe(pollFailure);
    expect(cancelCalls).toBe(1);
  });

  it("rejects a non-terminal poll result after manual input is no longer accepted", async () => {
    let cancelCalls = 0;

    await expect(
      completeOmpLoginFlow(
        {
          flowId: "login_callback_non_terminal",
          provider: "openai",
          kind: "input",
          inputType: "code",
        },
        {
          openBrowser: () => undefined,
          requestInput: async () => "late-code",
          respond: async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            return {
              flowId: "login_callback_non_terminal",
              provider: "openai",
              kind: "input",
              inputType: "code",
            };
          },
          submit: async () => ({ supported: true, accepted: false }),
          getSubmitSupport: () => true,
          setSubmitSupported: () => undefined,
          dismissInput: () => undefined,
          cancel: async () => {
            cancelCalls += 1;
          },
        },
        16,
        100,
      ),
    ).rejects.toThrow("Sign-in response was not accepted before the authorization flow completed.");
    expect(cancelCalls).toBe(1);
  });

  it("dismisses only the completed flow's input panel when the HTTP callback wins", async () => {
    const input = deferred<string | null>();
    const dismissed: string[] = [];
    let canceled = false;
    const completed = await completeOmpLoginFlow(
      {
        flowId: "login_http_callback",
        provider: "anthropic",
        kind: "input",
        inputType: "code",
        prompt: "Paste the authorization code.",
      },
      {
        openBrowser: () => undefined,
        requestInput: () => input.promise,
        respond: async () => ({
          flowId: "login_http_callback",
          provider: "anthropic",
          kind: "complete",
          outcome: "success",
        }),
        submit: async () => {
          throw new Error("HTTP callback completion must not submit manual input");
        },
        getSubmitSupport: () => true,
        setSubmitSupported: () => undefined,
        dismissInput: (flowId) => dismissed.push(flowId),
        cancel: async () => {
          canceled = true;
        },
      },
    );

    input.resolve(null);
    expect(completed?.outcome).toBe("success");
    expect(dismissed).toEqual(["login_http_callback"]);
    expect(canceled).toBe(false);
  });

  it("cancels a manual challenge only when the user dismisses it", async () => {
    const nextChallenge = deferred<OmpLoginChallenge>();
    let cancelled = false;
    const canceled = await completeOmpLoginFlow(
      { flowId: "login_cancel", provider: "anthropic", kind: "input" },
      {
        openBrowser: () => undefined,
        requestInput: async () => null,
        respond: async () => nextChallenge.promise,
        submit: async () => ({ supported: false, accepted: false }),
        getSubmitSupport: () => undefined,
        setSubmitSupported: () => undefined,
        dismissInput: () => undefined,
        cancel: async () => {
          cancelled = true;
          nextChallenge.resolve({
            flowId: "login_cancel",
            provider: "anthropic",
            kind: "complete",
            outcome: "failure",
          });
        },
      },
    );

    expect(canceled).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("surfaces cancellation transport failure when the user dismisses a login", async () => {
    const cancelFailure = new Error("cancel transport rejected");

    await expect(
      completeOmpLoginFlow(
        { flowId: "login_cancel_failure", provider: "anthropic", kind: "input" },
        {
          openBrowser: () => undefined,
          requestInput: async () => null,
          respond: async () => {
            throw new Error("legacy response must not start after dismissal");
          },
          submit: async () => ({ supported: false, accepted: false }),
          getSubmitSupport: () => undefined,
          setSubmitSupported: () => undefined,
          dismissInput: () => undefined,
          cancel: async () => {
            throw cancelFailure;
          },
        },
      ),
    ).rejects.toBe(cancelFailure);
  });

  it("throws the squashed atom-command failure at the cancellation adapter boundary", () => {
    const transportFailure = new Error("cancel RPC failed");
    const result = { _tag: "Failure" as const, cause: transportFailure };

    expect(() => throwOmpLoginCancelFailure(result, (failure) => failure.cause)).toThrow(
      transportFailure,
    );
  });

  it("falls back to legacy sequential response when login/submit is unavailable", async () => {
    const events: string[] = [];
    let submitSupported: boolean | undefined;
    const completed = await completeOmpLoginFlow(
      { flowId: "login_legacy", provider: "anthropic", kind: "input", inputType: "code" },
      {
        openBrowser: () => undefined,
        requestInput: async () => "legacy-code",
        respond: async (_flowId, response) => {
          events.push(`respond:${response}`);
          return {
            flowId: "login_legacy",
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          };
        },
        submit: async (_flowId, response) => {
          events.push(`submit:${response}`);
          return { supported: false, accepted: false };
        },
        getSubmitSupport: () => submitSupported,
        setSubmitSupported: (supported) => {
          submitSupported = supported;
        },
        dismissInput: () => undefined,
        cancel: async () => undefined,
      },
    );

    expect(events).toEqual(["submit:", "respond:legacy-code"]);
    expect(submitSupported).toBe(false);
    expect(completed?.outcome).toBe("success");
  });

  it("probes submit support before racing an unresolved input against callback completion", async () => {
    const input = deferred<string | null>();
    const events: string[] = [];
    let submitSupported: boolean | undefined;

    const completed = await completeOmpLoginFlow(
      { flowId: "login_probe", provider: "anthropic", kind: "input", inputType: "code" },
      {
        openBrowser: () => undefined,
        requestInput: () => {
          events.push("input");
          return input.promise;
        },
        respond: async (_flowId, response) => {
          events.push(`poll:${response}`);
          return {
            flowId: "login_probe",
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          };
        },
        submit: async (_flowId, response) => {
          events.push(`probe:${response}`);
          return { supported: true, accepted: false };
        },
        getSubmitSupport: () => submitSupported,
        setSubmitSupported: (supported) => {
          submitSupported = supported;
        },
        dismissInput: () => events.push("dismiss"),
        cancel: async () => undefined,
      },
    );

    input.resolve(null);
    expect(events).toEqual(["probe:", "poll:", "input", "dismiss"]);
    expect(submitSupported).toBe(true);
    expect(completed?.outcome).toBe("success");
  });

  it("cancels exactly once and preserves a submit failure after starting the long poll", async () => {
    const poll = deferred<OmpLoginChallenge>();
    const original = new Error("submit transport rejected");
    let cancelCalls = 0;

    await expect(
      completeOmpLoginFlow(
        { flowId: "login_reject", provider: "anthropic", kind: "input", inputType: "code" },
        {
          openBrowser: () => undefined,
          requestInput: async () => "callback-code",
          respond: async () => poll.promise,
          submit: async () => {
            throw original;
          },
          getSubmitSupport: () => true,
          setSubmitSupported: () => undefined,
          dismissInput: () => undefined,
          cancel: async () => {
            cancelCalls += 1;
            poll.resolve({
              flowId: "login_reject",
              provider: "anthropic",
              kind: "complete",
              outcome: "failure",
            });
            throw new Error("cancel also failed");
          },
        },
      ),
    ).rejects.toBe(original);
    expect(cancelCalls).toBe(1);
  });

  it("rejects same-provider and cross-provider reentry while retaining the active flow", () => {
    const first = reserveOmpLoginFlow(null, {
      environmentId: "environment-1",
      provider: "openai",
    });
    const duplicate = reserveOmpLoginFlow(first.active, {
      environmentId: "environment-1",
      provider: "openai",
    });
    const crossProvider = reserveOmpLoginFlow(first.active, {
      environmentId: "environment-1",
      provider: "anthropic",
    });

    expect(first.acquired).toBe(true);
    expect(duplicate).toEqual({ active: first.active, acquired: false });
    expect(crossProvider).toEqual({ active: first.active, acquired: false });
  });

  it("invalidates submit support so a supported-to-legacy reconnect falls back sequentially", async () => {
    const support = new Map([["environment-1", true]]);
    const connectedGenerationOne = new Map([["environment-1", "connected:runtime-1"]]);

    const reconnecting = reconcileOmpLoginSubmitSupport(support, connectedGenerationOne, [
      { environmentId: "environment-1", scope: "reconnecting:runtime-1" },
    ]);
    const generationTwo = reconcileOmpLoginSubmitSupport(support, connectedGenerationOne, [
      { environmentId: "environment-1", scope: "connected:runtime-2" },
    ]);

    expect(reconnecting.supportByEnvironment.has("environment-1")).toBe(false);
    expect(generationTwo.supportByEnvironment.has("environment-1")).toBe(false);

    const events: string[] = [];
    let supportAfterReconnect = reconnecting.supportByEnvironment.get("environment-1");
    const completed = await completeOmpLoginFlow(
      { flowId: "login_reconnected", provider: "anthropic", kind: "input", inputType: "code" },
      {
        openBrowser: () => undefined,
        requestInput: async () => "legacy-code",
        respond: async (_flowId, response) => {
          events.push(`respond:${response}`);
          return {
            flowId: "login_reconnected",
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          };
        },
        submit: async (_flowId, response) => {
          events.push(`probe:${response}`);
          return { supported: false, accepted: false };
        },
        getSubmitSupport: () => supportAfterReconnect,
        setSubmitSupported: (supported) => {
          supportAfterReconnect = supported;
        },
        dismissInput: () => undefined,
        cancel: async () => {
          throw new Error("legacy fallback must not cancel the reconnected flow");
        },
      },
    );

    expect(events).toEqual(["probe:", "respond:legacy-code"]);
    expect(completed?.outcome).toBe("success");
  });

  it("normalizes challenge input and extracts structured failures", () => {
    expect(normalizeOmpLoginChallengeResponse("  callback-code  ")).toBe("callback-code");
    expect(normalizeOmpLoginChallengeResponse("   ")).toBeNull();
    expect(describeOmpLoginFailure({ detail: "Authorization code expired." })).toBe(
      "Authorization code expired.",
    );
    expect(describeOmpLoginFailure({ reason: "request-failed" })).toBe("request-failed");
    expect(describeOmpLoginFailure({ cause: { token: "secret" } })).toBeUndefined();
  });

  it("derives a bounded delay for expiring login input panels", () => {
    const challenge: OmpLoginChallenge = {
      flowId: "login_expiry",
      provider: "anthropic",
      kind: "input",
      expiresAt: 12_000,
    };

    expect(ompLoginChallengeExpiryDelay(challenge, 10_000)).toBe(2_000);
    expect(ompLoginChallengeExpiryDelay(challenge, 15_000)).toBe(0);
    expect(
      ompLoginChallengeExpiryDelay(
        { flowId: challenge.flowId, provider: challenge.provider, kind: challenge.kind },
        10_000,
      ),
    ).toBeNull();
  });

  it("filters the ChatGPT Spark quota while keeping other account windows", () => {
    const rows = buildOmpUsageDisplayRows([
      {
        provider: "openai",
        maskedAccount: "ch***@example.com",
        fetchedAt: 1,
        limits: [
          {
            id: "weekly",
            label: "7-day quota",
            scope: { provider: "openai" },
            amount: { remainingFraction: 0.42, unit: "percent" },
          },
          {
            id: "spark",
            label: "7 days (Spark)",
            scope: { provider: "openai", tier: "Spark" },
            amount: { remainingFraction: 1, unit: "percent" },
          },
        ],
      },
    ]);

    expect(rows).toEqual([
      {
        key: "ch***@example.com:weekly",
        title: "ChatGPT · 7-day quota",
        description: "ch***@example.com · 42% remaining",
        stale: false,
      },
    ]);
  });

  it("labels retained provider usage as last known", () => {
    const rows = buildOmpUsageDisplayRows([
      {
        provider: "anthropic-claude",
        maskedAccount: "cl***de@example.com",
        fetchedAt: 1,
        limits: [
          {
            id: "weekly",
            label: "Weekly quota",
            scope: { provider: "anthropic-claude" },
            amount: { remainingFraction: 0.6, unit: "percent" },
          },
        ],
        notes: ["Last known usage; this account was omitted from the latest provider refresh."],
      },
    ]);

    expect(rows).toEqual([
      {
        key: "cl***de@example.com:weekly",
        title: "Claude · Weekly quota",
        description: "cl***de@example.com · 60% remaining · Last known",
        stale: true,
      },
    ]);
  });

  it("shows saved reset credits only when at least one is available", () => {
    const rows = buildOmpUsageDisplayRows(
      [
        {
          provider: "openai-codex",
          accountRef: OmpAccountRef.make("acct_openai_resets"),
          maskedAccount: "ch***@example.com",
          fetchedAt: 1,
          limits: [],
          resetCredits: {
            availableCount: 2,
            credits: [
              {
                grantedAt: "2026-07-24T20:00:00.000Z",
                expiresAt: "2026-08-24T20:00:00.000Z",
                status: "available",
              },
            ],
          },
        },
        {
          provider: "openai-codex",
          maskedAccount: "no***ne@example.com",
          fetchedAt: 1,
          limits: [],
          resetCredits: { availableCount: 0 },
        },
      ],
      [
        {
          accountRef: OmpAccountRef.make("acct_openai_resets"),
          provider: "openai-codex",
          authKind: "oauth",
          displayName: "ch***@example.com",
          maskedEmail: "ch***@example.com",
          state: "available",
          managed: false,
        },
      ],
    );

    expect(rows).toEqual([
      {
        key: "acct_openai_resets:reset-credits",
        title: "ChatGPT · Saved resets",
        description: "ch***@example.com · 2 available",
        stale: false,
      },
    ]);
  });

  it("shows a concise unavailable row for a connected account omitted from usage refresh", () => {
    const rows = buildOmpUsageDisplayRows(
      [
        {
          provider: "openai-codex",
          accountRef: OmpAccountRef.make("acct_openai_first"),
          maskedAccount: "fi***st@example.com",
          fetchedAt: 1,
          limits: [],
        },
      ],
      [
        {
          accountRef: OmpAccountRef.make("acct_openai_first"),
          provider: "openai-codex",
          authKind: "oauth",
          displayName: "fi***st@example.com",
          maskedEmail: "fi***st@example.com",
          state: "available",
          managed: false,
        },
        {
          accountRef: OmpAccountRef.make("acct_openai_second"),
          provider: "openai-codex",
          authKind: "oauth",
          displayName: "se***nd@example.com",
          maskedEmail: "se***nd@example.com",
          state: "available",
          managed: false,
        },
        {
          accountRef: OmpAccountRef.make("acct_claude_disabled"),
          provider: "anthropic",
          authKind: "oauth",
          displayName: "cl***de@example.com",
          maskedEmail: "cl***de@example.com",
          state: "unavailable",
          managed: false,
        },
      ],
    );

    expect(rows).toEqual([
      {
        key: "acct_openai_first:unavailable",
        title: "ChatGPT · fi***st@example.com",
        description: "Usage unavailable",
        stale: true,
      },
      {
        key: "acct_openai_second:unavailable",
        title: "ChatGPT · se***nd@example.com",
        description: "Usage unavailable",
        stale: true,
      },
    ]);
  });

  it("formats absolute usage when a provider does not report a percentage", () => {
    expect(
      formatOmpUsageAmount({
        id: "tokens",
        label: "Tokens",
        scope: { provider: "bifrost" },
        amount: { used: 1_250, limit: 10_000, unit: "tokens" },
      }),
    ).toBe("1,250 of 10,000 used");
  });

  it("uses subscription product names for OMP provider aliases", () => {
    expect(providerDisplayName("openai-codex")).toBe("ChatGPT");
    expect(providerDisplayName("anthropic-claude")).toBe("Claude");
  });

  it("shows the cached snapshot age and keeps refresh warnings persistent", () => {
    const now = Date.UTC(2026, 6, 24, 12, 10);
    const presentation = buildOmpOverviewStatusPresentation({
      overview: {
        accounts: {
          mode: "local",
          managed: false,
          accounts: [],
          capabilities: {
            accounts: true,
            login: true,
            remove: true,
            assignment: true,
            usage: true,
          },
          warning: "Account eligibility could not be refreshed.",
        },
        usage: {
          reports: [],
          refreshedAt: Date.UTC(2026, 6, 24, 12, 5),
          stale: true,
          warning: "Showing the last cached usage result.",
        },
      },
      cachedAt: Date.UTC(2026, 6, 24, 12, 6),
      refreshWarning: "The environment is offline.",
      now,
    });

    expect(presentation).toEqual({
      freshnessTitle: "Last refreshed 5m ago",
      freshnessDescription: "Account and plan usage snapshot",
      warning:
        "The environment is offline. Account eligibility could not be refreshed. Showing the last cached usage result.",
    });
  });

  it("falls back to the cache timestamp when OMP has no refresh timestamp", () => {
    const now = Date.UTC(2026, 6, 24, 12, 10);
    const presentation = buildOmpOverviewStatusPresentation({
      overview: {
        accounts: {
          mode: "local",
          managed: false,
          accounts: [],
          capabilities: {
            accounts: true,
            login: true,
            remove: true,
            assignment: true,
            usage: true,
          },
          warning: null,
        },
        usage: { reports: [], refreshedAt: null, stale: false, warning: null },
      },
      cachedAt: Date.UTC(2026, 6, 24, 10, 10),
      refreshWarning: null,
      now,
    });

    expect(presentation.freshnessTitle).toBe("Cached 2h ago");
    expect(presentation.warning).toBeNull();
  });

  it("keeps ChatGPT and Claude login enabled during an active turn and scopes it forward", () => {
    const activeTurnActions = ["Add ChatGPT", "Add Claude"].map((title) => ({
      title,
      ...getOmpLoginActionPresentation({ hasEnvironment: true, hasActiveTurn: true }),
    }));
    const idle = getOmpLoginActionPresentation({ hasEnvironment: true, hasActiveTurn: false });
    const activeLoginActions = ["Add ChatGPT", "Add Claude"].map((title) => ({
      title,
      ...getOmpLoginActionPresentation({
        hasEnvironment: true,
        hasActiveTurn: false,
        hasActiveLogin: true,
      }),
    }));

    expect(activeTurnActions).toEqual([
      {
        title: "Add ChatGPT",
        disabled: false,
        description: "For future sessions · This turn keeps its account",
      },
      {
        title: "Add Claude",
        disabled: false,
        description: "For future sessions · This turn keeps its account",
      },
    ]);
    expect(idle).toEqual({
      disabled: false,
      description: "Available for future sessions",
    });
    expect(activeLoginActions).toEqual([
      {
        title: "Add ChatGPT",
        disabled: true,
        description: "Another account sign-in is already in progress",
      },
      {
        title: "Add Claude",
        disabled: true,
        description: "Another account sign-in is already in progress",
      },
    ]);
  });

  it("explains why account login is unavailable without a local T3 environment", () => {
    expect(getOmpLoginActionPresentation({ hasEnvironment: false, hasActiveTurn: false })).toEqual({
      disabled: true,
      description: "Connect to a local T3 environment to manage accounts",
    });
  });

  it("presents unavailable OAuth accounts as reconnect-required, not connected", () => {
    expect(
      buildOmpAccountRowPresentation({
        accountRef: OmpAccountRef.make("acct_claude_disabled"),
        provider: "anthropic-claude",
        authKind: "oauth",
        displayName: "cl***de@example.com",
        maskedEmail: "cl***de@example.com",
        state: "unavailable",
        managed: false,
      }),
    ).toEqual({
      connected: false,
      title: "Claude needs reconnecting",
      description: "cl***de@example.com · Not connected",
    });
  });

  it("preserves cached account and usage rows when refresh fails", () => {
    const overview = {
      accounts: {
        mode: "local" as const,
        managed: false,
        accounts: [],
        capabilities: {
          accounts: true,
          login: true,
          remove: true,
          assignment: true,
          usage: true,
        },
        warning: null,
      },
      usage: { reports: [], refreshedAt: 123, stale: false, warning: null },
    };

    expect(
      preserveOmpOverviewAfterRefreshFailure({
        overview,
        cachedAt: 456,
        warning: "Showing the last cached account and usage data.",
      }),
    ).toEqual({
      overview,
      cachedAt: 456,
      refreshWarning: "Showing the last cached account and usage data.",
    });
  });
});
