type JsonObject = Record<string, unknown>;

const WEB_SEARCH_TOOL_TYPES = new Set(['web_search', 'web_search_preview']);

export type OptionalWebSearchFallback = {
	body: JsonObject;
	disabledTools: string[];
};

/** 只关闭可选内置搜索；保留必须调用工具与指定函数的约束。 */
export function withoutOptionalResponsesWebSearch(body: JsonObject): OptionalWebSearchFallback | null {
	if (!Array.isArray(body.tools)) return null;
	const disabledTools = new Set<string>();
	const tools = body.tools.filter((tool: unknown) => {
		if (!isJsonObject(tool) || typeof tool.type !== 'string' || !WEB_SEARCH_TOOL_TYPES.has(tool.type)) return true;
		disabledTools.add(tool.type);
		return false;
	});
	if (disabledTools.size === 0) return null;
	const functions = tools.filter((tool: unknown) => isJsonObject(tool) && tool.type === 'function');
	const choice = body.tool_choice;
	if (choice === 'required') {
		if (functions.length === 0) return null;
	} else if (isJsonObject(choice) && choice.type === 'function') {
		if (!functions.some((tool: unknown) => isJsonObject(tool) && tool.name === choice.name)) return null;
	} else if (choice != null && choice !== 'auto' && choice !== 'none') {
		return null;
	}
	// 明示能力缺失，避免模型因用户要求搜索而声称已执行不存在的内置工具。
	const notice = 'The built-in web_search tool is unavailable for this request. Do not claim to have used it.';
	return {
		body: {
			...body,
			tools,
			instructions: typeof body.instructions === 'string' && body.instructions
				? `${body.instructions}\n\n${notice}`
				: notice,
		},
		disabledTools: [...disabledTools],
	};
}

/** 参数修正即可恢复的 Responses 工具能力错误，不应触发用户与模型级熔断。 */
export function unsupportedResponsesToolType(status: number, errorBodyText: string): string | null {
	if (status !== 400) return null;
	try {
		const payload = JSON.parse(errorBodyText) as unknown;
		if (!isJsonObject(payload) || !isJsonObject(payload.error)) return null;
		const message = payload.error.message;
		return typeof message === 'string'
			? /^(?:Failed to convert responses request:\s*)?Unsupported Responses tools type ['"]([^'"]+)['"]/.exec(message)?.[1] ?? null
			: null;
	} catch {
		return null;
	}
}

export function isUnsupportedResponsesToolError(status: number, errorBodyText: string): boolean {
	return unsupportedResponsesToolType(status, errorBodyText) !== null;
}

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Responses reasoning 项的 summary 是必填数组；部分客户端/上游省略空摘要。 */
function normalizeReasoningItem(item: unknown): unknown {
	if (!isJsonObject(item) || item.type !== 'reasoning' || item.summary != null) return item;
	return { ...item, summary: [] };
}

function normalizeReasoningItems(items: unknown): unknown {
	if (!Array.isArray(items)) return items;
	const normalized = items.map(normalizeReasoningItem);
	return normalized.some((item, index) => item !== items[index]) ? normalized : items;
}

/** 在合并路由参数之后修复工具轮回传的 reasoning 项，不修改客户端历史。 */
export function normalizeResponsesInputBody(body: JsonObject): JsonObject {
	const input = normalizeReasoningItems(body.input);
	return input === body.input ? body : { ...body, input };
}

function normalizeResponseOutput(body: JsonObject): JsonObject {
	const output = normalizeReasoningItems(body.output);
	return output === body.output ? body : { ...body, output };
}

/** 修复 JSON output、SSE item 和终态 response.output，保留加密推理及未知字段。 */
export function normalizeResponsesOutputPayload(payload: JsonObject): JsonObject {
	let normalized = normalizeResponseOutput(payload);
	const item = normalizeReasoningItem(payload.item);
	if (item !== payload.item) normalized = { ...normalized, item };
	if (isJsonObject(payload.response)) {
		const response = normalizeResponseOutput(payload.response);
		if (response !== payload.response) normalized = { ...normalized, response };
	}
	return normalized;
}
