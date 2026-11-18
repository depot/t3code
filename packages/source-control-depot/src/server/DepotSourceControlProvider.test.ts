import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RepositoryIdentity, VcsProcessExitError } from "@t3tools/contracts";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { definition } from "../shared/definition.ts";
import * as DepotCli from "./DepotCli.ts";
import * as DepotSourceControlProvider from "./DepotSourceControlProvider.ts";

const repo = {
  repositoryId: "repo1",
  name: "team/widgets",
  defaultBranch: "develop",
  cloneUrl: "https://org1.code.depot.dev/team/widgets",
};
const remote = "https://org1.code.depot.dev/old-name";
const identity = RepositoryIdentity.make({
  canonicalKey: "org1.code.depot.dev/old-name",
  rootPath: "/repo",
  provider: definition.kind,
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: remote.replace("https://", "https://user:secret@"),
  },
});
const context = {
  provider: { kind: definition.kind, name: "Depot Code", baseUrl: "https://depot.dev" },
  remoteName: "upstream",
  remoteUrl: remote.replace("https://", "https://user:secret@"),
};
const layer = (respond: (args: ReadonlyArray<string>) => unknown) =>
  DepotCli.layer.pipe(
    Layer.provide(
      TestHost.layer({
        process: {
          run: (input) =>
            Effect.sync(() => TestHost.processOutput(JSON.stringify(respond(input.args)))),
        },
      }),
    ),
  );

it.effect(
  "resolves an empty repository through its selected remote and preserves its non-default branch",
  () =>
    Effect.gen(function* () {
      const provider = yield* DepotSourceControlProvider.make;
      const refined = yield* provider.refineRepositoryIdentity!({
        identity,
        resolveContext: () => Effect.succeed(null),
      });
      assert.strictEqual(refined.canonicalKey, "depot.dev/org1/repo1");
      assert.strictEqual(refined.name, "team/widgets");
      assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo", context }), "develop");
    }).pipe(
      Effect.provide(
        layer((args) => {
          assert.deepStrictEqual(args.slice(0, 3), ["code", "repo", "view"]);
          assert.strictEqual(args[args.indexOf("--remote") + 1], remote);
          return repo;
        }),
      ),
    ),
);

it.effect(
  "looks up namespaced repositories and creates private repositories in the requested organization",
  () =>
    Effect.gen(function* () {
      const provider = yield* DepotSourceControlProvider.make;
      for (const repository of [
        "org1/old-name",
        "https://depot.dev/orgs/org1/code/repositories/repo1",
        remote,
      ]) {
        const urls = yield* provider.getRepositoryCloneUrls({ cwd: "/repo", repository });
        assert.deepStrictEqual(urls, {
          nameWithOwner: "org1/team/widgets",
          url: repo.cloneUrl,
          sshUrl: repo.cloneUrl,
        });
      }
      const created = yield* provider.createRepository({
        cwd: "/repo",
        repository: "org1/team/widgets",
        visibility: "private",
      });
      assert.strictEqual(created.url, repo.cloneUrl);
      const error = yield* Effect.flip(
        provider.createRepository({
          cwd: "/repo",
          repository: "org1/public",
          visibility: "public",
        }),
      );
      assert.include(error.detail, "private");
    }).pipe(
      Effect.provide(
        layer((args) => {
          assert.strictEqual(args[args.indexOf("--org") + 1], "org1");
          if (args.includes("create"))
            assert.deepStrictEqual(args.slice(-2), ["--", "team/widgets"]);
          return repo;
        }),
      ),
    ),
);

it.effect(
  "checks out an MR URL by ID with its organization and repository and preserves CLI refusals",
  () => {
    const url = "https://depot.dev/orgs/org1/code/repositories/repo1/merge-requests?id=mr_abc";
    return Effect.gen(function* () {
      const provider = yield* DepotSourceControlProvider.make;
      const error = yield* Effect.flip(
        provider.checkoutChangeRequest({ cwd: "/repo", reference: url, force: true }),
      );
      assert.include(error.detail, "Commit or stash");
    }).pipe(
      Effect.provide(
        DepotCli.layer.pipe(
          Layer.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  assert.deepStrictEqual(input.args, [
                    "mr",
                    "checkout",
                    "--org",
                    "org1",
                    "--repo",
                    "repo1",
                    "--json",
                    "--force",
                    "--id",
                    "mr_abc",
                  ]);
                  input.classifyFailure?.(
                    "commit or stash local changes before checking out a merge request",
                  );
                  return Effect.fail(
                    new VcsProcessExitError({
                      operation: input.operation,
                      command: "depot",
                      cwd: input.cwd,
                      exitCode: 1,
                      detail: "refused",
                      failureKind: "command-failed",
                    }),
                  );
                },
              },
            }),
          ),
        ),
      ),
    );
  },
);

it.effect("refuses to prepare a thread from a different repository", () =>
  Effect.gen(function* () {
    const provider = yield* DepotSourceControlProvider.make;
    const error = yield* Effect.flip(
      provider.getChangeRequest({
        cwd: "/repo",
        context,
        reference: "https://depot.dev/orgs/org1/code/repositories/other/merge-requests?id=mr_abc",
      }),
    );
    assert.include(error.detail, "another repository");
  }).pipe(
    Effect.provide(
      layer((args) =>
        args[0] === "code"
          ? repo
          : {
              mergeRequest: {
                id: "mr_abc",
                repositoryId: "other",
                title: "Other",
                state: "STATE_OPEN",
                headRef: "feature",
                headOid: "a".repeat(40),
                baseRef: "main",
                createdAt: "2026-11-18T09:00:00Z",
                updatedAt: "2026-11-18T09:00:00Z",
              },
            },
      ),
    ),
  ),
);
