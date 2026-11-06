import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectionStore from "./ProjectionStore.ts";
import { providerTextWithThreadMessageSender } from "./ThreadMessageSender.ts";

const backend = ThreadId.make("thread:backend");
const frontend = ThreadId.make("thread:frontend");
const child = ThreadId.make("thread:frontend-child");
const missing = ThreadId.make("thread:missing");

const shells = new Map([
  [backend, { id: backend, title: "Backend\nAPI", parent: null }],
  [frontend, { id: frontend, title: "Frontend", parent: null }],
  [child, { id: child, title: "Child task", parent: frontend }],
]);

const projections = {
  getThreadShell: (threadId: ThreadId) => {
    const shell = shells.get(threadId);
    return Effect.succeed(
      shell === undefined
        ? null
        : {
            id: shell.id,
            title: shell.title,
            lineage: {
              parentThreadId: shell.parent,
              relationshipToParent: shell.parent === null ? null : ("subagent" as const),
              rootThreadId: shell.parent ?? shell.id,
            },
          },
    );
  },
};

const providerText = (input: {
  readonly threadId: ThreadId;
  readonly senderThreadId?: ThreadId;
  readonly role?: "user" | "assistant";
  readonly text?: string;
}) =>
  providerTextWithThreadMessageSender(projections, {
    threadId: input.threadId,
    message: {
      role: input.role ?? "user",
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
    },
    text: input.text ?? "Which fields does /users return?",
  });

describe("providerTextWithThreadMessageSender", () => {
  it.effect("heads a message from another thread's agent with that thread", () =>
    Effect.gen(function* () {
      expect(yield* providerText({ threadId: backend, senderThreadId: frontend })).toBe(
        '[Message from the agent in thread "Frontend" (threadId: thread:frontend). Answer it with t3_thread_send to that threadId.]\n\nWhich fields does /users return?',
      );
      // A child reporting to its parent is still a peer message.
      expect(yield* providerText({ threadId: frontend, senderThreadId: child })).toContain(
        '"Child task" (threadId: thread:frontend-child)',
      );
      expect(yield* providerText({ threadId: frontend, senderThreadId: backend })).toContain(
        '"Backend API"',
      );
    }),
  );

  it.effect("leaves messages without a peer sender unchanged", () =>
    Effect.gen(function* () {
      const text = "Which fields does /users return?";
      for (const input of [
        { threadId: backend },
        { threadId: backend, senderThreadId: backend },
        { threadId: backend, senderThreadId: frontend, role: "assistant" as const },
        // A delegated task's prompt comes from its parent, which waits on the task instead.
        { threadId: child, senderThreadId: frontend },
        { threadId: backend, senderThreadId: missing },
      ]) {
        expect(yield* providerText(input)).toBe(text);
      }
      expect(
        yield* providerText({ threadId: backend, senderThreadId: frontend, text: "/compact" }),
      ).toBe("/compact");
    }),
  );

  it.effect("sends the plain text when the sender lookup fails", () =>
    Effect.gen(function* () {
      const text = yield* providerTextWithThreadMessageSender(
        {
          getThreadShell: (threadId) =>
            Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
        },
        { threadId: backend, message: { role: "user", senderThreadId: frontend }, text: "Hi" },
      );
      expect(text).toBe("Hi");
    }),
  );
});
