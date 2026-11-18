import { describe, expect, it } from "vite-plus/test";
import { submitPullRequestReview } from "./submitPullRequestReview.ts";

describe("submitPullRequestReview", () => {
  it("retires only posted drafts and stops before approval when a later comment fails", async () => {
    const comments = ["first", "second"].map((body) => ({
      path: "a.ts",
      position: { kind: "added" as const, newLine: 1 },
      body,
    }));
    const sent: string[] = [];
    let remaining = comments;
    const send = () =>
      submitPullRequestReview({
        review: { verdict: "approve", body: "Summary", comments: remaining },
        batch: false,
        submit: async (step) => {
          const body = step.comments[0]?.body ?? (step.body || step.verdict);
          if (body === "second" && !sent.includes("retry")) throw new Error("head moved");
          sent.push(body);
        },
        onSubmitted: (step) => {
          remaining = remaining.filter((comment) => !step.comments.includes(comment));
        },
      });
    await expect(send()).rejects.toThrow("head moved");
    expect(sent).toEqual(["first"]);
    expect(remaining.map((comment) => comment.body)).toEqual(["second"]);
    sent.push("retry");
    await send();
    expect(sent).toEqual(["first", "retry", "second", "Summary", "approve"]);
    expect(remaining).toEqual([]);
  });

  it("keeps an atomic review together and retains its drafts when submission fails", async () => {
    const review = {
      verdict: "approve" as const,
      body: "Summary",
      comments: [
        { path: "a.ts", position: { kind: "added" as const, newLine: 2 }, body: "Feedback" },
      ],
    };
    let retired = false;
    await expect(
      submitPullRequestReview({
        review,
        batch: true,
        submit: async (step) => {
          expect(step).toEqual(review);
          throw new Error("refused");
        },
        onSubmitted: () => {
          retired = true;
        },
      }),
    ).rejects.toThrow("refused");
    expect(retired).toBe(false);
  });
});
