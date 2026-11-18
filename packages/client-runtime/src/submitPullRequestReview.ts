import type { PullRequestReviewCommentDraft, PullRequestReviewVerdict } from "@t3tools/contracts";

type Review<C> = {
  readonly verdict: PullRequestReviewVerdict;
  readonly body: string;
  readonly comments: readonly C[];
};

/** Hosts without batch reviews commit each comment independently; retire drafts after each success. */
export async function submitPullRequestReview<C extends PullRequestReviewCommentDraft>(input: {
  readonly review: Review<C>;
  readonly batch: boolean;
  readonly submit: (review: Review<C>) => Promise<void>;
  readonly onSubmitted: (review: Review<C>) => void | Promise<void>;
}) {
  const { review } = input;
  const steps: Review<C>[] = input.batch
    ? [review]
    : [
        ...review.comments.map((comment) => ({
          verdict: "comment" as const,
          body: "",
          comments: [comment],
        })),
        ...(review.body.trim()
          ? [{ verdict: "comment" as const, body: review.body, comments: [] }]
          : []),
        ...(review.verdict === "comment"
          ? []
          : [{ verdict: review.verdict, body: "", comments: [] }]),
      ];
  for (const step of steps) {
    await input.submit(step);
    await input.onSubmitted(step);
  }
}
