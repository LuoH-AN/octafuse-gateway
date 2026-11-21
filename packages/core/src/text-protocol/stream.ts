import {
	argumentsObject,
	object,
	objects,
	string,
	TextProtocolError,
	type JsonObject,
	type TextProtocol,
} from './request';
import {
	decodeTextFinish,
	decodeTextResponse,
	decodeTextUsage,
	emptyTextUsage,
	encodeTextFinish,
	encodeTextResponse,
	encodeTextUsage,
	textErrorPayload,
	type TextFinish,
	type TextUsage,
} from './response';

type ToolDelta = { id: string; name: string; args: string; signature?: string };
/** Per-response state: text is streamed immediately; JSON tool arguments are buffered for Gemini. */
export class TextStreamConverter {
	private id = `gateway_${crypto.randomUUID()}`;
	private started = false;
	private ended = false;
	private upstreamTerminal = false;
	private finish: TextFinish = 'stop';
	private usage = emptyTextUsage();
	private tools = new Map<number, ToolDelta>();
	private blockIndex = -1;
	private activeBlock: 'text' | 'thinking' | null = null;
	private created = Math.floor(Date.now() / 1000);
	constructor(
		private from: TextProtocol,
		private to: TextProtocol,
		private model: string,
		private includeUsage: boolean
	) {}

	private frame(payload: JsonObject, event?: string): string {
		return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
	}
	private chat(delta: JsonObject, finish: string | null = null): string {
		return this.frame({
			id: this.id,
			object: 'chat.completion.chunk',
			created: this.created,
			model: this.model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	}
	private gemini(parts: JsonObject[], finish?: string): string {
		return this.frame({
			responseId: this.id,
			modelVersion: this.model,
			candidates: [
				{
					index: 0,
					content: { role: 'model', parts },
					...(finish ? { finishReason: finish } : {}),
				},
			],
			...(finish ? { usageMetadata: encodeTextUsage('gemini', this.usage) } : {}),
		});
	}
	private begin(): string[] {
		if (this.started) return [];
		this.started = true;
		if (this.to === 'openai') return [this.chat({ role: 'assistant' })];
		if (this.to === 'anthropic')
			return [
				this.frame(
					{
						type: 'message_start',
						message: {
							id: this.id,
							type: 'message',
							role: 'assistant',
							model: this.model,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: encodeTextUsage('anthropic', this.usage),
						},
					},
					'message_start'
				),
			];
		return [];
	}
	private closeBlock(): string[] {
		if (!this.activeBlock) return [];
		this.activeBlock = null;
		return [
			this.frame({ type: 'content_block_stop', index: this.blockIndex }, 'content_block_stop'),
		];
	}
	private text(text: string, thinking = false): string[] {
		if (!text) return [];
		const out = this.begin();
		if (this.to === 'openai')
			return [...out, this.chat({ [thinking ? 'reasoning_content' : 'content']: text })];
		if (this.to === 'gemini')
			return [...out, this.gemini([{ text, ...(thinking ? { thought: true } : {}) }])];
		const kind = thinking ? 'thinking' : 'text';
		if (this.activeBlock !== kind) {
			out.push(...this.closeBlock());
			this.activeBlock = kind;
			this.blockIndex++;
			out.push(
				this.frame(
					{
						type: 'content_block_start',
						index: this.blockIndex,
						content_block: thinking
							? { type: 'thinking', thinking: '', signature: '' }
							: { type: 'text', text: '' },
					},
					'content_block_start'
				)
			);
		}
		out.push(
			this.frame(
				{
					type: 'content_block_delta',
					index: this.blockIndex,
					delta: thinking
						? { type: 'thinking_delta', thinking: text }
						: { type: 'text_delta', text },
				},
				'content_block_delta'
			)
		);
		return out;
	}
	private tool(index: number, delta: Partial<ToolDelta>): string[] {
		const out = this.begin();
		const previous = this.tools.get(index);
		const tool = previous ?? { id: delta.id || `call_gateway_${index}`, name: '', args: '' };
		if (delta.id) tool.id = delta.id;
		if (delta.name) tool.name += delta.name;
		if (delta.args) tool.args += delta.args;
		if (delta.signature) tool.signature = delta.signature;
		this.tools.set(index, tool);
		if (this.to === 'openai')
			out.push(
				this.chat({
					tool_calls: [
						{
							index: [...this.tools.keys()].indexOf(index),
							...(!previous ? { id: tool.id, type: 'function' } : {}),
							function: {
								...(delta.name ? { name: delta.name } : {}),
								...(delta.args ? { arguments: delta.args } : {}),
							},
							...(delta.signature
								? { extra_content: { google: { thought_signature: delta.signature } } }
								: {}),
						},
					],
				})
			);
		return out;
	}

	consume(payload: JsonObject): string[] {
		if (this.ended) return [];
		if (payload.error || payload.type === 'error') {
			throw new TextProtocolError(
				string(object(payload.error).message) || 'Upstream stream returned an error'
			);
		}
		const out: string[] = [];
		if (!this.started)
			this.id = string(payload.id ?? payload.responseId ?? object(payload.message).id) || this.id;
		if (this.from === 'openai') {
			if (payload.usage) this.usage = decodeTextUsage('openai', object(payload.usage));
			const choices = objects(payload.choices);
			if (choices.some((c) => (c.index ?? 0) !== 0))
				throw new TextProtocolError('Multiple stream choices are not supported');
			for (const c of choices) {
				const delta = object(c.delta);
				out.push(...this.text(string(delta.reasoning_content ?? delta.reasoning), true));
				out.push(...this.text(string(delta.content ?? delta.refusal)));
				for (const call of objects(delta.tool_calls)) {
					const f = object(call.function);
					out.push(
						...this.tool(typeof call.index === 'number' ? call.index : 0, {
							id: string(call.id),
							name: string(f.name),
							args: string(f.arguments),
							signature:
								string(object(object(call.extra_content).google).thought_signature) || undefined,
						})
					);
				}
				if (c.finish_reason != null) {
					this.finish = decodeTextFinish(c.finish_reason, this.tools.size > 0);
					this.upstreamTerminal = true;
				}
			}
		} else if (this.from === 'anthropic') {
			const index = typeof payload.index === 'number' ? payload.index : 0;
			if (payload.type === 'message_start') {
				this.usage = decodeTextUsage('anthropic', object(object(payload.message).usage));
				out.push(...this.begin());
			} else if (payload.type === 'content_block_start') {
				const block = object(payload.content_block);
				if (block.type === 'tool_use')
					out.push(
						...this.tool(index, {
							id: string(block.id),
							name: string(block.name),
							args: Object.keys(object(block.input)).length ? JSON.stringify(block.input) : '',
							signature:
								string(object(object(block.extra_content).google).thought_signature) || undefined,
						})
					);
				else if (block.type === 'text') out.push(...this.text(string(block.text)));
				else if (block.type === 'thinking') out.push(...this.text(string(block.thinking), true));
				else if (block.type !== 'redacted_thinking')
					throw new TextProtocolError(`Unsupported stream content block ${block.type}`);
			} else if (payload.type === 'content_block_delta') {
				const d = object(payload.delta);
				if (d.type === 'text_delta') out.push(...this.text(string(d.text)));
				else if (d.type === 'thinking_delta') out.push(...this.text(string(d.thinking), true));
				else if (d.type === 'input_json_delta')
					out.push(...this.tool(index, { args: string(d.partial_json) }));
				else if (d.type !== 'signature_delta')
					throw new TextProtocolError(`Unsupported stream delta ${d.type}`);
			} else if (payload.type === 'message_delta') {
				if (payload.usage)
					this.usage = decodeTextUsage('anthropic', object(payload.usage), this.usage);
				this.finish = decodeTextFinish(object(payload.delta).stop_reason, this.tools.size > 0);
			} else if (payload.type === 'message_stop') this.upstreamTerminal = true;
		} else {
			if (payload.usageMetadata)
				this.usage = decodeTextUsage('gemini', object(payload.usageMetadata));
			if (object(payload.promptFeedback).blockReason) {
				this.finish = 'content_filter';
				this.upstreamTerminal = true;
			}
			for (const c of objects(payload.candidates)) {
				if ((c.index ?? 0) !== 0)
					throw new TextProtocolError('Multiple stream candidates are not supported');
				for (const part of objects(object(c.content).parts)) {
					if (typeof part.text === 'string')
						out.push(...this.text(part.text, part.thought === true));
					else if (part.functionCall) {
						const call = object(part.functionCall);
						out.push(
							...this.tool(this.tools.size, {
								id: string(call.id),
								name: string(call.name),
								args: JSON.stringify(call.args ?? {}),
								signature: string(part.thoughtSignature) || undefined,
							})
						);
					} else throw new TextProtocolError('Unsupported non-text stream output');
				}
				if (c.usageMetadata) this.usage = decodeTextUsage('gemini', object(c.usageMetadata));
				if (c.finishReason) {
					this.finish = decodeTextFinish(c.finishReason, this.tools.size > 0);
					this.upstreamTerminal = true;
				}
			}
		}
		return out;
	}

	doneMarker(): void {
		if (this.from === 'openai') this.upstreamTerminal = true;
	}
	finalize(): string[] {
		if (this.ended) return [];
		if (!this.upstreamTerminal)
			throw new TextProtocolError('Upstream stream ended without a terminal event');
		// Validate even when forwarding deltas to OpenAI: partial JSON must not end as success.
		const calls = [...this.tools.values()].map((t) => ({ ...t, input: argumentsObject(t.args) }));
		const out = this.begin();
		if (this.to === 'anthropic') {
			out.push(...this.closeBlock());
			for (const t of calls) {
				const index = ++this.blockIndex;
				out.push(
					this.frame(
						{
							type: 'content_block_start',
							index,
							content_block: {
								type: 'tool_use', id: t.id, name: t.name, input: {},
								...(t.signature
									? { extra_content: { google: { thought_signature: t.signature } } }
									: {}),
							},
						},
						'content_block_start'
					)
				);
				out.push(
					this.frame(
						{
							type: 'content_block_delta',
							index,
							delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) },
						},
						'content_block_delta'
					)
				);
				out.push(this.frame({ type: 'content_block_stop', index }, 'content_block_stop'));
			}
			out.push(
				this.frame(
					{
						type: 'message_delta',
						delta: { stop_reason: encodeTextFinish('anthropic', this.finish), stop_sequence: null },
						usage: encodeTextUsage('anthropic', this.usage),
					},
					'message_delta'
				)
			);
			out.push(this.frame({ type: 'message_stop' }, 'message_stop'));
		} else if (this.to === 'gemini') {
			if (calls.length)
				out.push(
					this.gemini(
						calls.map((t) => ({
							functionCall: { id: t.id, name: t.name, args: t.input },
							...(t.signature ? { thoughtSignature: t.signature } : {}),
						}))
					)
				);
			out.push(this.gemini([], encodeTextFinish('gemini', this.finish)));
		} else {
			out.push(this.chat({}, encodeTextFinish('openai', this.finish)));
			if (this.includeUsage)
				out.push(
					this.frame({
						id: this.id,
						object: 'chat.completion.chunk',
						created: this.created,
						model: this.model,
						choices: [],
						usage: encodeTextUsage('openai', this.usage),
					})
				);
			out.push('data: [DONE]\n\n');
		}
		this.ended = true;
		return out;
	}
	fail(message: string): string[] {
		if (this.ended) return [];
		this.ended = true;
		return [
			this.frame(
				textErrorPayload(this.to, message, 502),
				this.to === 'anthropic' ? 'error' : undefined
			),
		];
	}
}

function rewrappedHeaders(source: Headers, stream: boolean): Headers {
	const headers = new Headers(source);
	for (const key of ['content-length', 'content-encoding', 'transfer-encoding', 'connection'])
		headers.delete(key);
	headers.set('Content-Type', stream ? 'text/event-stream; charset=utf-8' : 'application/json');
	if (stream) headers.set('Cache-Control', 'no-cache');
	return headers;
}

/** Cancellation propagates to the existing driver, which retains its bounded usage drain. */
export async function convertTextHttpResponse(
	response: Response,
	from: TextProtocol,
	to: TextProtocol,
	options: { model: string; includeUsage?: boolean }
): Promise<{ response: Response; completion: Promise<string | null> }> {
	if (!response.ok) {
		let payload: JsonObject = {};
		try {
			payload = object(await response.json());
		} catch {
			/* non-JSON upstream error */
		}
		const error = object(payload.error);
		const message = string(error.message ?? payload.message) || `Upstream HTTP ${response.status}`;
		return {
			response: new Response(
				JSON.stringify(
					textErrorPayload(to, message, response.status, string(error.code) || undefined)
				),
				{ status: response.status, headers: rewrappedHeaders(response.headers, false) }
			),
			completion: Promise.resolve(null),
		};
	}
	if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		try {
			const decoded = decodeTextResponse(from, object(await response.json()), options.model);
			return {
				response: new Response(JSON.stringify(encodeTextResponse(to, decoded)), {
					status: response.status,
					headers: rewrappedHeaders(response.headers, false),
				}),
				completion: Promise.resolve(null),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Invalid upstream response';
			return {
				response: new Response(JSON.stringify(textErrorPayload(to, message, 502)), {
					status: 502,
					headers: rewrappedHeaders(response.headers, false),
				}),
				completion: Promise.resolve(message),
			};
		}
	}
	const converter = new TextStreamConverter(from, to, options.model, options.includeUsage === true);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const reader = response.body!.getReader();
	let carry = '';
	let resolveCompletion!: (error: string | null) => void;
	const completion = new Promise<string | null>((resolve) => {
		resolveCompletion = resolve;
	});
	let settled = false;
	const settle = (error: string | null) => {
		if (!settled) {
			settled = true;
			resolveCompletion(error);
		}
	};
	const readFrames = (): string[] => {
		const output: string[] = [];
		carry = carry.replace(/\r\n/g, '\n');
		let end: number;
		while ((end = carry.indexOf('\n\n')) !== -1) {
			const frame = carry.slice(0, end);
			carry = carry.slice(end + 2);
			const data = frame
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())
				.join('\n');
			if (!data.trim()) continue;
			if (data.trim() === '[DONE]') converter.doneMarker();
			else output.push(...converter.consume(object(JSON.parse(data))));
		}
		if (carry.length > 4 * 1024 * 1024)
			throw new TextProtocolError('Upstream SSE frame exceeds 4MB');
		return output;
	};
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) {
						carry += decoder.decode();
						if (carry.trim()) carry += '\n\n';
						const out = [...readFrames(), ...converter.finalize()];
						if (out.length) controller.enqueue(encoder.encode(out.join('')));
						settle(null);
						controller.close();
						return;
					} else {
						carry += decoder.decode(chunk.value, { stream: true });
						const out = readFrames();
						if (out.length) {
							controller.enqueue(encoder.encode(out.join('')));
							return;
						}
					}
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Protocol stream conversion failed';
				settle(message);
				try {
					controller.enqueue(encoder.encode(converter.fail(message).join('')));
					controller.close();
				} catch {
					/* client cancelled */
				}
				void reader.cancel().catch(() => {});
			}
		},
		async cancel(reason) {
			settle(null);
			await reader.cancel(reason);
		},
	});
	return {
		response: new Response(stream, {
			status: response.status,
			headers: rewrappedHeaders(response.headers, true),
		}),
		completion,
	};
}
