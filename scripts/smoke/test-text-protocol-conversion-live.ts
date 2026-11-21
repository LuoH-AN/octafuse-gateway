/** Real upstream calls through the current source conversion/egress drivers; no DB writes or deploy. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TEXT_CONVERSION_ADAPTERS } from "@octafuse/core/adapters/registry";
import type { ProtocolEndpointsConfig } from "@octafuse/core";
import {
	object,
	objects,
	string,
	type JsonObject,
	type TextProtocol,
} from "@octafuse/core/text-protocol";
import type { RouteResult } from "../../packages/proxy/src/services/model-router";

type Upstream = {
	model: string;
	apiKey: string;
	endpoint: ProtocolEndpointsConfig;
	customParams: JsonObject | null;
};
const protocols = ["openai", "anthropic", "gemini"] as const;
const secrets: string[] = [];
const safeError = (error: unknown) => {
	let text = error instanceof Error ? error.message : "Live test failed";
	for (const secret of secrets)
		if (secret) text = text.split(secret).join("[redacted]");
	return text.slice(0, 800);
};
const toolName = "get_live_marker";

class LiveTimeoutError extends Error {}
async function withDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new LiveTimeoutError(`Live request exceeded ${timeoutMs}ms`)
						),
					timeoutMs
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function bodyFor(
	protocol: TextProtocol,
	prompt: string,
	maxTokens: number
): JsonObject {
	if (protocol === "gemini")
		return {
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			generationConfig: { maxOutputTokens: maxTokens },
		};
	return {
		model: "live-test",
		messages: [{ role: "user", content: prompt }],
		max_tokens: maxTokens,
		...(protocol === "openai"
			? { stream_options: { include_usage: true } }
			: {}),
	};
}

function withTool(
	protocol: TextProtocol,
	body: JsonObject,
	marker: string
): JsonObject {
	const schema = {
		type: "object",
		properties: { marker: { type: "string", enum: [marker] } },
		required: ["marker"],
	};
	if (protocol === "openai")
		return {
			...body,
			tools: [
				{
					type: "function",
					function: {
						name: toolName,
						description: "Return a live test marker.",
						parameters: schema,
					},
				},
			],
			tool_choice: { type: "function", function: { name: toolName } },
		};
	if (protocol === "anthropic")
		return {
			...body,
			tools: [
				{
					name: toolName,
					description: "Return a live test marker.",
					input_schema: schema,
				},
			],
			tool_choice: { type: "tool", name: toolName },
		};
	return {
		...body,
		tools: [
			{
				functionDeclarations: [
					{
						name: toolName,
						description: "Return a live test marker.",
						parametersJsonSchema: schema,
					},
				],
			},
		],
		toolConfig: {
			functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName] },
		},
	};
}

function messageText(protocol: TextProtocol, payload: JsonObject): string {
	if (protocol === "openai") {
		const choices = objects(payload.choices);
		assert.equal(choices.length, 1, "Expected one Chat response choice");
		assert.equal(object(choices[0]!.message).role, "assistant");
		assert.equal(
			choices[0]!.finish_reason,
			"stop",
			"Chat response did not finish normally"
		);
		return string(object(choices[0]!.message).content);
	}
	if (protocol === "anthropic") {
		assert.equal(payload.type, "message");
		assert.equal(payload.role, "assistant");
		assert.equal(
			payload.stop_reason,
			"end_turn",
			"Messages response did not finish normally"
		);
		return objects(payload.content)
			.filter((p) => p.type === "text")
			.map((p) => string(p.text))
			.join("");
	}
	const candidates = objects(payload.candidates);
	assert.equal(candidates.length, 1, "Expected one Gemini response candidate");
	assert.equal(
		candidates[0]!.finishReason,
		"STOP",
		"Gemini response did not finish normally"
	);
	return objects(object(candidates[0]!.content).parts)
		.filter((p) => p.thought !== true)
		.map((p) => string(p.text))
		.join("");
}

function continueTool(
	protocol: TextProtocol,
	body: JsonObject,
	payload: JsonObject,
	marker: string,
	result: string
): JsonObject {
	if (protocol === "openai") {
		const choice = objects(payload.choices)[0]!;
		assert.equal(choice.finish_reason, "tool_calls");
		const assistant = object(choice.message);
		const calls = objects(assistant.tool_calls);
		assert.equal(calls.length, 1, "Expected exactly one function call");
		const call = calls[0]!;
		assert.equal(object(call.function).name, toolName);
		assert.deepEqual(JSON.parse(string(object(call.function).arguments)), {
			marker,
		});
		assert.ok(string(call.id), "Function call ID is missing");
		return {
			...body,
			tool_choice: "none",
			messages: [
				...objects(body.messages),
				assistant,
				{
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify({ result }),
				},
			],
		};
	}
	if (protocol === "anthropic") {
		assert.equal(payload.stop_reason, "tool_use");
		const calls = objects(payload.content).filter((p) => p.type === "tool_use");
		assert.equal(calls.length, 1, "Expected exactly one function call");
		const call = calls[0]!;
		assert.equal(call.name, toolName);
		assert.deepEqual(call.input, { marker });
		assert.ok(string(call.id), "Function call ID is missing");
		return {
			...body,
			tool_choice: { type: "none" },
			messages: [
				...objects(body.messages),
				{ role: "assistant", content: payload.content },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: call.id,
							content: JSON.stringify({ result }),
						},
					],
				},
			],
		};
	}
	const assistant = object(objects(payload.candidates)[0]!.content);
	const calls = objects(assistant.parts).filter((p) => p.functionCall);
	assert.equal(calls.length, 1, "Expected exactly one function call");
	const call = object(calls[0]!.functionCall);
	assert.equal(call.name, toolName);
	assert.deepEqual(call.args, { marker });
	return {
		...body,
		toolConfig: { functionCallingConfig: { mode: "NONE" } },
		contents: [
			...objects(body.contents),
			assistant,
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: call.id,
							name: call.name,
							response: { result },
						},
					},
				],
			},
		],
	};
}

function streamText(protocol: TextProtocol, wire: string): string {
	let text = "";
	let terminal = false;
	let finish = "";
	for (const frame of wire.replace(/\r\n/g, "\n").split("\n\n")) {
		const data = frame
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trimStart())
			.join("\n");
		if (!data) continue;
		if (data.trim() === "[DONE]") {
			terminal = true;
			continue;
		}
		const payload = object(JSON.parse(data));
		assert.ok(
			!payload.error && payload.type !== "error",
			"Converted SSE contained an error event"
		);
		if (protocol === "openai")
			for (const choice of objects(payload.choices)) {
				text += string(object(choice.delta).content);
				finish = string(choice.finish_reason) || finish;
			}
		else if (protocol === "anthropic") {
			if (object(payload.delta).type === "text_delta")
				text += string(object(payload.delta).text);
			if (payload.type === "message_stop") terminal = true;
			finish = string(object(payload.delta).stop_reason) || finish;
		} else
			for (const candidate of objects(payload.candidates)) {
				text += objects(object(candidate.content).parts)
					.filter((p) => p.thought !== true)
					.map((p) => string(p.text))
					.join("");
				if (candidate.finishReason) {
					terminal = true;
					finish = string(candidate.finishReason);
				}
			}
	}
	assert.ok(terminal, "Converted SSE is missing its native terminal event");
	assert.equal(
		finish,
		protocol === "openai"
			? "stop"
			: protocol === "anthropic"
			? "end_turn"
			: "STOP"
	);
	return text;
}

async function main() {
	const configPath = process.argv[2] || process.env.TEXT_PROTOCOL_LIVE_CONFIG;
	if (!configPath)
		throw new Error(
			"A real upstream config file is required: npm run test:gateway:text-conversion-live -- <config.json>"
		);
	let raw: JsonObject;
	try {
		raw = object(JSON.parse(await readFile(configPath, "utf8")));
	} catch {
		throw new Error("Cannot read valid live-test config JSON");
	}
	const adapterIds = Array.isArray(raw.adapters)
		? raw.adapters
		: TEXT_CONVERSION_ADAPTERS.map((a) => a.id);
	assert.ok(
		adapterIds.length &&
			adapterIds.every((id) =>
				TEXT_CONVERSION_ADAPTERS.some((a) => a.id === id)
			),
		"Unknown or empty adapter selection"
	);
	const adapters = TEXT_CONVERSION_ADAPTERS.filter((a) =>
		adapterIds.includes(a.id)
	);
	const caseNames = ["json", "sse", "tool-roundtrip"] as const;
	const cases = Array.isArray(raw.cases) ? raw.cases : [...caseNames];
	assert.ok(
		cases.length && cases.every((name) => caseNames.some((c) => c === name)),
		"Unknown or empty test case selection"
	);
	const upstreams = {} as Record<TextProtocol, Upstream>;
	for (const protocol of protocols.filter((p) =>
		adapters.some((a) => a.upstream.protocol === p)
	)) {
		const entry = object(object(raw.upstreams)[protocol]);
		const apiKey =
			string(entry.apiKey) ||
			(entry.apiKeyEnv ? process.env[string(entry.apiKeyEnv)] || "" : "");
		if (apiKey) secrets.push(apiKey);
		const endpoint = object(entry.endpoint) as ProtocolEndpointsConfig;
		assert.ok(
			string(entry.model) && apiKey && (endpoint.base || endpoint.endpoints),
			`${protocol}: model, API Key and endpoint are required`
		);
		upstreams[protocol] = {
			model: string(entry.model),
			apiKey,
			endpoint,
			customParams: entry.customParams ? object(entry.customParams) : null,
		};
	}
	const maxTokens = typeof raw.maxTokens === "number" ? raw.maxTokens : 2048;
	const timeoutMs = typeof raw.timeoutMs === "number" ? raw.timeoutMs : 120_000;
	assert.ok(Number.isInteger(maxTokens) && maxTokens > 0);
	assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
	const { dispatchTextConversion } = await import(
		"../../packages/proxy/src/services/egress/text-conversion-driver"
	);
	const results: JsonObject[] = [];
	const report: JsonObject = {
		startedAt: new Date().toISOString(),
		mode: "local-source-with-real-upstreams",
		scope:
			"Current conversion and upstream drivers; excludes Worker deployment, HTTP auth, DB routing and billing writes.",
		testedAdapters: adapters.map((a) => a.id),
		excludedAdapters: TEXT_CONVERSION_ADAPTERS.filter(
			(a) => !adapterIds.includes(a.id)
		).map((a) => a.id),
		results,
	};
	let dispatches = 0;
	let timedOut = false;
	adapterLoop: for (const adapter of adapters) {
		const protocol = adapter.request.protocol;
		const upstream = upstreams[adapter.upstream.protocol];
		const route: RouteResult = {
			targetId: adapter.id,
			modelSurfaceId: null,
			routePoolId: null,
			providerId: `live-${adapter.upstream.protocol}`,
			providerName: "Live test upstream",
			providerModelName: upstream.model,
			upstreamProtocol: adapter.upstream.protocol,
			upstreamOperation: adapter.upstream.operations[0],
			adapter: adapter.id,
			providerEndpoints: { [adapter.upstream.protocol]: upstream.endpoint },
			providerApiKey: upstream.apiKey,
			priceOverrideRaw: null,
			routeMeteredProfileJson: null,
			routeChargedProfileJson: null,
			customParams: upstream.customParams,
			routeGroup: "default",
			routePriority: 1,
			routeWeight: 1,
		};
		for (const testCase of caseNames.filter((c) => cases.includes(c))) {
			const started = Date.now();
			console.log(
				`[live] START ${adapter.id} ${testCase} model=${upstream.model}`
			);
			const usageTotals = { input: 0, output: 0 };
			const send = async (body: JsonObject, streaming: boolean) =>
				withDeadline(
					(async () => {
						dispatches++;
						const result = await dispatchTextConversion(
							route,
							protocol,
							{
								...body,
								...(protocol === "gemini" ? {} : { stream: streaming }),
							},
							streaming,
							AbortSignal.timeout(timeoutMs),
							undefined,
							undefined,
							{
								headersTimeoutMs: timeoutMs,
								firstEventTimeoutMs: timeoutMs,
								idleTimeoutMs: timeoutMs,
							}
						);
						const wire = await result.response.text();
						assert.equal(
							result.response.status,
							200,
							`HTTP ${result.response.status}: ${wire.slice(0, 600)}`
						);
						assert.match(
							result.response.headers.get("content-type") || "",
							streaming ? /text\/event-stream/ : /application\/json/
						);
						const usage = await result.usagePromise;
						assert.ok(
							!usage.stream_error,
							`Upstream usage error: ${usage.stream_error}`
						);
						assert.ok(
							usage.input_tokens > 0 &&
								usage.output_tokens > 0 &&
								usage.total_tokens > 0,
							"Real upstream token usage is missing"
						);
						usageTotals.input += usage.input_tokens;
						usageTotals.output += usage.output_tokens;
						return wire;
					})(),
					timeoutMs
				);
			try {
				const marker = `OCTAFUSE_${crypto
					.randomUUID()
					.replaceAll("-", "")
					.slice(0, 12)}`;
				if (testCase === "tool-roundtrip") {
					const body = withTool(
						protocol,
						bodyFor(
							protocol,
							`Call ${toolName} with marker ${marker}. After receiving the tool result, output its result value verbatim, with no other text.`,
							maxTokens
						),
						marker
					);
					const payload = object(JSON.parse(await send(body, false)));
					const reply = `RESULT_${crypto
						.randomUUID()
						.replaceAll("-", "")
						.slice(0, 12)}`;
					const next = continueTool(protocol, body, payload, marker, reply);
					assert.ok(
						messageText(
							protocol,
							object(JSON.parse(await send(next, false)))
						).includes(reply),
						"Tool continuation did not return the actual tool result"
					);
				} else {
					const wire = await send(
						bodyFor(
							protocol,
							`Output exactly ${marker}, with no other text.`,
							maxTokens
						),
						testCase === "sse"
					);
					const text =
						testCase === "sse"
							? streamText(protocol, wire)
							: messageText(protocol, object(JSON.parse(wire)));
					assert.ok(
						text.includes(marker),
						"Response did not contain the requested live marker"
					);
				}
				results.push({
					adapter: adapter.id,
					testCase,
					model: upstream.model,
					pass: true,
					elapsedMs: Date.now() - started,
					tokens: usageTotals,
				});
				console.log(
					`[live] PASS ${adapter.id} ${testCase} input=${usageTotals.input} output=${usageTotals.output}`
				);
			} catch (error) {
				const message = safeError(error);
				results.push({
					adapter: adapter.id,
					testCase,
					model: upstream.model,
					pass: false,
					elapsedMs: Date.now() - started,
					error: message,
				});
				console.error(`[live] FAIL ${adapter.id} ${testCase}: ${message}`);
				if (error instanceof LiveTimeoutError) {
					timedOut = true;
					break adapterLoop;
				}
			}
		}
	}
	report.finishedAt = new Date().toISOString();
	report.dispatches = dispatches;
	report.passed = results.filter((r) => r.pass).length;
	report.failed = results.filter((r) => !r.pass).length;
	report.notRun =
		adapters.length * caseNames.filter((c) => cases.includes(c)).length -
		results.length;
	const reportPath = process.argv[3] || "data/text-protocol-live-report.json";
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
		mode: 0o600,
	});
	console.log(
		`[live] ${report.passed}/${results.length} passed; report=${reportPath}`
	);
	if (report.failed || report.notRun) process.exitCode = 1;
	if (timedOut) process.exit(1); // End outstanding non-stream fetches after writing the partial report.
}

main().catch((error) => {
	console.error(`[live] ${safeError(error)}`);
	process.exitCode = 1;
});
