import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ThreadPullRequestLink, VcsProcessExitError } from "@t3tools/contracts";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { definition } from "../shared/definition.ts";
import * as DepotCli from "./DepotCli.ts";
import * as DepotPullRequestProvider from "./DepotPullRequestProvider.ts";

const reference = {
  cwd: "/repo",
  host: "depot.dev",
  repository: "org1/repo1",
  number: "mr_c3d35jx9wn",
};
const mergedAt = "2026-11-16T10:28:24.183Z";
const mr = {
  id: reference.number,
  repositoryId: "repo1",
  title: "Fix scrolling",
  state: "STATE_MERGED",
  headRef: "fix-scroll",
  headOid: "a".repeat(40),
  baseRef: "main",
  createdAt: "2026-11-16T10:23:52.719Z",
  updatedAt: mergedAt,
  mergedAt,
};

const emptyCodePage = {
  mergeRequestId: mr.id,
  repositoryId: mr.repositoryId,
  headOid: mr.headOid,
  baseOid: "b".repeat(40),
  nextPageToken: "",
  files: [],
  commits: [],
};

const humanApproval = {
  approver: { id: "human1", kind: "KIND_USER" },
  headOid: "b".repeat(40),
  createdAt: mr.createdAt,
};
const agentApproval = {
  ...humanApproval,
  approver: { id: "agent1", kind: "KIND_AGENT" },
};
const readiness = {
  headOid: mr.headOid,
  mergeability: "MERGEABILITY_CLEAN",
  countingApprovals: [humanApproval],
  ciWorkflows: [{ workflowId: "workflow1", runId: "run1", name: "Build" }],
  agentChecks: [{ attemptId: "attempt1", agentId: "agent1", agentName: "Review" }],
};
const responseLayer = (response: () => unknown) =>
  DepotCli.layer.pipe(
    Layer.provide(
      TestHost.layer({
        process: {
          run: (input) =>
            Effect.succeed(
              TestHost.processOutput(
                JSON.stringify(input.operation === "diff" ? emptyCodePage : response()),
              ),
            ),
        },
      }),
    ),
  );

it.effect.each(["merge", "squash"] as const)(
  "merges the exact MR with %s and returns the authoritative result without a branch lookup",
  (mergeMethod) => {
    const operations: string[] = [];
    return Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      const result = yield* provider.runAction({ ...reference, action: "merge", mergeMethod });
      assert.strictEqual(result.number, reference.number);
      assert.strictEqual(result.state, "merged");
      assert.strictEqual(result.mergedAt, mergedAt);
      assert.deepStrictEqual(operations, ["read", "merge"]);
      assert.deepStrictEqual(provider.capabilities.mergeMethods, ["merge", "squash"]);
    }).pipe(
      Effect.provide(
        DepotCli.layer.pipe(
          Layer.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  operations.push(input.operation);
                  if (input.operation === "read")
                    return Effect.succeed(
                      TestHost.processOutput(
                        JSON.stringify({
                          mergeRequest: {
                            ...mr,
                            state: "STATE_OPEN",
                            mergedAt: undefined,
                            baseOid: "b".repeat(40),
                          },
                        }),
                      ),
                    );
                  assert.deepStrictEqual(input.args, [
                    "mr",
                    "merge",
                    "--org",
                    "org1",
                    "--repo",
                    "repo1",
                    "--id",
                    reference.number,
                    "--expected-head-oid",
                    mr.headOid,
                    "--expected-base-ref",
                    "main",
                    ...(mergeMethod === "squash" ? ["--squash"] : []),
                    "--json",
                  ]);
                  return Effect.succeed(
                    TestHost.processOutput(
                      JSON.stringify({
                        mergeRequest: { ...mr, mergeCommitOid: "c".repeat(40) },
                      }),
                    ),
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

it.effect.each([
  "head branch moved",
  "base branch moved",
  "base branch changed",
  "unknown flag: --id",
] as const)("does not retry a Depot merge after %s", (stderr) => {
  const operations: string[] = [];
  return Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const error = yield* Effect.flip(provider.runAction({ ...reference, action: "merge" }));
    assert.include(error.detail, stderr.startsWith("unknown") ? "Upgrade" : "Refresh");
    assert.deepStrictEqual(operations, ["read", "merge"]);
  }).pipe(
    Effect.provide(
      DepotCli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                operations.push(input.operation);
                if (input.operation === "read")
                  return Effect.succeed(
                    TestHost.processOutput(
                      JSON.stringify({
                        mergeRequest: { ...mr, state: "STATE_OPEN", mergedAt: undefined },
                      }),
                    ),
                  );
                const failureKind = input.classifyFailure?.(stderr) ?? "command-failed";
                return Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    exitCode: 1,
                    detail: "Process exited with a non-zero status.",
                    failureKind,
                  }),
                );
              },
            },
          }),
        ),
      ),
    ),
  );
});

it.effect.each([
  { id: "mr_other" },
  { repositoryId: "other" },
  { headOid: "d".repeat(40) },
  { baseRef: "release" },
  { state: "STATE_OPEN" },
  { mergeCommitOid: undefined },
] as const)("rejects an unconfirmed or mismatched merge response %j", (changed) => {
  let reads = 0;
  return Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const error = yield* Effect.flip(provider.runAction({ ...reference, action: "merge" }));
    assert.include(error.detail, "confirm");
    assert.strictEqual(reads, 2);
  }).pipe(
    Effect.provide(
      responseLayer(() =>
        ++reads === 1
          ? { mergeRequest: { ...mr, state: "STATE_OPEN", mergedAt: undefined } }
          : { mergeRequest: { ...mr, mergeCommitOid: "c".repeat(40), ...changed } },
      ),
    ),
  );
});

it.effect.each([
  { state: "STATE_MERGED" },
  { state: "STATE_CLOSED" },
  { headBranchDeleted: true },
  { headOid: "" },
])("does not merge an unavailable head or finished MR %j", (changed) => {
  let calls = 0;
  return Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    yield* Effect.flip(provider.runAction({ ...reference, action: "merge" }));
    assert.strictEqual(calls, 1);
  }).pipe(
    Effect.provide(
      responseLayer(() => {
        calls++;
        return { mergeRequest: { ...mr, state: "STATE_OPEN", ...changed } };
      }),
    ),
  );
});

it.effect("refuses rebase and stack merges without reading or changing the MR", () =>
  Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    yield* Effect.flip(
      provider.runAction({ ...reference, action: "merge", mergeMethod: "rebase" }),
    );
    yield* Effect.flip(
      provider.runAction({ ...reference, action: "merge", stackNumber: "mr_other" }),
    );
  }).pipe(Effect.provide(responseLayer(() => assert.fail("unsupported merge reached Depot")))),
);

it.effect.each([
  ["PASSED", "success", "passing"],
  ["FINDINGS", "success", "passing"],
  ["FAILED", "failure", "failing"],
  ["RUNNING", "pending", "pending"],
  ["QUEUED", "pending", "pending"],
  ["CANCELLED", "cancelled", "failing"],
  ["UNSPECIFIED", "pending", "pending"],
  ["NEW_SERVER_STATE", "pending", "pending"],
] as const)(
  "maps Depot %s checks and authoritative approvals across detail, summary and refresh",
  ([state, status, checksState]) =>
    Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(reference);
      assert.strictEqual(detail.mergeability, "mergeable");
      assert.deepStrictEqual(
        detail.reviewers.map((actor) => actor.login),
        ["human1"],
      );
      assert.deepStrictEqual(
        detail.checks.map((check) => check.status),
        [status, status],
      );
      assert.strictEqual(detail.checks[0]?.url, "https://depot.dev/orgs/org1/workflows/workflow1");
      assert.strictEqual(
        detail.checks[1]?.url,
        "https://depot.dev/orgs/org1/agents/checks?agent=agent1&check=attempt1",
      );
      assert.include(detail.checks[1]?.description, "2 open findings");
      assert.isFalse(detail.checks.some((check) => check.required));
      const summary = yield* provider.getChangeRequestSummary(reference);
      assert.strictEqual(summary.checksState, checksState);
      assert.strictEqual(summary.reviewDecision, "approved");
      const refreshed = yield* provider.getChangeRequestChecks(reference);
      assert.deepStrictEqual(refreshed.checks, detail.checks);
    }).pipe(
      Effect.provide(
        responseLayer(() => ({
          mergeRequest: { ...mr, state: "STATE_OPEN", mergedAt: undefined },
          approvals: [humanApproval, agentApproval],
          readiness: {
            ...readiness,
            ciWorkflows: readiness.ciWorkflows.map((check) => ({
              ...check,
              state: `MERGE_REQUEST_CHECK_STATE_${state}`,
            })),
            agentChecks: readiness.agentChecks.map((check) => ({
              ...check,
              state: `MERGE_REQUEST_CHECK_STATE_${state}`,
              openFindings: 2,
            })),
          },
        })),
      ),
    ),
);

it.effect.each(["missing", "stale", "incomplete", "unavailable"] as const)(
  "does not report success from %s readiness",
  (mode) =>
    Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(reference);
      assert.isTrue(detail.checks.some((check) => check.placeholder && check.status === "pending"));
      const summary = yield* provider.getChangeRequestSummary(reference);
      assert.strictEqual(summary.checksState, "pending");
      if (mode === "missing" || mode === "stale") {
        assert.strictEqual(summary.mergeability, "unknown");
        assert.strictEqual(summary.reviewDecision, null);
        assert.isEmpty(detail.reviewers);
        assert.strictEqual(detail.checks.length, 1);
      }
    }).pipe(
      Effect.provide(
        responseLayer(() => ({
          mergeRequest: { ...mr, state: "STATE_OPEN", mergedAt: undefined },
          approvals: [humanApproval],
          readiness:
            mode === "missing"
              ? undefined
              : {
                  ...readiness,
                  headOid: mode === "stale" ? "c".repeat(40) : mr.headOid,
                  checksIncomplete: mode === "incomplete",
                  reasons: mode === "unavailable" ? [{ kind: "KIND_STATUSES_UNAVAILABLE" }] : [],
                  ciWorkflows: [
                    { ...readiness.ciWorkflows[0], state: "MERGE_REQUEST_CHECK_STATE_PASSED" },
                  ],
                  agentChecks: [],
                },
        })),
      ),
    ),
);

it.effect(
  "refreshes conflict and check standing across pushes and settles without inventing checks",
  () => {
    let response: unknown = {
      mergeRequest: { ...mr, state: "STATE_OPEN", mergedAt: undefined },
      readiness: {
        ...readiness,
        mergeability: "MERGEABILITY_CONFLICTING",
        checksIncomplete: true,
        ciWorkflows: [{ ...readiness.ciWorkflows[0], state: "MERGE_REQUEST_CHECK_STATE_FAILED" }],
        agentChecks: [],
      },
    };
    return Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      const failing = yield* provider.getChangeRequestSummary(reference);
      assert.strictEqual(failing.mergeability, "conflicting");
      assert.strictEqual(failing.checksState, "failing");
      const headOid = "d".repeat(40);
      response = {
        mergeRequest: { ...mr, headOid, state: "STATE_OPEN", mergedAt: undefined },
        readiness: { headOid, mergeability: "MERGEABILITY_CLEAN" },
      };
      const unchecked = yield* provider.getChangeRequestSummary(reference);
      assert.strictEqual(unchecked.headSha, headOid);
      assert.strictEqual(unchecked.checksState, null);
      assert.strictEqual(unchecked.reviewDecision, null);
      assert.strictEqual(unchecked.mergeability, "mergeable");
      assert.isEmpty((yield* provider.getChangeRequestChecks(reference)).checks);
      response = { mergeRequest: { ...mr, headOid } };
      const merged = yield* provider.getChangeRequestChecks(reference);
      assert.strictEqual(merged.state, "merged");
      assert.isEmpty(merged.checks);
    }).pipe(Effect.provide(responseLayer(() => response)));
  },
);

it.effect("keeps repository listing lightweight rather than reading readiness for every MR", () =>
  Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const page = yield* provider.listChangeRequests({
      ...reference,
      state: "open",
      involvement: "all",
      viewer: "@me",
      limit: 20,
    });
    assert.strictEqual(page.items[0]?.number, mr.id);
    assert.strictEqual(page.items[0]?.mergeability, "unknown");
  }).pipe(
    Effect.provide(
      DepotCli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                assert.strictEqual(input.args[1], "list");
                return Effect.succeed(
                  TestHost.processOutput(
                    JSON.stringify({ mergeRequests: [{ ...mr, state: "STATE_OPEN" }] }),
                  ),
                );
              },
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect(
  "preserves a native MR identity and merge time through CLI decoding and persisted thread links",
  () =>
    Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      const summary = yield* provider.getChangeRequestSummary(reference);
      const parsed = definition.parseChangeRequestUrl(new URL(summary.url));
      if (parsed === null) return assert.fail("Depot URL was not parsed");
      assert.strictEqual(parsed.number, reference.number);
      assert.strictEqual(parsed.repository, "org1/repo1");
      assert.strictEqual(summary.state, "merged");
      assert.strictEqual(summary.mergedAt, mergedAt);
      const persisted = Schema.fromJsonString(ThreadPullRequestLink);
      const link = yield* Schema.decodeEffect(persisted)(
        JSON.stringify({
          host: parsed.host,
          repository: parsed.repository,
          number: parsed.number,
          url: summary.url,
          source: "agent",
          linkedAt: mr.createdAt,
          stack: null,
          snapshot: { ...summary, syncedAt: mergedAt },
        }),
      );
      assert.strictEqual(link.number, reference.number);
      assert.strictEqual(link.snapshot?.mergedAt, mergedAt);
    }).pipe(
      Effect.provide(
        DepotCli.layer.pipe(
          Layer.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  assert.deepStrictEqual(input.args, [
                    "mr",
                    "view",
                    "--org",
                    "org1",
                    "--repo",
                    "repo1",
                    "--id",
                    reference.number,
                    "--json",
                  ]);
                  return Effect.succeed(
                    TestHost.processOutput(JSON.stringify({ mergeRequest: mr })),
                  );
                },
              },
            }),
          ),
        ),
      ),
    ),
);

it.effect("refuses a mismatched repository response instead of settling a different MR", () =>
  Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const result = yield* provider.getChangeRequestSummary(reference).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
  }).pipe(
    Effect.provide(
      DepotCli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: () =>
                Effect.succeed(
                  TestHost.processOutput(
                    JSON.stringify({ mergeRequest: { ...mr, repositoryId: "other" } }),
                  ),
                ),
            },
          }),
        ),
      ),
    ),
  ),
);

it("recognizes Depot MR URLs without accepting lookalike hosts or losing the query ID", () => {
  const url = definition.changeRequestUrl(reference)!;
  assert.strictEqual(
    url,
    "https://depot.dev/orgs/org1/code/repositories/repo1/merge-requests?id=mr_c3d35jx9wn",
  );
  assert.strictEqual(
    definition.parseChangeRequestUrl(new URL(url.replace("depot.dev", "depot.dev.evil.test"))),
    null,
  );
  assert.strictEqual(
    definition.parseChangeRequestUrl(new URL(url.replace("?id=mr_c3d35jx9wn", ""))),
    null,
  );
  assert.strictEqual(
    definition.parseChangeRequestUrl(new URL(`${url}&tab=files`))?.number,
    reference.number,
  );
});

it.effect("closes and reopens the requested MR by ID without resolving its branch", () => {
  let state = "STATE_OPEN";
  return Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const closed = yield* provider.runAction({ ...reference, action: "close" });
    assert.strictEqual(closed.state, "closed");
    const reopened = yield* provider.runAction({ ...reference, action: "reopen" });
    assert.strictEqual(reopened.state, "open");
    assert.strictEqual(reopened.number, reference.number);
  }).pipe(
    Effect.provide(
      DepotCli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                assert.deepStrictEqual(input.args.slice(2), [
                  "--org",
                  "org1",
                  "--repo",
                  "repo1",
                  "--id",
                  reference.number,
                  "--json",
                ]);
                if (input.args[1] === "close") state = "STATE_CLOSED";
                if (input.args[1] === "reopen") state = "STATE_OPEN";
                return Effect.succeed(
                  TestHost.processOutput(
                    JSON.stringify({ mergeRequest: { ...mr, state, mergedAt: undefined } }),
                  ),
                );
              },
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("keeps review comments on their file and rejects replies to another MR's thread", () =>
  Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const activity = yield* provider.getChangeRequestActivity(reference);
    assert.deepInclude(activity.reviewThreads?.[0]?.comments[0], {
      id: "mrc_review1",
      canEdit: true,
      kind: "review-comment",
      path: "app.ts",
    });
    assert.strictEqual(activity.reviewThreads?.[0]?.side, "left");
    const result = yield* provider
      .replyToThread({ ...reference, threadId: "mrc_other", body: "Reply" })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
  }).pipe(
    Effect.provide(
      DepotCli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                assert.include(["view", "threads", "commits"], input.args[1]);
                if (input.operation === "commits")
                  return Effect.succeed(TestHost.processOutput(JSON.stringify(emptyCodePage)));
                const data =
                  input.args[1] === "view"
                    ? { mergeRequest: mr }
                    : {
                        mergeRequestId: mr.id,
                        comments: [],
                        threads: [
                          {
                            id: "mrc_review1",
                            path: "app.ts",
                            side: "old",
                            startLine: 1,
                            endLine: 1,
                            resolved: false,
                            outdated: false,
                            comments: [
                              {
                                id: "mrc_review1",
                                body: "Review",
                                createdAt: mr.createdAt,
                                canEdit: true,
                              },
                            ],
                          },
                        ],
                      };
                return Effect.succeed(TestHost.processOutput(JSON.stringify(data)));
              },
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect(
  "approves the displayed revision and can withdraw it without retargeting to a newer head",
  () => {
    const operations: string[] = [];
    let approved = false;
    return Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      assert.deepStrictEqual(provider.capabilities.review.verdicts, ["comment", "approve"]);
      yield* provider.submitReview({
        ...reference,
        verdict: "approve",
        body: "",
        comments: [],
        expectedHeadOid: mr.headOid,
      });
      assert.isTrue(approved);
      yield* provider.runAction({ ...reference, action: "withdraw-approval" });
      assert.isFalse(approved);
      assert.deepStrictEqual(operations, ["approve", "approve", "read"]);
    }).pipe(
      Effect.provide(
        DepotCli.layer.pipe(
          Layer.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  operations.push(input.operation);
                  if (input.operation === "read")
                    return Effect.succeed(
                      TestHost.processOutput(JSON.stringify({ mergeRequest: mr })),
                    );
                  const withdrawing = input.args.includes("--withdraw");
                  assert.deepStrictEqual(input.args, [
                    "mr",
                    "approve",
                    "--org",
                    "org1",
                    "--repo",
                    "repo1",
                    "--id",
                    reference.number,
                    ...(withdrawing ? ["--withdraw"] : ["--expected-head-oid", mr.headOid]),
                    "--json",
                  ]);
                  approved = !withdrawing;
                  return Effect.succeed(
                    TestHost.processOutput(
                      JSON.stringify(
                        withdrawing
                          ? {}
                          : { approval: { mergeRequestId: mr.id, headOid: mr.headOid } },
                      ),
                    ),
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

it.effect.each([
  "The merge request head moved",
  "unknown flag: --expected-head-oid",
  "this server does not support guarded approvals",
])("does not retry approval after %s", (stderr) => {
  let calls = 0;
  return Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const error = yield* Effect.flip(
      provider.submitReview({
        ...reference,
        verdict: "approve",
        body: "",
        comments: [],
        expectedHeadOid: mr.headOid,
      }),
    );
    assert.include(
      error.detail,
      stderr.startsWith("unknown")
        ? "Upgrade"
        : stderr.includes("moved")
          ? "Refresh"
          : "does not support guarded approvals",
    );
    assert.strictEqual(calls, 1);
  }).pipe(
    Effect.provide(
      DepotCli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                calls++;
                return Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    exitCode: 1,
                    detail: stderr,
                    failureKind: input.classifyFailure?.(stderr) ?? "command-failed",
                  }),
                );
              },
            },
          }),
        ),
      ),
    ),
  );
});

it.effect(
  "refuses unpinned or unsupported reviews before calling Depot and rejects a different approval result",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      const input = {
        ...reference,
        verdict: "approve" as const,
        body: "",
        comments: [],
        expectedHeadOid: mr.headOid,
      };
      for (const invalid of [
        { ...input, expectedHeadOid: "" },
        { ...input, expectedHeadOid: "abc" },
        { ...input, verdict: "request-changes" as const, body: "Please fix this" },
      ]) {
        const result = yield* Effect.flip(provider.submitReview(invalid));
        assert.strictEqual(result.reason, "failed");
      }
      assert.strictEqual(calls, 0);
      const result = yield* Effect.flip(provider.submitReview(input));
      assert.strictEqual(calls, 1);
      assert.include(result.detail, "did not confirm");
    }).pipe(
      Effect.provide(
        DepotCli.layer.pipe(
          Layer.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  calls++;
                  assert.strictEqual(input.operation, "approve");
                  assert.include(input.args, mr.headOid);
                  return Effect.succeed(
                    TestHost.processOutput(
                      JSON.stringify({
                        approval: { mergeRequestId: mr.id, headOid: "b".repeat(40) },
                      }),
                    ),
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

it.effect.each(["old", "new"] as const)(
  "posts a %s-side range at its original revision, and keeps editing scoped to its MR",
  (side) => {
    const baseOid = "b".repeat(40);
    let saved = "";
    return Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      yield* provider.submitReview({
        ...reference,
        verdict: "comment",
        body: "",
        comments: [
          {
            path: "new.ts",
            oldPath: "old.ts",
            body: "Review this range\n",
            position:
              side === "old" ? { kind: "deleted", oldLine: 7 } : { kind: "added", newLine: 7 },
            startPosition:
              side === "old" ? { kind: "deleted", oldLine: 3 } : { kind: "added", newLine: 3 },
            reviewRevision: { headOid: mr.headOid, baseOid },
          },
        ],
      });
      assert.strictEqual(saved, "Review this range\n");
      yield* provider.updateComment({
        ...reference,
        commentId: "mrc_own",
        kind: "review-comment",
        body: "Edited",
      });
      assert.strictEqual(saved, "Edited");
      const error = yield* Effect.flip(
        provider.updateComment({
          ...reference,
          commentId: "mrc_elsewhere",
          kind: "review-comment",
          body: "Wrong MR",
        }),
      );
      assert.include(error.detail, "does not belong");
      assert.strictEqual(saved, "Edited");
    }).pipe(
      Effect.provide(
        DepotCli.layer.pipe(
          Layer.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  if (input.operation === "threads")
                    return Effect.succeed(
                      TestHost.processOutput(
                        JSON.stringify({
                          mergeRequestId: mr.id,
                          comments: [],
                          threads: [
                            {
                              id: "mrc_own",
                              path: "new.ts",
                              side,
                              startLine: 3,
                              endLine: 7,
                              resolved: false,
                              outdated: false,
                              comments: [
                                {
                                  id: "mrc_own",
                                  body: saved,
                                  createdAt: mr.createdAt,
                                  canEdit: true,
                                },
                              ],
                            },
                          ],
                        }),
                      ),
                    );
                  assert.include(["comment", "edit-comment"], input.operation);
                  assert.include(input.args, reference.number);
                  assert.include(input.args, "--body-file");
                  if (input.operation === "comment") {
                    for (const [flag, value] of [
                      ["--head-oid", mr.headOid],
                      ["--base-oid", baseOid],
                      ["--path", side === "old" ? "old.ts" : "new.ts"],
                      ["--side", side],
                      ["--line", "7"],
                      ["--start-line", "3"],
                    ])
                      assert.strictEqual(input.args[input.args.indexOf(flag!) + 1], value);
                  }
                  saved = input.stdin ?? "";
                  return Effect.succeed(TestHost.processOutput("{}"));
                },
              },
            }),
          ),
        ),
      ),
    );
  },
);

it.effect("refuses unpinned, cross-side and batch comments before any write", () =>
  Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const draft = {
      path: "a.ts",
      body: "Feedback",
      position: { kind: "added" as const, newLine: 4 },
      reviewRevision: { headOid: mr.headOid, baseOid: "b".repeat(40) },
    };
    for (const comments of [
      [{ ...draft, reviewRevision: undefined }],
      [{ ...draft, startPosition: { kind: "deleted" as const, oldLine: 1 } }],
      [draft, draft],
    ]) {
      yield* Effect.flip(
        provider.submitReview({ ...reference, verdict: "comment", body: "", comments }),
      );
    }
  }).pipe(Effect.provide(responseLayer(() => assert.fail("invalid comment reached Depot")))),
);

it.effect.each([
  "The merge request changed since this diff was loaded",
  "permission_denied: Only the author can change a comment",
])("preserves %s without retrying or retargeting", (stderr) => {
  let calls = 0;
  return Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const failure = yield* Effect.flip(
      provider.submitReview({
        ...reference,
        verdict: "comment",
        body: "",
        comments: [
          {
            path: "a.ts",
            position: { kind: "added", newLine: 1 },
            body: "Feedback",
            reviewRevision: { headOid: mr.headOid, baseOid: "b".repeat(40) },
          },
        ],
      }),
    );
    assert.include(failure.detail, stderr.startsWith("permission") ? "author" : "Refresh");
    assert.strictEqual(calls, 1);
  }).pipe(
    Effect.provide(
      DepotCli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                calls++;
                return Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    exitCode: 1,
                    detail: stderr,
                    failureKind: input.classifyFailure?.(stderr) ?? "command-failed",
                  }),
                );
              },
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("uses server permissions and denies unreported permissions on older servers", () =>
  Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const permissions = yield* provider.getViewerPermissions(reference);
    assert.isEmpty(permissions.actions);
    assert.isFalse(permissions.comment);
    assert.isFalse(permissions.resolve);
    assert.isEmpty(permissions.verdicts);
    assert.isFalse(permissions.editChangeRequest);
    const detail = yield* provider.getChangeRequest(reference);
    assert.deepStrictEqual(detail.viewerPermissions, permissions);
  }).pipe(Effect.provide(responseLayer(() => ({ mergeRequest: mr })))),
);

it.effect("projects granted actions without enabling unsupported or denied operations", () =>
  Effect.gen(function* () {
    const provider = yield* DepotPullRequestProvider.make;
    const permissions = yield* provider.getViewerPermissions(reference);
    assert.deepStrictEqual(permissions.actions, ["close", "withdraw-approval"]);
    assert.deepStrictEqual(permissions.verdicts, ["comment", "approve"]);
    assert.isTrue(permissions.comment);
    assert.isFalse(permissions.resolve);
    assert.isFalse(permissions.editChangeRequest);
  }).pipe(
    Effect.provide(
      responseLayer(() => ({
        mergeRequest: mr,
        viewerPermissions: {
          canComment: true,
          canClose: true,
          canApprove: true,
          canWithdrawApproval: true,
        },
      })),
    ),
  ),
);

it.effect(
  "reads a stable viewer ID after organization switches and rejects mismatched identity",
  () => {
    let org = "org1";
    let responseOrg = "org1";
    return Effect.gen(function* () {
      const provider = yield* DepotPullRequestProvider.make;
      assert.strictEqual(yield* provider.getViewer({ cwd: "/repo", host: "depot.dev" }), "user1");
      org = responseOrg = "org2";
      assert.strictEqual(yield* provider.getViewer({ cwd: "/repo", host: "depot.dev" }), "user1");
      responseOrg = "org1";
      const error = yield* Effect.flip(provider.getViewer({ cwd: "/repo", host: "depot.dev" }));
      assert.include(error.detail, "different organization");
    }).pipe(
      Effect.provide(
        DepotCli.layer.pipe(
          Layer.provide(
            TestHost.layer({
              process: {
                run: (input) =>
                  Effect.sync(() => {
                    if (input.operation === "organization") return TestHost.processOutput(org);
                    assert.deepStrictEqual(input.args, ["mr", "viewer", "--org", org, "--json"]);
                    return TestHost.processOutput(
                      JSON.stringify({
                        orgId: responseOrg,
                        viewer: { id: "user1", kind: "KIND_USER", displayName: "Person" },
                      }),
                    );
                  }),
              },
            }),
          ),
        ),
      ),
    );
  },
);
