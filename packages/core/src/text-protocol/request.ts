/** Portable text conversation model. Vendor-native passthrough never enters this layer. */
export type TextProtocol = "openai" | "anthropic" | "gemini";
export type JsonObject = Record<string, unknown>;
export type TextPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "image"; url: string }
	| {
			type: "call";
			id: string;
			name: string;
			args: JsonObject;
			signature?: string;
	  }
	| {
			type: "result";
			id: string;
			name?: string;
			parts: TextPart[];
			isError?: boolean;
	  };
export type TextMessage = {
	role: "system" | "user" | "assistant";
	parts: TextPart[];
};
type TextTool = { name: string; description?: string; schema: JsonObject };
type ToolChoice = "auto" | "none" | "required" | { name: string };
export type TextRequest = {
	messages: TextMessage[];
	tools: TextTool[];
	choice?: ToolChoice;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	stop?: string[];
	json?: { schema?: JsonObject };
	thinking?: { budget?: number; effort?: string };
	parallel?: boolean;
};

export class TextProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TextProtocolError";
	}
}
export function object(value: unknown): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}
export function objects(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.map(object) : [];
}
export function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function number(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
function unsupported(feature: string): never {
	throw new TextProtocolError(
		`Text protocol conversion does not support ${feature}; use a native passthrough route`
	);
}
export function argumentsObject(value: unknown): JsonObject {
	if (typeof value === "string") {
		try {
			return argumentsObject(JSON.parse(value || "{}"));
		} catch {
			throw new TextProtocolError("Function arguments must be a JSON object");
		}
	}
	if (value == null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		throw new TextProtocolError("Function arguments must be a JSON object");
	return value as JsonObject;
}

function parseParts(protocol: TextProtocol, value: unknown): TextPart[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (value == null) return [];
	if (!Array.isArray(value))
		throw new TextProtocolError(
			"Message content must be text or an array of content parts"
		);
	return value.flatMap((raw): TextPart[] => {
		const p = object(raw);
		if (protocol === "gemini") {
			if (typeof p.text === "string")
				return [
					{ type: p.thought === true ? "thinking" : "text", text: p.text },
				];
			const inline = object(p.inlineData ?? p.inline_data);
			if (inline.data != null) {
				const mime = string(inline.mimeType ?? inline.mime_type);
				if (!mime.startsWith("image/")) unsupported(`inline media ${mime}`);
				return [
					{ type: "image", url: `data:${mime};base64,${string(inline.data)}` },
				];
			}
			const file = object(p.fileData ?? p.file_data);
			if (file.fileUri != null || file.file_uri != null) {
				if (!string(file.mimeType ?? file.mime_type).startsWith("image/"))
					unsupported("file media");
				return [{ type: "image", url: string(file.fileUri ?? file.file_uri) }];
			}
			const call = object(p.functionCall ?? p.function_call);
			if (call.name)
				return [
					{
						type: "call",
						id: string(call.id),
						name: string(call.name),
						args: argumentsObject(call.args),
						signature:
							string(p.thoughtSignature ?? p.thought_signature) || undefined,
					},
				];
			const result = object(p.functionResponse ?? p.function_response);
			if (result.name)
				return [
					{
						type: "result",
						id: string(result.id),
						name: string(result.name),
						parts: [
							{ type: "text", text: JSON.stringify(result.response ?? {}) },
						],
					},
				];
		} else {
			if (p.type === "text") return [{ type: "text", text: string(p.text) }];
			if (p.type === "thinking")
				return [{ type: "thinking", text: string(p.thinking) }];
			if (p.type === "redacted_thinking") return [];
			if (p.type === "image_url")
				return [{ type: "image", url: string(object(p.image_url).url) }];
			if (p.type === "image") {
				const s = object(p.source);
				if (s.type === "url") return [{ type: "image", url: string(s.url) }];
				if (s.type === "base64")
					return [
						{
							type: "image",
							url: `data:${string(s.media_type)};base64,${string(s.data)}`,
						},
					];
			}
			if (p.type === "tool_use")
				return [
					{
						type: "call",
						id: string(p.id),
						name: string(p.name),
						args: argumentsObject(p.input),
						signature:
							string(object(object(p.extra_content).google).thought_signature) || undefined,
					},
				];
			if (p.type === "tool_result")
				return [
					{
						type: "result",
						id: string(p.tool_use_id),
						parts: parseParts(protocol, p.content),
						isError: p.is_error === true,
					},
				];
		}
		return unsupported(
			`content part ${string(p.type) || Object.keys(p).join(",")}`
		);
	});
}

export function decodeTextRequest(
	protocol: TextProtocol,
	body: JsonObject
): TextRequest {
	const messages: TextMessage[] = [];
	const tools: TextTool[] = [];
	const config =
		protocol === "gemini"
			? object(body.generationConfig ?? body.generation_config)
			: body;
	const req: TextRequest = { messages, tools };
	if (protocol === "gemini") {
		const system = object(body.systemInstruction ?? body.system_instruction);
		if (system.parts)
			messages.push({
				role: "system",
				parts: parseParts(protocol, system.parts),
			});
		for (const m of objects(body.contents)) {
			if (m.role != null && m.role !== "user" && m.role !== "model")
				unsupported(`Gemini role ${m.role}`);
			messages.push({
				role: m.role === "model" ? "assistant" : "user",
				parts: parseParts(protocol, m.parts),
			});
		}
		for (const t of objects(body.tools)) {
			const declarations = t.functionDeclarations ?? t.function_declarations;
			if (
				!Array.isArray(declarations) ||
				Object.keys(t).some(
					(k) => !["functionDeclarations", "function_declarations"].includes(k)
				)
			)
				unsupported("Gemini built-in tools");
			for (const f of objects(declarations))
				tools.push({
					name: string(f.name),
					description: string(f.description) || undefined,
					schema: object(
						f.parametersJsonSchema ?? f.parameters_json_schema ?? f.parameters
					),
				});
		}
		const choice = object(
			object(body.toolConfig ?? body.tool_config).functionCallingConfig ??
				object(body.tool_config).function_calling_config
		);
		const allowed =
			choice.allowedFunctionNames ?? choice.allowed_function_names;
		if (Array.isArray(allowed) && allowed.length > 1)
			unsupported("multiple allowed function names");
		if (Array.isArray(allowed) && allowed.length === 1)
			req.choice = { name: string(allowed[0]) };
		else if (choice.mode != null) {
			if (!["AUTO", "NONE", "ANY"].includes(string(choice.mode)))
				unsupported(`function calling mode ${choice.mode}`);
			req.choice =
				choice.mode === "ANY"
					? "required"
					: choice.mode === "NONE"
					? "none"
					: "auto";
		}
		req.maxTokens = number(config.maxOutputTokens ?? config.max_output_tokens);
		req.temperature = number(config.temperature);
		req.topP = number(config.topP ?? config.top_p);
		req.topK = number(config.topK ?? config.top_k);
		req.stop = Array.isArray(config.stopSequences ?? config.stop_sequences)
			? ((config.stopSequences ?? config.stop_sequences) as string[])
			: undefined;
		if ((config.candidateCount ?? config.candidate_count ?? 1) !== 1)
			unsupported("multiple candidates");
		const modalities = config.responseModalities ?? config.response_modalities;
		if (Array.isArray(modalities) && modalities.some((m) => m !== "TEXT"))
			unsupported("non-text output");
		if (
			(config.responseMimeType ?? config.response_mime_type) ===
			"application/json"
		)
			req.json = {
				schema:
					config.responseJsonSchema || config.responseSchema
						? object(config.responseJsonSchema ?? config.responseSchema)
						: undefined,
			};
		const thinking = object(config.thinkingConfig ?? config.thinking_config);
		if (Object.keys(thinking).length)
			req.thinking = {
				budget: number(thinking.thinkingBudget ?? thinking.thinking_budget),
				effort:
					string(
						thinking.thinkingLevel ?? thinking.thinking_level
					).toLowerCase() || undefined,
			};
		if (body.cachedContent ?? body.cached_content)
			unsupported("Gemini cachedContent");
		if (body.safetySettings ?? body.safety_settings)
			unsupported("Gemini safetySettings");
	} else {
		if (protocol === "anthropic" && body.system != null)
			messages.push({
				role: "system",
				parts: parseParts(protocol, body.system),
			});
		for (const m of objects(body.messages)) {
			if (m.role === "tool" && protocol === "openai") {
				messages.push({
					role: "user",
					parts: [
						{
							type: "result",
							id: string(m.tool_call_id),
							name: string(m.name) || undefined,
							parts: parseParts(protocol, m.content),
						},
					],
				});
				continue;
			}
			if (
				!["system", "developer", "user", "assistant"].includes(string(m.role))
			)
				unsupported(`message role ${m.role}`);
			const parts = parseParts(protocol, m.content);
			if (typeof m.reasoning_content === "string")
				parts.unshift({ type: "thinking", text: m.reasoning_content });
			for (const call of objects(m.tool_calls)) {
				if (call.type !== "function")
					unsupported(`tool call type ${call.type}`);
				const f = object(call.function);
				parts.push({
					type: "call",
					id: string(call.id),
					name: string(f.name),
					args: argumentsObject(f.arguments),
					signature:
						string(
							object(object(call.extra_content).google).thought_signature
						) || undefined,
				});
			}
			if (m.function_call != null) unsupported("legacy function_call");
			messages.push({
				role:
					m.role === "developer" ? "system" : (m.role as TextMessage["role"]),
				parts,
			});
		}
		for (const t of objects(body.tools)) {
			if (protocol === "openai") {
				if (t.type !== "function") unsupported(`tool type ${t.type}`);
				const f = object(t.function);
				tools.push({
					name: string(f.name),
					description: string(f.description) || undefined,
					schema: object(f.parameters),
				});
			} else {
				if (t.type != null && t.type !== "custom")
					unsupported(`Anthropic built-in tool ${t.type}`);
				tools.push({
					name: string(t.name),
					description: string(t.description) || undefined,
					schema: object(t.input_schema),
				});
			}
		}
		const choice = body.tool_choice;
		if (typeof choice === "string") {
			if (!["auto", "none", "required"].includes(choice))
				unsupported(`tool choice ${choice}`);
			req.choice = choice as ToolChoice;
		} else if (choice != null) {
			const c = object(choice);
			if (c.type === "function" || c.type === "tool")
				req.choice = { name: string(object(c.function).name ?? c.name) };
			else if (c.type === "any" || c.type === "auto" || c.type === "none")
				req.choice = c.type === "any" ? "required" : c.type;
			else unsupported(`tool choice ${c.type}`);
			if (c.disable_parallel_tool_use != null)
				req.parallel = c.disable_parallel_tool_use !== true;
		}
		if (body.parallel_tool_calls != null)
			req.parallel = body.parallel_tool_calls === true;
		req.maxTokens = number(body.max_completion_tokens ?? body.max_tokens);
		req.temperature = number(body.temperature);
		req.topP = number(body.top_p);
		req.topK = number(body.top_k);
		const stop = body.stop_sequences ?? body.stop;
		req.stop =
			typeof stop === "string"
				? [stop]
				: Array.isArray(stop)
				? (stop as string[])
				: undefined;
		const format = object(body.response_format);
		if (format.type === "json_object" || format.type === "json_schema")
			req.json = {
				schema:
					format.type === "json_schema"
						? object(object(format.json_schema).schema)
						: undefined,
			};
		const nativeFormat = object(object(body.output_config).format);
		if (nativeFormat.type === "json_schema")
			req.json = { schema: object(nativeFormat.schema) };
		const thinking = object(body.thinking);
		if (thinking.type === "enabled" || thinking.type === "adaptive")
			req.thinking = {
				budget: number(thinking.budget_tokens),
				effort: string(object(body.output_config).effort) || undefined,
			};
		if (body.reasoning_effort != null)
			req.thinking = { effort: string(body.reasoning_effort) };
		if ((body.n ?? 1) !== 1) unsupported("multiple choices");
		if (body.logprobs || body.top_logprobs || body.logit_bias || body.functions)
			unsupported("log probabilities, logit_bias or legacy functions");
		if (
			body.audio ||
			(Array.isArray(body.modalities) &&
				body.modalities.some((m) => m !== "text"))
		)
			unsupported("non-text output");
	}
	if (!messages.some((m) => m.role !== "system"))
		throw new TextProtocolError(
			"A conversation requires at least one user or assistant message"
		);
	for (const tool of tools) {
		if (!tool.name)
			throw new TextProtocolError("Function tool name is required");
		if (!Object.keys(tool.schema).length)
			tool.schema = { type: "object", properties: {} };
	}
	const choice = req.choice;
	if (typeof choice === "object" && !tools.some((t) => t.name === choice.name))
		throw new TextProtocolError("Forced function must be present in tools");
	if (req.choice === "required" && !tools.length)
		throw new TextProtocolError(
			"Required tool choice needs at least one function"
		);
	const pending: Array<{ id: string; name: string }> = [];
	let nextId = 0;
	for (const message of messages) {
		if (
			message.role === "system" &&
			message.parts.some((p) => p.type !== "text" && p.type !== "thinking")
		)
			unsupported("non-text system instructions");
		for (const part of message.parts) {
			if (part.type === "call") {
				part.id ||= `call_gateway_${nextId++}`;
				pending.push({ id: part.id, name: part.name });
			} else if (part.type === "result") {
				if (part.parts.some((p) => p.type !== "text" && p.type !== "image"))
					unsupported("nested tools in tool results");
				const index = pending.findIndex((c) =>
					part.id ? c.id === part.id : c.name === part.name
				);
				if (index < 0)
					throw new TextProtocolError(
						"Tool result has no matching preceding function call"
					);
				const call = pending.splice(index, 1)[0]!;
				part.id = call.id;
				part.name = call.name;
			}
		}
	}
	return req;
}

export function imageData(url: string): { mime: string; data: string } | null {
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(url);
	return match ? { mime: match[1]!, data: match[2]! } : null;
}
function encodePart(protocol: TextProtocol, part: TextPart): JsonObject | null {
	if (part.type === "thinking") return null; // Foreign reasoning signatures cannot be replayed to another vendor.
	if (part.type === "text")
		return {
			text: part.text,
			...(protocol === "gemini" ? {} : { type: "text" }),
		};
	if (part.type === "image") {
		const data = imageData(part.url);
		if (!data && !/^https?:\/\//i.test(part.url))
			unsupported("image resource URI; provide an image data URL or HTTP URL");
		if (protocol === "openai")
			return { type: "image_url", image_url: { url: part.url } };
		if (protocol === "anthropic")
			return {
				type: "image",
				source: data
					? { type: "base64", media_type: data.mime, data: data.data }
					: { type: "url", url: part.url },
			};
		if (!data)
			unsupported(
				"remote Gemini images in cross-protocol history; provide a base64 data URL"
			);
		return { inlineData: { mimeType: data.mime, data: data.data } };
	}
	if (part.type === "call") {
		if (protocol === "anthropic")
			return {
				type: "tool_use",
				id: part.id,
				name: part.name,
				input: part.args,
			};
		if (protocol === "gemini")
			return {
				functionCall: { id: part.id, name: part.name, args: part.args },
				thoughtSignature: part.signature || "skip_thought_signature_validator",
			};
		return {
			id: part.id,
			type: "function",
			function: { name: part.name, arguments: JSON.stringify(part.args) },
			...(part.signature
				? { extra_content: { google: { thought_signature: part.signature } } }
				: {}),
		};
	}
	if (protocol === "anthropic")
		return {
			type: "tool_result",
			tool_use_id: part.id,
			content: part.parts.map((p) => encodePart(protocol, p)).filter(Boolean),
			...(part.isError ? { is_error: true } : {}),
		};
	if (protocol === "gemini") {
		if (part.parts.some((p) => p.type !== "text"))
			unsupported("multimodal function results for Gemini");
		const text = part.parts
			.map((p) => (p.type === "text" ? p.text : ""))
			.join("\n");
		let response: unknown;
		try {
			response = JSON.parse(text);
		} catch {
			response = { [part.isError ? "error" : "result"]: text };
		}
		return {
			functionResponse: {
				id: part.id,
				name: part.name,
				response:
					typeof response === "object" &&
					response !== null &&
					!Array.isArray(response)
						? response
						: { result: response },
			},
		};
	}
	return null;
}

/** custom_params are merged AFTER conversion, in the target protocol's dialect. */
export function encodeTextRequest(
	protocol: TextProtocol,
	req: TextRequest,
	stream: boolean
): JsonObject {
	const body: JsonObject = {};
	const system = req.messages
		.filter((m) => m.role === "system")
		.flatMap((m) => m.parts)
		.filter((p) => p.type === "text");
	if (protocol === "openai") {
		body.stream = stream;
		if (stream) body.stream_options = { include_usage: true };
		const messages: JsonObject[] = [];
		for (const m of req.messages) {
			if (m.parts.some((p) => p.type === "result")) {
				let pending: TextPart[] = [];
				const flush = () => {
					if (!pending.length) return;
					messages.push({
						role: m.role,
						content: pending.every((p) => p.type === "text")
							? pending.map((p) => (p.type === "text" ? p.text : "")).join("\n")
							: pending.map((p) => encodePart(protocol, p)),
					});
					pending = [];
				};
				for (const part of m.parts) {
					if (part.type === "result") {
						flush();
						messages.push({
							role: "tool",
							tool_call_id: part.id,
							content: part.parts.every((p) => p.type === "text")
								? part.parts
										.map((p) => (p.type === "text" ? p.text : ""))
										.join("\n")
								: part.parts.map((p) => encodePart(protocol, p)),
						});
					} else if (part.type === "text" || part.type === "image")
						pending.push(part);
				}
				flush();
				continue;
			}
			const content = m.parts.filter(
				(p) => p.type === "text" || p.type === "image"
			);
			const calls = m.parts.filter((p) => p.type === "call");
			const thinking = m.parts
				.flatMap((p) => (p.type === "thinking" ? [p.text] : []))
				.join("");
			if (content.length || calls.length || thinking) {
				messages.push({
					role: m.role,
					content: content.every((p) => p.type === "text")
						? content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
						: content.map((p) => encodePart(protocol, p)),
					...(calls.length
						? { tool_calls: calls.map((p) => encodePart(protocol, p)) }
						: {}),
					...(thinking && m.role === "assistant"
						? { reasoning_content: thinking }
						: {}),
				});
			}
		}
		body.messages = messages;
		if (req.tools.length)
			body.tools = req.tools.map((t) => ({
				type: "function",
				function: {
					name: t.name,
					description: t.description,
					parameters: t.schema,
				},
			}));
		if (req.choice != null)
			body.tool_choice =
				typeof req.choice === "string"
					? req.choice
					: { type: "function", function: { name: req.choice.name } };
		if (req.parallel != null) body.parallel_tool_calls = req.parallel;
		if (req.maxTokens != null) body.max_tokens = req.maxTokens;
		if (req.temperature != null) body.temperature = req.temperature;
		if (req.topP != null) body.top_p = req.topP;
		if (req.topK != null) body.top_k = req.topK;
		if (req.stop != null) body.stop = req.stop;
		if (req.json)
			body.response_format = req.json.schema
				? {
						type: "json_schema",
						json_schema: { name: "response", schema: req.json.schema },
				  }
				: { type: "json_object" };
		if (req.thinking?.effort) body.reasoning_effort = req.thinking.effort;
		else if (req.thinking?.budget != null) {
			const budget = req.thinking.budget;
			body.reasoning_effort =
				budget === 0
					? "none"
					: budget < 0
					? "medium"
					: budget <= 2048
					? "low"
					: budget <= 8192
					? "medium"
					: "high";
		}
	} else {
		const messages: JsonObject[] = [];
		for (const m of req.messages.filter((m) => m.role !== "system")) {
			const parts = m.parts
				.map((p) => encodePart(protocol, p))
				.filter((p) => p !== null);
			if (!parts.length) continue;
			const role =
				m.role === "assistant"
					? protocol === "gemini"
						? "model"
						: "assistant"
					: "user";
			const last = messages[messages.length - 1];
			const key = protocol === "gemini" ? "parts" : "content";
			if (last?.role === role) (last[key] as JsonObject[]).push(...parts);
			else messages.push({ role, [key]: parts });
		}
		if (protocol === "anthropic") {
			body.messages = messages;
			body.stream = stream;
			if (req.maxTokens != null) body.max_tokens = req.maxTokens;
			if (system.length)
				body.system = system.map((p) => encodePart(protocol, p));
			if (req.tools.length)
				body.tools = req.tools.map((t) => ({
					name: t.name,
					description: t.description,
					input_schema: t.schema,
				}));
			if (req.choice != null || req.parallel != null)
				body.tool_choice = {
					...(typeof req.choice === "object"
						? { type: "tool", name: req.choice.name }
						: {
								type: req.choice === "required" ? "any" : req.choice ?? "auto",
						  }),
					...(req.parallel == null
						? {}
						: { disable_parallel_tool_use: !req.parallel }),
				};
			if (req.temperature != null) body.temperature = req.temperature;
			if (req.topP != null) body.top_p = req.topP;
			if (req.topK != null) body.top_k = req.topK;
			if (req.stop != null) body.stop_sequences = req.stop;
			if (req.json?.schema)
				body.output_config = {
					format: { type: "json_schema", schema: req.json.schema },
				};
			else if (req.json)
				unsupported("JSON object mode without a schema for Anthropic");
			if (req.thinking) {
				if (req.thinking.budget != null)
					body.thinking =
						req.thinking.budget === 0
							? { type: "disabled" }
							: req.thinking.budget === -1
							? { type: "adaptive" }
							: { type: "enabled", budget_tokens: req.thinking.budget };
				else if (req.thinking.effort) {
					if (["none", "minimal"].includes(req.thinking.effort))
						body.thinking = { type: "disabled" };
					else {
						body.thinking = { type: "adaptive" };
						body.output_config = {
							...object(body.output_config),
							effort: req.thinking.effort,
						};
					}
				}
			}
		} else {
			body.contents = messages;
			if (system.length)
				body.systemInstruction = {
					parts: system.map((p) => encodePart(protocol, p)),
				};
			if (req.tools.length)
				body.tools = [
					{
						functionDeclarations: req.tools.map((t) => ({
							name: t.name,
							description: t.description,
							parametersJsonSchema: t.schema,
						})),
					},
				];
			if (req.choice != null)
				body.toolConfig = {
					functionCallingConfig:
						typeof req.choice === "object"
							? { mode: "ANY", allowedFunctionNames: [req.choice.name] }
							: {
									mode:
										req.choice === "required"
											? "ANY"
											: req.choice === "none"
											? "NONE"
											: "AUTO",
							  },
				};
			const generation: JsonObject = {};
			if (req.maxTokens != null) generation.maxOutputTokens = req.maxTokens;
			if (req.temperature != null) generation.temperature = req.temperature;
			if (req.topP != null) generation.topP = req.topP;
			if (req.topK != null) generation.topK = req.topK;
			if (req.stop != null) generation.stopSequences = req.stop;
			if (req.json) {
				generation.responseMimeType = "application/json";
				if (req.json.schema) generation.responseJsonSchema = req.json.schema;
			}
			if (req.thinking)
				generation.thinkingConfig = {
					includeThoughts: true,
					...(req.thinking.budget != null
						? { thinkingBudget: req.thinking.budget }
						: {
								thinkingLevel:
									req.thinking.effort === "none" ||
									req.thinking.effort === "minimal"
										? "MINIMAL"
										: req.thinking.effort?.toUpperCase(),
						  }),
				};
			if (Object.keys(generation).length) body.generationConfig = generation;
		}
	}
	return body;
}

export function convertTextRequest(
	from: TextProtocol,
	to: TextProtocol,
	body: JsonObject,
	stream = body.stream === true
): JsonObject {
	return encodeTextRequest(to, decodeTextRequest(from, body), stream);
}
