import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLogicalProjectKey,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  getProjectOrderKey,
  resolveProjectGroupingMode,
} from "./logicalProject";
import {
  buildLocalSidebarProjectPickerEntries,
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "./sidebarProjectGrouping";
import { orderItemsByPreferredIds } from "./components/Sidebar.logic";
import { legacyProjectCwdPreferenceKey } from "./uiStateStore";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const defaultGroupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("environment grouping", () => {
  it("groups matching repository identities across environments", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    expect(deriveLogicalProjectKey(primary)).toBe(repositoryIdentity.canonicalKey);
    expect(deriveLogicalProjectKey(remote)).toBe(repositoryIdentity.canonicalKey);
  });

  it("counts cross-environment copies as one new-thread project choice", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    const projectGroupCount = buildSidebarProjectSnapshots({
      projects: [primary, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    }).length;

    expect(projectGroupCount).toBe(1);
  });

  it("keeps projects without repository identity physically scoped", () => {
    const primary = makeProject();
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
    });

    expect(deriveLogicalProjectKey(primary)).toBe(derivePhysicalProjectKey(primary));
    expect(deriveLogicalProjectKey(remote)).toBe(derivePhysicalProjectKey(remote));
    expect(deriveLogicalProjectKey(primary)).not.toBe(deriveLogicalProjectKey(remote));
  });

  it("uses the physical key when repository grouping is disabled", () => {
    const project = makeProject({ repositoryIdentity });

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {},
      }),
    ).toBe(derivePhysicalProjectKey(project));
  });

  it("allows a per-project override to separate an otherwise grouped repository", () => {
    const project = makeProject({ repositoryIdentity });
    const physicalKey = derivePhysicalProjectKey(project);

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        ...defaultGroupingSettings,
        sidebarProjectGroupingOverrides: {
          [physicalKey]: "separate",
        },
      }),
    ).toBe(physicalKey);
  });

  it("allows a per-project override to group a repository while the global mode is separate", () => {
    const project = makeProject({ repositoryIdentity });

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {
          [derivePhysicalProjectKey(project)]: "repository",
        },
      }),
    ).toBe(repositoryIdentity.canonicalKey);
  });

  it("reports the effective grouping mode after applying an override", () => {
    const project = makeProject({ repositoryIdentity });
    const physicalKey = derivePhysicalProjectKey(project);

    expect(resolveProjectGroupingMode(project, defaultGroupingSettings)).toBe("repository");
    expect(
      resolveProjectGroupingMode(project, {
        ...defaultGroupingSettings,
        sidebarProjectGroupingOverrides: {
          [physicalKey]: "separate",
        },
      }),
    ).toBe("separate");
  });

  it("dedupes stale project rows with the same environment and workspace path", () => {
    const duplicate = makeProject({
      id: ProjectId.make("project-duplicate"),
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const primary = makeProject({
      id: ProjectId.make("project-primary"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [primary, duplicate, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.groupedProjectCount).toBe(2);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      primary.id,
      remote.id,
    ]);
  });

  it("prefers the fresher project row when duplicate stale rows are ordered first", () => {
    const staleDuplicate = makeProject({
      id: ProjectId.make("project-stale"),
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleDuplicate, canonical],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([canonical.id]);
    expect(snapshots[0]?.id).toBe(canonical.id);
  });

  it("dedupes stale project rows before logical grouping", () => {
    const staleWithoutRepositoryIdentity = makeProject({
      id: ProjectId.make("project-stale"),
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleWithoutRepositoryIdentity, canonical, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      canonical.id,
      remote.id,
    ]);
    expect(snapshots[0]?.memberProjectRefs).toEqual([
      {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
      { environmentId: primaryEnvironmentId, projectId: canonical.id },
      { environmentId: remoteEnvironmentId, projectId: remote.id },
    ]);

    const [pickerEntry] = buildSidebarProjectPickerEntries({
      groups: snapshots,
      preferredProjectRef: {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
    });
    expect(pickerEntry?.isPreferred).toBe(true);
    expect(pickerEntry?.targetProject.id).toBe(canonical.id);
  });

  it("routes duplicate physical project keys to the winning logical group", () => {
    const staleWithoutRepositoryIdentity = makeProject({
      id: ProjectId.make("project-stale"),
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const physicalToLogicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects: [staleWithoutRepositoryIdentity, canonical],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
    });

    expect(physicalToLogicalKey.get(derivePhysicalProjectKey(staleWithoutRepositoryIdentity))).toBe(
      repositoryIdentity.canonicalKey,
    );
  });

  it("builds one picker entry per logical project and targets the preferred environment", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [separate, primary, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: remoteEnvironmentId,
        projectId: remote.id,
      },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.group.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(entries[0]?.targetProject).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: remote.id,
    });
    expect(entries[0]?.isPreferred).toBe(true);
    expect(entries[1]?.group.displayName).toBe("separate");
  });

  it("targets the primary project for local sessions when the preferred project is remote", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [separate, primary, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildLocalSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: remoteEnvironmentId,
        projectId: remote.id,
      },
      primaryEnvironmentId,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.group.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(entries[0]?.targetProject).toMatchObject({
      environmentId: primaryEnvironmentId,
      id: primary.id,
    });
    expect(entries[0]?.isPreferred).toBe(true);
  });

  it("omits remote-only projects from the local session picker", () => {
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(
      buildLocalSidebarProjectPickerEntries({
        groups,
        preferredProjectRef: {
          environmentId: remoteEnvironmentId,
          projectId: remote.id,
        },
        primaryEnvironmentId,
      }),
    ).toEqual([]);
  });

  it("keeps an available local fallback when the preferred remote project is unrelated", () => {
    const local = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-unrelated-remote"),
      environmentId: remoteEnvironmentId,
      title: "unrelated remote",
      workspaceRoot: "/tmp/unrelated-remote",
      repositoryIdentity: {
        ...repositoryIdentity,
        canonicalKey: "github.com/ashler/unrelated",
      },
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [local, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildLocalSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: remoteEnvironmentId,
        projectId: remote.id,
      },
      primaryEnvironmentId,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetProject).toMatchObject({
      environmentId: primaryEnvironmentId,
      id: local.id,
    });
    expect(entries[0]?.isPreferred).toBe(false);
  });

  it("preserves the preferred local worktree within a grouped repository", () => {
    const primary = makeProject({ repositoryIdentity });
    const preferredWorktree = makeProject({
      id: ProjectId.make("project-preferred-worktree"),
      workspaceRoot: "/tmp/preferred-worktree",
      repositoryIdentity,
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [primary, preferredWorktree],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildLocalSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: primaryEnvironmentId,
        projectId: preferredWorktree.id,
      },
      primaryEnvironmentId,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetProject).toMatchObject({
      environmentId: primaryEnvironmentId,
      id: preferredWorktree.id,
    });
    expect(entries[0]?.isPreferred).toBe(true);
  });

  it("keeps manual project order when building grouped sidebar entries", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const orderedProjects = orderItemsByPreferredIds({
      items: [primary, remote, separate],
      preferredIds: [getProjectOrderKey(separate), getProjectOrderKey(primary)],
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });

    const groups = buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(groups.map((group) => group.displayName)).toEqual(["separate", "shared-repo"]);
  });
});
