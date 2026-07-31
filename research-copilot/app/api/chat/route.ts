import { NextRequest } from "next/server";
import type OpenAI from "openai";
import { openai, MODEL } from "@/lib/ai/client";
import { executeTool, toolDefinitions } from "@/lib/ai/tools";
import { CHAT_PROMPT } from "@/lib/ai/prompts";
import { EvidencePack, verify } from "@/lib/ai/evidence";
import type { Evidence } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Research chat with tool calling.
 *
 * The loop is bounded at MAX_TOOL_ROUNDS. Unbounded agent loops are the standard
 * way to accidentally spend $40 on one question: a model that cannot find an
 * answer will happily call the same tool forever. When the budget is exhausted
 * we force a final text-only turn so the user always gets a reply.
 *
 * The client sends prior turns back each request. That is intentional — the route
 * is stateless, so it scales horizontally and survives redeploys mid-conversation.
 * Context is trimmed to the last N turns before sending upstream.
 */
const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_TURNS = 12;

interface ChatRequest {
  ticker: string;
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
  /** Evidence pack from the current research session, sent by the client. */
  evidence?: Evidence[];
}

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ticker = (body.ticker ?? "").toUpperCase();
  const question = (body.message ?? "").trim();
  if (!question) return Response.json({ error: "message is required" }, { status: 400 });

  // Rehydrate the evidence pack so citations in the reply can be verified against
  // exactly the same ids the report used.
  const pack = EvidencePack.hydrate(body.evidence ?? []);
  const evidenceBlock = (body.evidence ?? [])
    .map((i) => `[${i.id}] (${i.provider}, as of ${i.asOf.slice(0, 10)}) ${i.text}`)
    .join("\n");

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${CHAT_PROMPT}\n\nCurrent company under analysis: ${ticker}\n\nEVIDENCE\n${
        evidenceBlock || "(no research session evidence — use tools for everything factual)"
      }\nEND EVIDENCE`,
    },
    ...(body.history ?? []).slice(-MAX_HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content } as const)),
    { role: "user", content: question },
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        let full = "";

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const lastRound = round === MAX_TOOL_ROUNDS;

          const completion = await openai.chat.completions.create({
            model: MODEL,
            temperature: 0.3,
            max_tokens: 1600,
            stream: true,
            messages,
            // On the final round, drop the tools so the model must answer in text.
            ...(lastRound ? {} : { tools: toolDefinitions, tool_choice: "auto" }),
          });

          // Streamed tool calls arrive in fragments and must be reassembled by
          // index; arguments come through as partial JSON strings.
          const pendingCalls: { id: string; name: string; args: string }[] = [];
          let roundText = "";

          for await (const part of completion) {
            const delta = part.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              roundText += delta.content;
              full += delta.content;
              send("delta", { text: delta.content });
            }

            for (const call of delta.tool_calls ?? []) {
              const index = call.index ?? 0;
              const slot = (pendingCalls[index] ??= { id: "", name: "", args: "" });
              if (call.id) slot.id = call.id;
              if (call.function?.name) slot.name += call.function.name;
              if (call.function?.arguments) slot.args += call.function.arguments;
            }
          }

          const calls = pendingCalls.filter((c) => c.name);
          if (calls.length === 0) break;

          messages.push({
            role: "assistant",
            content: roundText || null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.args },
            })),
          });

          // Tools run concurrently; each returns data or a structured error.
          const results = await Promise.all(
            calls.map(async (call) => {
              send("tool", { name: call.name, args: safeParse(call.args) });
              const output = await executeTool(call.name, call.args);
              send("tool_done", { name: call.name, bytes: output.length });
              return { call, output };
            })
          );

          for (const { call, output } of results) {
            messages.push({ role: "tool", tool_call_id: call.id, content: output });
          }
        }

        // Verify citations on the assembled answer and report any that failed.
        const verified = verify(full, pack);
        send("done", {
          invalidCitations: verified.invalidCitations,
          unsupportedSentences: verified.unsupportedSentences,
        });
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
