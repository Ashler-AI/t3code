// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Host-side notice generation shells out to the workspace package manager.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

type PnpmLicenseEntry = {
  readonly name: string;
  readonly versions: ReadonlyArray<string>;
  readonly license?: string;
  readonly homepage?: string;
};

type PnpmLicenseReport = Readonly<Record<string, ReadonlyArray<PnpmLicenseEntry>>>;

export type NoticeEntry = {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly homepage?: string;
};

export function normalizeLicenseReport(report: PnpmLicenseReport): ReadonlyArray<NoticeEntry> {
  const entries = new Map<string, NoticeEntry>();
  for (const [licenseGroup, packages] of Object.entries(report)) {
    for (const dependency of packages) {
      for (const version of dependency.versions) {
        const entry = {
          name: dependency.name,
          version,
          license: dependency.license ?? licenseGroup,
          ...(dependency.homepage ? { homepage: dependency.homepage } : {}),
        };
        entries.set(`${entry.name}\0${entry.version}\0${entry.license}`, entry);
      }
    }
  }
  return [...entries.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.license.localeCompare(right.license),
  );
}

export function renderThirdPartyNotices(entries: ReadonlyArray<NoticeEntry>): string {
  const tableHeader = ["Package", "Version", "License", "Project"] as const;
  const tableRows = entries.map((entry) => [
    entry.name.replaceAll("|", "\\|"),
    entry.version,
    entry.license.replaceAll("|", "\\|"),
    entry.homepage ? `[link](${entry.homepage})` : "—",
  ]);
  const columnWidths = tableHeader.map((header, columnIndex) =>
    Math.max(header.length, ...tableRows.map((row) => row[columnIndex]?.length ?? 0)),
  );
  const renderTableRow = (row: ReadonlyArray<string>) =>
    `| ${row
      .map((cell, columnIndex) => String(cell ?? "").padEnd(columnWidths[columnIndex] ?? 0))
      .join(" | ")} |`;
  const lines = [
    "# Third-Party Notices",
    "",
    "Ashler Code is based on T3 Code and remains distributed under the root MIT license.",
    "This inventory is generated from the production dependency graph by",
    "`pnpm ashler:notices`; do not edit it by hand.",
    "",
    "The custom file icon attribution maintained by upstream remains available in",
    "`apps/web/THIRD_PARTY_NOTICES.md`.",
    "",
    renderTableRow(tableHeader),
    renderTableRow(columnWidths.map((width) => "-".repeat(width))),
    ...tableRows.map(renderTableRow),
  ];
  return `${lines.join("\n")}\n`;
}

export function loadPnpmLicenseReport(repoRoot: string): PnpmLicenseReport {
  const result = NodeChildProcess.spawnSync(
    "corepack",
    ["pnpm", "licenses", "list", "--json", "--prod"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`pnpm license inventory failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as PnpmLicenseReport;
}

export function generateThirdPartyNotices(repoRoot: string): string {
  return renderThirdPartyNotices(normalizeLicenseReport(loadPnpmLicenseReport(repoRoot)));
}

const isMain =
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]);
if (isMain) {
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const outputPath = NodePath.join(repoRoot, "ashler/THIRD_PARTY_NOTICES.md");
  const generated = generateThirdPartyNotices(repoRoot);
  if (process.argv.includes("--check")) {
    const current = NodeFS.existsSync(outputPath) ? NodeFS.readFileSync(outputPath, "utf8") : "";
    if (current !== generated) {
      console.error("ashler/THIRD_PARTY_NOTICES.md is stale; run pnpm ashler:notices");
      process.exitCode = 1;
    } else {
      console.log("Ashler third-party notices are current.");
    }
  } else {
    NodeFS.writeFileSync(outputPath, generated);
    console.log(`Wrote ${NodePath.relative(repoRoot, outputPath)}.`);
  }
}
