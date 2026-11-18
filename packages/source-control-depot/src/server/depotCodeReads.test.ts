import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PullRequestDiffResult } from "@t3tools/contracts";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as DepotCli from "./DepotCli.ts";
import * as DepotCodeReads from "./depotCodeReads.ts";

const decodeDiff = Schema.decodeEffect(Schema.fromJsonString(PullRequestDiffResult));
const ref = { cwd: "/repo", host: "depot.dev", repository: "org1/repo1", number: "mr_abc" };
const envelope = {
  mergeRequestId: ref.number,
  repositoryId: "repo1",
  headOid: "a".repeat(40),
  baseOid: "b".repeat(40),
  anchorBaseOid: "c".repeat(40),
  nextPageToken: "",
};
const file = {
  path: "a.txt",
  kind: "added",
  oldOid: "",
  newOid: "c".repeat(40),
  contentKind: "text",
  additions: 2,
  deletions: 0,
  patch:
    "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
};
const layer = (response: (operation: string, args: ReadonlyArray<string>) => unknown) =>
  DepotCli.layer.pipe(
    Layer.provide(
      TestHost.layer({
        process: {
          run: (input) =>
            Effect.succeed(
              TestHost.processOutput(JSON.stringify(response(input.operation, input.args))),
            ),
        },
      }),
    ),
  );

it.effect("pages MR stats and preserves oversized files as incomplete on the wire", () =>
  Effect.gen(function* () {
    const code = yield* DepotCodeReads.make;
    const stats = yield* code.stats(ref);
    assert.deepStrictEqual(stats, {
      headOid: envelope.headOid,
      additions: 2,
      deletions: 0,
      changedFiles: 2,
      statsIncomplete: true,
    });
    const first = yield* code.getDiff(ref);
    assert.strictEqual(first.patch, file.patch);
    assert.strictEqual(first.nextCursor, "next");
    assert.isFalse(first.truncated);
    const second = yield* code.getDiff({ ...ref, cursor: first.nextCursor! });
    const wire = yield* decodeDiff(JSON.stringify(second));
    assert.isTrue(wire.truncated);
    assert.deepStrictEqual(wire.reviewRevision, {
      headOid: envelope.headOid,
      baseOid: envelope.anchorBaseOid,
    });
    assert.deepStrictEqual(wire.omittedFileStats, [
      { path: "huge.txt", additions: 0, deletions: 0, statsIncomplete: true },
    ]);
  }).pipe(
    Effect.provide(
      layer((_, args) => ({
        ...envelope,
        nextPageToken: args.includes("--page-token") ? "" : "next",
        files: args.includes("--page-token")
          ? [
              {
                ...file,
                path: "huge.txt",
                contentKind: "too_large",
                additions: null,
                deletions: null,
                patch: args.includes("--stat")
                  ? undefined
                  : "diff --git a/huge.txt b/huge.txt\nnew file mode 100644\n",
              },
            ]
          : [{ ...file, patch: args.includes("--stat") ? undefined : file.patch }],
      })),
    ),
  ),
);

it.effect.each(["repeated", "moved", "wrong-repository"] as const)(
  "rejects %s pages instead of returning mixed or partial stats",
  (mode) =>
    Effect.gen(function* () {
      const code = yield* DepotCodeReads.make;
      const result = yield* Effect.flip(code.stats(ref));
      assert.include(result.detail, mode === "repeated" ? "incomplete" : "changed");
    }).pipe(
      Effect.provide(
        layer((_, args) => ({
          ...envelope,
          files: [file],
          nextPageToken: "next",
          ...(mode === "wrong-repository" ? { repositoryId: "other" } : {}),
          ...(mode === "moved" && args.includes("--page-token") ? { headOid: "d".repeat(40) } : {}),
        })),
      ),
    ),
);

it.effect("keeps walking after an empty commit page and returns commit identities", () =>
  Effect.gen(function* () {
    const code = yield* DepotCodeReads.make;
    const commits = yield* code.commits(ref);
    assert.deepStrictEqual(commits, [
      {
        oid: envelope.headOid,
        messageHeadline: "Fix scrolling",
        committedDate: "2026-11-17T10:00:00Z",
        authors: [{ login: "a@example.com", name: "Alice", avatarUrl: null }],
      },
    ]);
  }).pipe(
    Effect.provide(
      layer((_, args) => ({
        ...envelope,
        nextPageToken: args.includes("--page-token") ? "" : "more",
        commits: args.includes("--page-token")
          ? [
              {
                oid: envelope.headOid,
                message: "Fix scrolling\n\nDetails",
                authorName: "Alice",
                authorEmail: "a@example.com",
                committedDate: "2026-11-17T10:00:00Z",
              },
            ]
          : [],
      })),
    ),
  ),
);

it.effect.each([false, true])(
  "reads exact file contents and rejects binary text (binary=%s)",
  (binary) =>
    Effect.gen(function* () {
      const code = yield* DepotCodeReads.make;
      const result = code.getDiffFileContents({
        ...ref,
        changeType: "new",
        oldPath: "/dev/null",
        newPath: "a.txt",
      });
      if (binary) assert.include((yield* Effect.flip(result)).detail, "binary");
      else assert.deepStrictEqual(yield* result, { oldContents: "", newContents: "hello\n" });
    }).pipe(
      Effect.provide(
        layer((_, args) => {
          assert.include(args, "a.txt");
          return {
            ...envelope,
            path: "a.txt",
            oldContents: "",
            newContents: Buffer.from(binary ? "\0hello" : "hello\n").toString("base64"),
          };
        }),
      ),
    ),
);
