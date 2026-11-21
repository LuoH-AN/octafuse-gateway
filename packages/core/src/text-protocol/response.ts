import {
	argumentsObject,
	object,
	objects,
	string,
	TextProtocolError,
	type JsonObject,
	type TextPart,
	type TextProtocol,
} from './request';

export type TextUsage = {
	input: number;
	output: number;
	cached: number;
	cacheWrite: number;
	reasoning: number;
};
export type TextFinish = 'stop' | 'length' | 'tool_calls' | 'content_filter';
export type TextResponse = {
	id: string;
	model: string;
	parts: TextPart[];
	finish: TextFinish;
	usage: TextUsage;
};
export function emptyTextUsage(): TextUsage {
	return { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
}
function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Keep native usage semantics at the boundary; billing continues to use the upstream driver. */
export function decodeTextUsage(
	protocol: TextProtocol,
	raw: JsonObject,
	previous = emptyTextUsage()
): TextUsage {
	if (protocol === 'openai')
		return {
			input: count(raw.prompt_tokens),
			output: count(raw.completion_tokens),
			cached: count(object(raw.prompt_tokens_details).cached_tokens),
			cacheWrite: count(object(raw.prompt_tokens_details).cache_creation_tokens),
			reasoning: count(object(raw.completion_tokens_details).reasoning_tokens),
		};
	if (protocol === 'anthropic') {
		const cached =
			raw.cache_read_input_tokens == null ? previous.cached : count(raw.cache_read_input_tokens);
		const cacheWrite =
			raw.cache_creation_input_tokens == null
				? previous.cacheWrite
				: count(raw.cache_creation_input_tokens);
		return {
			input:
				raw.input_tokens == null ? previous.input : count(raw.input_tokens) + cached + cacheWrite,
			output: raw.output_tokens == null ? previous.output : count(raw.output_tokens),
			cached,
			cacheWrite,
			reasoning: 0,
		};
	}
	const reasoning = count(raw.thoughtsTokenCount ?? raw.thinkingTokenCount);
	return {
		input: count(raw.promptTokenCount),
		output: count(raw.candidatesTokenCount) + reasoning,
		cached: count(raw.cachedContentTokenCount),
		cacheWrite: 0,
		reasoning,
	};
}

export function encodeTextUsage(protocol: TextProtocol, usage: TextUsage): JsonObject {
	if (protocol === 'openai')
		return {
			prompt_tokens: usage.input,
			completion_tokens: usage.output,
			total_tokens: usage.input + usage.output,
			prompt_tokens_details: {
				cached_tokens: usage.cached,
				cache_creation_tokens: usage.cacheWrite,
			},
			completion_tokens_details: { reasoning_tokens: usage.reasoning },
		};
	if (protocol === 'anthropic')
		return {
			input_tokens: Math.max(0, usage.input - usage.cached - usage.cacheWrite),
			output_tokens: usage.output,
			cache_read_input_tokens: usage.cached,
			cache_creation_input_tokens: usage.cacheWrite,
		};
	return {
		promptTokenCount: usage.input,
		candidatesTokenCount: Math.max(0, usage.output - usage.reasoning),
		totalTokenCount: usage.input + usage.output,
		cachedContentTokenCount: usage.cached,
		thoughtsTokenCount: usage.reasoning,
	};
}

export function decodeTextFinish(reason: unknown, hasCalls: boolean): TextFinish {
	if (['length', 'max_tokens', 'MAX_TOKENS'].includes(string(reason))) return 'length';
	if (
		[
			'content_filter',
			'refusal',
			'SAFETY',
			'RECITATION',
			'BLOCKLIST',
			'PROHIBITED_CONTENT',
			'SPII',
			'IMAGE_SAFETY',
		].includes(string(reason))
	)
		return 'content_filter';
	if (hasCalls || ['tool_calls', 'function_call', 'tool_use'].includes(string(reason)))
		return 'tool_calls';
	return 'stop';
}
export function encodeTextFinish(protocol: TextProtocol, finish: TextFinish): string {
	if (protocol === 'openai') return finish;
	if (protocol === 'anthropic')
		return finish === 'length'
			? 'max_tokens'
			: finish === 'tool_calls'
			? 'tool_use'
			: finish === 'content_filter'
			? 'refusal'
			: 'end_turn';
	return finish === 'length' ? 'MAX_TOKENS' : finish === 'content_filter' ? 'SAFETY' : 'STOP';
}

export function decodeTextResponse(
	protocol: TextProtocol,
	body: JsonObject,
	fallbackModel: string
): TextResponse {
	const parts: TextPart[] = [];
	let finish: unknown;
	let nativeUsage: JsonObject;
	if (protocol === 'openai') {
		const choices = objects(body.choices);
		if (choices.length !== 1)
			throw new TextProtocolError('Expected exactly one Chat response choice');
		const choice = choices[0]!;
		const message = object(choice.message);
		if (typeof message.reasoning_content === 'string')
			parts.push({ type: 'thinking', text: message.reasoning_content });
		if (typeof message.content === 'string') parts.push({ type: 'text', text: message.content });
		else
			for (const p of objects(message.content)) {
				if (p.type !== 'text')
					throw new TextProtocolError('Upstream returned unsupported non-text output');
				parts.push({ type: 'text', text: string(p.text) });
			}
		if (message.refusal) parts.push({ type: 'text', text: string(message.refusal) });
		for (const call of objects(message.tool_calls)) {
			const f = object(call.function);
			parts.push({
				type: 'call',
				id: string(call.id),
				name: string(f.name),
				args: argumentsObject(f.arguments),
				signature: string(object(object(call.extra_content).google).thought_signature) || undefined,
			});
		}
		finish = choice.finish_reason;
		nativeUsage = object(body.usage);
	} else if (protocol === 'anthropic') {
		if (!Array.isArray(body.content))
			throw new TextProtocolError('Expected Anthropic response content');
		for (const p of objects(body.content)) {
			if (p.type === 'text') parts.push({ type: 'text', text: string(p.text) });
			else if (p.type === 'thinking') parts.push({ type: 'thinking', text: string(p.thinking) });
			else if (p.type === 'tool_use')
				parts.push({
					type: 'call',
					id: string(p.id),
					name: string(p.name),
					args: argumentsObject(p.input),
					signature: string(object(object(p.extra_content).google).thought_signature) || undefined,
				});
			else if (p.type !== 'redacted_thinking')
				throw new TextProtocolError(`Unsupported upstream content block ${p.type}`);
		}
		finish = body.stop_reason;
		nativeUsage = object(body.usage);
	} else {
		const candidates = objects(body.candidates);
		if (candidates.length > 1) throw new TextProtocolError('Expected exactly one Gemini candidate');
		if (!candidates.length && !object(body.promptFeedback).blockReason)
			throw new TextProtocolError('Gemini response has no candidates');
		const candidate = candidates[0] ?? {};
		for (const p of objects(object(candidate.content).parts)) {
			if (typeof p.text === 'string')
				parts.push({ type: p.thought === true ? 'thinking' : 'text', text: p.text });
			else if (p.functionCall) {
				const call = object(p.functionCall);
				parts.push({
					type: 'call',
					id: string(call.id) || `call_gateway_${parts.length}`,
					name: string(call.name),
					args: argumentsObject(call.args),
					signature: string(p.thoughtSignature) || undefined,
				});
			} else throw new TextProtocolError('Upstream returned unsupported non-text output');
		}
		finish =
			candidate.finishReason ?? (object(body.promptFeedback).blockReason ? 'SAFETY' : 'STOP');
		nativeUsage = object(body.usageMetadata ?? candidate.usageMetadata);
	}
	return {
		id: string(body.id ?? body.responseId) || `gateway_${crypto.randomUUID()}`,
		model: fallbackModel,
		parts,
		finish: decodeTextFinish(
			finish,
			parts.some((p) => p.type === 'call')
		),
		usage: decodeTextUsage(protocol, nativeUsage),
	};
}

export function encodeTextResponse(protocol: TextProtocol, response: TextResponse): JsonObject {
	const { id, model, parts, finish, usage } = response;
	if (protocol === 'openai') {
		const text = parts
			.filter((p) => p.type === 'text')
			.map((p) => (p.type === 'text' ? p.text : ''))
			.join('');
		const thinking = parts
			.filter((p) => p.type === 'thinking')
			.map((p) => (p.type === 'thinking' ? p.text : ''))
			.join('');
		const calls = parts.flatMap((p) =>
			p.type === 'call'
				? [
						{
							id: p.id,
							type: 'function',
							function: { name: p.name, arguments: JSON.stringify(p.args) },
							...(p.signature
								? { extra_content: { google: { thought_signature: p.signature } } }
								: {}),
						},
				  ]
				: []
		);
		return {
			id,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: text || (calls.length ? null : ''),
						...(thinking ? { reasoning_content: thinking } : {}),
						...(calls.length ? { tool_calls: calls } : {}),
					},
					finish_reason: encodeTextFinish(protocol, finish),
				},
			],
			usage: encodeTextUsage(protocol, usage),
		};
	}
	if (protocol === 'anthropic')
		return {
			id,
			type: 'message',
			role: 'assistant',
			model,
			content: parts.flatMap((p) =>
				p.type === 'text'
					? [{ type: 'text', text: p.text } as JsonObject]
					: p.type === 'thinking'
					? [{ type: 'thinking', thinking: p.text, signature: '' }]
					: p.type === 'call'
					? [{
							type: 'tool_use', id: p.id, name: p.name, input: p.args,
							...(p.signature
								? { extra_content: { google: { thought_signature: p.signature } } }
								: {}),
						}]
					: []
			),
			stop_reason: encodeTextFinish(protocol, finish),
			stop_sequence: null,
			usage: encodeTextUsage(protocol, usage),
		};
	return {
		responseId: id,
		modelVersion: model,
		candidates: [
			{
				index: 0,
				content: {
					role: 'model',
					parts: parts.flatMap((p) =>
						p.type === 'text'
							? [{ text: p.text } as JsonObject]
							: p.type === 'thinking'
							? [{ text: p.text, thought: true }]
							: p.type === 'call'
							? [
									{
										functionCall: { id: p.id, name: p.name, args: p.args },
										...(p.signature ? { thoughtSignature: p.signature } : {}),
									},
							  ]
							: []
					),
				},
				finishReason: encodeTextFinish(protocol, finish),
			},
		],
		usageMetadata: encodeTextUsage(protocol, usage),
	};
}

export function textErrorPayload(
	protocol: TextProtocol,
	message: string,
	status: number,
	code = 'protocol_conversion_error'
): JsonObject {
	if (protocol === 'anthropic')
		return {
			type: 'error',
			error: { type: status === 400 ? 'invalid_request_error' : 'api_error', message },
		};
	if (protocol === 'gemini')
		return {
			error: {
				code: status,
				message,
				status:
					status === 400 ? 'INVALID_ARGUMENT' : status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL',
			},
		};
	return { error: { message, type: status === 400 ? 'invalid_request_error' : 'api_error', code } };
}
