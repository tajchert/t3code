import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";

interface ThreadShellLookup {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Pick<OrchestrationV2ThreadShell, "id" | "title" | "lineage"> | null,
    ProjectionStoreV2Error
  >;
}

const MAX_SENDER_TITLE_CHARS = 120;

/**
 * Heads a message another thread's agent sent, so the receiving agent knows who wrote it and
 * where to reply. The orchestration instructions name this exact opening.
 */
function withThreadMessageSender(
  text: string,
  sender: { readonly threadId: ThreadId; readonly title: string },
): string {
  const title =
    sender.title.replace(/\s+/g, " ").trim().slice(0, MAX_SENDER_TITLE_CHARS) || "Untitled";
  return `[Message from the agent in thread ${JSON.stringify(title)} (threadId: ${sender.threadId}). Answer it with t3_thread_send to that threadId.]\n\n${text}`;
}

/**
 * The provider text for a turn's message, headed with its sender when another thread's agent
 * sent it. A delegating parent is left out: its child already reports back through the task.
 */
export const providerTextWithThreadMessageSender = Effect.fn(
  "ThreadMessageSender.providerTextWithThreadMessageSender",
)(
  function* (
    projections: ThreadShellLookup,
    input: {
      readonly threadId: ThreadId;
      readonly message: Pick<
        OrchestrationV2ConversationMessage,
        "role" | "senderThreadId" | "notification"
      >;
      readonly text: string;
    },
  ) {
    const senderThreadId = input.message.senderThreadId;
    if (
      senderThreadId === undefined ||
      // Native slash commands must remain at the start of the prompt.
      input.text.trimStart().startsWith("/") ||
      senderThreadId === input.threadId ||
      input.message.role !== "user" ||
      input.message.notification !== undefined
    ) {
      return input.text;
    }
    const [receiver, sender] = yield* Effect.all([
      projections.getThreadShell(input.threadId),
      projections.getThreadShell(senderThreadId),
    ]);
    if (sender === null || receiver?.lineage.parentThreadId === senderThreadId) return input.text;
    return withThreadMessageSender(input.text, { threadId: sender.id, title: sender.title });
  },
  // Attribution is a hint; a failed lookup must never block the turn.
  (effect, _projections, input) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not attribute a thread message to its sender", error).pipe(
          Effect.as(input.text),
        ),
      ),
    ),
);
