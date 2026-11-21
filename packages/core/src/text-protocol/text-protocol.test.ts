import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TEXT_CONVERSION_ADAPTERS } from "../adapters/registry";
import { isRouteAdapterCompatible } from "../route-topology";
import {
	convertTextRequest,
	decodeTextRequest,
	TextProtocolError,
	type JsonObject,
	type TextProtocol,
} from "./request";
import { decodeTextResponse, encodeTextResponse } from "./response";
import { convertTextHttpResponse } from "./stream";

const schema = {
	type: "object",
	properties: { city: { type: "string" } },
	required: ["city"],
};
const image = "data:image/png;base64,aGVsbG8=";
export const requests: Record<TextProtocol, JsonObject> = {
	openai: {
		model: "catalog",
		messages: [
			{ role: "system", content: "Be accurate" },
			{
				role: "user",
				content: [
					{ type: "text", text: "Look" },
					{ type: "image_url", image_url: { url: image } },
				],
			},
			{
				role: "assistant",
				content: "Checking",
				tool_calls: [
					{
						id: "call_a",
						type: "function",
						function: { name: "weather", arguments: '{"city":"Paris"}' },
					},
					{
						id: "call_b",
						type: "function",
						function: { name: "weather", arguments: '{"city":"Tokyo"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_a", content: '{"temperature":20}' },
			{ role: "tool", tool_call_id: "call_b", content: '{"temperature":25}' },
			{ role: "user", content: "Continue" },
		],
		tools: [
			{
				type: "function",
				function: {
					name: "weather",
					description: "Current weather",
					parameters: schema,
				},
			},
		],
		tool_choice: { type: "function", function: { name: "weather" } },
		max_tokens: 1234,
		temperature: 0.3,
		top_p: 0.8,
		stop: ["END"],
	},
	anthropic: {
		model: "catalog",
		system: "Be accurate",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Look" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "aGVsbG8=",
						},
					},
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Checking" },
					{
						type: "tool_use",
						id: "call_a",
						name: "weather",
						input: { city: "Paris" },
					},
					{
						type: "tool_use",
						id: "call_b",
						name: "weather",
						input: { city: "Tokyo" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_a",
						content: '{"temperature":20}',
					},
					{
						type: "tool_result",
						tool_use_id: "call_b",
						content: '{"temperature":25}',
					},
				],
			},
			{ role: "user", content: "Continue" },
		],
		tools: [
			{ name: "weather", description: "Current weather", input_schema: schema },
		],
		tool_choice: { type: "tool", name: "weather" },
		max_tokens: 1234,
		temperature: 0.3,
		top_p: 0.8,
		stop_sequences: ["END"],
	},
	gemini: {
		systemInstruction: { parts: [{ text: "Be accurate" }] },
		contents: [
			{
				role: "user",
				parts: [
					{ text: "Look" },
					{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
				],
			},
			{
				role: "model",
				parts: [
					{ text: "Checking" },
					{ functionCall: { name: "weather", args: { city: "Paris" } } },
					{ functionCall: { name: "weather", args: { city: "Tokyo" } } },
				],
			},
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							name: "weather",
							response: { temperature: 20 },
						},
					},
					{
						functionResponse: {
							name: "weather",
							response: { temperature: 25 },
						},
					},
				],
			},
			{ role: "user", parts: [{ text: "Continue" }] },
		],
		tools: [
			{
				functionDeclarations: [
					{
						name: "weather",
						description: "Current weather",
						parameters: schema,
					},
				],
			},
		],
		toolConfig: {
			functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["weather"] },
		},
		generationConfig: {
			maxOutputTokens: 1234,
			temperature: 0.3,
			topP: 0.8,
			stopSequences: ["END"],
		},
	},
};

export const responses: Record<TextProtocol, JsonObject> = {
	openai: {
		id: "upstream-id",
		choices: [
			{
				message: {
					role: "assistant",
					reasoning_content: "Consider",
					content: "你好",
					tool_calls: [
						{
							id: "call_a",
							type: "function",
							function: { name: "weather", arguments: '{"city":"Paris"}' },
						},
					],
				},
				finish_reason: "tool_calls",
			},
		],
		usage: {
			prompt_tokens: 13,
			completion_tokens: 6,
			prompt_tokens_details: { cached_tokens: 2, cache_creation_tokens: 1 },
			completion_tokens_details: { reasoning_tokens: 2 },
		},
	},
	anthropic: {
		id: "upstream-id",
		content: [
			{ type: "thinking", thinking: "Consider", signature: "native" },
			{ type: "text", text: "你好" },
			{
				type: "tool_use",
				id: "call_a",
				name: "weather",
				input: { city: "Paris" },
			},
		],
		stop_reason: "tool_use",
		usage: {
			input_tokens: 10,
			cache_read_input_tokens: 2,
			cache_creation_input_tokens: 1,
			output_tokens: 6,
		},
	},
	gemini: {
		responseId: "upstream-id",
		candidates: [
			{
				content: {
					role: "model",
					parts: [
						{ text: "Consider", thought: true },
						{ text: "你好" },
						{
							functionCall: {
								id: "call_a",
								name: "weather",
								args: { city: "Paris" },
							},
							thoughtSignature: "gemini-signature",
						},
					],
				},
				finishReason: "STOP",
			},
		],
		usageMetadata: {
			promptTokenCount: 13,
			candidatesTokenCount: 4,
			thoughtsTokenCount: 2,
			cachedContentTokenCount: 2,
			totalTokenCount: 19,
		},
	},
};

export const chunks: Record<TextProtocol, JsonObject[]> = {
	openai: [
		{
			id: "upstream-id",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", reasoning_content: "Consider" },
				},
			],
		},
		{ id: "upstream-id", choices: [{ index: 0, delta: { content: "你好" } }] },
		{
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_a",
								type: "function",
								function: { name: "weather", arguments: '{"ci' },
							},
						],
					},
				},
			],
		},
		{
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }],
					},
				},
			],
		},
		{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		{ choices: [], usage: responses.openai.usage },
	],
	anthropic: [
		{
			type: "message_start",
			message: {
				id: "upstream-id",
				usage: {
					input_tokens: 10,
					cache_read_input_tokens: 2,
					cache_creation_input_tokens: 1,
					output_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "Consider" },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: "你好" },
		},
		{ type: "content_block_stop", index: 1 },
		{
			type: "content_block_start",
			index: 2,
			content_block: {
				type: "tool_use",
				id: "call_a",
				name: "weather",
				input: {},
			},
		},
		{
			type: "content_block_delta",
			index: 2,
			delta: { type: "input_json_delta", partial_json: '{"ci' },
		},
		{
			type: "content_block_delta",
			index: 2,
			delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' },
		},
		{ type: "content_block_stop", index: 2 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 6 },
		},
		{ type: "message_stop" },
	],
	gemini: [
		{
			responseId: "upstream-id",
			candidates: [
				{ index: 0, content: { parts: [{ text: "Consider", thought: true }] } },
			],
		},
		{
			responseId: "upstream-id",
			candidates: [{ index: 0, content: { parts: [{ text: "你好" }] } }],
		},
		{
			candidates: [
				{
					index: 0,
					content: {
						parts: [
							{
								functionCall: {
									id: "call_a",
									name: "weather",
									args: { city: "Paris" },
								},
								thoughtSignature: "gemini-signature",
							},
						],
					},
					finishReason: "STOP",
				},
			],
		},
		{ usageMetadata: responses.gemini.usageMetadata },
	],
};

export function sse(protocol: TextProtocol): string {
	return (
		chunks[protocol]
			.map(
				(p) =>
					`${
						protocol === "anthropic" ? `event: ${p.type}\n` : ""
					}data: ${JSON.stringify(p)}\n\n`
			)
			.join("") + (protocol === "openai" ? "data: [DONE]\n\n" : "")
	);
}
function events(text: string): JsonObject[] {
	return text.split("\n\n").flatMap((frame) => {
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
	});
}

describe("text protocol conversion", () => {
	it("maps dynamic Gemini reasoning and disabled OpenAI reasoning to Anthropic modes", () => {
		for (const [budget, expected] of [
			[-1, { type: "adaptive" }],
			[0, { type: "disabled" }],
			[2048, { type: "enabled", budget_tokens: 2048 }],
		] as const) {
			const body = convertTextRequest("gemini", "anthropic", {
				contents: [{ role: "user", parts: [{ text: "Check" }] }],
				generationConfig: { thinkingConfig: { thinkingBudget: budget } },
			});
			assert.deepEqual(body.thinking, expected);
		}
		for (const effort of ["none", "minimal"]) {
			const body = convertTextRequest("openai", "anthropic", {
				messages: [{ role: "user", content: "Check" }],
				reasoning_effort: effort,
			});
			assert.deepEqual(body.thinking, { type: "disabled" });
		}
	});
	it("preserves tool-result ordering and reasoning text for OpenAI tool continuation", () => {
		const body = convertTextRequest("anthropic", "openai", {
			messages: [
				{ role: "user", content: "Check" },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Use weather",
							signature: "native-signature",
						},
						{ type: "tool_use", id: "call_a", name: "weather", input: {} },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_a", content: "20C" },
						{ type: "text", text: "Continue" },
					],
				},
			],
		});
		const messages = body.messages as JsonObject[];
		assert.deepEqual(
			messages.map((m) => m.role),
			["user", "assistant", "tool", "user"]
		);
		assert.equal(messages[1]!.reasoning_content, "Use weather");
		assert.equal(messages[2]!.content, "20C");
		assert.equal(messages[3]!.content, "Continue");
		assert.doesNotMatch(JSON.stringify(body), /native-signature/);
	});
	for (const adapter of TEXT_CONVERSION_ADAPTERS) {
		const from = adapter.request.protocol;
		const to = adapter.upstream.protocol;
		it(`${from} → ${to}: maps conversation, parallel calls/results and request controls`, () => {
			assert.equal(
				isRouteAdapterCompatible({
					adapter: adapter.id,
					requestProtocol: from,
					requestOperation: adapter.request.operation,
					upstreamProtocol: to,
					upstreamOperation: adapter.upstream.operations[0],
				}),
				true
			);
			assert.equal(
				isRouteAdapterCompatible({
					adapter: "passthrough",
					requestProtocol: from,
					requestOperation: adapter.request.operation,
					upstreamProtocol: to,
					upstreamOperation: adapter.upstream.operations[0],
				}),
				false
			);
			const source = structuredClone(requests[from]);
			const wire = convertTextRequest(from, to, source, true);
			assert.deepEqual(source, requests[from]);
			const decoded = decodeTextRequest(to, wire);
			assert.deepEqual(decoded.tools, [
				{ name: "weather", description: "Current weather", schema },
			]);
			assert.deepEqual(decoded.choice, { name: "weather" });
			assert.equal(decoded.maxTokens, 1234);
			assert.equal(decoded.temperature, 0.3);
			assert.equal(decoded.topP, 0.8);
			assert.deepEqual(decoded.stop, ["END"]);
			assert.deepEqual(
				decoded.messages
					.flatMap((m) => m.parts)
					.filter((p) => p.type === "text")
					.map((p) => p.text),
				["Be accurate", "Look", "Checking", "Continue"]
			);
			assert.deepEqual(
				decoded.messages
					.flatMap((m) => m.parts)
					.filter((p) => p.type === "call")
					.map((p) => ({ name: p.name, args: p.args })),
				[
					{ name: "weather", args: { city: "Paris" } },
					{ name: "weather", args: { city: "Tokyo" } },
				]
			);
			assert.deepEqual(
				decoded.messages
					.flatMap((m) => m.parts)
					.filter((p) => p.type === "result")
					.map((p) => p.name),
				["weather", "weather"]
			);
			assert.deepEqual(
				decoded.messages
					.flatMap((m) => m.parts)
					.filter((p) => p.type === "image"),
				[{ type: "image", url: image }]
			);
			assert.equal(wire.stream, to === "gemini" ? undefined : true);
		});
		it(`${from} → ${to}: converts JSON responses with thinking, tools and native usage`, () => {
			const result = encodeTextResponse(
				to,
				decodeTextResponse(from, responses[from], "catalog-model")
			);
			const decoded = decodeTextResponse(to, result, "catalog-model");
			assert.equal(decoded.id, "upstream-id");
			assert.equal(decoded.model, "catalog-model");
			assert.equal(decoded.finish, "tool_calls");
			assert.deepEqual(
				decoded.parts.filter((p) => p.type === "text"),
				[{ type: "text", text: "你好" }]
			);
			assert.equal(decoded.usage.input, 13);
			assert.equal(decoded.usage.output, 6);
		});
		it(`${from} → ${to}: translates fragmented UTF-8 SSE, tool JSON and terminal usage`, async () => {
			const bytes = new TextEncoder().encode(
				sse(from).replaceAll("\n", "\r\n")
			);
			let position = 0;
			const upstream = new Response(
				new ReadableStream({
					pull(controller) {
						if (position < bytes.length) {
							controller.enqueue(bytes.slice(position, position + 11));
							position += 11;
						} else controller.close();
					},
				}),
				{
					headers: {
						"Content-Type": "text/event-stream",
						"Content-Length": "99999",
						"Content-Encoding": "gzip",
					},
				}
			);
			const result = await convertTextHttpResponse(upstream, from, to, {
				model: "catalog-model",
				includeUsage: true,
			});
			const text = await result.response.text();
			const frames = events(text);
			assert.equal(await result.completion, null);
			assert.equal(result.response.headers.get("content-length"), null);
			assert.equal(result.response.headers.get("content-encoding"), null);
			assert.ok(text.includes("你好"));
			assert.ok(text.includes("Consider"));
			if (to === "openai") {
				const choices = frames.flatMap((p) => p.choices as JsonObject[]);
				assert.equal(choices.filter((c) => c.finish_reason != null).length, 1);
				assert.equal(
					choices.find((c) => c.finish_reason)?.finish_reason,
					"tool_calls"
				);
				const calls = choices.flatMap(
					(c) => ((c.delta as JsonObject).tool_calls as JsonObject[]) ?? []
				);
				assert.ok(calls.every((c) => c.index === 0));
				assert.equal(
					JSON.parse(
						calls
							.map((c) => (c.function as JsonObject).arguments ?? "")
							.join("")
					).city,
					"Paris"
				);
				assert.equal(
					(frames.find((f) => f.usage)?.usage as JsonObject).prompt_tokens,
					13
				);
				assert.equal(
					(frames.find((f) => f.usage)?.usage as JsonObject).completion_tokens,
					6
				);
				assert.equal(text.match(/\[DONE\]/g)?.length, 1);
			} else if (to === "anthropic") {
				assert.equal(frames.filter((f) => f.type === "message_stop").length, 1);
				assert.equal(
					(frames.find((f) => f.type === "message_delta")?.delta as JsonObject)
						.stop_reason,
					"tool_use"
				);
				assert.ok(
					frames.some(
						(f) =>
							f.type === "content_block_start" &&
							(f.content_block as JsonObject).name === "weather"
					)
				);
				assert.equal(
					(frames.find((f) => f.type === "message_delta")?.usage as JsonObject)
						.output_tokens,
					6
				);
			} else {
				const candidates = frames.flatMap((f) => f.candidates as JsonObject[]);
				assert.equal(candidates.filter((c) => c.finishReason).length, 1);
				const parts = candidates.flatMap(
					(c) => (c.content as JsonObject).parts as JsonObject[]
				);
				assert.deepEqual(
					(parts.find((p) => p.functionCall)?.functionCall as JsonObject).args,
					{
						city: "Paris",
					}
				);
				assert.equal(
					(frames.find((f) => f.usageMetadata)?.usageMetadata as JsonObject)
						.totalTokenCount,
					19
				);
			}
		});
	}
	it("rejects hosted tools, multiple choices, orphan tool results and unsupported media", () => {
		for (const body of [
			{ ...requests.openai, tools: [{ type: "web_search" }] },
			{ ...requests.openai, n: 2 },
			{ messages: [{ role: "tool", tool_call_id: "unknown", content: "ok" }] },
			{
				messages: [
					{ role: "user", content: [{ type: "input_audio", input_audio: {} }] },
				],
			},
		])
			assert.throws(
				() => convertTextRequest("openai", "anthropic", body),
				TextProtocolError
			);
		assert.throws(
			() =>
				convertTextRequest("gemini", "openai", {
					...requests.gemini,
					tools: [{ googleSearch: {} }],
				}),
			/built-in/
		);
		assert.throws(
			() =>
				convertTextRequest("openai", "gemini", {
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image_url",
									image_url: { url: "https://example.com/image.png" },
								},
							],
						},
					],
				}),
			/base64/
		);
	});
	it("preserves Gemini tool thought signatures across OpenAI history and removes foreign thinking history", () => {
		const openai = encodeTextResponse(
			"openai",
			decodeTextResponse("gemini", responses.gemini, "catalog")
		);
		const message = (openai.choices as JsonObject[])[0]!.message as JsonObject;
		const wire = convertTextRequest("openai", "gemini", {
			messages: [{ role: "user", content: "test" }, message],
		});
		const parts = (wire.contents as JsonObject[])[1]!.parts as JsonObject[];
		assert.equal(
			parts.find((p) => p.functionCall)?.thoughtSignature,
			"gemini-signature"
		);
		assert.equal(
			parts.some((p) => p.thought),
			false
		);
	});
	it("retains Google tool signatures through an Anthropic client tool-result continuation", () => {
		for (const upstream of ["openai", "gemini"] as const) {
			const native = encodeTextResponse(upstream, decodeTextResponse("gemini", responses.gemini, "catalog"));
			const reply = encodeTextResponse("anthropic", decodeTextResponse(upstream, native, "catalog"));
			const call = (reply.content as JsonObject[]).find((p) => p.type === "tool_use")!;
			const history = {
				messages: [
					{ role: "user", content: "Check the weather" },
					{ role: "assistant", content: reply.content },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "20C" }] },
				],
			};
			const chat = convertTextRequest("anthropic", "openai", history);
			const assistant = (chat.messages as JsonObject[]).find((m) => m.role === "assistant")!;
			const chatCall = (assistant.tool_calls as JsonObject[])[0]!;
			assert.equal(((chatCall.extra_content as JsonObject).google as JsonObject).thought_signature, "gemini-signature");
			const gemini = convertTextRequest("anthropic", "gemini", history);
			const parts = (gemini.contents as JsonObject[]).flatMap((m) => m.parts as JsonObject[]);
			assert.equal(parts.find((p) => p.functionCall)?.thoughtSignature, "gemini-signature");
			assert.doesNotMatch(JSON.stringify(convertTextRequest("anthropic", "anthropic", history)), /gemini-signature/);
			assert.equal(decodeTextResponse("anthropic", reply, "catalog").parts.find((p) => p.type === "call")?.signature, "gemini-signature");
		}
	});
	it("retains Google tool signatures when an Anthropic SSE response is replayed through another gateway", async () => {
		const first = await convertTextHttpResponse(
			new Response(sse("gemini"), { headers: { "Content-Type": "text/event-stream" } }),
			"gemini", "anthropic", { model: "catalog" }
		);
		const wire = await first.response.text();
		assert.equal(await first.completion, null);
		const second = await convertTextHttpResponse(
			new Response(wire, { headers: { "Content-Type": "text/event-stream" } }),
			"anthropic", "openai", { model: "catalog" }
		);
		const chatWire = await second.response.text();
		assert.equal(await second.completion, null);
		assert.match(chatWire, /"thought_signature":"gemini-signature"/);
		assert.match(chatWire, /\[DONE\]/);
	});
	it("reports malformed and truncated streams as native errors without successful termination", async () => {
		for (const from of ["openai", "anthropic", "gemini"] as const) {
			const valid = sse(from);
			for (const invalid of [
				"data: {oops}\n\n",
				valid.slice(0, valid.indexOf("你好")) + "",
			]) {
				const result = await convertTextHttpResponse(
					new Response(invalid, {
						headers: { "Content-Type": "text/event-stream" },
					}),
					from,
					from === "openai" ? "anthropic" : "openai",
					{ model: "catalog" }
				);
				const text = await result.response.text();
				assert.ok(await result.completion);
				assert.match(text, /error/);
				assert.doesNotMatch(text, /\[DONE\]|event: message_stop/);
			}
		}
	});
	it("adapts HTTP errors while preserving retry headers", async () => {
		const result = await convertTextHttpResponse(
			Response.json(
				{ error: { message: "Rate limited", code: "limit" } },
				{ status: 429, headers: { "Retry-After": "7" } }
			),
			"openai",
			"gemini",
			{ model: "catalog" }
		);
		assert.equal(result.response.status, 429);
		assert.equal(result.response.headers.get("retry-after"), "7");
		assert.deepEqual(await result.response.json(), {
			error: {
				code: 429,
				message: "Rate limited",
				status: "RESOURCE_EXHAUSTED",
			},
		});
	});
	it("propagates cancellation and settles conversion completion", async () => {
		let cancelled = false;
		const upstream = new Response(
			new ReadableStream({
				pull(c) {
					c.enqueue(
						new TextEncoder().encode(
							'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
						)
					);
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } }
		);
		const result = await convertTextHttpResponse(upstream, "openai", "gemini", {
			model: "catalog",
		});
		const reader = result.response.body!.getReader();
		assert.match(
			new TextDecoder().decode((await reader.read()).value),
			/hello/
		);
		await reader.cancel();
		assert.equal(cancelled, true);
		assert.equal(await result.completion, null);
	});
});
