import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, type PullRequestCommit } from "@t3tools/contracts";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
import { isMergeRequestId } from "../shared/definition.ts";
import * as DepotCli from "./DepotCli.ts";

type Reference = Parameters<PullRequestProviderApi["getDiff"]>[0];
const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const Envelope = {
  mergeRequestId: Schema.String,
  repositoryId: Schema.String,
  headOid: Revision,
  baseOid: Schema.String,
};
const File = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["added", "deleted", "modified", "type_changed"]),
  oldOid: Schema.String,
  newOid: Schema.String,
  contentKind: Schema.Literals(["text", "binary", "gitlink", "too_large", "unread"]),
  additions: Schema.NullOr(Schema.Number),
  deletions: Schema.NullOr(Schema.Number),
  patch: Schema.optional(Schema.String),
});
const Diff = Schema.Struct({
  anchorBaseOid: Schema.optional(Schema.String),
  ...Envelope,
  files: Schema.Array(File),
  nextPageToken: Schema.String,
});
const Commits = Schema.Struct({
  ...Envelope,
  commits: Schema.Array(
    Schema.Struct({
      oid: Revision,
      message: Schema.String,
      authorName: Schema.String,
      authorEmail: Schema.String,
      committedDate: Schema.NullOr(IsoDateTime),
    }),
  ),
  nextPageToken: Schema.String,
});
const Contents = Schema.Struct({
  ...Envelope,
  path: Schema.String,
  oldContents: Schema.String,
  newContents: Schema.String,
});

export const make = Effect.gen(function* () {
  const cli = yield* DepotCli.DepotCli;
  const read = Effect.fn("DepotCodeReads.read")(function* <S extends Schema.Top>(
    input: Reference,
    command: string,
    args: ReadonlyArray<string>,
    schema: S,
  ) {
    if (!isMergeRequestId(input.number))
      return yield* DepotCli.failure(command, "Specify a Depot merge request ID.");
    const scope = yield* cli.scope(input);
    return yield* cli.run(
      {
        cwd: input.cwd,
        operation: command,
        args: ["mr", command, ...scope.args, "--id", String(input.number), "--json", ...args],
      },
      schema,
    );
  });
  const validate = Effect.fn("DepotCodeReads.validate")(function* (
    input: Reference,
    page: typeof Diff.Type | typeof Commits.Type | typeof Contents.Type,
    previous?: { readonly headOid: string; readonly baseOid: string },
  ) {
    if (
      page.mergeRequestId !== input.number ||
      page.repositoryId !== input.repository.split("/")[1] ||
      (input.commit && page.headOid !== input.commit) ||
      (previous && (previous.headOid !== page.headOid || previous.baseOid !== page.baseOid))
    )
      return yield* DepotCli.failure(
        "diff",
        "The merge request comparison changed. Refresh and try again.",
      );
  });
  const diffPage = Effect.fn("DepotCodeReads.diffPage")(function* (
    input: Reference,
    namesOnly = false,
    context = 3,
  ) {
    const page = yield* read(
      input,
      "diff",
      [
        ...(input.cursor ? ["--page-token", input.cursor] : []),
        ...(input.commit ? ["--commit", input.commit] : []),
        ...(input.path ? ["--path", input.path] : []),
        ...(namesOnly
          ? ["--name-only"]
          : context === 0
            ? ["--stat"]
            : ["--context", String(context)]),
      ],
      Diff,
    );
    yield* validate(input, page);
    if (
      (!input.commit && !page.baseOid) ||
      (!namesOnly &&
        context > 0 &&
        page.files.some((file) => !file.patch || file.contentKind === "unread"))
    )
      return yield* DepotCli.failure("diff", "Depot returned an incomplete diff response.");
    return page;
  });
  const allFiles = Effect.fn("DepotCodeReads.allFiles")(function* (input: Reference) {
    const files: Array<typeof File.Type> = [];
    let previous: typeof Diff.Type | undefined;
    const tokens = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = yield* diffPage({ ...input, cursor }, false, 0);
      yield* validate(input, page, previous);
      files.push(...page.files);
      cursor = page.nextPageToken || undefined;
      if (cursor && tokens.has(cursor))
        return yield* DepotCli.failure(
          "diff",
          "Depot repeated a diff page; results are incomplete.",
        );
      if (cursor) tokens.add(cursor);
      previous = page;
    } while (cursor);
    return { files, headOid: previous!.headOid };
  });
  const stats = Effect.fn("DepotCodeReads.stats")(function* (input: Reference) {
    const page = yield* allFiles(input);
    return {
      headOid: page.headOid,
      additions: page.files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: page.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      changedFiles: page.files.length,
      statsIncomplete: page.files.some((f) => f.contentKind === "too_large"),
    };
  });
  const commits = Effect.fn("DepotCodeReads.commits")(function* (input: Reference) {
    const commits: PullRequestCommit[] = [];
    let previous: typeof Commits.Type | undefined;
    const tokens = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = yield* read(input, "commits", cursor ? ["--page-token", cursor] : [], Commits);
      yield* validate(input, page, previous);
      for (const commit of page.commits) {
        if (!commit.committedDate)
          return yield* DepotCli.failure(
            "commits",
            "Depot returned a commit without a valid timestamp.",
          );
        commits.push({
          oid: commit.oid,
          messageHeadline: commit.message.split("\n")[0] || "(no commit message)",
          committedDate: commit.committedDate,
          authors: [
            {
              login: commit.authorEmail || commit.authorName || "unknown",
              name: commit.authorName || null,
              avatarUrl: null,
            },
          ],
        });
      }
      cursor = page.nextPageToken || undefined;
      if (cursor && tokens.has(cursor))
        return yield* DepotCli.failure(
          "commits",
          "Depot repeated a history page; results are incomplete.",
        );
      if (cursor) tokens.add(cursor);
      previous = page;
    } while (cursor);
    return commits;
  });
  const getDiff: PullRequestProviderApi["getDiff"] = Effect.fn("DepotCodeReads.getDiff")(
    function* (input) {
      const page = yield* diffPage(input);
      const withheld = page.files.filter((file) => file.contentKind === "too_large");
      return {
        ...(input.commit || page.anchorBaseOid === undefined
          ? {}
          : { reviewRevision: { headOid: page.headOid, baseOid: page.anchorBaseOid } }),
        patch: page.files.map((file) => file.patch ?? "").join(""),
        truncated: withheld.length > 0,
        nextCursor: page.nextPageToken || null,
        omittedFileStats: withheld.map((file) => ({
          path: file.path,
          additions: 0,
          deletions: 0,
          statsIncomplete: true,
        })),
        withheldFilesReadable: false,
      };
    },
  );
  const getDiffFilePaths: NonNullable<PullRequestProviderApi["getDiffFilePaths"]> = Effect.fn(
    "DepotCodeReads.getDiffFilePaths",
  )(function* (input) {
    const page = yield* diffPage(input, true);
    return {
      files: page.files.map((f) => ({
        oldPath: f.kind === "added" ? "/dev/null" : f.path,
        newPath: f.kind === "deleted" ? "/dev/null" : f.path,
      })),
      nextCursor: page.nextPageToken || null,
    };
  });
  const getDiffFileContents: NonNullable<PullRequestProviderApi["getDiffFileContents"]> = Effect.fn(
    "DepotCodeReads.getDiffFileContents",
  )(function* (input) {
    const path = input.changeType === "deleted" ? input.oldPath : input.newPath;
    const page = yield* read(
      input,
      "file",
      ["--path", path, ...(input.commit ? ["--commit", input.commit] : [])],
      Contents,
    );
    yield* validate(input, page);
    if (page.path !== path)
      return yield* DepotCli.failure("file", "Depot returned a different file.");
    return yield* Effect.try({
      try: () => {
        const decode = (value: string) => {
          const bytes = Buffer.from(value, "base64");
          if (bytes.toString("base64") !== value || bytes.includes(0))
            throw new Error("Invalid text contents");
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        };
        return { oldContents: decode(page.oldContents), newContents: decode(page.newContents) };
      },
      catch: () =>
        DepotCli.failure(
          "file",
          "This file contains binary or non-UTF-8 data and cannot be displayed as text.",
        ),
    });
  });
  const getFileStats: NonNullable<PullRequestProviderApi["getFileStats"]> = Effect.fn(
    "DepotCodeReads.getFileStats",
  )(function* (input) {
    const { files } = yield* allFiles(input);
    return {
      files: files.map((f) => ({
        path: f.path,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      })),
      truncated: files.some((f) => f.contentKind === "too_large"),
    };
  });
  return { stats, commits, getDiff, getDiffFilePaths, getDiffFileContents, getFileStats };
});
