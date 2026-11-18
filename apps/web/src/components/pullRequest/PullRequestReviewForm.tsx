import { submitPullRequestReview } from "@t3tools/client-runtime/submit-pull-request-review";
import { useAtomCommand } from "~/state/use-atom-command";
import { capitalizeTerm } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentId, PullRequestRef, PullRequestReviewVerdict } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";

const VERDICTS: ReadonlyArray<{
  readonly value: PullRequestReviewVerdict;
  readonly label: string;
  readonly sent: (term: string) => string;
  readonly icon: ReactNode;
}> = [
  {
    value: "comment",
    label: "Comment",
    sent: () => "Review submitted",
    icon: <MessageSquareIcon className="size-3" />,
  },
  {
    value: "approve",
    label: "Approve",
    sent: (term) => `${capitalizeTerm(term)} approved`,
    icon: <CheckIcon className="size-3" />,
  },
  {
    value: "request-changes",
    label: "Request changes",
    sent: () => "Changes requested",
    icon: <XCircleIcon className="size-3" />,
  },
];

export function PullRequestReviewForm({
  environmentId,
  active,
  reference,
  headOid,
  summarySupported = true,
  batchSupported = true,
  completionScope,
  term,
  verdicts,
  requestChangesSummaryRequired,
  textareaRef,
  pending,
  onPendingChange,
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  /** False while the form stays mounted but hidden; dictation is cancelled then. */
  active: boolean;
  reference: PullRequestRef;
  headOid: string;
  summarySupported?: boolean;
  batchSupported?: boolean;
  completionScope: PullRequestCompletionScope | null;
  /** The host's word for a change request, as in "pull request". */
  term: string;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  requestChangesSummaryRequired: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onSubmitted: () => void;
}) {
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const comments = usePendingReviewComments(reference);
  const reviewKey = pullRequestReviewKey(reference);
  const body = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const removeComments = usePullRequestReviewStore((store) => store.removeComments);
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const speech = useTextFieldSpeech({
    environmentId,
    projectId: reference.projectId,
    ownerKey: JSON.stringify(["pr-review", environmentId, reviewKey]),
    text: body,
    textareaRef,
    onTextChange: (text) => setSummary(reviewKey, text),
    disabled: !active || pending || !summarySupported,
  });
  const { cancel } = speech;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards a recording when the hidden form can no longer be submitted
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const offered = VERDICTS.filter((verdict) => verdicts.includes(verdict.value));
  const selectedVerdict =
    offered.find((verdict) => verdict.value === requestedVerdict) ?? offered[0];

  const submit = async (verdict: (typeof VERDICTS)[number], text: string) => {
    const submittedComments = usePullRequestReviewStore.getState().drafts[reviewKey] ?? [];
    if (pending || !canSubmit(verdict.value, text, submittedComments.length)) return;
    const submittedBody = text;
    onPendingChange(true);
    try {
      await submitPullRequestReview({
        review: {
          verdict: verdict.value,
          body: summarySupported ? submittedBody : "",
          comments: submittedComments,
        },
        batch: batchSupported,
        submit: async (review) => {
          const result = await submitReview({
            environmentId,
            input: {
              ...reference,
              expectedHeadOid: headOid,
              ...review,
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
        onSubmitted: (review) => {
          removeComments(
            reviewKey,
            review.comments.map((comment) => comment.id),
          );
          if (summarySupported && review.body) clearSummary(reviewKey, review.body);
        },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "The review could not be submitted",
        description: readableFailure(
          error,
          "The host refused the review. Unsent feedback is still here to try again.",
        ),
      });
      onPendingChange(false);
      return;
    }
    onPendingChange(false);
    toastManager.add({ type: "success", title: verdict.sent(term) });
    onSubmitted();
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  const canSubmit = (verdict: PullRequestReviewVerdict, summary: string, commentCount: number) =>
    verdict === "request-changes" && requestChangesSummaryRequired
      ? summary.trim().length > 0
      : verdict === "approve" || summary.trim().length > 0 || commentCount > 0;
  const placeholder =
    selectedVerdict === undefined || canSubmit(selectedVerdict.value, "", comments.length)
      ? "Summarize your review (optional)"
      : selectedVerdict.value === "request-changes" && requestChangesSummaryRequired
        ? "Summarize your review (required to request changes)"
        : "Summarize your review or add line comments";

  return (
    <>
      {summarySupported ? (
        <PullRequestMarkdownTextarea
          ref={textareaRef}
          completionScope={completionScope}
          rows={3}
          readOnly={speech.freezesEditor}
          value={body}
          placeholder={placeholder}
          aria-label="Review summary"
          onValueChange={(next) => setSummary(reviewKey, next)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
            if (
              selectedVerdict !== undefined &&
              isCommentSubmitShortcut(event, body, pending || speech.preparing, true)
            ) {
              event.preventDefault();
              event.stopPropagation();
              speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
            }
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Approve revision {headOid.slice(0, 7)}.</p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {summarySupported ? <TextFieldSpeechControls speech={speech} disabled={pending} /> : null}
        {offered.length > 1 ? (
          <Select
            value={selectedVerdict?.value ?? null}
            disabled={pending}
            onValueChange={(value) => {
              if (value !== null) setRequestedVerdict(value);
            }}
          >
            <SelectTrigger size="xs" className="w-auto min-w-0" aria-label="Review verdict">
              <span className="flex items-center gap-1.5">
                {selectedVerdict?.icon}
                {selectedVerdict?.label}
              </span>
            </SelectTrigger>
            <SelectPopup side="top" alignItemWithTrigger={false}>
              {offered.map((verdict) => (
                <SelectItem key={verdict.value} value={verdict.value}>
                  <span className="flex items-center gap-1.5">
                    {verdict.icon}
                    {verdict.label}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Button
          size="xs"
          disabled={
            speech.preparing ||
            pending ||
            selectedVerdict === undefined ||
            (!canSubmit(selectedVerdict.value, body, comments.length) && !speech.blocksSubmission)
          }
          onClick={() => {
            if (selectedVerdict === undefined) return;
            if (summarySupported)
              speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
            else void submit(selectedVerdict, "");
          }}
        >
          {pending ? "Submitting..." : "Submit review"}
        </Button>
      </div>
    </>
  );
}
