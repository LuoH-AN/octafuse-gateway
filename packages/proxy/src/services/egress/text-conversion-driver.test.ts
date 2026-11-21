import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { TEXT_CONVERSION_ADAPTERS } from '@octafuse/core/adapters/registry';
import type { JsonObject, TextProtocol } from '@octafuse/core/text-protocol';
import type { RouteResult } from '../model-router';
import { proxyAnthropicMessages, proxyChatCompletions, proxyGeminiContent } from '../proxy';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker';
import { dispatchTextConversion, textConversionUpstreamBodyForLog } from './text-conversion-driver';

const bodies: Record<TextProtocol, JsonObject> = {
	openai: {
		model: 'catalog',
		messages: [{ role: 'user', content: 'private prompt' }],
		max_tokens: 100,
		stream_options: { include_usage: true },
	},
	anthropic: {
		model: 'catalog',
		messages: [{ role: 'user', content: 'private prompt' }],
		max_tokens: 100,
	},
	gemini: {
		contents: [{ role: 'user', parts: [{ text: 'private prompt' }] }],
		generationConfig: { maxOutputTokens: 100 },
	},
};
const json: Record<TextProtocol, JsonObject> = {
	openai: {
		id: 'message-id',
		choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 10, completion_tokens: 4 },
	},
	anthropic: {
		id: 'message-id',
		content: [{ type: 'text', text: 'hello' }],
		stop_reason: 'end_turn',
		usage: { input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 4 },
	},
	gemini: {
		responseId: 'message-id',
		candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
		usageMetadata: {
			promptTokenCount: 10,
			candidatesTokenCount: 3,
			thoughtsTokenCount: 1,
			totalTokenCount: 14,
		},
	},
};
const stream: Record<TextProtocol, string> = {
	openai:
		'data: {"id":"message-id","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
	anthropic:
		'event: message_start\ndata: {"type":"message_start","message":{"id":"message-id","usage":{"input_tokens":8,"cache_read_input_tokens":2}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
	gemini:
		'data: {"responseId":"message-id","candidates":[{"index":0,"content":{"parts":[{"text":"hello"}]}}]}\n\ndata: {"candidates":[{"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":1,"totalTokenCount":14}}\n\n',
};
function route(
	adapter: (typeof TEXT_CONVERSION_ADAPTERS)[number],
	overrides: Partial<RouteResult> = {}
): RouteResult {
	return {
		targetId: 'target',
		modelSurfaceId: 'surface',
		routePoolId: 'pool',
		providerId: 'provider',
		providerName: 'Provider',
		providerModelName: 'native-model',
		upstreamProtocol: adapter.upstream.protocol,
		upstreamOperation: adapter.upstream.operations[0],
		adapter: adapter.id,
		providerEndpoints: {
			openai: { base: 'https://upstream.example/v1' },
			anthropic: { base: 'https://upstream.example' },
			gemini: { base: 'https://upstream.example/v1beta/models', auth: 'bearer' },
		},
		providerApiKey: 'test-key',
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 1,
		routeWeight: 1,
		...overrides,
	};
}
const repos = { systemConfig: { getConfig: async () => null } } as unknown as GatewayRepositories;
beforeEach(() => resetProviderCircuitStateForTests());
afterEach(() => mock.restoreAll());

describe('text conversion dispatch', () => {
	for (const adapter of TEXT_CONVERSION_ADAPTERS) {
		const from = adapter.request.protocol;
		const to = adapter.upstream.protocol;
		for (const streaming of [false, true])
			it(`${adapter.id}: ${
				streaming ? 'SSE' : 'JSON'
			} through the public proxy dispatch`, async () => {
				const fetchMock = mock.method(
					globalThis,
					'fetch',
					async (raw: RequestInfo | URL, init?: RequestInit) => {
						const url = String(raw);
						assert.match(
							url,
							to === 'openai'
								? /\/chat\/completions$/
								: to === 'anthropic'
								? /\/v1\/messages$/
								: streaming
								? /:streamGenerateContent/
								: /:generateContent/
						);
						const headers = new Headers(init?.headers);
						assert.equal(
							headers.get(to === 'anthropic' ? 'x-api-key' : 'authorization'),
							to === 'anthropic' ? 'test-key' : 'Bearer test-key'
						);
						const body = JSON.parse(String(init?.body));
						assert.ok(body[to === 'gemini' ? 'contents' : 'messages']);
						assert.equal(body.temperature, to === 'gemini' ? undefined : 0.2);
						if (to === 'gemini') assert.equal(body.generationConfig.temperature, 0.2);
						assert.equal(body.stream, to === 'gemini' ? undefined : streaming);
						if (to !== 'gemini') assert.equal(body.model, 'native-model');
						if (to === 'openai' && streaming) assert.equal(body.stream_options.include_usage, true);
						return new Response(streaming ? stream[to] : JSON.stringify(json[to]), {
							headers: {
								'Content-Type': streaming ? 'text/event-stream' : 'application/json',
								'x-request-id': 'request-id',
							},
						});
					}
				);
				const customParams = {
					body: to === 'gemini' ? { generationConfig: { temperature: 0.2 } } : { temperature: 0.2 },
				};
				const input = { ...bodies[from], ...(from !== 'gemini' ? { stream: streaming } : {}) };
				const routes = [route(adapter, { customParams })];
				const result =
					from === 'openai'
						? await proxyChatCompletions(repos, routes, input)
						: from === 'anthropic'
						? await proxyAnthropicMessages(repos, routes, input)
						: await proxyGeminiContent(
								repos,
								routes,
								streaming ? 'streamGenerateContent' : 'generateContent',
								input,
								''
						  );
				assert.equal(result.response.status, 200);
				assert.match(await result.response.text(), /hello/);
				assert.equal(result.chosenRoute.adapter, adapter.id);
				const usage = await result.usagePromise;
				assert.equal(usage.input_tokens, 10);
				assert.equal(usage.output_tokens, 4);
				assert.equal(usage.total_tokens, 14);
				assert.equal(usage.reasoning_tokens, to === 'gemini' ? 1 : 0);
				assert.equal(result.upstreamRequestId, 'request-id');
				assert.equal(fetchMock.mock.callCount(), 1);
				const log = textConversionUpstreamBodyForLog(routes[0]!, from, input, streaming)!;
				assert.doesNotMatch(log, /private prompt/);
				assert.match(log, new RegExp(adapter.id));
			});
	}
	it('fails over from a native OpenAI route to an Anthropic conversion route', async () => {
		const adapter = TEXT_CONVERSION_ADAPTERS[0];
		let attempts = 0;
		mock.method(globalThis, 'fetch', async () =>
			++attempts === 1
				? Response.json({ error: { message: 'Unavailable' } }, { status: 503 })
				: Response.json(json.anthropic)
		);
		const native = route(adapter, {
			providerId: 'native',
			upstreamProtocol: 'openai',
			upstreamOperation: 'chat',
			adapter: 'passthrough',
			routePriority: 2,
		});
		const converted = route(adapter, { providerId: 'converted', routePriority: 1 });
		const result = await proxyChatCompletions(repos, [native, converted], bodies.openai);
		assert.equal(result.response.status, 200);
		assert.equal(result.chosenRoute.providerId, 'converted');
		assert.match(await result.response.text(), /hello/);
		assert.equal(attempts, 2);
	});
	it('marks local conversion errors and avoids upstream fetch', async () => {
		const fetchMock = mock.method(globalThis, 'fetch', async () => {
			throw new Error('must not fetch');
		});
		const result = await proxyChatCompletions(repos, [route(TEXT_CONVERSION_ADAPTERS[0])], {
			...bodies.openai,
			tools: [{ type: 'web_search' }],
		});
		assert.equal(result.response.status, 400);
		assert.equal(result.meta?.textConversionClientError, true);
		assert.equal(fetchMock.mock.callCount(), 0);
	});
	it('uses Anthropic route defaults before supplying the missing max_tokens fallback', async () => {
		const limits: number[] = [];
		mock.method(globalThis, 'fetch', async (_raw: RequestInfo | URL, init?: RequestInit) => {
			limits.push(JSON.parse(String(init?.body)).max_tokens);
			return Response.json(json.anthropic);
		});
		const input = { messages: [{ role: 'user', content: 'ping' }] };
		await dispatchTextConversion(
			route(TEXT_CONVERSION_ADAPTERS[0], { customParams: { body: { max_tokens: 8192 } } }),
			'openai',
			input,
			false
		);
		await dispatchTextConversion(route(TEXT_CONVERSION_ADAPTERS[0]), 'openai', input, false);
		assert.deepEqual(limits, [8192, 4096]);
	});
	it('keeps force overrides in the upstream dialect and redacts native tools from logs', async () => {
		const target = route(TEXT_CONVERSION_ADAPTERS[1], {
			customParams: {
				body: { generationConfig: { maxOutputTokens: 777 } },
				force_override: { body: true },
			},
		});
		mock.method(globalThis, 'fetch', async (_raw: RequestInfo | URL, init?: RequestInit) => {
			assert.equal(JSON.parse(String(init?.body)).generationConfig.maxOutputTokens, 777);
			return Response.json(json.gemini);
		});
		const input = {
			...bodies.openai,
			tools: [
				{
					type: 'function',
					function: {
						name: 'weather',
						description: 'private tool description',
						parameters: { type: 'object' },
					},
				},
			],
		};
		const result = await dispatchTextConversion(target, 'openai', input, false);
		assert.equal(result.response.status, 200);
		const log = textConversionUpstreamBodyForLog(target, 'openai', input, false)!;
		assert.doesNotMatch(log, /private tool description|private prompt/);
		assert.match(log, /weather/);
	});
	it('adds a stream conversion failure to upstream usage without turning EOF into success', async () => {
		mock.method(
			globalThis,
			'fetch',
			async () =>
				new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"partial"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
					{ headers: { 'Content-Type': 'text/event-stream' } }
				)
		);
		const result = await dispatchTextConversion(
			route(TEXT_CONVERSION_ADAPTERS[2]),
			'anthropic',
			{ ...bodies.anthropic, stream: true },
			true
		);
		const text = await result.response.text();
		assert.match(text, /error/);
		assert.doesNotMatch(text, /event: message_stop/);
		const usage = await result.usagePromise;
		assert.equal(usage.input_tokens, 10);
		assert.match(usage.stream_error!, /terminal/);
	});
});
