import { inspectChatGpt, parseInspectEnvironment } from '../src/chatgpt/inspect.js';

const options = parseInspectEnvironment(process.env);
const result = await inspectChatGpt(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
