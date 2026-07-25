import { APP_BASE_NAME, APP_DISPLAY_NAME } from "../branding";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex flex-col items-center justify-center gap-3"
        aria-label={`${APP_BASE_NAME} splash screen`}
      >
        <img alt="" aria-hidden className="size-16" src="/ashler-code-mark.svg" />
        <span className="text-sm font-medium tracking-tight text-muted-foreground">
          {APP_DISPLAY_NAME}
        </span>
      </div>
    </div>
  );
}
