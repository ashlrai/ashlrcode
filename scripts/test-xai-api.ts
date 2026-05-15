/**
 * Quick test script to verify xAI API responses and usage tracking.
 */
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY!,
  baseURL: "https://api.x.ai/v1",
});

console.log("Testing xAI Grok API...\n");

// Test 1: Simple chat with streaming
console.log("=== Test 1: Streaming chat ===");
const stream = await client.chat.completions.create({
  model: "grok-4.3",
  messages: [{ role: "user", content: "Say 'hello world' and nothing else" }],
  max_tokens: 50,
  stream: true,
  stream_options: { include_usage: true },
});

let fullText = "";
for await (const chunk of stream) {
  const choice = chunk.choices[0];
  if (choice?.delta?.content) {
    fullText += choice.delta.content;
    process.stdout.write(choice.delta.content);
  }
  if (chunk.usage) {
    console.log("\n\nUsage:", JSON.stringify(chunk.usage, null, 2));
  }
  if (choice?.finish_reason) {
    console.log("Finish reason:", choice.finish_reason);
  }
}
console.log(`\nFull text: "${fullText}"\n`);

// Test 2: Tool calling
console.log("=== Test 2: Tool calling ===");
const toolStream = await client.chat.completions.create({
  model: "grok-4.3",
  messages: [{ role: "user", content: "What files are in the current directory? Use the list_files tool." }],
  tools: [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a directory",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path" },
          },
          required: ["path"],
        },
      },
    },
  ],
  max_tokens: 200,
  stream: true,
  stream_options: { include_usage: true },
});

for await (const chunk of toolStream) {
  const choice = chunk.choices[0];
  if (choice?.delta?.content) {
    process.stdout.write(choice.delta.content);
  }
  if (choice?.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      if (tc.function?.name) {
        console.log(`\nTool call: ${tc.function.name}`);
      }
      if (tc.function?.arguments) {
        process.stdout.write(tc.function.arguments);
      }
    }
  }
  if (chunk.usage) {
    console.log("\n\nUsage:", JSON.stringify(chunk.usage, null, 2));
  }
  if (choice?.finish_reason) {
    console.log("\nFinish reason:", choice.finish_reason);
  }
}

console.log("\n\nDone!");
