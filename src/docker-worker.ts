/**
 * Docker worker script — runs inside a context container.
 * Reads a task from stdin as JSON, executes it with the Claude Code SDK,
 * and writes the result to stdout as JSON.
 *
 * Input format (JSON on stdin):
 *   { prompt, model, maxTurns, systemPrompt?, resume?, mcpServers? }
 *
 * Output format (JSON on stdout):
 *   { result, sessionId? } on success
 *   { error } on failure
 */
import { query, type SDKResultMessage, type SDKAssistantMessage, type Options, type McpServerConfig as SdkMcpConfig } from '@anthropic-ai/claude-agent-sdk';

interface WorkerInput {
  prompt: string;
  model: string;
  maxTurns: number;
  systemPrompt?: string;
  resume?: string;
  mcpServers?: Record<string, SdkMcpConfig>;
  env?: Record<string, string>;
}

interface WorkerOutput {
  result?: string;
  sessionId?: string;
  error?: string;
}

async function main() {
  let input: WorkerInput;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch (err: any) {
    writeOutput({ error: `Invalid input: ${err.message}` });
    process.exit(1);
  }

  try {
    const options: Options = {
      model: input.model,
      maxTurns: input.maxTurns,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      env: input.env,
    };

    if (input.systemPrompt) {
      options.systemPrompt = input.systemPrompt;
    }
    if (input.resume) {
      options.resume = input.resume;
    }
    if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
      options.mcpServers = input.mcpServers;
    }

    const stream = query({
      prompt: input.prompt,
      options: {
        ...options,
        stderr: (data: string) => { process.stderr.write(data); },
      },
    });

    let resultText = '';
    let hasResult = false;
    let sessionId: string | undefined;

    for await (const message of stream) {
      if (!sessionId && message.session_id) {
        sessionId = message.session_id;
      }

      if (message.type === 'result') {
        const resultMsg = message as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          resultText = resultMsg.result;
          hasResult = true;
        } else {
          writeOutput({ error: `Claude Code error: ${resultMsg.subtype}` });
          process.exit(1);
        }
      } else if (message.type === 'assistant' && !hasResult) {
        const assistantMsg = message as SDKAssistantMessage;
        const textParts = assistantMsg.message.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: any) => b.text);
        if (textParts.length > 0) {
          resultText = textParts.join('\n');
        }
      }
    }

    writeOutput({
      result: resultText || '(no response)',
      sessionId,
    });
  } catch (err: any) {
    writeOutput({ error: err.message || String(err) });
    process.exit(1);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: WorkerOutput): void {
  process.stdout.write(JSON.stringify(output) + '\n');
}

main();
