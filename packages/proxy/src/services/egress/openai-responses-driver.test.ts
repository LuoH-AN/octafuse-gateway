import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { RouteResult } from '../model-router';
import {
	applyResponsesUsage,
	dispatchOpenAiResponsesRoute,
	ensureResponsesSequenceNumber,
	isResponsesTerminalEventType,
	processResponsesDataLine,
	syntheticMissingTerminalEvent,
	usageFromResponses,
} from './openai-responses-driver';
import type { UsageFromStream } from '../proxy';

function emptyUsage(): UsageFromStream {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
		total_tokens: 0,
		raw_usage: null,
	};
}

describe('openai-responses-driver usage', () => {
	it('parses Responses usage with cached and reasoning tokens', () => {
		const usage = usageFromResponses({
			input_tokens: 20,
			output_tokens: 30,
			total_tokens: 50,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens_details: { reasoning_tokens: 12 },
		});
		assert.equal(usage.input_tokens, 20);
		assert.equal(usage.output_tokens, 30);
		assert.equal(usage.cache_read_tokens, 4);
		assert.equal(usage.reasoning_tokens, 12);
		assert.equal(usage.total_tokens, 50);
	});

	it('accepts chat-style prompt/completion aliases', () => {
		const usage = usageFromResponses({
			prompt_tokens: 8,
			completion_tokens: 3,
			prompt_tokens_details: { cached_tokens: 2 },
			completion_tokens_details: { reasoning_tokens: 1 },
		});
		assert.equal(usage.input_tokens, 8);
		assert.equal(usage.output_tokens, 3);
		assert.equal(usage.cache_read_tokens, 2);
		assert.equal(usage.reasoning_tokens, 1);
		assert.equal(usage.total_tokens, 11);
	});
});

describe('openai-responses-driver SSE lines', () => {
	it('reads usage and response id from response.completed', () => {
		const usage = emptyUsage();
		const terminal = processResponsesDataLine(
			`data: ${JSON.stringify({
				type: 'response.completed',
				response: {
					id: 'resp_abc',
					usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
				},
			})}`,
			usage,
		);
		assert.equal(terminal, true);
		assert.equal(usage.upstreamMessageId, 'resp_abc');
		assert.equal(usage.input_tokens, 11);
		assert.equal(usage.output_tokens, 7);
	});

	it('marks stream_error on response.failed', () => {
		const usage = emptyUsage();
		const terminal = processResponsesDataLine(
			`data: ${JSON.stringify({
				type: 'response.failed',
				error: { message: 'model overloaded' },
			})}`,
			usage,
		);
		assert.equal(terminal, true);
		assert.equal(usage.stream_error, 'model overloaded');
	});

	it('does not treat output deltas as terminal', () => {
		assert.equal(isResponsesTerminalEventType('response.output_text.delta'), false);
		const usage = emptyUsage();
		assert.equal(
			processResponsesDataLine(
				`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}`,
				usage,
			),
			false,
		);
	});

	it('overwrites usage snapshots', () => {
		const usage = emptyUsage();
		applyResponsesUsage(usage, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
		applyResponsesUsage(usage, { input_tokens: 9, output_tokens: 4, total_tokens: 13 });
		assert.equal(usage.input_tokens, 9);
		assert.equal(usage.output_tokens, 4);
		assert.equal(usage.total_tokens, 13);
	});
});

describe('ensureResponsesSequenceNumber', () => {
	it('injects an incrementing sequence_number when the event is missing it', () => {
		const seq = { value: 0 };
		const a = ensureResponsesSequenceNumber(
			`data: ${JSON.stringify({ type: 'response.created' })}`,
			seq,
		);
		const b = ensureResponsesSequenceNumber(
			`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}`,
			seq,
		);
		assert.equal(JSON.parse(a.slice(6)).sequence_number, 0);
		assert.equal(JSON.parse(b.slice(6)).sequence_number, 1);
		assert.equal(seq.value, 2);
	});

	it('starts from 0 and preserves upstream sequence numbers without overwriting', () => {
		const seq = { value: 0 };
		// 上游已带 sequence_number=7，应原样保留且计数器越过去。
		const out = ensureResponsesSequenceNumber(
			`data: ${JSON.stringify({ type: 'response.output_text.done', sequence_number: 7 })}`,
			seq,
		);
		assert.equal(out, `data: ${JSON.stringify({ type: 'response.output_text.done', sequence_number: 7 })}`);
		assert.equal(JSON.parse(out.slice(6)).sequence_number, 7);
		assert.equal(seq.value, 8);

		// 下一个缺失事件应接着 8 注入，避免与上游重复。
		const next = ensureResponsesSequenceNumber(`data: {"type":"response.completed"}`, seq);
		assert.equal(JSON.parse(next.slice(6)).sequence_number, 8);
	});

	it('leaves non-data lines, [DONE], and non-object JSON untouched', () => {
		const seq = { value: 0 };
		assert.equal(ensureResponsesSequenceNumber('event: response.created', seq), 'event: response.created');
		assert.equal(ensureResponsesSequenceNumber('data: [DONE]', seq), 'data: [DONE]');
		assert.equal(ensureResponsesSequenceNumber('data: "just a string"', seq), 'data: "just a string"');
		assert.equal(ensureResponsesSequenceNumber('data: [1,2]', seq), 'data: [1,2]');
		assert.equal(seq.value, 0);
	});

	it('keeps the data: prefix and round-trips unknown fields', () => {
		const seq = { value: 0 };
		const input = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK', item_id: 'i_1' })}`;
		const out = ensureResponsesSequenceNumber(input, seq);
		const parsed = JSON.parse(out.slice(6));
		assert.equal(parsed.type, 'response.output_text.delta');
		assert.equal(parsed.delta, 'OK');
		assert.equal(parsed.item_id, 'i_1');
		assert.equal(parsed.sequence_number, 0);
	});

	it('synthetic terminal error event carries a sequence_number', () => {
		// 场景：上游已发 3 个事件（0/1/2），随后静默 EOF，网关补发 error 事件。
		const seq = { value: 0 };
		ensureResponsesSequenceNumber(`data: {"type":"response.created"}`, seq);
		ensureResponsesSequenceNumber(`data: {"type":"response.in_progress"}`, seq);
		ensureResponsesSequenceNumber(`data: {"type":"response.output_item.added"}`, seq);
		assert.equal(seq.value, 3);
		const out = syntheticMissingTerminalEvent(seq);
		const dataLine = out.split('\n').find((l) => l.startsWith('data: '));
		assert.ok(dataLine, 'synthetic event contains a data: line');
		const parsed = JSON.parse(dataLine!.slice(6));
		assert.equal(parsed.type, 'error');
		assert.equal(parsed.sequence_number, 3);
		assert.equal(seq.value, 4);
	});
});

describe('dispatchOpenAiResponsesRoute', () => {
	afterEach(() => {
		mock.reset();
	});

	function responsesRoute(): RouteResult {
		return {
			targetId: 't1',
			modelSurfaceId: 's1',
			routePoolId: 'p1',
			providerId: 'prov1',
			providerName: 'OpenAI',
			providerModelName: 'gpt-5',
			upstreamProtocol: 'openai',
			upstreamOperation: 'responses',
			adapter: 'passthrough',
			providerEndpoints: {
				openai: { base: 'https://api.openai.com/v1' },
			},
			providerApiKey: 'sk-test',
			priceOverrideRaw: null,
			routeMeteredProfileJson: null,
			routeChargedProfileJson: null,
			customParams: null,
			routeGroup: 'default',
			routePriority: 0,
			routeWeight: 1,
		};
	}

	function unsupportedToolResponse(tool = 'web_search'): Response {
		return Response.json({ error: {
			message: `Failed to convert responses request: Unsupported Responses tools type '${tool}': the Chat Completions adapter supports only function tools`,
			type: 'invalid_request_error',
		} }, { status: 400 });
	}

	for (const stream of [false, true]) {
		it(`recovers optional web search rejection while preserving function tools and ${stream ? 'streamed' : 'JSON'} usage`, async () => {
			const fn = { type: 'function', name: 'weather', parameters: { type: 'object' } };
			const body = {
				input: 'Call weather', stream, tools: [{ type: 'web_search' }, fn], tool_choice: 'auto',
				instructions: 'Be brief', reasoning: { effort: 'high', summary: 'auto' }, store: false,
			};
			const original = structuredClone(body);
			const requests: Record<string, unknown>[] = [];
			const output = [{ type: 'function_call', name: 'weather', call_id: 'call_1', arguments: '{}' }];
			const completed = { id: 'resp_1', status: 'completed', output, usage: { input_tokens: 13, output_tokens: 5 } };
			mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
				const wire = JSON.parse(init.body as string);
				requests.push(wire);
				assert.equal(new Headers(init.headers).get('authorization'), 'Bearer sk-test');
				if (requests.length === 1) return unsupportedToolResponse();
				assert.deepEqual(wire.tools, [fn]);
				assert.match(wire.instructions, /^Be brief\n\n.*web_search tool is unavailable/);
				assert.deepEqual(wire.reasoning, body.reasoning);
				assert.equal(wire.store, false);
				return stream
					? new Response(`data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`, {
						headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_retry' },
					})
					: Response.json(completed, { headers: { 'x-request-id': 'req_retry' } });
			});
			const result = await dispatchOpenAiResponsesRoute(responsesRoute(), body);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[0]!.tools, original.tools);
			assert.deepEqual(body, original);
			assert.equal(result.response.status, 200);
			assert.equal(result.upstreamRequestId, 'req_retry');
			assert.equal(result.response.headers.get('X-Octafuse-Disabled-Tools'), 'web_search');
			assert.match(result.response.headers.get('Warning')!, /optional tool disabled/);
			if (stream) {
				const text = await result.response.text();
				assert.match(text, /response.completed/);
				assert.match(text, /"sequence_number":0/);
				assert.match(text, /"call_id":"call_1"/);
			} else {
				assert.deepEqual(await result.response.json(), completed);
			}
			const usage = await result.usagePromise;
			assert.equal(usage.input_tokens, 13);
			assert.equal(usage.output_tokens, 5);
		});
	}

	it('forwards web search unchanged when the upstream supports it', async () => {
		const body = { input: 'Search', tools: [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }] };
		let calls = 0;
		mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
			calls++;
			assert.deepEqual(JSON.parse(init.body as string), { ...body, model: 'gpt-5' });
			return Response.json({ output: [{ type: 'web_search_call', status: 'completed' }] });
		});
		const result = await dispatchOpenAiResponsesRoute(responsesRoute(), body);
		assert.equal(calls, 1);
		assert.equal(result.response.headers.get('X-Octafuse-Disabled-Tools'), null);
	});

	for (const toolChoice of ['required', { type: 'web_search' }, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] }]) {
		it(`keeps explicit tool requirements ${JSON.stringify(toolChoice)} visible as errors`, async () => {
			let calls = 0;
			mock.method(globalThis, 'fetch', async () => { calls++; return unsupportedToolResponse(); });
			const result = await dispatchOpenAiResponsesRoute(responsesRoute(), {
				input: 'Search', tools: [{ type: 'web_search' }], tool_choice: toolChoice,
			});
			assert.equal(calls, 1);
			assert.equal(result.response.status, 400);
			assert.match(await result.response.text(), /Unsupported Responses tools type/);
			assert.equal(result.response.headers.get('X-Octafuse-Disabled-Tools'), null);
		});
	}

	it('does not mask unrelated errors or retry indefinitely', async () => {
		for (const kind of ['other-parameter', 'other-tool', 'second-error', 'sensitive']) {
			let calls = 0;
			mock.method(globalThis, 'fetch', async () => {
				calls++;
				if (kind === 'other-parameter') return Response.json({ error: { message: 'invalid temperature' } }, { status: 400 });
				if (kind === 'other-tool') return unsupportedToolResponse('code_interpreter');
				if (kind === 'sensitive') return Response.json({ error: { message: "Unsupported Responses tools type 'web_search': sensitive content blocked" } }, { status: 400 });
				return unsupportedToolResponse();
			});
			const result = await dispatchOpenAiResponsesRoute(responsesRoute(), { tools: [{ type: 'web_search' }] });
			assert.equal(calls, kind === 'second-error' ? 2 : 1);
			assert.equal(result.response.status, 400);
			await result.response.text();
			mock.reset();
		}
	});

	for (const toolChoice of ['required', { type: 'function', name: 'weather' }]) {
		it(`preserves function tool choice ${JSON.stringify(toolChoice)} when search is optional`, async () => {
			const fn = { type: 'function', name: 'weather', parameters: { type: 'object' } };
			let calls = 0;
			mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
				calls++;
				if (calls === 1) return unsupportedToolResponse();
				const wire = JSON.parse(init.body as string);
				assert.deepEqual(wire.tools, [fn]);
				assert.deepEqual(wire.tool_choice, toolChoice);
				return Response.json({ output: [{ type: 'function_call', name: 'weather', call_id: 'call_1', arguments: '{}' }] });
			});
			const result = await dispatchOpenAiResponsesRoute(responsesRoute(), {
				tools: [{ type: 'web_search' }, fn], tool_choice: toolChoice,
			});
			assert.equal(calls, 2);
			assert.equal(result.response.status, 200);
			assert.equal((await result.response.json() as { output: { name: string }[] }).output[0]!.name, 'weather');
		});
	}

	it('also handles optional preview search without removing client function tools', async () => {
		let calls = 0;
		mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
			calls++;
			if (calls === 1) return unsupportedToolResponse('web_search_preview');
			assert.deepEqual(JSON.parse(init.body as string).tools, []);
			return Response.json({ output: [] });
		});
		const result = await dispatchOpenAiResponsesRoute(responsesRoute(), { tools: [{ type: 'web_search_preview' }] });
		assert.equal(calls, 2);
		assert.equal(result.response.headers.get('X-Octafuse-Disabled-Tools'), 'web_search_preview');
	});

	for (const summary of [undefined, null]) {
		it(`repairs ${String(summary)} reasoning summary before a tool continuation reaches the upstream`, async () => {
			const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-state', summary };
			const body = {
				model: 'public-model',
				store: false,
				input: [
					{ role: 'user', content: 'Check the weather' },
					{ type: 'message', role: 'assistant', content: [] },
					reasoning,
					{ type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{}' },
					{ type: 'function_call_output', call_id: 'call_1', output: '{"temperature":20}' },
				],
				include: ['reasoning.encrypted_content'],
				tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }],
			};
			const original = structuredClone(body);
			let calls = 0;
			mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
				calls += 1;
				assert.equal(url, 'https://api.openai.com/v1/responses');
				const wire = JSON.parse(init.body as string);
				if (!Array.isArray(wire.input[2].summary)) {
					return Response.json({ error: { message: "Missing required parameter: 'input[2].summary'." } }, { status: 400 });
				}
				assert.deepEqual(wire, {
					...body,
					model: 'gpt-5',
					input: body.input.map((item, index) => index === 2 ? { ...reasoning, summary: [] } : item),
				});
				return Response.json({ id: 'resp_tool', output: [], usage: { input_tokens: 12, output_tokens: 3 } });
			});
			const result = await dispatchOpenAiResponsesRoute(responsesRoute(), body);
			assert.equal(result.response.status, 200);
			assert.equal(calls, 1);
			assert.deepEqual(body, original);
			assert.equal((await result.usagePromise).input_tokens, 12);
		});
	}

	it('normalizes reasoning after route defaults are forcibly merged', async () => {
		const route = responsesRoute();
		route.customParams = {
			body: { input: [{ type: 'reasoning', id: 'rs_default', encrypted_content: 'opaque' }] },
			force_override: { body: true },
		};
		mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
			assert.deepEqual(JSON.parse(init.body as string).input, [
				{ type: 'reasoning', id: 'rs_default', encrypted_content: 'opaque', summary: [] },
			]);
			return Response.json({ output: [] });
		});
		await dispatchOpenAiResponsesRoute(route, { input: 'client input' });
		assert.equal('summary' in (route.customParams.body as { input: object[] }).input[0]!, false);
	});

	it('preserves existing summaries, string input, and tool payloads', async () => {
		const inputs = [
			'Hello',
			[
				{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Checking weather' }] },
				{ type: 'reasoning', id: 'rs_2', summary: [] },
				{ type: 'reasoning', id: 'rs_invalid', summary: 'invalid value stays visible to upstream validation' },
				{ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'reasoning', encrypted_content: 'tool data' }] },
				{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
				null,
			],
		];
		for (const input of inputs) {
			mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
				assert.deepEqual(JSON.parse(init.body as string).input, input);
				return Response.json({ output: [] });
			});
			await dispatchOpenAiResponsesRoute(responsesRoute(), { input });
			mock.reset();
		}
	});

	it('repairs JSON reasoning outputs and preserves usage and rewrapped headers', async () => {
		const output = [
			{ type: 'reasoning', id: 'rs_json', encrypted_content: 'encrypted-json', status: 'completed' },
			{ type: 'function_call', call_id: 'call_json', name: 'weather', arguments: '{}' },
		];
		for (const wrapped of [false, true]) {
			const responseBody = { id: 'resp_json', output, usage: { input_tokens: 10, output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 } } };
			const upstream = wrapped ? { response: responseBody, custom: 'keep' } : responseBody;
			mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(upstream), {
				headers: { 'Content-Type': 'application/json', 'Content-Length': '123', 'Content-Encoding': 'gzip', 'x-request-id': 'req_json' },
			}));
			const result = await dispatchOpenAiResponsesRoute(responsesRoute(), { input: 'weather' });
			const normalized = { ...responseBody, output: [{ ...output[0], summary: [] }, output[1]] };
			assert.deepEqual(await result.response.json(), wrapped ? { response: normalized, custom: 'keep' } : normalized);
			assert.equal(result.response.headers.get('content-length'), null);
			assert.equal(result.response.headers.get('content-encoding'), null);
			assert.equal(result.response.headers.get('x-request-id'), 'req_json');
			assert.equal(result.upstreamRequestId, 'req_json');
			const usage = await result.usagePromise;
			assert.equal(usage.upstreamMessageId, 'resp_json');
			assert.equal(usage.input_tokens, 10);
			assert.equal(usage.reasoning_tokens, 2);
			mock.reset();
		}
	});

	it('keeps compliant JSON responses and upstream errors byte-for-byte', async () => {
		for (const status of [200, 400]) {
			const text = status === 200
				? '{ "id": "resp_ok", "output": [{"type":"reasoning","id":"rs_ok","summary":[]}], "usage": {"input_tokens":1} }'
				: '{ "error": { "message": "other invalid parameter", "output": [{"type":"reasoning"}] } }';
			mock.method(globalThis, 'fetch', async () => new Response(text, { status, headers: { 'Content-Type': 'application/json' } }));
			const result = await dispatchOpenAiResponsesRoute(responsesRoute(), { input: 'hello' });
			assert.equal(result.response.status, status);
			assert.equal(await result.response.text(), text);
			mock.reset();
		}
	});

	it('repairs SSE reasoning items and terminal output across chunk boundaries for tool replay', async () => {
		const added = { type: 'reasoning', id: 'rs_stream', encrypted_content: 'partial', status: 'in_progress' };
		const done = { type: 'reasoning', id: 'rs_stream', encrypted_content: 'complete', status: 'completed' };
		const summarized = { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: '天气' }] };
		const tool = { type: 'function_call', call_id: 'call_stream', name: 'weather', arguments: '{}' };
		const events = [
			{ type: 'response.output_item.added', sequence_number: 4, output_index: 0, item: added },
			{ type: 'response.output_item.done', output_index: 0, item: done },
			{ type: 'response.output_item.done', sequence_number: 6, output_index: 1, item: summarized },
			{ type: 'response.output_item.done', output_index: 2, item: tool },
			{ type: 'response.completed', sequence_number: 8, response: { id: 'resp_stream', output: [done, summarized, tool], usage: { input_tokens: 20, output_tokens: 5 } } },
		];
		const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join('\n\n');
		const bytes = new TextEncoder().encode(sse);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
				controller.close();
			},
		});
		mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
		const result = await dispatchOpenAiResponsesRoute(responsesRoute(), { input: 'weather', stream: true });
		const forwarded = (await result.response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
		assert.deepEqual(forwarded, [
			{ ...events[0], item: { ...added, summary: [] } },
			{ ...events[1], sequence_number: 5, item: { ...done, summary: [] } },
			events[2],
			{ ...events[3], sequence_number: 7 },
			{ ...events[4], response: { ...events[4]!.response, output: [{ ...done, summary: [] }, summarized, tool] } },
		]);
		const usage = await result.usagePromise;
		assert.equal(usage.input_tokens, 20);
		assert.equal(usage.output_tokens, 5);
		assert.equal(usage.stream_error, undefined);
		mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
			const wire = JSON.parse(init.body as string);
			assert.equal(wire.input[0].encrypted_content, 'complete');
			assert.deepEqual(wire.input[0].summary, []);
			assert.deepEqual(wire.input[1].summary, summarized.summary);
			assert.equal(wire.input[2].call_id, wire.input[3].call_id);
			return Response.json({ id: 'resp_continued', output: [] });
		});
		const continuation = await dispatchOpenAiResponsesRoute(responsesRoute(), {
			input: [...forwarded.at(-1)!.response.output, { type: 'function_call_output', call_id: 'call_stream', output: 'sunny' }],
		});
		assert.equal(continuation.response.status, 200);
	});

	it('returns 524 when the first SSE event exceeds firstEventTimeoutMs', async () => {
		const hung = new ReadableStream<Uint8Array>({
			start() {},
			cancel() {},
		});
		mock.method(globalThis, 'fetch', async () =>
			new Response(hung, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		);
		const result = await dispatchOpenAiResponsesRoute(
			responsesRoute(),
			{ stream: true },
			undefined,
			null,
			undefined,
			{ firstEventTimeoutMs: 20 }
		);
		assert.equal(result.response.status, 524);
		const usage = await result.usagePromise;
		assert.equal(usage.input_tokens, 0);
	});

	it('writes a stream_idle_timeout error event once when the upstream goes idle', async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							type: 'response.output_text.delta',
							sequence_number: 0,
							delta: 'hi',
						})}\n\n`
					)
				);
			},
			cancel() {},
		});
		mock.method(globalThis, 'fetch', async () =>
			new Response(stream, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		);
		const result = await dispatchOpenAiResponsesRoute(
			responsesRoute(),
			{ stream: true },
			undefined,
			null,
			undefined,
			{ idleTimeoutMs: 40 }
		);
		const [usage, text] = await Promise.all([result.usagePromise, result.response.text()]);
		assert.equal(usage.stream_error, 'Stream idle timeout');
		assert.equal(text.split('event: error').length - 1, 1, text);
		assert.ok(text.includes('"code":"stream_idle_timeout"'), text);
		assert.ok(text.includes('"sequence_number"'), text);
	});
});
